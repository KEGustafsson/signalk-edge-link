"use strict";

import * as msgpack from "@msgpack/msgpack";
import { encryptBinary, decryptBinary } from "./crypto";
import { encodeDelta, decodeDelta } from "./pathDictionary";
import {
  deltaBuffer,
  compressPayload,
  brotliDecompressAsync,
  udpSendAsync as _udpSendAsyncShared
} from "./pipeline-utils";
import {
  MAX_SAFE_UDP_PAYLOAD,
  MAX_DECOMPRESSED_SIZE,
  MAX_DELTAS_PER_PACKET,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch
} from "./constants";
import type { SignalKApp, MetricsApi, InstanceState, Delta } from "./types";

/**
 * Creates the data processing pipeline (compress, encrypt, send / receive, decrypt, decompress).
 * @param app - SignalK app object (for logging)
 * @param state - Shared mutable state (options, socketUdp, batching vars, lastPacketTime)
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API: { packCrypt, unpackDecrypt }
 */
function createPipeline(
  app: SignalKApp,
  state: InstanceState,
  metricsApi: MetricsApi
): {
  packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    udpAddress: string,
    udpPort: number
  ): Promise<void>;
  unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
} {
  const { metrics, recordError, trackPathStats } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});

  /**
   * Compresses, encrypts, and sends delta data via UDP.
   * Pipeline: Serialize -> Compress -> Encrypt (AES-256-GCM) -> Send
   */
  async function packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    udpAddress: string,
    udpPort: number
  ): Promise<void> {
    try {
      // Guard against calls after plugin stop
      if (!state.options) {
        app.debug("packCrypt called but plugin is stopped, ignoring");
        return;
      }

      // Apply path dictionary encoding if enabled
      const processedDelta = state.options.usePathDictionary
        ? Array.isArray(delta)
          ? delta.map(encodeDelta)
          : encodeDelta(delta)
        : delta;

      // Serialize to buffer (JSON or MessagePack)
      const serialized = deltaBuffer(processedDelta, state.options.useMsgpack);

      // Track raw bytes for compression ratio calculation
      metrics.bandwidth.bytesOutRaw += serialized.length;

      // Track path stats AFTER serialization (reuse size for efficiency)
      if (Array.isArray(delta)) {
        delta.forEach((d) => trackPathStats(d, serialized.length / delta.length));
      } else {
        trackPathStats(delta, serialized.length);
      }

      // Single compression stage (before encryption)
      const compressed = await compressPayload(serialized, state.options.useMsgpack || false);

      // Encrypt with AES-256-GCM (binary format with built-in authentication)
      const packet = encryptBinary(compressed, secretKey);

      // Check for MTU issues
      if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
        app.debug(
          `Warning: Packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment. ` +
            "Consider reducing delta timer interval or filtering paths."
        );
        metrics.smartBatching.oversizedPackets++;
      }

      // Track bandwidth
      metrics.bandwidth.bytesOut += packet.length;
      metrics.bandwidth.packetsOut++;

      // Send packet
      await udpSendAsync(packet, udpAddress, udpPort);
      metrics.deltasSent++;

      // Update smart batching model after successful send
      const deltaCount = Array.isArray(delta) ? Math.max(delta.length, 1) : 1;
      const bytesPerDelta = packet.length / deltaCount;

      // Update rolling average using exponential smoothing
      state.avgBytesPerDelta =
        (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta +
        SMART_BATCH_SMOOTHING * bytesPerDelta;

      // Recalculate max deltas for next batch based on updated average
      state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

      // Update metrics for monitoring
      metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
      metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

      app.debug(
        `Smart batch: ${deltaCount} deltas, ${packet.length} bytes (${bytesPerDelta.toFixed(0)} bytes/delta), ` +
          `avg=${state.avgBytesPerDelta.toFixed(0)}, nextMaxDeltas=${state.maxDeltasPerBatch}`
      );

      // Update last packet time for hello message suppression
      state.lastPacketTime = Date.now();
    } catch (error: any) {
      const msg = error.message || "";
      const code = error.code || "";
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
  }

  /**
   * Decompresses, decrypts, and processes received UDP data.
   * Pipeline: Receive -> Decrypt (AES-256-GCM) -> Decompress -> Parse -> Process
   */
  async function unpackDecrypt(packet: Buffer, secretKey: string): Promise<void> {
    try {
      // Guard against calls after plugin stop
      if (!state.options) {
        app.debug("unpackDecrypt called but plugin is stopped, ignoring");
        return;
      }

      // Track incoming bandwidth
      metrics.bandwidth.bytesIn += packet.length;
      metrics.bandwidth.packetsIn++;

      // Decrypt with AES-256-GCM (authentication is verified automatically)
      const decrypted = decryptBinary(packet, secretKey);

      // Decompress (single decompression stage, capped to prevent decompression bombs)
      const decompressed = (await brotliDecompressAsync(decrypted, {
        maxOutputLength: MAX_DECOMPRESSED_SIZE
      })) as Buffer;

      // Track raw bytes
      metrics.bandwidth.bytesInRaw += decompressed.length;

      // Parse content (JSON or MessagePack)
      let jsonContent: unknown;
      if (state.options.useMsgpack) {
        try {
          jsonContent = msgpack.decode(decompressed);
        } catch (msgpackErr) {
          // Fallback to JSON if MessagePack fails
          jsonContent = JSON.parse(decompressed.toString());
        }
      } else {
        jsonContent = JSON.parse(decompressed.toString());
      }

      // Validate parsed content is an object or array
      if (jsonContent === null || typeof jsonContent !== "object") {
        app.error("Received non-object payload, skipping");
        recordError("general", "Received non-object payload");
        return;
      }

      // Process deltas: payload may be an Array of deltas or an indexed object.
      const deltas = Array.isArray(jsonContent)
        ? (jsonContent as Delta[])
        : Object.values(jsonContent as Record<string, Delta>);
      const deltaCount = Math.min(deltas.length, MAX_DELTAS_PER_PACKET);

      if (deltas.length > MAX_DELTAS_PER_PACKET) {
        app.error(
          `Received ${deltas.length} deltas in one packet (limit ${MAX_DELTAS_PER_PACKET}), truncating`
        );
      }

      for (let i = 0; i < deltaCount; i++) {
        let deltaMessage: Delta | null = deltas[i];

        // Skip null or undefined delta messages
        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`Skipping null delta message at index ${i}`);
          continue;
        }

        // Decode path dictionary IDs
        deltaMessage = decodeDelta(deltaMessage);

        // Skip if decoding returned null
        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`Skipping null delta message after decoding at index ${i}`);
          continue;
        }

        // Track path stats for server-side analytics
        trackPathStats(deltaMessage, decompressed.length / deltaCount);

        app.handleMessage("", deltaMessage);
        app.debug(JSON.stringify(deltaMessage, null, 2));
        metrics.deltasReceived++;
      }
    } catch (error: any) {
      const msg = error.message || "";
      const code = error.code || "";
      if (
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
  }

  /**
   * Sends a message via UDP with retry logic (delegates to shared utility)
   */
  function udpSendAsync(message: Buffer, host: string, port: number): Promise<void> {
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

  return { packCrypt, unpackDecrypt };
}

export = createPipeline;
