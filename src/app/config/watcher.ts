"use strict";

/**
 * Signal K Edge Link - Config File Watcher
 *
 * Manages per-instance configuration file watchers with debouncing,
 * content-hash deduplication, and automatic recovery on file rename.
 *
 * @module app/config/watcher
 */

import { promises as fsPromises, watch, FSWatcher } from "fs";
import { join } from "path";
import * as crypto from "crypto";
import { loadConfigFileSafe, saveConfigFile } from "../../foundation/config-io";
import {
  DEFAULT_DELTA_TIMER,
  FILE_WATCH_DEBOUNCE_DELAY,
  CONTENT_HASH_ALGORITHM,
  WATCHER_RECOVERY_DELAY
} from "../../foundation/constants";
import type { SignalKApp } from "../../foundation/types";

const { readFile, writeFile, mkdir } = fsPromises;

interface DebounceHandlerOpts {
  name: string;
  getFilePath: () => string | null;
  processConfig: (config: unknown) => void | Promise<void>;
  state: {
    configDebounceTimers: Record<string, ReturnType<typeof setTimeout>>;
    configContentHashes: Record<string, string>;
    stopped?: boolean;
  };
  instanceId: string;
  app: SignalKApp;
  readFallback?: unknown;
}

interface WatcherRecoveryOpts {
  filePath: string | null;
  onChange: () => void;
  name: string;
  instanceId: string;
  app: SignalKApp;
  state: { stopped?: boolean };
}

interface WatcherHandle {
  readonly watcher: FSWatcher | null;
  close(): void;
}

/**
 * A debounced config-change handler. Calling the returned function schedules
 * the file (re)load on the standard debounce delay. The attached `flush()`
 * runs the same load immediately, bypassing the debounce timer — used for the
 * initial subscription wire-up at plugin start so that deltas produced by
 * co-located plugins aren't lost during the debounce window.
 */
export interface DebouncedConfigHandler {
  (): void;
  flush(): Promise<void>;
}

/** Creates a config-file watcher whose reload calls are promise-serialised so a burst of file-change events cannot silently drop a reload if one is already in flight. */
export function createDebouncedConfigHandler(opts: DebounceHandlerOpts): DebouncedConfigHandler {
  const { name, getFilePath, processConfig, state, instanceId, app, readFallback } = opts;

  // Serialize concurrent runLoad calls: while one is in flight, a follow-up
  // call awaits its completion and only then evaluates its own work. The
  // previous hash-claim trick had a window between "claim hash" and
  // "processConfig await" in which a second runLoad could observe the new
  // hash, skip, and silently drop a legitimate event if the first one then
  // threw. A simple promise-chain serialization is strictly more correct.
  let runInFlight: Promise<void> | null = null;

  async function runLoadInner(): Promise<void> {
    if (state.stopped) return;
    let content: string | null;
    const filePath = getFilePath();
    if (readFallback !== undefined) {
      content = filePath ? await readFile(filePath, "utf-8").catch(() => null) : null;
    } else {
      content = filePath ? await readFile(filePath, "utf-8") : null;
    }

    if (state.stopped) return;

    const hashSource = content || JSON.stringify(readFallback) || "";
    const contentHash = crypto.createHash(CONTENT_HASH_ALGORITHM).update(hashSource).digest("hex");

    if (contentHash === state.configContentHashes[name]) {
      app.debug(`[${instanceId}] ${name} file unchanged, skipping`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = content ? JSON.parse(content) : readFallback;
    } catch (parseErr) {
      // Parse failure: do not advance the hash so a subsequent file event
      // (presumably with corrected content) is not silently skipped.
      throw parseErr;
    }

    try {
      await processConfig(parsed);
    } catch (err) {
      // Processing failed: leave the previous hash intact so a retry can
      // re-detect the same content as still-pending.
      throw err;
    }

    // Only after processConfig completes successfully do we mark this
    // content as the last-known-good. Holding the hash update to the
    // success path means a failed apply does not silently swallow the next
    // identical event.
    if (!state.stopped) {
      state.configContentHashes[name] = contentHash;
    }
  }

  let rerunRequested = false;

  async function runLoad(): Promise<void> {
    // Single-producer serialization: only the first caller spawns the
    // runLoadInner loop; later callers set rerunRequested and return,
    // so the producer drains them before clearing runInFlight. A naive
    // "attach + recreate" pattern would let two callers both spawn a
    // fresh runLoadInner and reintroduce overlap.
    if (runInFlight) {
      rerunRequested = true;
      await runInFlight.catch(() => {
        /* errors surface through the caller's .catch */
      });
      return;
    }
    runInFlight = (async () => {
      // Drain queued reruns even if an earlier pass threw — a parse or
      // apply failure must not strand the queued follow-up that
      // arrived between the failure and now. The latest error is
      // reported once draining is complete.
      let lastError: unknown;
      while (!state.stopped) {
        rerunRequested = false;
        try {
          await runLoadInner();
          lastError = undefined;
        } catch (err) {
          lastError = err;
        }
        if (!rerunRequested) {
          break;
        }
      }
      if (lastError !== undefined) {
        throw lastError;
      }
    })();
    try {
      await runInFlight;
    } finally {
      runInFlight = null;
    }
  }

  const handleChange = function () {
    clearTimeout(state.configDebounceTimers[name]);
    state.configDebounceTimers[name] = setTimeout(() => {
      runLoad().catch((err: unknown) => {
        if (state.stopped) return;
        const msg = err instanceof Error ? err.message : String(err);
        app.error(`[${instanceId}] Error handling ${name} change: ${msg}`);
      });
    }, FILE_WATCH_DEBOUNCE_DELAY);
  } as DebouncedConfigHandler;

  handleChange.flush = async function flush(): Promise<void> {
    clearTimeout(state.configDebounceTimers[name]);
    try {
      await runLoad();
    } catch (err: unknown) {
      if (state.stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] Error handling ${name} change: ${msg}`);
    }
  };

  return handleChange;
}

/**
 * Create a file-system watcher with automatic recovery on error or rename.
 */
export function createWatcherWithRecovery(opts: WatcherRecoveryOpts): WatcherHandle {
  const { filePath, onChange, name, instanceId, app, state } = opts;
  const MAX_RECOVERY_ATTEMPTS = 10;
  const MAX_RECOVERY_DELAY = 60000;
  const watcherObj: {
    watcher: FSWatcher | null;
    recoveryTimer: ReturnType<typeof setTimeout> | null;
    recoveryAttempts: number;
  } = { watcher: null, recoveryTimer: null, recoveryAttempts: 0 };

  function scheduleWatcherRecreate(): void {
    if (watcherObj.recoveryTimer) {
      clearTimeout(watcherObj.recoveryTimer);
    }
    if (watcherObj.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      app.error(
        `[${instanceId}] ${name} watcher recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts, giving up`
      );
      return;
    }
    const delay = Math.min(
      WATCHER_RECOVERY_DELAY * Math.pow(2, watcherObj.recoveryAttempts),
      MAX_RECOVERY_DELAY
    );
    watcherObj.recoveryAttempts++;
    watcherObj.recoveryTimer = setTimeout(() => {
      watcherObj.recoveryTimer = null;
      if (state.stopped) {
        return;
      }
      app.debug(
        `[${instanceId}] Recreating ${name} watcher (attempt ${watcherObj.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}, delay ${delay}ms)...`
      );
      const created = createWatcher();
      if (created) {
        watcherObj.recoveryAttempts = 0;
      } else {
        scheduleWatcherRecreate();
      }
    }, delay);
  }

  function createWatcher(): boolean {
    try {
      if (watcherObj.watcher) {
        watcherObj.watcher.close();
        watcherObj.watcher = null;
      }
      if (!filePath) {
        return false;
      }
      watcherObj.watcher = watch(filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          app.debug(`[${instanceId}] ${name} file changed`);
          onChange();
          if (eventType === "rename") {
            scheduleWatcherRecreate();
          }
        }
      });

      watcherObj.watcher.on("error", (error: Error) => {
        app.error(`[${instanceId}] ${name} watcher error: ${error.message}`);
        if (watcherObj.watcher) {
          watcherObj.watcher.close();
          watcherObj.watcher = null;
        }
        scheduleWatcherRecreate();
      });

      return true;
    } catch (err: unknown) {
      app.error(
        `[${instanceId}] Failed to create ${name} watcher: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  createWatcher();

  return {
    get watcher() {
      return watcherObj.watcher;
    },
    close() {
      if (watcherObj.recoveryTimer) {
        clearTimeout(watcherObj.recoveryTimer);
        watcherObj.recoveryTimer = null;
      }
      if (watcherObj.watcher) {
        watcherObj.watcher.close();
        watcherObj.watcher = null;
      }
    }
  };
}

interface MigrateLegacyOpts {
  instanceId: string;
  dataDir: string;
  instanceDir: string;
  app: SignalKApp;
}

/**
 * Migrate legacy root-level config files to the instance-namespaced directory
 * when upgrading from single-instance to multi-instance mode.
 */
export async function migrateLegacyConfigFiles({
  instanceId,
  dataDir,
  instanceDir,
  app
}: MigrateLegacyOpts): Promise<void> {
  if (instanceId !== "default") {
    return;
  }
  const legacyFiles = ["delta_timer.json", "subscription.json", "sentence_filter.json"];
  for (const file of legacyFiles) {
    const legacy = join(dataDir, file);
    const target = join(instanceDir, file);
    try {
      const data = await readFile(legacy, "utf-8");
      await writeFile(target, data, { encoding: "utf-8", flag: "wx" });
      app.debug(`[${instanceId}] Migrated legacy ${file} → instances/default/${file}`);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "EEXIST") {
        app.error(`[${instanceId}] Migration failed for ${file}: ${e.message}`);
      }
    }
  }
}

interface InitPersistentStorageOpts {
  instanceId: string;
  app: SignalKApp;
  state: {
    deltaTimerFile: string | null;
    subscriptionFile: string | null;
    sentenceFilterFile: string | null;
    excludedSentences: string[];
  };
}

/**
 * Initialize per-instance persistent storage (config files and defaults).
 */
export async function initializePersistentStorage({
  instanceId,
  app,
  state
}: InitPersistentStorageOpts): Promise<void> {
  const instanceDir = join(app.getDataDirPath(), "instances", instanceId);
  await mkdir(instanceDir, { recursive: true });

  await migrateLegacyConfigFiles({
    instanceId,
    dataDir: app.getDataDirPath(),
    instanceDir,
    app
  });

  state.deltaTimerFile = join(instanceDir, "delta_timer.json");
  state.subscriptionFile = join(instanceDir, "subscription.json");
  state.sentenceFilterFile = join(instanceDir, "sentence_filter.json");

  const defaults: Array<{ file: string; data: unknown; name: string }> = [
    {
      file: state.deltaTimerFile,
      data: { deltaTimer: DEFAULT_DELTA_TIMER },
      name: "delta_timer.json"
    },
    {
      file: state.subscriptionFile,
      data: { context: "*", subscribe: [{ path: "*" }] },
      name: "subscription.json"
    },
    {
      file: state.sentenceFilterFile,
      data: { excludedSentences: ["GSV"] },
      name: "sentence_filter.json"
    }
  ];

  for (const { file, data, name } of defaults) {
    const existing = await loadConfigFileSafe(file, app);
    if (existing.status === "not_found") {
      await saveConfigFile(file, data);
      app.debug(`[${instanceId}] Initialized ${name} with defaults`);
    } else if (existing.status === "ok" && name === "sentence_filter.json") {
      const sentenceConfig =
        existing.data && typeof existing.data === "object" && !Array.isArray(existing.data)
          ? (existing.data as Record<string, unknown>)
          : {};
      state.excludedSentences = Array.isArray(sentenceConfig.excludedSentences)
        ? (sentenceConfig.excludedSentences as string[])
        : ["GSV"];
    } else if (existing.status === "parse_error" || existing.status === "read_error") {
      app.error(
        `[${instanceId}] Preserving existing ${name}; default initialization skipped after ${existing.status}: ${existing.message}`
      );
    }
  }
}
