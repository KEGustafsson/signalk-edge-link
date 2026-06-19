"use strict";

/**
 * Outbound delta processing (L4 application layer).
 *
 * The producer side of the send loop: validates/sanitizes an inbound delta,
 * suppresses recent duplicates, enforces the buffer cap, enqueues into
 * `state.deltas`, and triggers a batch flush when ready. Extracted from
 * `createConnection` and split into focused helpers to keep cyclomatic
 * complexity and statement counts within the layer caps.
 *
 * @module app/connection/process-delta
 */

import {
  MAX_DELTAS_BUFFER_SIZE,
  DELTA_BUFFER_DROP_RATIO,
  OUTBOUND_DUPLICATE_SUPPRESS_MS,
  OUTBOUND_DEDUPE_MAX_ENTRIES
} from "../../foundation/constants";
import { extractLiveMeta, resolveSelfContext } from "../../codec/metadata-codec";
import { sanitizeDeltaForSignalK, stripOwnDataFromDelta } from "../../codec/delta-sanitizer";
import type { Delta } from "../../foundation/types";
import type { ConnectionContext } from "./context";

/** Build a deterministic dedupe key for an outbound delta (hot path). */
export function buildOutboundDedupeKey(delta: Delta): string {
  const parts: string[] = [];
  function push(tag: string, raw: unknown): void {
    const s = raw === null || raw === undefined ? "" : String(raw);
    parts.push(tag, String(s.length), ":", s);
  }
  push("c", delta.context);
  const updates = Array.isArray(delta.updates) ? delta.updates : [];
  for (const update of updates) {
    parts.push("|u");
    push("s", update?.$source);
    const srcObj = update?.source as Record<string, unknown> | undefined;
    if (srcObj && typeof srcObj === "object") {
      push("sl", srcObj.label);
      push("st", srcObj.type);
      push("ss", srcObj.src);
    }
    push("t", update?.timestamp);
    const values = Array.isArray(update?.values) ? update.values : [];
    for (const v of values) {
      parts.push("|v");
      push("p", v?.path);
      const value = v?.value;
      if (value === null || value === undefined) {
        push("v", "");
      } else if (typeof value === "object") {
        push("v", JSON.stringify(value));
      } else {
        push("v", String(value));
      }
    }
  }
  return parts.join("");
}

/** Emit a throttled debug line describing a suppressed duplicate delta. */
function logSuppressedDuplicate(ctx: ConnectionContext, outboundDelta: Delta, now: number): void {
  if (now - ctx.lastDupLogAt < 1000) return;
  ctx.lastDupLogAt = now;
  const upd = Array.isArray(outboundDelta.updates) ? outboundDelta.updates[0] : null;
  const val = Array.isArray(upd?.values) ? upd.values[0] : null;
  ctx.app.debug(
    `[${ctx.instanceId}] Suppressed duplicate outbound delta ` +
      `(context=${outboundDelta.context || "?"}, path=${val?.path || "?"}, ` +
      `source=${upd?.$source || upd?.source?.label || "?"}, timestamp=${upd?.timestamp || "?"}, ` +
      `updates=${Array.isArray(outboundDelta.updates) ? outboundDelta.updates.length : 0}, ` +
      `values=${Array.isArray(upd?.values) ? upd.values.length : 0}, ` +
      `suppressed=${ctx.metrics.suppressedOutboundDuplicates || 0})`
  );
}

/**
 * Returns true if this delta is a recent duplicate (already suppressed and
 * accounted for); false if it is new and has been recorded in the dedupe map.
 */
function suppressDuplicate(ctx: ConnectionContext, outboundDelta: Delta, now: number): boolean {
  const key = buildOutboundDedupeKey(outboundDelta);
  const seenAt = ctx.recentOutboundDeltas.get(key);
  if (seenAt !== undefined && now - seenAt <= OUTBOUND_DUPLICATE_SUPPRESS_MS) {
    ctx.metrics.suppressedOutboundDuplicates = (ctx.metrics.suppressedOutboundDuplicates || 0) + 1;
    logSuppressedDuplicate(ctx, outboundDelta, now);
    return true;
  }
  ctx.recentOutboundDeltas.set(key, now);
  if (ctx.recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) ctx.cleanupDedupeMap(now);
  return false;
}

/** Drop the oldest deltas when the outbound buffer is over capacity. */
function enforceBufferCap(ctx: ConnectionContext): void {
  const { state, metrics, app, instanceId, recordError } = ctx;
  if (state.deltas.length < MAX_DELTAS_BUFFER_SIZE) return;
  const drop = Math.floor(MAX_DELTAS_BUFFER_SIZE * DELTA_BUFFER_DROP_RATIO);
  state.deltas.splice(0, drop);
  app.debug(`[${instanceId}] Delta buffer overflow, dropped ${drop} oldest items`);
  metrics.droppedDeltaCount = (metrics.droppedDeltaCount || 0) + drop;
  metrics.droppedDeltaBatches = (metrics.droppedDeltaBatches || 0) + 1;
  state.droppedDeltaCount += drop;
  state.droppedDeltaBatches++;
  recordError("sendFailure", `[${instanceId}] Delta buffer overflow, dropped ${drop} oldest items`);
}

/** Flush the buffer if a batch is ready or the timer has fired. */
function maybeFlush(ctx: ConnectionContext): void {
  const { state, metrics, app, instanceId, recordError, services } = ctx;
  const batchReady = state.deltas.length >= state.maxDeltasPerBatch;
  if (!((batchReady || state.timer) && !state.pendingRetry)) return;
  if (batchReady) metrics.smartBatching.earlySends++;
  else metrics.smartBatching.timerSends++;
  services.flushDeltaBatch().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    app.error(`[${instanceId}] flushDeltaBatch error: ${msg}`);
    recordError("sendFailure", `flushDeltaBatch error: ${msg}`);
  });
}

/** Process a single inbound delta through the outbound send pipeline. */
export function processDelta(ctx: ConnectionContext, delta: Delta): void {
  const { state, metrics, options, appProxy, services } = ctx;
  metrics.processDeltaCalls = (metrics.processDeltaCalls || 0) + 1;
  // readyToSend is kept in sync with the lifecycle FSM (set true on Ready,
  // false on stop). Tests may also set it directly without going through start().
  if (!state.readyToSend || state.subscribing) return;

  if (state.metaConfig?.enabled) {
    const liveMeta = extractLiveMeta(delta, state.metaConfig, resolveSelfContext(appProxy));
    if (liveMeta.length > 0) services.enqueueMetaDiff(liveMeta);
  }

  const sanitized = sanitizeDeltaForSignalK(delta);
  if (!sanitized) return;
  const outboundDelta = options.skipOwnData ? stripOwnDataFromDelta(sanitized) : sanitized;
  if (!outboundDelta) return;

  const now = Date.now();
  if (suppressDuplicate(ctx, outboundDelta, now)) return;

  enforceBufferCap(ctx);

  state.deltas.push(outboundDelta);
  if (state.deltas.length > (metrics.deltasBufferHighWaterMark || 0)) {
    metrics.deltasBufferHighWaterMark = state.deltas.length;
  }
  ctx.scheduleReportOutputMessages();

  maybeFlush(ctx);
}
