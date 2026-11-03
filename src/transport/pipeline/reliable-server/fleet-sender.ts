"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet sharing sender
 *
 * Delivers each accepted session's coalesced fleet values (protocol-v3-spec
 * §15.4-15.6): per-session token bucket, FLEET_DATA with the session's stream
 * and sequence space, retransmit on FLEET_NAK and after a timeout, HELLO_ACK
 * keepalive for idle sessions, and the subscription / tick lifecycle.
 *
 * @module transport/pipeline/reliable-server/fleet-sender
 */

import { encodeFleetPayload } from "../../../codec/fleet-payload";
import { ParsedPacket } from "../../../codec/packet-codec";
import {
  FLEET_KEEPALIVE_MS,
  FLEET_RETRANSMIT_AFTER_MS,
  FLEET_VALUES_PER_PACKET,
  FLEET_MAX_NAK_SEQUENCES,
  MAX_SAFE_UDP_PAYLOAD,
  MAX_UDP_DATAGRAM_PAYLOAD,
  FLEET_SNAPSHOT_MIN_INTERVAL_MS
} from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { Delta, DeltaUpdate } from "../../../foundation/types";
import type { ServerContext, ClientSession } from "./context";
import { bindBuilderEpochForPeer } from "./context";
import { sendUDP } from "./sessions";
import { withFirstSightMeta } from "./fleet-meta";
import { backOff, recoverRate, refillTokens } from "./fleet-rate";
import {
  acceptedSessions,
  memberSession,
  onFleetDelta,
  queueJoinSnapshots,
  refreshMemberCount,
  secretKeyOf,
  sendHelloAck,
  type FleetSessionState,
  type PendingValue
} from "./fleet";

/**
 * Group pending entries into deltas by context, then ($source, timestamp).
 * Metadata entries share one meta-only update per context.
 */
function buildDeltas(values: PendingValue[]): Delta[] {
  const byContext = new Map<string, Map<string, DeltaUpdate>>();
  for (const v of values) {
    let updates = byContext.get(v.context);
    if (!updates) {
      updates = new Map();
      byContext.set(v.context, updates);
    }
    if (v.kind === "meta") {
      let metaUpdate = updates.get("\u0001meta") as
        | (DeltaUpdate & { meta: Array<{ path: string; value: unknown }> })
        | undefined;
      if (!metaUpdate) {
        metaUpdate = { values: [], meta: [] } as unknown as DeltaUpdate & {
          meta: Array<{ path: string; value: unknown }>;
        };
        updates.set("\u0001meta", metaUpdate);
      }
      metaUpdate.meta.push({ path: v.path, value: v.value });
      continue;
    }
    const updateKey = `${v.$source ?? ""}\u0000${v.timestamp ?? ""}`;
    let update = updates.get(updateKey) as (DeltaUpdate & Record<string, unknown>) | undefined;
    if (!update) {
      update = { values: [] } as unknown as DeltaUpdate & Record<string, unknown>;
      if (v.$source !== undefined) {
        update.$source = v.$source;
      }
      if (v.source !== undefined) {
        update.source = v.source as never;
      }
      if (v.timestamp !== undefined) {
        update.timestamp = v.timestamp;
      }
      updates.set(updateKey, update);
    }
    update.values!.push({ path: v.path, value: v.value } as never);
  }
  const deltas: Delta[] = [];
  for (const [context, updates] of byContext) {
    deltas.push({ context, updates: [...updates.values()] } as Delta);
  }
  return deltas;
}

async function sendFleetPacket(
  ctx: ServerContext,
  session: ClientSession,
  packet: Buffer
): Promise<void> {
  await sendUDP(ctx, packet, { address: session.address, port: session.port });
  ctx.metrics.bandwidth.bytesOut += packet.length;
  ctx.metrics.bandwidth.packetsOut++;
}

/** Remove up to one packet's worth of values from the head of the queue. */
function takeChunk(fleetSession: FleetSessionState): PendingValue[] {
  const chunk: PendingValue[] = [];
  for (const [key, value] of fleetSession.pending) {
    fleetSession.pending.delete(key);
    chunk.push(value);
    if (chunk.length >= FLEET_VALUES_PER_PACKET) {
      break;
    }
  }
  return chunk;
}

/** Undo the first-sight metadata recorded for a packet that is not sent. */
function forgetMeta(fleetSession: FleetSessionState, keys: string[]): void {
  for (const key of keys) {
    fleetSession.metaSent.delete(key);
  }
}

/**
 * Send `values` as two halves. If the first half throws, the second is still
 * queued (its values have left `pending`) so a NAK can recover it, and the
 * first error is rethrown.
 */
async function sendSplit(
  ctx: ServerContext,
  session: ClientSession,
  fleetSession: FleetSessionState,
  values: PendingValue[]
): Promise<boolean> {
  const half = Math.ceil(values.length / 2);
  let headSent: boolean;
  try {
    headSent = await sendChunk(ctx, session, fleetSession, values.slice(0, half));
  } catch (err: unknown) {
    await sendChunk(ctx, session, fleetSession, values.slice(half)).catch(() => false);
    throw err;
  }
  return headSent && sendChunk(ctx, session, fleetSession, values.slice(half));
}

/**
 * Encode, build, queue and send `values` as FLEET_DATA. A packet over
 * MAX_SAFE_UDP_PAYLOAD is split in half and each half sent on its own, so a
 * large value travels alone instead of fragmenting its neighbours' packet.
 * False if the session left.
 */
async function sendChunk(
  ctx: ServerContext,
  session: ClientSession,
  fleetSession: FleetSessionState,
  values: PendingValue[]
): Promise<boolean> {
  const options = ctx.state.options!;
  const withMeta = withFirstSightMeta(ctx, fleetSession, values);
  const encrypted = await encodeFleetPayload(buildDeltas(withMeta.values), {
    secretKey: secretKeyOf(ctx),
    stretchAsciiKey: ctx.stretchAsciiKey,
    useMsgpack: !!options.useMsgpack,
    usePathDictionary: !!options.usePathDictionary,
    brotliQuality: options.brotliQuality
  });
  if (session.fleet !== fleetSession) {
    return false;
  }
  // Bind and build synchronously so no other destination's epoch can
  // interleave (see bindBuilderEpochForPeer).
  bindBuilderEpochForPeer(ctx, session.key);
  const seq = fleetSession.nextSeq;
  const packet = ctx.packetBuilder.buildFleetDataPacket(fleetSession.stream, seq, encrypted, {
    messagepack: !!options.useMsgpack,
    pathDictionary: !!options.usePathDictionary
  });
  if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
    if (values.length > 1) {
      // Not sent: the halves attach this metadata again.
      forgetMeta(fleetSession, withMeta.added);
      return sendSplit(ctx, session, fleetSession, values);
    }
    if (packet.length > MAX_UDP_DATAGRAM_PAYLOAD) {
      // No datagram can carry it: queueing it would only fail again on every
      // retransmit and drain the byte budget each time.
      forgetMeta(fleetSession, withMeta.added);
      ensureFleetMetrics(ctx.metrics).packetsAbandoned++;
      ctx.app.debug(
        `[fleet] ${values[0].context} ${values[0].path} needs ${packet.length} bytes; dropped`
      );
      return true;
    }
    ctx.app.debug(
      `[fleet] ${values[0].context} ${values[0].path} needs ${packet.length} bytes; sent alone`
    );
  }
  fleetSession.nextSeq = (seq + 1) >>> 0;
  // Queue before sending so a failed send is still recoverable by NAK.
  fleetSession.retransmitQueue.add(seq, packet);
  fleetSession.tokens -= packet.length;
  fleetSession.lastSentAt = Date.now();
  await sendFleetPacket(ctx, session, packet);
  const metrics = ensureFleetMetrics(ctx.metrics);
  metrics.packetsSent++;
  metrics.bytesSent += packet.length;
  metrics.valuesSent += values.length;
  return true;
}

/** Send as much of one session's pending values as its byte budget allows. */
async function flushSession(ctx: ServerContext, session: ClientSession): Promise<void> {
  const fleetSession = session.fleet;
  if (!fleetSession || fleetSession.flushing || fleetSession.pending.size === 0) {
    return;
  }
  if (!ctx.state.options) {
    return;
  }
  fleetSession.flushing = true;
  try {
    refillTokens(fleetSession, Date.now());
    while (fleetSession.pending.size > 0) {
      if (fleetSession.tokens < MAX_SAFE_UDP_PAYLOAD / 4) {
        // Values stay queued; newer values for the same key replace them.
        ensureFleetMetrics(ctx.metrics).rateLimitedFlushes++;
        return;
      }
      if (!(await sendChunk(ctx, session, fleetSession, takeChunk(fleetSession)))) {
        return;
      }
    }
  } catch (err: unknown) {
    ctx.app.debug(
      `[fleet] flush to ${session.key} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    fleetSession.flushing = false;
  }
}

/**
 * Resend `sequences` within the session's byte budget. A sequence left over
 * when the budget runs out keeps its retry state and goes out on a later NAK
 * or stale tick, so loss recovery cannot push the budget far below zero and
 * stall new values.
 */
export async function retransmit(
  ctx: ServerContext,
  session: ClientSession,
  sequences: number[]
): Promise<void> {
  const fleetSession = session.fleet;
  if (!fleetSession || sequences.length === 0) {
    return;
  }
  const metrics = ensureFleetMetrics(ctx.metrics);
  for (const sequence of sequences) {
    refillTokens(fleetSession, Date.now());
    if (fleetSession.tokens < MAX_SAFE_UDP_PAYLOAD / 4) {
      return;
    }
    for (const item of fleetSession.retransmitQueue.retransmit([sequence])) {
      fleetSession.tokens -= item.packet.length;
      fleetSession.lastSentAt = Date.now();
      await sendFleetPacket(ctx, session, item.packet);
      metrics.retransmits++;
    }
  }
}

/** Retransmit packets that stayed unacknowledged past the timeout. */
async function retransmitStale(
  ctx: ServerContext,
  session: ClientSession,
  now: number
): Promise<void> {
  const fleetSession = session.fleet;
  if (!fleetSession || fleetSession.retransmitQueue.getSize() === 0) {
    return;
  }
  const stale = fleetSession.retransmitQueue.getOldestSequences(16).filter((seq) => {
    const entry = fleetSession.retransmitQueue.get(seq);
    return !!entry && now - entry.timestamp >= FLEET_RETRANSMIT_AFTER_MS;
  });
  if (stale.length > 0) {
    backOff(ctx, fleetSession, now);
  }
  await retransmit(ctx, session, stale);
}

/** One fleet tick: retransmit, flush, keepalive, member bookkeeping. */
export async function fleetTick(ctx: ServerContext): Promise<void> {
  if (!ctx.fleet) {
    return;
  }
  const now = Date.now();
  for (const session of acceptedSessions(ctx)) {
    try {
      await retransmitStale(ctx, session, now);
      if (session.fleet) {
        recoverRate(session.fleet, now);
        if (
          session.fleet.snapshotDue &&
          now - session.fleet.lastSnapshotAt >= FLEET_SNAPSHOT_MIN_INTERVAL_MS
        ) {
          queueJoinSnapshots(ctx, session, session.fleet.self);
        }
      }
      await flushSession(ctx, session);
      const fleetSession = session.fleet;
      if (fleetSession && now - fleetSession.lastSentAt >= FLEET_KEEPALIVE_MS) {
        await sendHelloAck(ctx, session, true, fleetSession.nonce);
        ensureFleetMetrics(ctx.metrics).keepalivesSent++;
      }
    } catch (err: unknown) {
      ctx.app.debug(
        `[fleet] tick for ${session.key} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  for (const context of [...ctx.fleet.members.keys()]) {
    memberSession(ctx, context);
  }
  refreshMemberCount(ctx);
  const factors = acceptedSessions(ctx).map((s) => s.fleet!.rateFactor);
  ensureFleetMetrics(ctx.metrics).minRateFactor = factors.length ? Math.min(...factors) : 1;
}

function sessionFor(
  ctx: ServerContext,
  rinfo?: { address: string; port: number }
): ClientSession | null {
  return rinfo ? (ctx.clientSessions.get(`${rinfo.address}:${rinfo.port}`) ?? null) : null;
}

/** FLEET_ACK from a client: release acknowledged packets. */
export function handleFleetAck(
  ctx: ServerContext,
  parsed: ParsedPacket,
  rinfo?: { address: string; port: number }
): void {
  const session = sessionFor(ctx, rinfo);
  if (!session?.fleet) {
    return;
  }
  const { stream, sequence } = ctx.packetParser.parseFleetAckPayload(parsed.payload);
  if (stream !== session.fleet.stream) {
    ensureFleetMetrics(ctx.metrics).staleStreamPackets++;
    return;
  }
  session.lastPacketTime = Date.now();
  session.fleet.retransmitQueue.acknowledge(sequence);
}

/** FLEET_NAK from a client: retransmit the named sequences. */
export async function handleFleetNak(
  ctx: ServerContext,
  parsed: ParsedPacket,
  rinfo?: { address: string; port: number }
): Promise<void> {
  const session = sessionFor(ctx, rinfo);
  if (!session?.fleet) {
    return;
  }
  const { stream, missing } = ctx.packetParser.parseFleetNakPayload(parsed.payload);
  if (stream !== session.fleet.stream) {
    ensureFleetMetrics(ctx.metrics).staleStreamPackets++;
    return;
  }
  session.lastPacketTime = Date.now();
  if (missing.length > 0) {
    backOff(ctx, session.fleet, Date.now());
  }
  await retransmit(ctx, session, missing.slice(0, FLEET_MAX_NAK_SEQUENCES));
}

/** Subscribe to the tree and start the fleet tick. Idempotent. */
export function startFleet(ctx: ServerContext): void {
  const fleet = ctx.fleet;
  if (!fleet || fleet.timer) {
    return;
  }
  // On a server `state` reads `active` while sharing runs.
  ensureFleetMetrics(ctx.metrics).state = "active";
  const manager = ctx.app.subscriptionmanager;
  if (manager && typeof manager.subscribe === "function") {
    try {
      manager.subscribe(
        { context: "*", subscribe: [{ path: "*", policy: "instant" }] },
        fleet.unsubscribes,
        (err: unknown) => {
          ctx.app.error(
            `[fleet] subscription error: ${err instanceof Error ? err.message : String(err)}`
          );
        },
        (delta: Delta) => onFleetDelta(ctx, delta)
      );
    } catch (err: unknown) {
      ctx.app.error(
        `[fleet] subscribe failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  fleet.timer = setInterval(() => {
    fleetTick(ctx).catch((err: unknown) => {
      ctx.app.debug(`[fleet] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, fleet.config.batchIntervalMs);
}

/** Unsubscribe and stop the fleet tick. Idempotent. */
export function stopFleet(ctx: ServerContext): void {
  const fleet = ctx.fleet;
  if (!fleet) {
    return;
  }
  if (fleet.timer) {
    clearInterval(fleet.timer);
    fleet.timer = null;
  }
  ensureFleetMetrics(ctx.metrics).state = "disabled";
  for (const unsubscribe of fleet.unsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch {
      // Teardown must continue even if one unsubscribe throws.
    }
  }
}
