"use strict";

/**
 * Signal K Edge Link - Debounced config reload
 *
 * Promise-serialised, content-hash-deduplicated reload of a config file. Shared
 * infrastructure (L0) so both the app-layer file watcher and domain-layer
 * managers can reuse it without crossing layer boundaries.
 *
 * @module foundation/config-reload
 */

import { promises as fsPromises } from "fs";
import * as crypto from "crypto";
import { CONTENT_HASH_ALGORITHM, FILE_WATCH_DEBOUNCE_DELAY } from "./constants";
import type { SignalKApp } from "./types";

const { readFile } = fsPromises;

export interface DebounceHandlerOpts {
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

/** Mutable serialization state shared between the producer and queued callers. */
interface SerializationState {
  runInFlight: Promise<void> | null;
  rerunRequested: boolean;
}

/**
 * Perform a single load pass: read the file, dedupe by content hash, parse and
 * apply. Parse/apply failures propagate — the content hash is only advanced on
 * success so a failed apply does not silently swallow the next identical event.
 */
async function runLoadInner(opts: DebounceHandlerOpts): Promise<void> {
  const { name, getFilePath, processConfig, state, instanceId, app, readFallback } = opts;
  if (state.stopped) {
    return;
  }
  const filePath = getFilePath();
  let content: string | null;
  if (readFallback !== undefined) {
    content = filePath ? await readFile(filePath, "utf-8").catch(() => null) : null;
  } else {
    content = filePath ? await readFile(filePath, "utf-8") : null;
  }

  if (state.stopped) {
    return;
  }

  const hashSource = content || JSON.stringify(readFallback) || "";
  const contentHash = crypto.createHash(CONTENT_HASH_ALGORITHM).update(hashSource).digest("hex");

  if (contentHash === state.configContentHashes[name]) {
    app.debug(`[${instanceId}] ${name} file unchanged, skipping`);
    return;
  }

  // Parse failure propagates: we do not advance the hash (the update below is
  // gated on success), so a subsequent file event with corrected content is not
  // silently skipped.
  const parsed: unknown = content ? JSON.parse(content) : readFallback;

  // Processing failure propagates too: leaving the previous hash intact lets a
  // retry re-detect the same content as still-pending.
  await processConfig(parsed);

  // Only after processConfig completes successfully do we mark this content as
  // the last-known-good.
  if (!state.stopped) {
    state.configContentHashes[name] = contentHash;
  }
}

/**
 * Single-producer serialization around `runLoadInner`: only the first caller
 * spawns the drain loop; later callers set `rerunRequested` and await the
 * in-flight pass. A naive "attach + recreate" pattern would let two callers
 * both spawn a fresh loop and reintroduce overlap.
 */
async function runLoad(opts: DebounceHandlerOpts, ser: SerializationState): Promise<void> {
  if (ser.runInFlight) {
    ser.rerunRequested = true;
    await ser.runInFlight.catch(() => {
      /* errors surface through the caller's .catch */
    });
    return;
  }
  ser.runInFlight = (async () => {
    // Drain queued reruns even if an earlier pass threw — a parse or apply
    // failure must not strand a follow-up that arrived between the failure and
    // now. The latest error is reported once draining is complete.
    let lastError: unknown;
    while (!opts.state.stopped) {
      ser.rerunRequested = false;
      try {
        await runLoadInner(opts);
        lastError = undefined;
      } catch (err) {
        lastError = err;
      }
      if (!ser.rerunRequested) {
        break;
      }
    }
    if (lastError !== undefined) {
      throw lastError;
    }
  })();
  try {
    await ser.runInFlight;
  } finally {
    ser.runInFlight = null;
  }
}

/** Creates a config-file watcher whose reload calls are promise-serialised so a burst of file-change events cannot silently drop a reload if one is already in flight. */
export function createDebouncedConfigHandler(opts: DebounceHandlerOpts): DebouncedConfigHandler {
  const { name, state, instanceId, app } = opts;
  const ser: SerializationState = { runInFlight: null, rerunRequested: false };

  const reportError = (err: unknown): void => {
    if (state.stopped) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    app.error(`[${instanceId}] Error handling ${name} change: ${msg}`);
  };

  const handleChange = function () {
    clearTimeout(state.configDebounceTimers[name]);
    state.configDebounceTimers[name] = setTimeout(() => {
      runLoad(opts, ser).catch(reportError);
    }, FILE_WATCH_DEBOUNCE_DELAY);
  } as DebouncedConfigHandler;

  handleChange.flush = async function flush(): Promise<void> {
    clearTimeout(state.configDebounceTimers[name]);
    try {
      await runLoad(opts, ser);
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return handleChange;
}
