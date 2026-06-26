"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: session lifecycle + transport
 *
 * Session allocation/eviction/expiry, UDP send, and ACK/NAK emission helpers.
 *
 * @module transport/pipeline/reliable-server/sessions
 */

import { SequenceTracker } from "../../reliability/sequence";
import type { ServerContext, ClientSession } from "./context";

import { MAX_CLIENT_SESSIONS, MAX_NAK_SEQUENCES_PER_PACKET } from "../../../foundation/constants";

/**
 * Get or create a session object for the given rinfo.
 */
/** Evict the oldest session (by last-packet time) when the table is at capacity. */
function evictOldestSessionIfFull(ctx: ServerContext): void {
  const { app, clientSessions } = ctx;
  if (clientSessions.size < MAX_CLIENT_SESSIONS) {
    return;
  }
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [k, s] of clientSessions) {
    if (s.lastPacketTime < oldestTime) {
      oldestTime = s.lastPacketTime;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const evicted = clientSessions.get(oldestKey);
    if (evicted) {
      evicted.sequenceTracker.reset();
    }
    clientSessions.delete(oldestKey);
    app.error(`[v2-server] Session evicted (at capacity ${MAX_CLIENT_SESSIONS}): ${oldestKey}`);
  }
}

export function getOrCreateSession(
  ctx: ServerContext,
  rinfo: { address: string; port: number }
): ClientSession | null {
  const { app, metrics, clientSessions, nakTimeout, MAX_SESSIONS_PER_IP } = ctx;
  const key = `${rinfo.address}:${rinfo.port}`;

  // Fast path: session already exists (most common case).
  const existing = clientSessions.get(key);
  if (existing) {
    existing.lastPacketTime = Date.now();
    return existing;
  }

  // Evict the oldest idle session if we are at capacity.
  evictOldestSessionIfFull(ctx);

  // Create new session. Guard against a re-entrant creation that may have
  // already added the session during the eviction scan above.
  if (clientSessions.has(key)) {
    const session = clientSessions.get(key)!;
    session.lastPacketTime = Date.now();
    return session;
  }

  // Enforce per-source-IP session limit to prevent a single attacker from
  // filling the global session table by spoofing many source ports. Count by
  // iterating in place (no array allocation) and short-circuit as soon as the
  // limit is reached — under a spoofed-port flood this runs on every new-key
  // packet, so avoiding the per-packet spread/filter allocation matters.
  let ipSessionCount = 0;
  for (const s of clientSessions.values()) {
    if (s.address === rinfo.address && ++ipSessionCount >= MAX_SESSIONS_PER_IP) {
      break;
    }
  }
  if (ipSessionCount >= MAX_SESSIONS_PER_IP) {
    app.debug(
      `[v2-server] Rejecting new session from ${rinfo.address}: per-IP limit (${MAX_SESSIONS_PER_IP}) reached`
    );
    // Drop the new session entirely. Returning null makes the caller drop the
    // packet rather than processing it under an unstored "dummy" session.
    metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
    return null;
  }

  const session: ClientSession = {
    key,
    sourceClientInstanceId: null,
    clientId: null,
    address: rinfo.address,
    port: rinfo.port,
    sequenceTracker: new SequenceTracker({
      nakTimeout,
      onLossDetected: (missing: number[]) => {
        app.debug(`[v2-server] packet loss from ${key}: seqs ${missing.join(", ")}`);
        sendNAK(ctx, missing, { address: rinfo.address, port: rinfo.port });
      }
    }),
    lastAckSeq: null,
    lastAckSentAt: 0,
    hasReceivedData: false,
    lastPacketTime: Date.now(),
    // per-session loss window counters
    lossBaseSeq: null,
    lossHighestSeq: null,
    lossReceivedCount: 0,
    lastLossExpected: 0,
    lastLossReceived: 0,
    // per-session UDP rate limiting
    rateLimitCount: 0,
    rateLimitWindowStart: Date.now(),
    // META_REQUEST bookkeeping
    metaRequested: false,
    // FULL_STATUS_REQUEST bookkeeping
    statusRequested: false,
    // Stale-envelope rejection for METADATA packets
    lastMetaEnvSeq: null,
    seenMetaChunkIdx: new Set<number>(),
    lastSourceEnvSeq: null,
    seenSourceChunkIdx: new Set<number>(),
    // Same-as-last value dedup expansion (created lazily when needed)
    valueDedupState: null
  };
  clientSessions.set(key, session);
  app.debug(`[v2-server] new client session: ${key}`);
  return session;
}

/**
 * Remove sessions that have been idle longer than SESSION_IDLE_TTL_MS.
 */
export function expireIdleSessions(ctx: ServerContext): void {
  const { app, clientSessions, SESSION_IDLE_TTL_MS } = ctx;
  const now = Date.now();
  // Collect keys to evict first, then delete — avoids modifying the Map
  // during iteration, which can cause entries to be silently skipped in V8.
  const toEvict: string[] = [];
  for (const [key, session] of clientSessions) {
    if (now - session.lastPacketTime > SESSION_IDLE_TTL_MS) {
      toEvict.push(key);
    }
  }
  for (const key of toEvict) {
    const session = clientSessions.get(key);
    if (session) {
      session.sequenceTracker.reset();
      clientSessions.delete(key);
      app.debug(`[v2-server] session expired (idle): ${key}`);
    }
  }
}

// sequenceTracker is now per-session; kept for backward-compat test access
export function getFirstSessionTracker(ctx: ServerContext): SequenceTracker {
  const first = ctx.clientSessions.values().next().value;
  return first ? first.sequenceTracker : new SequenceTracker({ nakTimeout: ctx.nakTimeout });
}

/**
 * Send UDP packet to a destination.
 */
export function sendUDP(
  ctx: ServerContext,
  packet: Buffer,
  destination: { address: string; port: number }
): Promise<void> {
  if (!destination) {
    throw new Error("No client address known");
  }
  if (!ctx.state.socketUdp) {
    throw new Error("UDP socket not initialized");
  }

  return new Promise<void>((resolve, reject) => {
    ctx.state.socketUdp!.send(
      packet,
      destination.port,
      destination.address,
      (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * Send NAK for missing packets back to a specific client.
 */
export async function sendNAK(
  ctx: ServerContext,
  missingSeqs: number[],
  destination: { address: string; port: number }
): Promise<void> {
  const { app, metrics, packetBuilder } = ctx;
  if (missingSeqs.length === 0) {
    return;
  }
  if (!destination) {
    return;
  }

  try {
    // Split large (coalesced) loss batches into MTU-safe NAK datagrams so a big
    // burst loss does not build one oversized, fragmenting packet.
    for (let i = 0; i < missingSeqs.length; i += MAX_NAK_SEQUENCES_PER_PACKET) {
      const chunk = missingSeqs.slice(i, i + MAX_NAK_SEQUENCES_PER_PACKET);
      const nakPacket = packetBuilder.buildNAKPacket(chunk);
      await sendUDP(ctx, nakPacket, destination);

      metrics.naksSent = (metrics.naksSent ?? 0) + 1;
      app.debug(
        `Sent NAK to ${destination.address}:${destination.port}: missing=${chunk.join(", ")}`
      );
    }
  } catch (err: unknown) {
    app.error(`Failed to send NAK: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Send periodic ACK to all active client sessions.
 */
export async function sendPeriodicACKs(ctx: ServerContext): Promise<void> {
  const { app, metrics, packetBuilder, clientSessions, ackResendInterval } = ctx;
  for (const session of clientSessions.values()) {
    if (!session.hasReceivedData) {
      continue;
    }
    if (session.sequenceTracker.expectedSeq === null) {
      continue;
    }

    const currentExpected = session.sequenceTracker.expectedSeq >>> 0;
    const ackSeq = (currentExpected - 1) >>> 0;

    const isDuplicateAck = session.lastAckSeq !== null && ackSeq === session.lastAckSeq;
    const timeSinceLastAck = Date.now() - session.lastAckSentAt;
    if (isDuplicateAck && timeSinceLastAck < ackResendInterval) {
      continue;
    }

    try {
      const ackPacket = packetBuilder.buildACKPacket(ackSeq);
      await sendUDP(ctx, ackPacket, { address: session.address, port: session.port });

      session.lastAckSeq = ackSeq;
      session.lastAckSentAt = Date.now();
      metrics.acksSent = (metrics.acksSent ?? 0) + 1;
      app.debug(`Sent ACK to ${session.key}: seq=${ackSeq}`);
    } catch (err: unknown) {
      app.error(
        `Failed to send ACK to ${session.key}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Build and send a FULL_STATUS_REQUEST (0x08) control packet to a client.
 */
export async function sendFullStatusRequest(
  ctx: ServerContext,
  session: ClientSession,
  secretKey: string
): Promise<void> {
  const packet = ctx.packetBuilder.buildFullStatusRequestPacket({ secretKey });
  await sendUDP(ctx, packet, { address: session.address, port: session.port });
  ctx.app.debug(`[v2-server] FULL_STATUS_REQUEST sent to ${session.key}`);
}

/**
 * Build and send a META_REQUEST (0x07) control packet to a client.
 */
export async function sendMetaRequest(
  ctx: ServerContext,
  session: ClientSession,
  secretKey: string
): Promise<void> {
  // Errors propagate to the caller's .catch() so they are recorded once.
  const packet = ctx.packetBuilder.buildMetaRequestPacket({ secretKey });
  await sendUDP(ctx, packet, { address: session.address, port: session.port });
  ctx.app.debug(`[v2-server] META_REQUEST sent to ${session.key}`);
}
