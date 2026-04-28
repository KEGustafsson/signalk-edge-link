"use strict";

import * as msgpack from "@msgpack/msgpack";
import { encryptBinary, decryptBinary } from "./crypto";
import { encodeDelta, decodeDelta, encodeMetaEntry, decodeMetaEntry } from "./pathDictionary";
import { sanitizeDeltaForSignalK } from "./delta-sanitizer";
import { handleMessageBySource, normalizeDeltaSourceRefs } from "./source-dispatch";
import {
  deltaBuffer,
  compressPayload,
  brotliDecompressAsync,
  udpSendAsync as _udpSendAsyncShared
} from "./pipeline-utils";
import {
  MAX_SAFE_UDP_PAYLOAD,
  MAX_DECOMPRESSED_SIZE,
  MAX_PARSE_PAYLOAD_SIZE,
  MAX_DELTAS_PER_PACKET,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch
} from "./constants";
import { splitIntoPackets, buildMetaEnvelope } from "./metadata";
import type { SignalKApp, MetricsApi, InstanceState, Delta, MetaEntry } from "./types";

/** Leading magic that distinguishes v1 meta payloads from v1 deltas, placed
 *  inside the encrypted plaintext so existing v1 receivers (which do not
 *  recognise it) simply reject the packet rather than misinterpreting it. */
const V1_META_MAGIC = Buffer.from("SKM1", "ascii");

/** Threshold for v1 sender-restart detection — see the v2 server's
 *  META_RESTART_THRESHOLD comment. envSeq=0 is treated as a restart only when
 *  the last accepted seq has moved beyond this small reorder window. */
const META_RESTART_THRESHOLD_V1 = 8;

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
  packCryptMeta(
    entries: MetaEntry[],
    kind: "snapshot" | "diff",
    secretKey: string,
    udpAddress: string,
    udpMetaPort: number
  ): Promise<void>;
  unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
  unpackDecryptMeta(msg: Buffer, secretKey: string): Promise<void>;
} {
  const { metrics, recordError, trackPathStats } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});
  let metaEnvelopeSeqV1 = 0;
  // Last accepted inner-envelope seq on the receive side. v1 has no
  // per-session concept (one socket per pipeline instance), so a single
  // closure variable is sufficient. Used to drop stale/duplicate envelopes
  // that UDP reorders or replays.
  let lastIngestedMetaEnvSeqV1: number | null = null;

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
      const packet = encryptBinary(compressed, secretKey, {
        stretchAsciiKey: !!state.options.stretchAsciiKey
      });

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
    } catch (error: unknown) {
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
  }

  /**
   * Sends Signal K path metadata to the receiver using the v1 wire format on a
   * separate UDP port.
   *
   * v1 has no packet-type byte so we cannot multiplex meta with deltas on the
   * existing port without breaking every deployed v1 receiver. To keep the
   * change backward-compatible, meta is sent on `udpMetaPort` with a 4-byte
   * `SKM1` magic prefix inside the encrypted plaintext — a v1 receiver that
   * has not been upgraded will fail to JSON-parse the payload and simply drop
   * it without side effects.
   */
  async function packCryptMeta(
    entries: MetaEntry[],
    kind: "snapshot" | "diff",
    secretKey: string,
    udpAddress: string,
    udpMetaPort: number
  ): Promise<void> {
    try {
      if (!state.options) {
        app.debug("packCryptMeta called but plugin is stopped, ignoring");
        return;
      }
      if (!udpMetaPort || udpMetaPort <= 0) {
        app.debug("packCryptMeta: no udpMetaPort configured, meta disabled on v1");
        return;
      }
      if (entries.length === 0) {
        return;
      }

      const usePathDict = !!state.options.usePathDictionary;
      const useMsgpack = !!state.options.useMsgpack;
      const maxPerPacket = state.metaConfig?.maxPathsPerPacket ?? 500;
      const chunks = splitIntoPackets(entries, maxPerPacket);
      const envelopeSeq = metaEnvelopeSeqV1++ >>> 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const processed = usePathDict ? chunk.map(encodeMetaEntry) : chunk;
        const envelope = buildMetaEnvelope(processed, kind, envelopeSeq, i, chunks.length);
        const serialized = deltaBuffer(envelope, useMsgpack);
        const withMagic = Buffer.concat([V1_META_MAGIC, serialized]);
        const compressed = await compressPayload(withMagic, useMsgpack);
        const packet = encryptBinary(compressed, secretKey, {
          stretchAsciiKey: !!state.options.stretchAsciiKey
        });

        if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
          app.debug(
            `Warning: v1 meta packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD})`
          );
        }

        await udpSendAsync(packet, udpAddress, udpMetaPort);

        metrics.bandwidth.metaBytesOut = (metrics.bandwidth.metaBytesOut || 0) + packet.length;
        metrics.bandwidth.metaPacketsOut = (metrics.bandwidth.metaPacketsOut || 0) + 1;
        metrics.bandwidth.bytesOut += packet.length;
        metrics.bandwidth.packetsOut++;
      }

      if (kind === "snapshot") {
        metrics.bandwidth.metaSnapshotsSent = (metrics.bandwidth.metaSnapshotsSent || 0) + 1;
      } else {
        metrics.bandwidth.metaDiffsSent = (metrics.bandwidth.metaDiffsSent || 0) + 1;
      }

      app.debug(
        `v1 meta sent: kind=${kind}, entries=${entries.length}, chunks=${chunks.length}, envSeq=${envelopeSeq}`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      app.error(`packCryptMeta error: ${msg}`);
      recordError("general", `packCryptMeta error: ${msg}`);
      // Re-throw so the caller (sendMetaEntries) can tell the send failed
      // and refrain from committing the MetaCache. Without this, a broken
      // socket/encryption/compression would silently suppress every future
      // diff for the affected paths.
      throw error instanceof Error ? error : new Error(msg);
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
      const decrypted = decryptBinary(packet, secretKey, {
        stretchAsciiKey: !!state.options.stretchAsciiKey
      });

      // Decompress (single decompression stage, capped to prevent decompression bombs)
      const decompressed = (await brotliDecompressAsync(decrypted, {
        maxOutputLength: MAX_DECOMPRESSED_SIZE
      })) as Buffer;

      // Track raw bytes
      metrics.bandwidth.bytesInRaw += decompressed.length;

      // Reject payloads that exceed the safe parse limit to prevent DoS via
      // deeply-nested JSON objects that fit within the decompression cap but
      // still cause multi-second parse stalls.
      if (decompressed.length > MAX_PARSE_PAYLOAD_SIZE) {
        app.error(
          `Received decompressed payload too large to parse: ${decompressed.length} bytes ` +
            `(limit ${MAX_PARSE_PAYLOAD_SIZE})`
        );
        recordError(
          "general",
          `Payload too large to parse: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
        );
        return;
      }

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

        deltaMessage = sanitizeDeltaForSignalK(deltaMessage);
        if (deltaMessage === null) {
          app.debug(`Skipping delta with no valid Signal K values at index ${i}`);
          continue;
        }
        deltaMessage = normalizeDeltaSourceRefs(deltaMessage);

        // Track path stats for server-side analytics
        trackPathStats(deltaMessage, decompressed.length / deltas.length);

        handleMessageBySource(app, deltaMessage);
        // Log a compact summary only — never log full delta values which may
        // contain sensitive data (position, fuel, MMSI) in plaintext logs.
        app.debug(
          `delta ctx=${deltaMessage.context ?? "?"} updates=${Array.isArray(deltaMessage.updates) ? deltaMessage.updates.length : 0}`
        );
        metrics.deltasReceived++;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
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

  /**
   * Receive-side counterpart to `packCryptMeta` for v1. Decrypts a packet
   * arrived on `udpMetaPort`, verifies the 4-byte `SKM1` magic inside the
   * plaintext (packets without the magic are dropped — v1 has no packet-type
   * byte, so the magic is the only signal that this is a meta payload and not
   * a corrupted delta), and dispatches each entry as a minimal Signal K delta
   * with `updates[].meta[]` via `app.handleMessage`.
   */
  async function unpackDecryptMeta(packet: Buffer, secretKey: string): Promise<void> {
    try {
      if (!state.options) {
        app.debug("unpackDecryptMeta called but plugin is stopped, ignoring");
        return;
      }

      // Bump bytesIn/packetsIn AND the meta-scoped counters at the same
      // gate — any packet that reached this code is a meta packet (the
      // separate udpMetaPort ensures that), so bytesIn should always equal
      // metaBytesIn for this pipeline path. Keeping them in lockstep lets
      // consumers cross-check: bytesIn === dataBytesIn + metaBytesIn.
      metrics.bandwidth.bytesIn += packet.length;
      metrics.bandwidth.packetsIn++;
      metrics.bandwidth.metaBytesIn = (metrics.bandwidth.metaBytesIn || 0) + packet.length;
      metrics.bandwidth.metaPacketsIn = (metrics.bandwidth.metaPacketsIn || 0) + 1;

      const decrypted = decryptBinary(packet, secretKey, {
        stretchAsciiKey: !!state.options.stretchAsciiKey
      });
      const decompressed = (await brotliDecompressAsync(decrypted, {
        maxOutputLength: MAX_DECOMPRESSED_SIZE
      })) as Buffer;

      if (decompressed.length < V1_META_MAGIC.length) {
        app.debug("v1 meta: decompressed payload too short, ignoring");
        return;
      }

      // Reject anything that isn't prefixed with the SKM1 magic so a stray
      // non-meta packet on the meta port (misconfiguration, replay, attacker)
      // cannot be misinterpreted. The magic lives INSIDE the encrypted
      // plaintext, so this check is authenticated.
      if (decompressed.subarray(0, V1_META_MAGIC.length).compare(V1_META_MAGIC) !== 0) {
        app.debug("v1 meta: missing SKM1 magic, dropping");
        return;
      }

      const body = decompressed.subarray(V1_META_MAGIC.length);
      if (body.length > MAX_PARSE_PAYLOAD_SIZE) {
        app.error(`v1 meta: payload too large to parse: ${body.length} bytes`);
        return;
      }

      let content: unknown;
      if (state.options.useMsgpack) {
        try {
          content = msgpack.decode(body);
        } catch {
          content = JSON.parse(body.toString());
        }
      } else {
        content = JSON.parse(body.toString());
      }

      if (!content || typeof content !== "object" || Array.isArray(content)) {
        app.debug("v1 meta: envelope was not an object, dropping");
        return;
      }
      const env = content as {
        entries?: Array<{
          context?: string;
          path?: string | number;
          meta?: Record<string, unknown>;
        }>;
        kind?: string;
        seq?: number;
      };
      if (!Array.isArray(env.entries) || env.entries.length === 0) {
        return;
      }

      // Drop stale/duplicate envelopes. The inner envelope `seq` is shared
      // across all chunks of the same batch, so equal-seq chunks are still
      // accepted; only earlier batches are rejected. Uint32-wrap aware so a
      // long-running sender's wrap doesn't trigger mass-rejection.
      //
      // Sender-restart detection: the v1 client's meta envelope counter
      // initialises to 0 at process start. Treat envSeq=0 as a peer restart
      // only once lastIngestedMetaEnvSeqV1 has advanced beyond a small
      // reorder window — below the threshold, envSeq=0 is ambiguous with
      // first-packet replay and falls through to normal dedup.
      if (typeof env.seq === "number" && Number.isFinite(env.seq)) {
        const envSeq = env.seq >>> 0;
        if (
          lastIngestedMetaEnvSeqV1 !== null &&
          envSeq === 0 &&
          lastIngestedMetaEnvSeqV1 >= META_RESTART_THRESHOLD_V1
        ) {
          app.debug(
            `v1 meta: sender restart detected (last seq was ${lastIngestedMetaEnvSeqV1}); resetting`
          );
          lastIngestedMetaEnvSeqV1 = null;
        }
        if (lastIngestedMetaEnvSeqV1 !== null) {
          const distance = (envSeq - lastIngestedMetaEnvSeqV1) >>> 0;
          if (distance !== 0 && distance >= 0x80000000) {
            app.debug(
              `v1 meta: stale envelope seq=${envSeq} (last=${lastIngestedMetaEnvSeqV1}), dropping`
            );
            return;
          }
          if (distance !== 0) {
            lastIngestedMetaEnvSeqV1 = envSeq;
          }
        } else {
          lastIngestedMetaEnvSeqV1 = envSeq;
        }
      }

      const nowIso = new Date().toISOString();
      const usePathDict = !!state.options.usePathDictionary;
      for (const rawEntry of env.entries) {
        if (!rawEntry || typeof rawEntry.meta !== "object" || !rawEntry.meta) {
          continue;
        }
        const entry = usePathDict
          ? decodeMetaEntry(rawEntry as { path: string | number; meta: Record<string, unknown> })
          : rawEntry;
        const path = typeof entry.path === "string" ? entry.path : String(entry.path ?? "");
        if (!path) {
          continue;
        }
        const context = typeof rawEntry.context === "string" ? rawEntry.context : "vessels.self";
        const delta: Delta = {
          context,
          updates: [
            {
              timestamp: nowIso,
              values: [],
              meta: [{ path, value: entry.meta as Record<string, unknown> }]
            } as Delta["updates"][number]
          ]
        };
        app.handleMessage("", delta);
      }

      app.debug(`v1 meta received: kind=${env.kind ?? "?"}, entries=${env.entries.length}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      app.error(`unpackDecryptMeta error: ${msg}`);
      recordError("general", `unpackDecryptMeta error: ${msg}`);
    }
  }

  return { packCrypt, packCryptMeta, unpackDecrypt, unpackDecryptMeta };
}

export = createPipeline;
