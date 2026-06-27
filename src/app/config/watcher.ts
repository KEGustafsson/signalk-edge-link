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
import { loadConfigFileSafe, saveConfigFile } from "../../foundation/config-io";
import { DEFAULT_DELTA_TIMER, WATCHER_RECOVERY_DELAY } from "../../foundation/constants";
import type { SignalKApp } from "../../foundation/types";

const { readFile, writeFile, mkdir } = fsPromises;

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

// `createDebouncedConfigHandler` now lives in the foundation layer (shared
// config-reload infrastructure) so domain-layer consumers can use it without
// importing upward into the app layer. Re-exported here for back-compat with
// the legacy `lib/config-watcher` entrypoint.
export {
  createDebouncedConfigHandler,
  type DebouncedConfigHandler,
  type DebounceHandlerOpts
} from "../../foundation/config-reload";

const MAX_RECOVERY_ATTEMPTS = 10;
const MAX_RECOVERY_DELAY = 60000;

interface WatcherContext {
  opts: WatcherRecoveryOpts;
  watcherObj: {
    watcher: FSWatcher | null;
    recoveryTimer: ReturnType<typeof setTimeout> | null;
    recoveryAttempts: number;
  };
}

function scheduleWatcherRecreate(ctx: WatcherContext): void {
  const { app, name, instanceId, state } = ctx.opts;
  const { watcherObj } = ctx;
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
    const created = createWatcher(ctx);
    if (created) {
      watcherObj.recoveryAttempts = 0;
    } else {
      scheduleWatcherRecreate(ctx);
    }
  }, delay);
}

function createWatcher(ctx: WatcherContext): boolean {
  const { filePath, onChange, name, instanceId, app } = ctx.opts;
  const { watcherObj } = ctx;
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
          scheduleWatcherRecreate(ctx);
        }
      }
    });

    watcherObj.watcher.on("error", (error: Error) => {
      app.error(`[${instanceId}] ${name} watcher error: ${error.message}`);
      if (watcherObj.watcher) {
        watcherObj.watcher.close();
        watcherObj.watcher = null;
      }
      scheduleWatcherRecreate(ctx);
    });

    return true;
  } catch (err: unknown) {
    app.error(
      `[${instanceId}] Failed to create ${name} watcher: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Create a file-system watcher with automatic recovery on error or rename.
 */
export function createWatcherWithRecovery(opts: WatcherRecoveryOpts): WatcherHandle {
  const ctx: WatcherContext = {
    opts,
    watcherObj: { watcher: null, recoveryTimer: null, recoveryAttempts: 0 }
  };
  const { watcherObj } = ctx;

  createWatcher(ctx);

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
