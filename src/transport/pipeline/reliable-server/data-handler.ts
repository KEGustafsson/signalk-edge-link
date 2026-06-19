"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: DATA packet handling
 *
 * Decrypt → decompress → sequence-track → decode → dispatch for DATA (0x05)
 * packets, including per-session rate limiting, duplicate-ACK reflection, and
 * packet-loss window accounting.
 *
 * @module transport/pipeline/reliable-server/data-handler
 */

import { promisify } from "util";
import zlib from "node:zlib";
import * as msgpack from "@msgpack/msgpack";
import { decryptBinary } from "../../../codec/crypto";
import { decodeDelta } from "../../../codec/path-dictionary";
import { sanitizeDeltaForSignalK } from "../../../codec/delta-sanitizer";
import { createValueDedupState, undedupDelta } from "../../../codec/value-dedup";
import { isCompactDeltaArray, decodeCompactDeltaArray } from "../../../codec/compact-delta";
import { handleMessageBySource, normalizeDeltaSourceRefs } from "../../../codec/source-dispatch";
import { ParsedPacket } from "../../../codec/packet-codec";
import { getOrCreateSession, sendUDP, sendFullStatusRequest } from "./sessions";
import { ingestRemoteTelemetry } from "./telemetry";
import type { ServerContext, ClientSession } from "./context";
import type { Delta } from "../../../foundation/types";

import {
  MAX_DECOMPRESSED_SIZE,
  MAX_PARSE_PAYLOAD_SIZE,
  MAX_DELTAS_PER_PACKET,
  UDP_RATE_LIMIT_WINDOW,
  UDP_RATE_LIMIT_MAX_PACKETS
} from "../../../foundation/constants";

import { preAuthRateLimited } from "./context";

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

function isAhead(seq: number, reference: number): boolean {
  const distance = (seq - reference) >>> 0;
  return distance !== 0 && distance < 0x80000000;
}

/**
 * Rate-limit a DATA packet before the (relatively expensive) decrypt. Returns
 * true when the packet should be dropped. An established session uses its own
 * per-session limiter; a new peer uses the per-IP pre-auth limiter.
 */
function dataRateLimited(
  ctx: ServerContext,
  existingDataSession: ClientSession | null,
  rinfo?: { address: string; port: number }
): boolean {
  const { app, metrics } = ctx;
  if (existingDataSession) {
    const now = Date.now();
    if (now - existingDataSession.rateLimitWindowStart >= UDP_RATE_LIMIT_WINDOW) {
      existingDataSession.rateLimitCount = 0;
      existingDataSession.rateLimitWindowStart = now;
    }
    existingDataSession.rateLimitCount++;
    if (existingDataSession.rateLimitCount > UDP_RATE_LIMIT_MAX_PACKETS) {
      metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
      app.debug(
        `[v2-server] rate limited ${existingDataSession.key}: ${existingDataSession.rateLimitCount} packets in window`
      );
      return true;
    }
  } else if (rinfo && preAuthRateLimited(ctx, rinfo.address)) {
    metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
    return true;
  }
  return false;
}

/**
 * Send an immediate ACK in response to a duplicate DATA packet so the client
 * stops retransmitting without waiting for the next periodic ACK tick.
 */
async function ackDuplicate(
  ctx: ServerContext,
  session: ClientSession,
  rinfo: { address: string; port: number }
): Promise<void> {
  const { app, metrics, packetBuilder } = ctx;
  const currentExpected = session.sequenceTracker.expectedSeq! >>> 0;
  const ackSeq = (currentExpected - 1) >>> 0;
  try {
    const ackPacket = packetBuilder.buildACKPacket(ackSeq);
    await sendUDP(ctx, ackPacket, { address: rinfo.address, port: rinfo.port });
    session.lastAckSeq = ackSeq;
    session.lastAckSentAt = Date.now();
    metrics.acksSent = (metrics.acksSent ?? 0) + 1;
    app.debug(`Sent immediate ACK on duplicate to ${session.key}: seq=${ackSeq}`);
  } catch (ackErr: unknown) {
    app.error(
      `Failed to send immediate ACK to ${session.key}: ${ackErr instanceof Error ? ackErr.message : String(ackErr)}`
    );
  }
}

/** Update a session's packet-loss window for a freshly-accepted DATA seq. */
function updateLossWindow(
  ctx: ServerContext,
  session: ClientSession,
  dataSeq: number,
  resynced: boolean
): void {
  if (resynced || session.lossBaseSeq === null) {
    session.lossBaseSeq = dataSeq;
    session.lossHighestSeq = dataSeq;
    session.lossReceivedCount = 1;
    session.lastLossExpected = 0;
    session.lastLossReceived = 0;
    ctx.app.debug(`v2 sequence resync at seq=${dataSeq} for ${session.key}`);
  } else {
    session.lossReceivedCount++;
    if (isAhead(dataSeq, session.lossHighestSeq ?? 0)) {
      session.lossHighestSeq = dataSeq;
    }
  }
}

/** Decode the decompressed DATA payload into an array of deltas. */
function decodeDeltas(ctx: ServerContext, jsonContent: unknown): Delta[] {
  if (isCompactDeltaArray(jsonContent)) {
    return decodeCompactDeltaArray(jsonContent);
  }
  if (Array.isArray(jsonContent)) {
    return jsonContent as Delta[];
  }
  if (Array.isArray((jsonContent as Delta).updates)) {
    return [jsonContent as Delta];
  }
  return Object.values(jsonContent as Record<string, Delta>);
}

/** Upsert a delta into the source registry under a stable source-client id. */
function upsertSourceRegistry(
  ctx: ServerContext,
  deltaMessage: Delta,
  session: ClientSession | null
): void {
  const { state } = ctx;
  if (!state.sourceRegistry || typeof state.sourceRegistry.upsertFromDelta !== "function") {
    return;
  }
  const deltaRecord = deltaMessage as unknown as Record<string, unknown>;
  const deltaSourceInstanceId =
    typeof deltaRecord.sourceClientInstanceId === "string"
      ? (deltaRecord.sourceClientInstanceId as string) || null
      : null;
  const stableSourceClientId =
    (session && (session.sourceClientInstanceId || session.clientId)) ||
    deltaSourceInstanceId ||
    "unknown";
  state.sourceRegistry.upsertFromDelta(deltaMessage, stableSourceClientId);
}

/** Process a single decoded delta: dedup-expand, sanitize, ingest, dispatch. */
function processDelta(
  ctx: ServerContext,
  rawDelta: Delta,
  index: number,
  session: ClientSession | null,
  decompressedLength: number,
  totalDeltas: number
): void {
  const { app, trackPathStats, metrics } = ctx;
  let deltaMessage: Delta | null | undefined = rawDelta;

  if (deltaMessage === null || deltaMessage === undefined) {
    app.debug(`v2 skipping null delta at index ${index}`);
    return;
  }

  deltaMessage = decodeDelta(deltaMessage);

  if (deltaMessage === null || deltaMessage === undefined) {
    app.debug(`v2 skipping null delta after decoding at index ${index}`);
    return;
  }

  // Expand same-as-last sentinels using the per-session cache.
  if (session) {
    if (!session.valueDedupState) {
      session.valueDedupState = createValueDedupState();
    }
    deltaMessage = undedupDelta(deltaMessage, session.valueDedupState);
  }

  const sanitizedDelta = sanitizeDeltaForSignalK(deltaMessage);
  if (sanitizedDelta === null) {
    app.debug(`v2 skipping delta with no valid Signal K values at index ${index}`);
    return;
  }
  deltaMessage = sanitizedDelta;
  deltaMessage = normalizeDeltaSourceRefs(deltaMessage);

  ingestRemoteTelemetry(ctx, deltaMessage, session);
  if (!Array.isArray(deltaMessage.updates) || deltaMessage.updates.length === 0) {
    return;
  }
  upsertSourceRegistry(ctx, deltaMessage, session);

  trackPathStats(deltaMessage, decompressedLength / totalDeltas);

  handleMessageBySource(app, deltaMessage);
  metrics.deltasReceived++;
}

/**
 * Sequence-track an authenticated DATA packet. Returns false (stop) for a
 * duplicate (after reflecting an immediate ACK); otherwise records the accepted
 * packet's bookkeeping (counters, full-status trigger, loss window) and returns
 * true to continue with payload processing.
 */
async function trackDataSequence(
  ctx: ServerContext,
  session: ClientSession | null,
  parsed: ParsedPacket,
  secretKey: string,
  rinfo?: { address: string; port: number }
): Promise<boolean> {
  const { app, state, metrics } = ctx;
  const seqResult = session
    ? session.sequenceTracker.processSequence(parsed.sequence)
    : { duplicate: false, resynced: false };

  if (seqResult.duplicate) {
    app.debug(`v2 duplicate packet: seq=${parsed.sequence}`);
    metrics.duplicatePackets = (metrics.duplicatePackets ?? 0) + 1;
    if (session && session.sequenceTracker.expectedSeq !== null && rinfo) {
      await ackDuplicate(ctx, session, rinfo);
    }
    return false;
  }

  // Count valid DATA packets for accurate packet loss calculation
  metrics.dataPacketsReceived = (metrics.dataPacketsReceived ?? 0) + 1;
  if (session) {
    session.hasReceivedData = true;
  }
  // On first DATA from a new session, request full-status replay if enabled.
  if (session && !session.statusRequested && state.options?.requestFullStatusOnRestart) {
    session.statusRequested = true;
    sendFullStatusRequest(ctx, session, secretKey).catch((err: unknown) => {
      app.debug(
        `[v2-server] FULL_STATUS_REQUEST (data trigger) send failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
  if (session) {
    updateLossWindow(ctx, session, parsed.sequence >>> 0, seqResult.resynced);
  }
  return true;
}

/**
 * Parse a decompressed DATA payload (MessagePack with JSON fallback, or JSON).
 * Returns null (after recording the error) when the payload is too large or is
 * not an object/array.
 */
function parsePayloadContent(
  ctx: ServerContext,
  decompressed: Buffer,
  parsed: ParsedPacket
): unknown | null {
  const { app, recordError } = ctx;
  // Reject payloads that exceed the safe parse limit to prevent DoS.
  if (decompressed.length > MAX_PARSE_PAYLOAD_SIZE) {
    app.error(
      `[v2] Received decompressed payload too large to parse: ${decompressed.length} bytes ` +
        `(limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    recordError(
      "general",
      `[v2] Payload too large to parse: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    return null;
  }

  let jsonContent: unknown;
  if (parsed.flags.messagepack) {
    try {
      jsonContent = msgpack.decode(decompressed);
    } catch (msgpackErr: unknown) {
      app.debug(
        `MessagePack decode failed (${msgpackErr instanceof Error ? msgpackErr.message : String(msgpackErr)}), falling back to JSON`
      );
      jsonContent = JSON.parse(decompressed.toString());
    }
  } else {
    jsonContent = JSON.parse(decompressed.toString());
  }

  if (jsonContent === null || typeof jsonContent !== "object") {
    app.error("v2 received non-object payload, skipping");
    recordError("general", "v2 received non-object payload");
    return null;
  }
  return jsonContent;
}

/** Decode the payload into deltas (capped) and dispatch each one. */
function decodeAndDispatchPayload(
  ctx: ServerContext,
  decompressed: Buffer,
  session: ClientSession | null,
  packet: Buffer,
  parsed: ParsedPacket
): void {
  const { app } = ctx;
  const jsonContent = parsePayloadContent(ctx, decompressed, parsed);
  if (jsonContent === null) {
    return;
  }

  // Process deltas: payload may be compact-encoded, a plain Array, a bare
  // Delta, or an indexed object.
  const deltas = decodeDeltas(ctx, jsonContent);
  const deltaCount = Math.min(deltas.length, MAX_DELTAS_PER_PACKET);

  if (deltas.length > MAX_DELTAS_PER_PACKET) {
    app.error(
      `v2 received ${deltas.length} deltas in one packet (limit ${MAX_DELTAS_PER_PACKET}), truncating`
    );
  }

  for (let i = 0; i < deltaCount; i++) {
    processDelta(ctx, deltas[i], i, session, decompressed.length, deltas.length);
  }

  app.debug(`v2 received: seq=${parsed.sequence}, ${deltaCount} deltas, ${packet.length} bytes`);
}

/**
 * Handle a DATA (0x05) packet. Mirrors the original `receivePacket` DATA branch
 * exactly. Caller has already validated version / authenticatedHeaders.
 */
export async function handleDataPacket(
  ctx: ServerContext,
  packet: Buffer,
  parsed: ParsedPacket,
  secretKey: string,
  rinfo?: { address: string; port: number }
): Promise<void> {
  const { metrics, stretchAsciiKey, clientSessions } = ctx;

  // DATA packet. AES-GCM payload decryption is the first hard authentication
  // boundary, so rate-limit and decrypt BEFORE allocating a session.
  const existingDataSession = rinfo
    ? (clientSessions.get(`${rinfo.address}:${rinfo.port}`) ?? null)
    : null;
  if (dataRateLimited(ctx, existingDataSession, rinfo)) {
    return;
  }

  // Decrypt (authenticates the payload via AES-GCM; throws on bad tag)
  const decrypted = decryptBinary(parsed.payload, secretKey, { stretchAsciiKey });

  // Decompress (capped to prevent decompression bombs)
  const decompressed = await brotliDecompressAsync(decrypted, {
    maxOutputLength: MAX_DECOMPRESSED_SIZE
  });

  metrics.bandwidth.bytesInRaw += decompressed.length;

  // Payload authenticated: only now allocate the session and touch
  // sequence/NAK/loss state.
  const session = rinfo ? getOrCreateSession(ctx, rinfo) : null;
  if (rinfo && !session) {
    // Over per-IP session cap: drop after auth without creating state.
    return;
  }
  // Seed the per-session rate limiter for a freshly-created session.
  if (session && !existingDataSession) {
    session.rateLimitCount = 1;
    session.rateLimitWindowStart = Date.now();
  }

  if (!(await trackDataSequence(ctx, session, parsed, secretKey, rinfo))) {
    return;
  }

  decodeAndDispatchPayload(ctx, decompressed, session, packet, parsed);
}
