"use strict";

/**
 * Signal K Edge Link - reliable client delta sender.
 *
 * Extracted from the v2 client factory: payload shape helpers, path-latency
 * recording, and the full `sendDelta` send pipeline (sanitize → filter →
 * quantize → throttle → dedup → encode → compress → encrypt → packet → UDP →
 * retransmit-queue).
 *
 * @module transport/pipeline/reliable-client/delta-sender
 */

import * as msgpack from "@msgpack/msgpack";
import { encryptBinary } from "../../../codec/crypto";
import { encodeDelta } from "../../../codec/path-dictionary";
import {
  filterDeltaPayload,
  quantizeDeltaPayload,
  sanitizeDeltaPayloadForSignalK,
  throttleDeltaPayload,
  type DeltaPayload
} from "../../../codec/delta-sanitizer";
import { dedupDeltaPayload } from "../../../codec/value-dedup";
import { encodeCompactPayload } from "../../../codec/compact-delta";
import { deltaBuffer, compressPayload } from "../../../codec/compression";
import {
  MAX_SAFE_UDP_PAYLOAD,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch,
  clampBytesPerDeltaSample
} from "../../../foundation/constants";
import type { Delta } from "../../../foundation/types";
import type { ClientContext } from "./context";
import { udpSendAsync } from "./lifecycle";
import { pruneRetransmitQueue } from "./reliability";

export function isSingleDeltaPayload(deltaPayload: DeltaPayload): deltaPayload is Delta {
  return !Array.isArray(deltaPayload) && Array.isArray((deltaPayload as Delta).updates);
}

export function deltaPayloadItems(deltaPayload: DeltaPayload): Delta[] {
  if (Array.isArray(deltaPayload)) {
    return deltaPayload;
  }
  if (isSingleDeltaPayload(deltaPayload)) {
    return [deltaPayload];
  }
  return Object.values(deltaPayload);
}

export function encodeDeltaPayload(deltaPayload: DeltaPayload): DeltaPayload {
  if (Array.isArray(deltaPayload)) {
    return deltaPayload.map(encodeDelta);
  }
  if (isSingleDeltaPayload(deltaPayload)) {
    return encodeDelta(deltaPayload);
  }
  return Object.fromEntries(
    Object.entries(deltaPayload).map(([key, value]) => [key, encodeDelta(value)])
  );
}

export function recordPathLatencies(ctx: ClientContext, deltaPayload: DeltaPayload): void {
  const monitoringHooks = ctx.mut.monitoringHooks;
  if (!monitoringHooks || !monitoringHooks.pathLatencyTracker) {
    return;
  }

  const now = Date.now();
  const deltas = deltaPayloadItems(deltaPayload);

  for (const delta of deltas) {
    if (!delta || !Array.isArray(delta.updates)) {
      continue;
    }

    for (const update of delta.updates) {
      const timestampMs = update && update.timestamp ? Date.parse(update.timestamp) : NaN;
      if (!Number.isFinite(timestampMs)) {
        continue;
      }

      const latencyMs = Math.max(0, now - timestampMs);
      const values = Array.isArray(update.values) ? update.values : [];
      for (const value of values) {
        if (value && typeof value.path === "string" && value.path.length > 0) {
          monitoringHooks.pathLatencyTracker.record(value.path, latencyMs);
        }
      }
    }
  }
}

/**
 * Apply the outbound delta transforms (sanitize → filter → quantize →
 * throttle → dedup → path-dictionary) and return the processed payload plus
 * the deduped payload (used for path stats / latency recording), or null when
 * the whole payload is dropped by a sanitize/filter/throttle stage.
 */
function prepareDeltaPayload(
  ctx: ClientContext,
  delta: Delta | Delta[]
): { processed: DeltaPayload; deduped: DeltaPayload } | null {
  const { app, state } = ctx;
  const options = state.options;
  if (!options) {
    return null;
  }

  const sanitizedDelta = sanitizeDeltaPayloadForSignalK(delta);
  if (sanitizedDelta === null) {
    app.debug("sendDelta skipped: no valid Signal K values");
    return null;
  }

  const filteredDelta = filterDeltaPayload(sanitizedDelta, options.pathFilter);
  if (filteredDelta === null) {
    app.debug("sendDelta skipped: all values removed by pathFilter");
    return null;
  }

  const quantizedDelta = quantizeDeltaPayload(filteredDelta, options.pathPrecision);

  const throttledDelta = throttleDeltaPayload(
    quantizedDelta,
    options.pathThrottle,
    ctx.throttleState
  );
  if (throttledDelta === null) {
    app.debug("sendDelta skipped: all values dropped by pathThrottle");
    return null;
  }

  const dedupedDelta = options.useValueDedup
    ? dedupDeltaPayload(throttledDelta, ctx.dedupState)
    : throttledDelta;

  const processed = options.usePathDictionary ? encodeDeltaPayload(dedupedDelta) : dedupedDelta;
  return { processed, deduped: dedupedDelta };
}

/** Update the smart-batching rolling average + monitoring after a send. */
function updateSmartBatch(ctx: ClientContext, packetLength: number, sentCount: number): void {
  const { state, metricsApi } = ctx;
  const { metrics } = metricsApi;
  const deltaCount = Math.max(1, sentCount);
  const bytesPerDelta = clampBytesPerDeltaSample(packetLength / deltaCount);

  state.avgBytesPerDelta =
    (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
  state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

  metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
  metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;
}

/** Record monitoring capture/inspect/loss hooks for a sent DATA packet. */
function recordSentDataPacket(
  ctx: ClientContext,
  packet: Buffer,
  udpAddress: string,
  udpPort: number
): void {
  const monitoringHooks = ctx.mut.monitoringHooks;
  if (!monitoringHooks) {
    return;
  }
  const rinfo = { address: udpAddress, port: udpPort };
  if (monitoringHooks.packetCapture) {
    monitoringHooks.packetCapture.capture(packet, "send", rinfo);
  }
  if (monitoringHooks.packetInspector) {
    monitoringHooks.packetInspector.inspect(packet, "send", rinfo);
  }
  if (monitoringHooks.packetLossTracker) {
    monitoringHooks.packetLossTracker.record(false);
  }
}

/** Classify and report a sendDelta error to logging/metrics surfaces. */
function reportSendDeltaError(ctx: ClientContext, error: unknown): void {
  const { app, metricsApi } = ctx;
  const { recordError } = metricsApi;
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("compress")) {
    app.error(`v2 compression error: ${msg}`);
    recordError("compression", `v2 compression error: ${msg}`);
  } else if (msg.includes("encrypt")) {
    app.error(`v2 encryption error: ${msg}`);
    recordError("encryption", `v2 encryption error: ${msg}`);
  } else {
    app.error(`v2 sendDelta error: ${msg}`);
    recordError("general", `v2 sendDelta error: ${msg}`);
  }
}

/**
 * Serialize → compress → encrypt → build the v2 DATA packet. Returns the
 * captured pre-build sequence (buildDataPacket advances it) and the packet.
 */
async function buildDataPacket(
  ctx: ClientContext,
  processedDelta: DeltaPayload,
  serialized: Buffer,
  secretKey: string
): Promise<{ seq: number; packet: Buffer }> {
  const { app, state, metricsApi, packetBuilder, stretchAsciiKey } = ctx;
  const { metrics } = metricsApi;
  const options = state.options!;

  const compressed = await compressPayload(
    serialized,
    options.useMsgpack ?? false,
    options.brotliQuality
  );
  const encrypted = encryptBinary(compressed, secretKey, { stretchAsciiKey });

  // Capture sequence before building (buildDataPacket advances it)
  const seq = packetBuilder.getCurrentSequence();
  const packet = packetBuilder.buildDataPacket(encrypted, {
    compressed: true,
    encrypted: true,
    messagepack: !!options.useMsgpack,
    pathDictionary: !!options.usePathDictionary
  });

  if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
    app.debug(
      `Warning: v2 packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment.`
    );
    metrics.smartBatching.oversizedPackets++;
  }
  return { seq, packet };
}

/** Post-send bookkeeping: monitoring, retransmit queue, loss window, batching. */
function recordDataSend(
  ctx: ClientContext,
  seq: number,
  packet: Buffer,
  udpAddress: string,
  udpPort: number,
  sentCount: number
): void {
  const { app, metricsApi, retransmitQueue } = ctx;
  const { metrics } = metricsApi;

  recordSentDataPacket(ctx, packet, udpAddress, udpPort);

  retransmitQueue.add(seq, packet);
  metrics.queueDepth = retransmitQueue.getSize();
  pruneRetransmitQueue(ctx, "send");

  // Record clean send in loss window
  ctx.lossWindow.push(false);

  updateSmartBatch(ctx, packet.length, sentCount);

  app.debug(`v2 sent: seq=${seq}, ${Math.max(1, sentCount)} deltas, ${packet.length} bytes`);
}

/**
 * Compress, encrypt, wrap in v2 packet, and send delta data via UDP.
 * Pipeline: Serialize → Compress → Encrypt → PacketBuild → Send → Store in retransmit queue
 */
export async function sendDelta(
  ctx: ClientContext,
  delta: Delta | Delta[],
  secretKey: string,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, state, metricsApi } = ctx;
  const { metrics, trackPathStats } = metricsApi;
  try {
    if (!state.options) {
      app.debug("sendDelta called but plugin is stopped, ignoring");
      return;
    }

    const prepared = prepareDeltaPayload(ctx, delta);
    if (prepared === null) {
      return;
    }
    const { processed: processedDelta, deduped: dedupedDelta } = prepared;

    // Serialize to buffer — compact mode requires msgpack (no gain in JSON)
    const serialized =
      state.options.useCompactDeltas && state.options.useMsgpack
        ? Buffer.from(msgpack.encode(encodeCompactPayload(processedDelta)))
        : deltaBuffer(processedDelta, state.options.useMsgpack);

    metrics.bandwidth.bytesOutRaw += serialized.length;

    const sentItems = deltaPayloadItems(dedupedDelta);
    for (const item of sentItems) {
      trackPathStats(item, serialized.length / sentItems.length);
    }
    recordPathLatencies(ctx, dedupedDelta);

    const { seq, packet } = await buildDataPacket(ctx, processedDelta, serialized, secretKey);

    metrics.bandwidth.bytesOut += packet.length;
    metrics.bandwidth.packetsOut++;

    await udpSendAsync(ctx, packet, udpAddress, udpPort);
    metrics.deltasSent++;
    const sentAt = Date.now();

    recordDataSend(ctx, seq, packet, udpAddress, udpPort, sentItems.length);

    state.lastPacketTime = sentAt;
  } catch (error: unknown) {
    reportSendDeltaError(ctx, error);
    throw error;
  }
}
