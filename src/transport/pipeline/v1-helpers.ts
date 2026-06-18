"use strict";

/**
 * Signal K Edge Link - v1 pipeline helpers
 *
 * Cohesive blocks factored out of the v1 `packCrypt` / `unpackDecrypt`
 * closures so each public function stays under the layer size/complexity
 * caps. These helpers are pure-ish (no closure over mutable pipeline state)
 * and take everything they need as explicit parameters.
 *
 * @module transport/pipeline/v1-helpers
 */

import * as msgpack from "@msgpack/msgpack";
import { DecryptError } from "../../foundation/result";
import { encryptBinary, decryptBinary } from "../../codec/crypto";
import { encodeDelta, decodeDelta } from "../../codec/path-dictionary";
import {
  filterDeltaPayload,
  quantizeDelta,
  sanitizeDeltaForSignalK,
  throttleDelta,
  type PathThrottleState
} from "../../codec/delta-sanitizer";
import { handleMessageBySource, normalizeDeltaSourceRefs } from "../../codec/source-dispatch";
import { deltaBuffer, compressPayload, brotliDecompressAsync } from "../../codec/compression";
import { udpSendAsync as _udpSendAsyncShared } from "../udp-socket-manager";
import {
  MAX_SAFE_UDP_PAYLOAD,
  MAX_DECOMPRESSED_SIZE,
  MAX_PARSE_PAYLOAD_SIZE,
  MAX_DELTAS_PER_PACKET,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch,
  clampBytesPerDeltaSample
} from "../../foundation/constants";
import type {
  SignalKApp,
  MetricsApi,
  InstanceState,
  ConnectionConfig,
  Delta
} from "../../foundation/types";

type RecordErrorFn = MetricsApi["recordError"];
type TrackPathStatsFn = MetricsApi["trackPathStats"];

/**
 * Shared dependencies + mutable state for the v1 pipeline operations. The
 * factory in v1.ts builds this once and the module-level operations below
 * close over it explicitly, keeping each function under the layer size caps.
 */
export interface V1PipelineContext {
  app: SignalKApp;
  state: InstanceState;
  metricsApi: MetricsApi;
  throttleState: PathThrottleState;
  setStatus: (message: string) => void;
}

/**
 * Applies the v1 outbound delta transforms (filter → quantize → throttle →
 * path-dictionary encoding) and returns the processed payload, or null if the
 * payload was entirely dropped by a filter/throttle stage.
 */
export function prepareOutboundDelta(
  delta: Delta | Delta[],
  options: ConnectionConfig,
  throttleState: PathThrottleState
): { processed: Delta | Delta[]; sentItems: Delta[] } | null {
  const filterConfig = options.pathFilter;
  const filtered = filterConfig
    ? (filterDeltaPayload(delta, filterConfig) as Delta | Delta[] | null)
    : delta;
  if (filtered === null) {
    return null;
  }

  const precisionMap = options.pathPrecision;
  const quantized = precisionMap
    ? Array.isArray(filtered)
      ? filtered.map((d) => quantizeDelta(d, precisionMap))
      : quantizeDelta(filtered, precisionMap)
    : filtered;

  const throttled = applyThrottle(quantized, options, throttleState);
  if (throttled === null) {
    return null;
  }

  const processed = options.usePathDictionary
    ? Array.isArray(throttled)
      ? throttled.map(encodeDelta)
      : encodeDelta(throttled)
    : throttled;

  const sentItems = Array.isArray(throttled) ? throttled : [throttled];
  return { processed, sentItems };
}

/** Apply per-path throttle / deadband, dropping values that fail the rule. */
function applyThrottle(
  quantized: Delta | Delta[],
  options: ConnectionConfig,
  throttleState: PathThrottleState
): Delta | Delta[] | null {
  const throttleMap = options.pathThrottle;
  if (!throttleMap) {
    return quantized;
  }
  if (Array.isArray(quantized)) {
    const kept: Delta[] = [];
    for (const d of quantized) {
      const t = throttleDelta(d, throttleMap, throttleState);
      if (t !== null) {
        kept.push(t);
      }
    }
    return kept.length > 0 ? kept : null;
  }
  return throttleDelta(quantized, throttleMap, throttleState);
}

/** Classify and report a packCrypt error to the metrics/logging surfaces. */
export function reportPackCryptError(
  app: SignalKApp,
  recordError: RecordErrorFn,
  error: unknown
): void {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (
    code.startsWith("ERR_ZLIB") ||
    code === "ERR_BUFFER_OUT_OF_RANGE" ||
    msg.includes("compress")
  ) {
    app.error(`Compression error: ${msg}`);
    recordError("compression", `Compression error: ${msg}`);
  } else if (
    code === "ERR_CRYPTO_INVALID_STATE" ||
    msg.includes("encrypt") ||
    msg.includes("cipher")
  ) {
    app.error(`Encryption error: ${msg}`);
    recordError("encryption", `Encryption error: ${msg}`);
  } else {
    app.error(`packCrypt error: ${msg}`);
    recordError("general", `packCrypt error: ${msg}`);
  }
}

/** Classify and report an unpackDecrypt error to the metrics/logging surfaces. */
export function reportUnpackDecryptError(
  app: SignalKApp,
  recordError: RecordErrorFn,
  error: unknown
): void {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (error instanceof DecryptError) {
    const hint = error.keyMismatchHint
      ? " (possible stretchAsciiKey or key-format mismatch between peers)"
      : "";
    app.error(`Decryption/authentication failed${hint}: ${msg}`);
    recordError("encryption", `Decryption/authentication failed${hint}`);
  } else if (
    msg.includes("Unsupported state") ||
    msg.includes("auth") ||
    code === "ERR_CRYPTO_INVALID_STATE"
  ) {
    app.error("Authentication failed: packet tampered or wrong key");
    recordError("encryption", "Authentication failed: packet tampered or wrong key");
  } else if (
    msg.includes("decrypt") ||
    msg.includes("cipher") ||
    code === "ERR_OSSL_EVP_BAD_DECRYPT"
  ) {
    app.error(`Decryption error: ${msg}`);
    recordError("encryption", `Decryption error: ${msg}`);
  } else if (
    code.startsWith("ERR_ZLIB") ||
    code === "ERR_BUFFER_OUT_OF_RANGE" ||
    msg.includes("decompress")
  ) {
    app.error(`Decompression error: ${msg}`);
    recordError("compression", `Decompression error: ${msg}`);
  } else {
    app.error(`unpackDecrypt error: ${msg}`);
    recordError("general", `unpackDecrypt error: ${msg}`);
  }
}

/**
 * Decompress a decrypted v1 payload (capped against decompression bombs) and
 * parse it into deltas. Returns null when the payload is too large to parse or
 * decodes to a non-object — the caller has already been informed via app/error.
 */
export async function decompressAndParse(
  app: SignalKApp,
  recordError: RecordErrorFn,
  decrypted: Buffer,
  useMsgpack: boolean
): Promise<{ decompressed: Buffer; deltas: Delta[] } | null> {
  const decompressed = (await brotliDecompressAsync(decrypted, {
    maxOutputLength: MAX_DECOMPRESSED_SIZE
  })) as Buffer;

  if (decompressed.length > MAX_PARSE_PAYLOAD_SIZE) {
    app.error(
      `Received decompressed payload too large to parse: ${decompressed.length} bytes ` +
        `(limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    recordError(
      "general",
      `Payload too large to parse: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    return null;
  }

  let jsonContent: unknown;
  if (useMsgpack) {
    try {
      jsonContent = msgpack.decode(decompressed);
    } catch (msgpackErr) {
      jsonContent = JSON.parse(decompressed.toString());
    }
  } else {
    jsonContent = JSON.parse(decompressed.toString());
  }

  if (jsonContent === null || typeof jsonContent !== "object") {
    app.error("Received non-object payload, skipping");
    recordError("general", "Received non-object payload");
    return null;
  }

  const deltas = Array.isArray(jsonContent)
    ? (jsonContent as Delta[])
    : Object.values(jsonContent as Record<string, Delta>);
  return { decompressed, deltas };
}

/** Decode, sanitize, dispatch and meter a batch of received deltas. */
export function dispatchReceivedDeltas(
  app: SignalKApp,
  metrics: MetricsApi["metrics"],
  trackPathStats: TrackPathStatsFn,
  deltas: Delta[],
  decompressedLength: number
): void {
  const deltaCount = Math.min(deltas.length, MAX_DELTAS_PER_PACKET);

  if (deltas.length > MAX_DELTAS_PER_PACKET) {
    app.error(
      `Received ${deltas.length} deltas in one packet (limit ${MAX_DELTAS_PER_PACKET}), truncating`
    );
  }

  for (let i = 0; i < deltaCount; i++) {
    let deltaMessage: Delta | null = deltas[i];

    if (deltaMessage === null || deltaMessage === undefined) {
      app.debug(`Skipping null delta message at index ${i}`);
      continue;
    }

    deltaMessage = decodeDelta(deltaMessage);

    if (deltaMessage === null || deltaMessage === undefined) {
      app.debug(`Skipping null delta message after decoding at index ${i}`);
      continue;
    }

    deltaMessage = sanitizeDeltaForSignalK(deltaMessage);
    if (deltaMessage === null) {
      app.debug(`Skipping delta with no valid Signal K values at index ${i}`);
      continue;
    }
    deltaMessage = normalizeDeltaSourceRefs(deltaMessage);

    trackPathStats(deltaMessage, decompressedLength / deltas.length);

    handleMessageBySource(app, deltaMessage);
    app.debug(
      `delta ctx=${deltaMessage.context ?? "?"} updates=${Array.isArray(deltaMessage.updates) ? deltaMessage.updates.length : 0}`
    );
    metrics.deltasReceived++;
  }
}

/** Update the smart-batching rolling average after a successful packCrypt send. */
function updateSmartBatch(ctx: V1PipelineContext, packetLength: number, sentCount: number): void {
  const { state, metricsApi, app } = ctx;
  const { metrics } = metricsApi;
  const deltaCount = Math.max(sentCount, 1);
  const bytesPerDelta = clampBytesPerDeltaSample(packetLength / deltaCount);

  state.avgBytesPerDelta =
    (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
  state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

  metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
  metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

  app.debug(
    `Smart batch: ${deltaCount} deltas, ${packetLength} bytes (${bytesPerDelta.toFixed(0)} bytes/delta), ` +
      `avg=${state.avgBytesPerDelta.toFixed(0)}, nextMaxDeltas=${state.maxDeltasPerBatch}`
  );
}

/**
 * Compresses, encrypts, and sends delta data via UDP.
 * Pipeline: Serialize -> Compress -> Encrypt (AES-256-GCM) -> Send
 */
export async function packCrypt(
  ctx: V1PipelineContext,
  delta: Delta | Delta[],
  secretKey: string,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, state, metricsApi, throttleState } = ctx;
  const { metrics, recordError, trackPathStats } = metricsApi;
  try {
    if (!state.options) {
      app.debug("packCrypt called but plugin is stopped, ignoring");
      return;
    }

    // Filter → quantize → throttle → path-dictionary encoding. Returns null
    // when the whole payload is dropped by a filter/throttle stage.
    const prepared = prepareOutboundDelta(delta, state.options, throttleState);
    if (prepared === null) {
      return;
    }
    const { processed: processedDelta, sentItems } = prepared;

    const serialized = deltaBuffer(processedDelta, state.options.useMsgpack);
    metrics.bandwidth.bytesOutRaw += serialized.length;

    for (const d of sentItems) {
      trackPathStats(d, serialized.length / sentItems.length);
    }

    const compressed = await compressPayload(
      serialized,
      state.options.useMsgpack || false,
      state.options.brotliQuality
    );

    const packet = encryptBinary(compressed, secretKey, {
      stretchAsciiKey: !!state.options.stretchAsciiKey
    });

    if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
      app.debug(
        `Warning: Packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment. ` +
          "Consider reducing delta timer interval or filtering paths."
      );
      metrics.smartBatching.oversizedPackets++;
    }

    metrics.bandwidth.bytesOut += packet.length;
    metrics.bandwidth.packetsOut++;

    await udpSendAsync(ctx, packet, udpAddress, udpPort);
    metrics.deltasSent++;

    updateSmartBatch(ctx, packet.length, sentItems.length);

    state.lastPacketTime = Date.now();
  } catch (error: unknown) {
    reportPackCryptError(app, recordError, error);
  }
}

/**
 * Decompresses, decrypts, and processes received UDP data.
 * Pipeline: Receive -> Decrypt (AES-256-GCM) -> Decompress -> Parse -> Process
 */
export async function unpackDecrypt(
  ctx: V1PipelineContext,
  packet: Buffer,
  secretKey: string
): Promise<void> {
  const { app, state, metricsApi } = ctx;
  const { metrics, recordError, trackPathStats } = metricsApi;
  try {
    if (!state.options) {
      app.debug("unpackDecrypt called but plugin is stopped, ignoring");
      return;
    }

    metrics.bandwidth.bytesIn += packet.length;
    metrics.bandwidth.packetsIn++;

    const decrypted = decryptBinary(packet, secretKey, {
      stretchAsciiKey: !!state.options.stretchAsciiKey
    });

    const parsed = await decompressAndParse(
      app,
      recordError,
      decrypted,
      !!state.options.useMsgpack
    );
    if (parsed === null) {
      return;
    }

    metrics.bandwidth.bytesInRaw += parsed.decompressed.length;

    dispatchReceivedDeltas(app, metrics, trackPathStats, parsed.deltas, parsed.decompressed.length);
  } catch (error: unknown) {
    reportUnpackDecryptError(app, recordError, error);
  }
}

/** Sends a message via UDP with retry logic (delegates to shared utility). */
export function udpSendAsync(
  ctx: V1PipelineContext,
  message: Buffer,
  host: string,
  port: number
): Promise<void> {
  const { app, state, metricsApi, setStatus } = ctx;
  const { metrics, recordError } = metricsApi;
  if (!state.socketUdp) {
    const error = new Error("UDP socket not initialized, cannot send message");
    app.error(error.message);
    setStatus("UDP socket not initialized - cannot send data");
    throw error;
  }

  return _udpSendAsyncShared(state.socketUdp, message, host, port, {
    onRetry(retryCount: number, err: NodeJS.ErrnoException) {
      metrics.udpRetries++;
      app.debug(`UDP send error (${err.code}), retry ${retryCount}/${3}`);
    },
    onError(err: NodeJS.ErrnoException, retryCount: number) {
      metrics.udpSendErrors++;
      app.error(`UDP send error to ${host}:${port} - ${err.message} (code: ${err.code})`);
      recordError("udpSend", `UDP send error: ${err.message} (${err.code})`);
      if (retryCount >= 3) {
        app.error("Max retries reached, packet dropped");
      }
    }
  });
}
