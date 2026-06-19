"use strict";

/**
 * Signal K Edge Link - reliable client source snapshot sender.
 *
 * Extracted from the reliable client factory: source-patch flatten/merge helpers,
 * MTU-aware chunking, and `sendSourceSnapshot`.
 *
 * @module transport/pipeline/reliable-client/source-snapshot
 */

import { encryptBinary } from "../../../codec/crypto";
import { deltaBuffer, compressPayload } from "../../../codec/compression";
import {
  MAX_SAFE_UDP_PAYLOAD,
  SOURCE_SNAPSHOT_COMPRESSION_BUDGET_FACTOR
} from "../../../foundation/constants";
import type { SourceSnapshotEnvelope } from "../../../foundation/types";
import type { ClientContext } from "./context";
import { udpSendAsync } from "./lifecycle";
import { recordSentMetadataPacket } from "./metadata-sender";

function isSourceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeSourcePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isSourceRecord(current) && isSourceRecord(value)) {
      mergeSourcePatch(current, value);
    } else {
      target[key] = value;
    }
  }
}

function buildSourcePatch(path: string[], value: unknown): Record<string, unknown> {
  let patch: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) {
    patch = { [path[i]]: patch };
  }
  return patch as Record<string, unknown>;
}

function flattenSourcePatches(value: unknown, path: string[] = []): Array<Record<string, unknown>> {
  if (!isSourceRecord(value)) {
    return path.length > 0 ? [buildSourcePatch(path, value)] : [];
  }

  const entries = Object.entries(value);
  if (path.length > 0 && entries.length === 0) {
    return [buildSourcePatch(path, {})];
  }

  const patches: Array<Record<string, unknown>> = [];
  for (const [key, entry] of entries) {
    patches.push(...flattenSourcePatches(entry, path.concat(key)));
  }
  return patches;
}

function buildSourceChunk(patches: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const patch of patches) {
    mergeSourcePatch(out, patch);
  }
  return out;
}

async function buildSourceSnapshotPacket(
  ctx: ClientContext,
  sources: Record<string, unknown>,
  envelopeSeq: number,
  idx: number,
  total: number,
  useMsgpack: boolean,
  secretKey: string
): Promise<Buffer> {
  const envelope: SourceSnapshotEnvelope = {
    v: 1,
    kind: "sources",
    seq: envelopeSeq >>> 0,
    idx,
    total,
    sources
  };
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
    pathDictionary: false
  });
}

/**
 * Greedy-fill source patches into MTU-sized chunks. Uses a cheap per-patch
 * serialized size estimate, then verifies by building the real packet and
 * splitting any chunk that is actually over the MTU (single-patch chunks
 * cannot be split further, which guarantees termination).
 */
function packPatchesIntoChunks(
  sourcePatches: Array<Record<string, unknown>>,
  useMsgpack: boolean
): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let currentPatches: Array<Record<string, unknown>> = [];

  const UNCOMPRESSED_BUDGET = MAX_SAFE_UDP_PAYLOAD * SOURCE_SNAPSHOT_COMPRESSION_BUDGET_FACTOR;
  let runningSize = 0;
  for (const patch of sourcePatches) {
    const patchSize = deltaBuffer(patch, useMsgpack).length;
    if (currentPatches.length > 0 && runningSize + patchSize > UNCOMPRESSED_BUDGET) {
      chunks.push(currentPatches);
      currentPatches = [patch];
      runningSize = patchSize;
    } else {
      currentPatches.push(patch);
      runningSize += patchSize;
    }
  }

  if (currentPatches.length > 0) {
    chunks.push(currentPatches);
  }
  return chunks;
}

export async function chunkSourceSnapshot(
  ctx: ClientContext,
  sources: Record<string, unknown>,
  envelopeSeq: number,
  useMsgpack: boolean,
  secretKey: string
): Promise<Array<{ sources: Record<string, unknown>; packet: Buffer }>> {
  const sourcePatches = flattenSourcePatches(sources);
  let finalChunks = packPatchesIntoChunks(sourcePatches, useMsgpack);

  // Repeatedly rebuild packets, splitting any oversized multi-patch chunk in
  // half, until every chunk fits the safe UDP payload.
  for (;;) {
    const packets: Array<{ sources: Record<string, unknown>; packet: Buffer }> = [];
    let splitIndex = -1;

    for (let i = 0; i < finalChunks.length; i++) {
      const patchChunk = finalChunks[i];
      const sourceChunk = buildSourceChunk(patchChunk);
      const packet = await buildSourceSnapshotPacket(
        ctx,
        sourceChunk,
        envelopeSeq,
        i,
        finalChunks.length,
        useMsgpack,
        secretKey
      );
      packets.push({ sources: sourceChunk, packet });

      if (packet.length > MAX_SAFE_UDP_PAYLOAD && patchChunk.length > 1) {
        splitIndex = i;
        break;
      }
    }

    if (splitIndex === -1) {
      return packets;
    }

    const patchesToSplit = finalChunks[splitIndex];
    const midpoint = Math.ceil(patchesToSplit.length / 2);
    finalChunks = [
      ...finalChunks.slice(0, splitIndex),
      patchesToSplit.slice(0, midpoint),
      patchesToSplit.slice(midpoint),
      ...finalChunks.slice(splitIndex + 1)
    ];
  }
}

export async function sendSourceSnapshot(
  ctx: ClientContext,
  sources: Record<string, unknown>,
  secretKey: string,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, state, metricsApi } = ctx;
  const { metrics, recordError } = metricsApi;
  try {
    if (!state.options) {
      app.debug("sendSourceSnapshot called but plugin is stopped, ignoring");
      return;
    }
    if (!sources || Object.keys(sources).length === 0) {
      return;
    }

    const useMsgpack = !!state.options.useMsgpack;
    const envelopeSeq = ctx.mut.sourceEnvelopeSeq++ >>> 0;
    const chunks = await chunkSourceSnapshot(ctx, sources, envelopeSeq, useMsgpack, secretKey);

    for (const { packet } of chunks) {
      if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
        app.debug(
          `Warning: v2 source snapshot packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment.`
        );
        metrics.smartBatching.oversizedPackets++;
      }

      await udpSendAsync(ctx, packet, udpAddress, udpPort);
      recordSentMetadataPacket(ctx, packet, udpAddress, udpPort);
    }

    app.debug(
      `v2 source snapshot sent: sources=${Object.keys(sources).length}, chunks=${chunks.length}, envSeq=${envelopeSeq}`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    app.error(`v2 sendSourceSnapshot error: ${msg}`);
    recordError("general", `v2 sendSourceSnapshot error: ${msg}`);
    throw error;
  }
}
