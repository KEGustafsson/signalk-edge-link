"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet loss recovery
 *
 * FLEET_ACK and FLEET_NAK from clients, and retransmission of FLEET_DATA on
 * a NAK or after a timeout, within each session's byte budget
 * (protocol-v3-spec §15.5, §15.9).
 *
 * @module transport/pipeline/reliable-server/fleet-recovery
 */

import { ParsedPacket } from "../../../codec/packet-codec";
import { FLEET_MAX_NAK_SEQUENCES, FLEET_RETRANSMIT_AFTER_MS } from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { ServerContext, ClientSession } from "./context";
import { sendUDP } from "./sessions";
import { backOff, budgetCovers, refillTokens } from "./fleet-rate";

/** Send one fleet packet to a session and count it as link traffic. */
export async function sendFleetPacket(
  ctx: ServerContext,
  session: ClientSession,
  packet: Buffer
): Promise<void> {
  await sendUDP(ctx, packet, { address: session.address, port: session.port });
  ctx.metrics.bandwidth.bytesOut += packet.length;
  ctx.metrics.bandwidth.packetsOut++;
}

/**
 * Resend `sequences` within the session's byte budget, each only when the
 * budget covers its packet. A sequence left over when the budget runs out
 * keeps its retry state and goes out on a later NAK or stale tick, so loss
 * recovery cannot overspend the budget and stall new values.
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
    const entry = fleetSession.retransmitQueue.get(sequence);
    if (!entry) {
      continue;
    }
    if (!budgetCovers(fleetSession, entry.packet.length)) {
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
export async function retransmitStale(
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
  session.fleet.confirmed = true;
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
  session.fleet.confirmed = true;
  if (missing.length > 0) {
    backOff(ctx, session.fleet, Date.now());
  }
  await retransmit(ctx, session, missing.slice(0, FLEET_MAX_NAK_SEQUENCES));
}
