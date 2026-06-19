"use strict";

/**
 * Delta batcher (L3 domain service).
 *
 * Owns the outbound delta send loop: the periodic flush timer and the
 * batch-flush state machine — in-flight guard, retry/back-off, drop-on-repeated
 * failure, and the `setImmediate` drain that keeps emptying the buffer in
 * MTU-safe chunks. Extracted from the `instance.ts` God Object; the producer
 * side (`processDelta`, which enqueues into `state.deltas`) still lives in
 * instance.ts and drives this service via {@link DeltaBatcher.flushDeltaBatch}.
 *
 * State is shared by reference: the batcher reads and mutates the same `state`
 * and `metrics` objects the rest of the connection uses, so nothing is copied.
 * Everything else is injected, which is what makes the loop unit-testable with
 * fakes (no real socket, no real pipeline, no timers needed for the core path).
 *
 * @module domain/delta-batcher
 */

import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  MetricsApi,
  Delta
} from "../foundation/types";
import { DELTA_SEND_MAX_RETRIES, DELTA_SEND_RETRY_BACKOFF_MS } from "../foundation/constants";

/** Minimal v1-pipeline surface the batcher falls back to when no v2/v3 pipeline. */
interface V1PipelineLike {
  packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
}

/** Injected dependencies for `createDeltaBatcher`. */
export interface DeltaBatcherDeps {
  /** Shared per-instance state (mutated in place). */
  state: InstanceState;
  /** Shared metrics counters (mutated in place). */
  metrics: MetricsApi["metrics"];
  app: SignalKApp;
  options: ConnectionConfig;
  instanceId: string;
  recordError: MetricsApi["recordError"];
  /** Lazily-resolved v1 pipeline, used when no v2/v3 pipeline is configured. */
  getV1Pipeline: () => V1PipelineLike;
}

/** Public API returned by `createDeltaBatcher`. */
export interface DeltaBatcher {
  /** (Re)arm the periodic timer that flips `state.timer` to force a flush. */
  scheduleDeltaTimer(): void;
  /** Send up to `batchSize` buffered deltas, retrying transient failures. */
  flushDeltaBatch(batchSize?: number, retryCount?: number): Promise<void>;
}

/** Shared mutable context for the batcher's module-level helpers. */
interface BatcherContext {
  deps: DeltaBatcherDeps;
  scheduleDeltaTimer: () => void;
  flushDeltaBatch: (batchSize?: number, retryCount?: number) => Promise<void>;
}

function scheduleDeltaTimer(ctx: BatcherContext): void {
  const { state } = ctx.deps;
  clearTimeout(state.deltaTimer ?? undefined);
  state.deltaTimer = setTimeout(() => {
    if (state.stopped) {
      return;
    }
    state.timer = true;
    ctx.scheduleDeltaTimer();
  }, state.deltaTimerTime);
}

async function sendDeltaBatch(ctx: BatcherContext, batch: Delta[]): Promise<void> {
  const { state, options, getV1Pipeline } = ctx.deps;
  if (state.pipeline) {
    await state.pipeline.sendDelta(
      batch,
      options.secretKey,
      options.udpAddress ?? "",
      options.udpPort
    );
  } else {
    await getV1Pipeline().packCrypt(
      batch,
      options.secretKey,
      options.udpAddress ?? "",
      options.udpPort
    );
  }
}

function scheduleBatchRetry(ctx: BatcherContext, batchSize: number, retryCount: number): void {
  const { state } = ctx.deps;
  if (state.pendingRetry || state.stopped) {
    return;
  }

  state.pendingRetry = setTimeout(() => {
    state.pendingRetry = null;
    ctx.flushDeltaBatch(batchSize, retryCount);
  }, DELTA_SEND_RETRY_BACKOFF_MS);
}

/** Handle a failed batch send: retry while attempts remain, else drop and record. */
function handleBatchSendFailure(
  ctx: BatcherContext,
  err: unknown,
  actualBatchSize: number,
  retryCount: number
): void {
  const { state, metrics, app, instanceId, recordError } = ctx.deps;
  const nextRetryCount = retryCount + 1;
  app.debug(
    `[${instanceId}] Batch send failed (attempt ${nextRetryCount}/${DELTA_SEND_MAX_RETRIES + 1}): ${err instanceof Error ? err.message : String(err)}`
  );

  if (nextRetryCount <= DELTA_SEND_MAX_RETRIES) {
    scheduleBatchRetry(ctx, actualBatchSize, nextRetryCount);
    return;
  }

  state.deltas.splice(0, actualBatchSize);
  state.timer = false;
  state.droppedDeltaBatches++;
  state.droppedDeltaCount += actualBatchSize;
  metrics.droppedDeltaBatches = (metrics.droppedDeltaBatches || 0) + 1;
  metrics.droppedDeltaCount = (metrics.droppedDeltaCount || 0) + actualBatchSize;
  const dropMessage = `[${instanceId}] Dropped delta batch after ${nextRetryCount} failed attempts (${actualBatchSize} deltas)`;
  app.error(dropMessage);
  // Use the "udpSend" category so the udpSendErrors counter (and the
  // udpSend errors_by_category bucket) reflects dropped sends; the bare
  // "sendFailure" category maps to no Prometheus counter.
  recordError("udpSend", dropMessage);
}

async function flushDeltaBatch(
  ctx: BatcherContext,
  batchSize: number = ctx.deps.state.deltas.length,
  retryCount: number = 0
): Promise<void> {
  const { state } = ctx.deps;
  if (
    state.batchSendInFlight ||
    state.pendingRetry ||
    state.stopped ||
    !state.readyToSend ||
    state.socketRecoveryInProgress
  ) {
    return;
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0 || state.deltas.length === 0) {
    state.timer = false;
    return;
  }

  const actualBatchSize = Math.min(batchSize, state.deltas.length, state.maxDeltasPerBatch);
  const batch = state.deltas.slice(0, actualBatchSize);
  state.batchSendInFlight = true;

  try {
    await sendDeltaBatch(ctx, batch);
    state.deltas.splice(0, actualBatchSize);
    state.timer = false;
    state.lastPacketTime = Date.now(); // suppress hello sends right after real data
  } catch (err: unknown) {
    handleBatchSendFailure(ctx, err, actualBatchSize, retryCount);
  } finally {
    state.batchSendInFlight = false;
    if (state.deltas.length > 0 && !state.pendingRetry && !state.stopped) {
      setImmediate(() => {
        ctx.flushDeltaBatch();
      });
    }
  }
}

/** Create the outbound delta send loop: periodic flush timer and batch-flush state machine. */
export function createDeltaBatcher(deps: DeltaBatcherDeps): DeltaBatcher {
  const ctx: BatcherContext = {
    deps,
    scheduleDeltaTimer: () => scheduleDeltaTimer(ctx),
    flushDeltaBatch: (batchSize?: number, retryCount?: number) =>
      flushDeltaBatch(ctx, batchSize, retryCount)
  };

  return {
    scheduleDeltaTimer: ctx.scheduleDeltaTimer,
    flushDeltaBatch: ctx.flushDeltaBatch
  };
}
