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
  FLEET_MIN_MAX_BYTES_PER_SEC,
  FLEET_RATE_BACKOFF_FACTOR,
  FLEET_RATE_MIN_FACTOR,
  FLEET_RATE_BACKOFF_INTERVAL_MS,
  FLEET_RATE_RECOVERY_DELAY_MS,
  FLEET_RATE_RECOVERY_PER_SEC
} from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { Delta, DeltaUpdate } from "../../../foundation/types";
import type { ServerContext, ClientSession } from "./context";
import { bindBuilderEpochForPeer } from "./context";
import { sendUDP } from "./sessions";
import { withFirstSightMeta } from "./fleet-meta";
import {
  acceptedSessions,
  memberSession,
  onFleetDelta,
  refreshMemberCount,
  secretKeyOf,
  sendHelloAck,
  type FleetSessionState,
  type PendingValue
} from "./fleet";

/** Current byte rate: the session ceiling scaled by its loss-adaptive factor. */
export function effectiveRate(fleetSession: FleetSessionState): number {
  return Math.max(FLEET_MIN_MAX_BYTES_PER_SEC, fleetSession.bytesPerSec * fleetSession.rateFactor);
}

function refillTokens(fleetSession: FleetSessionState, now: number): void {
  const elapsed = Math.max(0, now - fleetSession.lastRefillAt);
  fleetSession.lastRefillAt = now;
  const rate = effectiveRate(fleetSession);
  // Bucket depth: one second of rate, never less than one full packet.
  const depth = Math.max(rate, MAX_SAFE_UDP_PAYLOAD);
  fleetSession.tokens = Math.min(depth, fleetSession.tokens + (rate * elapsed) / 1000);
}

/**
 * Loss seen on this session's downlink (a NAK, or a packet that went
 * unacknowledged): cut the rate multiplicatively, at most once per interval
 * so one burst of loss counts once. The vessel's link — usually the
 * bottleneck — sets the pace without any configuration.
 */
function backOff(ctx: ServerContext, fleetSession: FleetSessionState, now: number): void {
  if (now - fleetSession.lastBackoffAt < FLEET_RATE_BACKOFF_INTERVAL_MS) {
    return;
  }
  fleetSession.lastBackoffAt = now;
  fleetSession.lastRateIncreaseAt = now;
  fleetSession.rateFactor = Math.max(
    FLEET_RATE_MIN_FACTOR,
    fleetSession.rateFactor * FLEET_RATE_BACKOFF_FACTOR
  );
  ensureFleetMetrics(ctx.metrics).rateBackoffs++;
}

/** Recover additively once the session has been loss-free for a while. */
function recoverRate(fleetSession: FleetSessionState, now: number): void {
  if (
    fleetSession.rateFactor >= 1 ||
    now - fleetSession.lastBackoffAt < FLEET_RATE_RECOVERY_DELAY_MS
  ) {
    fleetSession.lastRateIncreaseAt = now;
    return;
  }
  const seconds = Math.max(0, now - fleetSession.lastRateIncreaseAt) / 1000;
  fleetSession.lastRateIncreaseAt = now;
  fleetSession.rateFactor = Math.min(
    1,
    fleetSession.rateFactor + FLEET_RATE_RECOVERY_PER_SEC * seconds
  );
}

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

/** Encode, build, queue and send one FLEET_DATA. False if the session left. */
async function sendChunk(
  ctx: ServerContext,
  session: ClientSession,
  fleetSession: FleetSessionState,
  values: PendingValue[]
): Promise<boolean> {
  const options = ctx.state.options!;
  const encrypted = await encodeFleetPayload(
    buildDeltas(withFirstSightMeta(ctx, fleetSession, values)),
    {
      secretKey: secretKeyOf(ctx),
      stretchAsciiKey: ctx.stretchAsciiKey,
      useMsgpack: !!options.useMsgpack,
      usePathDictionary: !!options.usePathDictionary,
      brotliQuality: options.brotliQuality
    }
  );
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

async function retransmit(
  ctx: ServerContext,
  session: ClientSession,
  sequences: number[]
): Promise<void> {
  const fleetSession = session.fleet;
  if (!fleetSession || sequences.length === 0) {
    return;
  }
  const metrics = ensureFleetMetrics(ctx.metrics);
  for (const item of fleetSession.retransmitQueue.retransmit(sequences)) {
    fleetSession.tokens -= item.packet.length;
    fleetSession.lastSentAt = Date.now();
    await sendFleetPacket(ctx, session, item.packet);
    metrics.retransmits++;
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
