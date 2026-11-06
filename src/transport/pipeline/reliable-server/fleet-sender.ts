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
import {
  FLEET_KEEPALIVE_MS,
  FLEET_VALUES_PER_PACKET,
  MAX_SAFE_UDP_PAYLOAD,
  MAX_UDP_DATAGRAM_PAYLOAD,
  FLEET_SNAPSHOT_MIN_INTERVAL_MS
} from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { Delta, DeltaUpdate } from "../../../foundation/types";
import type { ServerContext, ClientSession } from "./context";
import { bindBuilderEpochForPeer } from "./context";
import { withFirstSightMeta } from "./fleet-meta";
import { budgetCovers, recoverRate, refillTokens } from "./fleet-rate";
import { retransmitStale, sendFleetPacket } from "./fleet-recovery";
import {
  acceptedSessions,
  memberSession,
  onFleetDelta,
  queueJoinSnapshots,
  refreshMemberCount,
  requeuePending,
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
 * first error is rethrown. If the first half waits for budget, the second
 * goes back to `pending` with it.
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
  if (!headSent) {
    if (session.fleet === fleetSession) {
      requeuePending(fleetSession, values.slice(half));
    }
    return false;
  }
  return sendChunk(ctx, session, fleetSession, values.slice(half));
}

/** Leave `values` for a later flush: the budget does not cover their packet. */
function deferChunk(
  ctx: ServerContext,
  fleetSession: FleetSessionState,
  values: PendingValue[],
  metaAdded: string[]
): false {
  forgetMeta(fleetSession, metaAdded);
  requeuePending(fleetSession, values);
  ensureFleetMetrics(ctx.metrics).rateLimitedFlushes++;
  return false;
}

/**
 * Encode, build, queue and send `values` as FLEET_DATA. A packet over
 * MAX_SAFE_UDP_PAYLOAD is split in half and each half sent on its own, so a
 * large value travels alone instead of fragmenting its neighbours' packet.
 * Each packet goes out only when the byte budget covers it (budgetCovers).
 * False if the session left or the budget ran out.
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
  const packet = ctx.packetBuilder.buildFleetDataPacket(
    fleetSession.stream,
    fleetSession.nextSeq,
    encrypted,
    {
      messagepack: !!options.useMsgpack,
      pathDictionary: !!options.usePathDictionary
    }
  );
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
  if (!fleetSession.confirmed && unconfirmedHeld(fleetSession)) {
    // Until the client proves it receives here: one FLEET_DATA in flight,
    // and a new one at most once per keepalive interval, so a lost first
    // packet cannot stall the stream and a spoofed address gets a trickle.
    forgetMeta(fleetSession, withMeta.added);
    requeuePending(fleetSession, values);
    return false;
  }
  if (!budgetCovers(fleetSession, packet.length)) {
    return deferChunk(ctx, fleetSession, values, withMeta.added);
  }
  await transmitFleetData(ctx, session, fleetSession, packet, values.length);
  return true;
}

/** An unconfirmed stream waits while a packet is in flight or one went out recently. */
function unconfirmedHeld(fleetSession: FleetSessionState): boolean {
  return (
    fleetSession.retransmitQueue.getSize() > 0 ||
    (fleetSession.unconfirmedSentAt !== 0 &&
      Date.now() - fleetSession.unconfirmedSentAt < FLEET_KEEPALIVE_MS)
  );
}

/** Take the next sequence, queue the packet for recovery, charge and send it. */
async function transmitFleetData(
  ctx: ServerContext,
  session: ClientSession,
  fleetSession: FleetSessionState,
  packet: Buffer,
  valueCount: number
): Promise<void> {
  const seq = fleetSession.nextSeq;
  fleetSession.nextSeq = (seq + 1) >>> 0;
  // Queue before sending so a failed send is still recoverable by NAK.
  fleetSession.retransmitQueue.add(seq, packet);
  fleetSession.tokens -= packet.length;
  fleetSession.lastSentAt = Date.now();
  if (!fleetSession.confirmed) {
    fleetSession.unconfirmedSentAt = fleetSession.lastSentAt;
  }
  await sendFleetPacket(ctx, session, packet);
  const metrics = ensureFleetMetrics(ctx.metrics);
  metrics.packetsSent++;
  metrics.bytesSent += packet.length;
  metrics.valuesSent += valueCount;
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
