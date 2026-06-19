"use strict";

/**
 * Signal K Edge Link - reliable client metadata sender.
 *
 * Extracted from the reliable client factory: `sendMetadata` and the shared
 * monitoring/metrics bookkeeping for sent META/source packets.
 *
 * @module transport/pipeline/reliable-client/metadata-sender
 */

import { encryptBinary } from "../../../codec/crypto";
import { encodeMetaEntry } from "../../../codec/path-dictionary";
import { deltaBuffer, compressPayload } from "../../../codec/compression";
import { splitIntoPackets, buildMetaEnvelope } from "../../../codec/metadata-codec";
import { MAX_SAFE_UDP_PAYLOAD } from "../../../foundation/constants";
import type { MetaEntry } from "../../../foundation/types";
import type { ClientContext } from "./context";
import { udpSendAsync } from "./lifecycle";

/** Record monitoring + bandwidth bookkeeping for a sent META/source packet. */
export function recordSentMetadataPacket(
  ctx: ClientContext,
  packet: Buffer,
  udpAddress: string,
  udpPort: number
): void {
  const { metricsApi } = ctx;
  const { metrics } = metricsApi;
  const monitoringHooks = ctx.mut.monitoringHooks;
  if (monitoringHooks) {
    const rinfo = { address: udpAddress, port: udpPort };
    if (monitoringHooks.packetCapture) {
      monitoringHooks.packetCapture.capture(packet, "send", rinfo);
    }
    if (monitoringHooks.packetInspector) {
      monitoringHooks.packetInspector.inspect(packet, "send", rinfo);
    }
  }

  metrics.bandwidth.metaBytesOut = (metrics.bandwidth.metaBytesOut || 0) + packet.length;
  metrics.bandwidth.metaPacketsOut = (metrics.bandwidth.metaPacketsOut || 0) + 1;
  metrics.bandwidth.bytesOut += packet.length;
  metrics.bandwidth.packetsOut++;
}

/** Build, compress, encrypt and frame a single META envelope chunk. */
async function buildMetaPacket(
  ctx: ClientContext,
  entries: MetaEntry[],
  kind: "snapshot" | "diff",
  envelopeSeq: number,
  idx: number,
  total: number,
  usePathDict: boolean,
  useMsgpack: boolean,
  secretKey: string
): Promise<Buffer> {
  const processedEntries = usePathDict ? entries.map(encodeMetaEntry) : entries;
  const envelope = buildMetaEnvelope(processedEntries, kind, envelopeSeq, idx, total);

  const serialized = deltaBuffer(envelope, useMsgpack);
  const compressed = await compressPayload(
    serialized,
    useMsgpack,
    ctx.state.options?.brotliQuality
  );
  const encrypted = encryptBinary(compressed, secretKey, { stretchAsciiKey: ctx.stretchAsciiKey });
  return ctx.packetBuilder.buildMetadataPacket(encrypted, {
    compressed: true,
    encrypted: true,
    messagepack: useMsgpack,
    pathDictionary: usePathDict
  });
}

/**
 * Send a batch of Signal K metadata entries to the receiver as one or more
 * METADATA (0x06) packets. Mirrors the compress → encrypt → packet-build
 * pipeline of `sendDelta` but uses a meta envelope so the receiver can
 * reconstruct multi-chunk snapshots.
 *
 * Snapshots are NOT inserted into the retransmit queue — eventual
 * consistency is provided by the periodic resend timer in instance.ts, and
 * the receiver can always request a fresh snapshot via META_REQUEST.
 */
export async function sendMetadata(
  ctx: ClientContext,
  entries: MetaEntry[],
  kind: "snapshot" | "diff",
  secretKey: string,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, state, metricsApi } = ctx;
  const { metrics, recordError } = metricsApi;
  try {
    if (!state.options) {
      app.debug("sendMetadata called but plugin is stopped, ignoring");
      return;
    }
    if (entries.length === 0) {
      return;
    }

    const maxPerPacket = state.metaConfig?.maxPathsPerPacket ?? 500;
    const chunks = splitIntoPackets(entries, maxPerPacket);
    const usePathDict = !!state.options.usePathDictionary;
    const useMsgpack = !!state.options.useMsgpack;

    // Assign one envelope seq per chunk group so the receiver can correlate
    // `idx/total` inside a single snapshot/diff operation.
    const envelopeSeq = ctx.mut.metaEnvelopeSeq++ >>> 0;

    for (let i = 0; i < chunks.length; i++) {
      const packet = await buildMetaPacket(
        ctx,
        chunks[i],
        kind,
        envelopeSeq,
        i,
        chunks.length,
        usePathDict,
        useMsgpack,
        secretKey
      );

      // Mirror sendDelta's MTU guard so oversized META packets are visible to
      // the same observability surfaces as DATA rather than fragmenting
      // silently.
      if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
        app.debug(
          `Warning: v2 meta packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment.`
        );
        metrics.smartBatching.oversizedPackets++;
      }

      await udpSendAsync(ctx, packet, udpAddress, udpPort);
      recordSentMetadataPacket(ctx, packet, udpAddress, udpPort);
    }

    // Count one envelope per call (a multi-chunk envelope is logically one
    // snapshot/diff, even though it shows up in metaPacketsOut as N).
    if (kind === "snapshot") {
      metrics.bandwidth.metaSnapshotsSent = (metrics.bandwidth.metaSnapshotsSent || 0) + 1;
    } else {
      metrics.bandwidth.metaDiffsSent = (metrics.bandwidth.metaDiffsSent || 0) + 1;
    }

    app.debug(
      `v2 meta sent: kind=${kind}, entries=${entries.length}, chunks=${chunks.length}, envSeq=${envelopeSeq}`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    app.error(`v2 sendMetadata error: ${msg}`);
    recordError("general", `v2 sendMetadata error: ${msg}`);
    // Re-throw so callers (e.g., sendMetaEntries in instance.ts) can
    // distinguish a successful send from a swallowed failure.
    throw error instanceof Error ? error : new Error(msg);
  }
}
