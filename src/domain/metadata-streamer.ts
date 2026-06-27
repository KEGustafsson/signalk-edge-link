"use strict";

/**
 * Metadata streamer (L3 domain service).
 *
 * Owns outbound Signal K metadata streaming: full snapshots (periodic, on
 * (re)subscribe, and on receiver `META_REQUEST`), and coalesced live diffs
 * extracted from the delta stream. Extracted from the `instance.ts` God
 * Object.
 *
 * The {@link MetaCache} is shared by reference with the connection (instance.ts
 * still calls `metaCache.clear()` across resubscribe/stop), so it is injected
 * rather than owned here. All snapshot/diff timers live on the shared `state`
 * object so the connection's `stop()` can cancel them.
 *
 * @module domain/metadata-streamer
 */

import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  MetricsApi,
  MetaEntry
} from "../foundation/types";
import { MetaCache, collectSnapshot } from "../codec/metadata-codec";

/** Debounce window for coalescing live meta entries observed in the delta
 *  stream before they are transmitted as a single `diff` packet. */
const META_DIFF_DEBOUNCE_MS = 500;

/** Minimum gap between receiver-initiated snapshot sends. Prevents a noisy
 *  or malicious receiver from forcing snapshots on every delta. */
const META_REQUEST_RATE_LIMIT_MS = 5000;

/** Injected dependencies for `createMetadataStreamer`. */
export interface MetadataStreamerDeps {
  state: InstanceState;
  options: ConnectionConfig;
  app: SignalKApp;
  /** App proxy used for self-context resolution during snapshot collection. */
  appProxy: SignalKApp;
  instanceId: string;
  recordError: MetricsApi["recordError"];
  /** Last-sent meta cache, shared with the connection (cleared on resubscribe). */
  metaCache: MetaCache;
}

/** Public API returned by `createMetadataStreamer`. */
export interface MetadataStreamer {
  sendMetadataSnapshot(): Promise<void>;
  enqueueMetaDiff(entries: MetaEntry[]): void;
  restartMetadataTimer(): void;
  scheduleMetadataSnapshot(delayMs: number): void;
  handleMetaRequest(): void;
}

/** Shared context for the streamer's module-level helpers. */
interface StreamerContext {
  deps: MetadataStreamerDeps;
  sendMetadataSnapshot: () => Promise<void>;
}

/** Dispatches `entries` through the active pipeline. Returns true on a
 *  successful send so callers (e.g. `enqueueMetaDiff`) can decide whether
 *  to commit the MetaCache. Any failure is logged and returns false. */
async function sendMetaEntries(
  ctx: StreamerContext,
  entries: MetaEntry[],
  kind: "snapshot" | "diff"
): Promise<boolean> {
  const { state, options, app, instanceId, recordError } = ctx.deps;
  if (!options.udpAddress || !options.secretKey) {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }
  try {
    if (state.pipeline && typeof state.pipeline.sendMetadata === "function") {
      await state.pipeline.sendMetadata(
        entries,
        kind,
        options.secretKey,
        options.udpAddress,
        options.udpPort
      );
    } else {
      app.debug(
        `[${instanceId}] Meta skipped: pipeline not ready or does not support sendMetadata`
      );
      return false;
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    app.error(`[${instanceId}] sendMetaEntries failed: ${msg}`);
    recordError("general", `sendMetaEntries failed: ${msg}`);
    return false;
  }
}

/**
 * Build and transmit a full metadata snapshot from the current Signal K
 * state tree. Resets the internal diff cache afterwards so the next diff is
 * measured against what was just sent.
 */
async function sendMetadataSnapshot(ctx: StreamerContext): Promise<void> {
  const { state, appProxy, metaCache } = ctx.deps;
  if (!state.metaConfig?.enabled || state.stopped || !state.readyToSend) {
    return;
  }
  const entries = collectSnapshot(appProxy, state.metaConfig);
  const sent = await sendMetaEntries(ctx, entries, "snapshot");
  // Only prime the diff cache on a successful send; on failure the next
  // snapshot (periodic or META_REQUEST-triggered) will still cover every
  // path rather than the cache showing stale "already sent" state.
  if (sent) {
    metaCache.replaceAll(entries);
  }
}

/** Flush handler for the debounced meta-diff buffer. */
function flushMetaDiff(ctx: StreamerContext): void {
  const { state, app, instanceId, metaCache } = ctx.deps;
  state.metaDiffFlushTimer = null;
  const pending = state.metaDiffBuffer;
  state.metaDiffBuffer = [];
  const changed = metaCache.computeDiff(pending);
  if (changed.length === 0) {
    return;
  }
  // Snapshot cache generation before the async send; if a resubscribe
  // clears the cache while the send is in flight, the post-send commit
  // must NOT repopulate stale entries into the new generation.
  const generationAtSend = metaCache.generation();
  sendMetaEntries(ctx, changed, "diff")
    .then((sent) => {
      if (sent && metaCache.generation() === generationAtSend) {
        metaCache.commit(changed);
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] meta diff flush failed: ${msg}`);
    });
}

/** Coalesces live meta diffs extracted from deltas; flushes after a short
 *  debounce window so a burst of meta changes becomes one packet. */
function enqueueMetaDiff(ctx: StreamerContext, entries: MetaEntry[]): void {
  const { state } = ctx.deps;
  // Buffer raw entries; the actual change-detection (and cache commit)
  // happens in the flush handler so a failed send doesn't leave the
  // MetaCache thinking it transmitted something it never did.
  if (entries.length === 0) {
    return;
  }
  state.metaDiffBuffer.push(...entries);
  if (state.metaDiffFlushTimer) {
    return;
  }
  state.metaDiffFlushTimer = setTimeout(() => flushMetaDiff(ctx), META_DIFF_DEBOUNCE_MS);
}

function restartMetadataTimer(ctx: StreamerContext): void {
  const { state, app, instanceId } = ctx.deps;
  if (state.metaTimer) {
    clearInterval(state.metaTimer);
    state.metaTimer = null;
  }
  if (!state.metaConfig?.enabled) {
    return;
  }
  const intervalMs = Math.max(30, state.metaConfig.intervalSec) * 1000;
  state.metaTimer = setInterval(() => {
    ctx.sendMetadataSnapshot().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] periodic snapshot failed: ${msg}`);
    });
  }, intervalMs);
}

/** Schedules a meta snapshot send after `delayMs`. Cancels any prior
 *  pending snapshot timer first — back-to-back (re)subscribes or socket
 *  recoveries should coalesce into a single pending snapshot rather than
 *  queue up multiple sends. The returned timer is tracked on
 *  state.metaSnapshotTimers so stop() can cancel it. */
function scheduleMetadataSnapshot(ctx: StreamerContext, delayMs: number): void {
  const { state } = ctx.deps;
  for (const existing of state.metaSnapshotTimers) {
    clearTimeout(existing);
  }
  state.metaSnapshotTimers.length = 0;
  const handle = setTimeout(() => {
    const idx = state.metaSnapshotTimers.indexOf(handle);
    if (idx !== -1) {
      state.metaSnapshotTimers.splice(idx, 1);
    }
    if (state.stopped) {
      return;
    }
    ctx.sendMetadataSnapshot().catch(() => {
      /* errors already logged inside sendMetadataSnapshot */
    });
  }, delayMs);
  state.metaSnapshotTimers.push(handle);
}

/** Receiver asked for a fresh meta snapshot (META_REQUEST control packet).
 *  Rate-limited so a malformed or buggy receiver cannot force continuous
 *  snapshot work on the edge-link. */
function handleMetaRequest(ctx: StreamerContext): void {
  const { state, app, instanceId } = ctx.deps;
  if (!state.metaConfig?.enabled) {
    return;
  }
  const now = Date.now();
  if (now - state.lastMetaRequestAt < META_REQUEST_RATE_LIMIT_MS) {
    return;
  }
  state.lastMetaRequestAt = now;
  ctx.sendMetadataSnapshot().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    app.debug(`[${instanceId}] META_REQUEST snapshot failed: ${msg}`);
  });
}

/** Create the outbound metadata streaming service (full snapshots and live diffs). */
export function createMetadataStreamer(deps: MetadataStreamerDeps): MetadataStreamer {
  const ctx: StreamerContext = {
    deps,
    sendMetadataSnapshot: () => sendMetadataSnapshot(ctx)
  };

  return {
    sendMetadataSnapshot: ctx.sendMetadataSnapshot,
    enqueueMetaDiff: (entries: MetaEntry[]) => enqueueMetaDiff(ctx, entries),
    restartMetadataTimer: () => restartMetadataTimer(ctx),
    scheduleMetadataSnapshot: (delayMs: number) => scheduleMetadataSnapshot(ctx, delayMs),
    handleMetaRequest: () => handleMetaRequest(ctx)
  };
}
