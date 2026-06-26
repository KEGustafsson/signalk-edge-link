"use strict";

/**
 * Signal K Edge Link - monotonic connection epoch (H3 anti-replay)
 *
 * The server resets its per-peer replay window only on a strictly higher epoch,
 * so the client's epoch must increase on every (re)start to distinguish a
 * legitimate restart from a replayed HELLO. Wall-clock time alone is not
 * monotonic across a device reboot without a working RTC, so the epoch is
 * persisted and advanced as `max(Date.now(), stored + 1)`.
 *
 * @module transport/reliability/connection-epoch
 */

import { loadConfigFileSafe, saveConfigFile } from "../../foundation/config-io";

/** Minimal logger shape accepted by the config-io helpers. */
interface Logger {
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * Resolve the next monotonic connection epoch from a persisted counter.
 * Persistence is best-effort: when the store is unavailable the value still
 * advances within this run, degrading to `Date.now()`-style behavior (correct
 * wherever the clock is sane across restarts).
 *
 * @param epochFilePath - File backing the persisted epoch, or null to skip
 *   persistence entirely (returns `Date.now()`).
 */
export async function resolveMonotonicEpoch(
  epochFilePath: string | null,
  logger?: Logger
): Promise<number> {
  const now = Date.now();
  if (!epochFilePath) {
    return now;
  }

  let stored = 0;
  const res = await loadConfigFileSafe(epochFilePath, logger);
  if (res.status === "ok") {
    const data = res.data as { epoch?: unknown } | null;
    const v = typeof data?.epoch === "number" ? data.epoch : 0;
    if (Number.isFinite(v) && v > 0) {
      stored = v;
    }
  }

  const epoch = Math.max(now, stored + 1);
  try {
    await saveConfigFile(epochFilePath, { epoch }, logger);
  } catch {
    /* best-effort persistence */
  }
  return epoch;
}
