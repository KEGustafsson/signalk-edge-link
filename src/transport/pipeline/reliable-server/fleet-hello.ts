"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet HELLO handling
 *
 * Decrypt the client's `fleet` identity, accept or decline, answer with
 * HELLO_ACK and resolve duplicate vessel claims (newest wins), refusing
 * replayed HELLOs (protocol-v3-spec §15.3, §15.7).
 *
 * @module transport/pipeline/reliable-server/fleet-hello
 */

import { decodeFleetIdentity, type FleetIdentity } from "../../../codec/fleet-identity";
import { FLEET_CAPABILITY } from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { ServerContext, ClientSession } from "./context";
import {
  createSessionState,
  memberSession,
  queueJoinSnapshots,
  refreshMemberCount,
  secretKeyOf,
  sendHelloAck,
  serverSelf
} from "./fleet";
import { helloReplayed, helloTimestamp } from "./fleet-replay";

function leaveFleet(ctx: ServerContext, session: ClientSession): void {
  if (!session.fleet) {
    return;
  }
  if (ctx.fleet?.members.get(session.fleet.self) === session.key) {
    ctx.fleet.members.delete(session.fleet.self);
  }
  session.fleet.retransmitQueue.clear();
  session.fleet = null;
  refreshMemberCount(ctx);
}

function helloRequestsFleet(info: Record<string, unknown>): boolean {
  return Array.isArray(info.capabilities) && info.capabilities.includes(FLEET_CAPABILITY);
}

/** Decrypt the HELLO identity; null (and session leaves) when unusable. */
function readHelloIdentity(
  ctx: ServerContext,
  session: ClientSession,
  info: Record<string, unknown>
): FleetIdentity | null {
  if (!helloRequestsFleet(info)) {
    // The client no longer asks for fleet data (option turned off).
    leaveFleet(ctx, session);
    return null;
  }
  const identity = decodeFleetIdentity(info.fleet, secretKeyOf(ctx), {
    stretchAsciiKey: ctx.stretchAsciiKey
  });
  if (!identity) {
    ensureFleetMetrics(ctx.metrics).identityRejected++;
    ctx.app.debug(`[fleet] ${session.key} requested fleet sharing with an unreadable identity`);
    leaveFleet(ctx, session);
  }
  return identity;
}

/**
 * Make `session` the member for `identity.self`. Returns true when the
 * session starts a new stream (new member or client restart).
 */
function claimMembership(
  ctx: ServerContext,
  session: ClientSession,
  identity: FleetIdentity,
  restarted: boolean,
  helloTs: number
): boolean {
  // Newest HELLO wins a duplicate vessel claim.
  const owner = memberSession(ctx, identity.self);
  if (owner && owner !== session) {
    ensureFleetMetrics(ctx.metrics).identityConflicts++;
    ctx.app.debug(`[fleet] ${identity.self} moved from ${owner.key} to ${session.key}`);
    leaveFleet(ctx, owner);
  }
  const existing = session.fleet;
  const keepStream = !!existing && existing.self === identity.self && !restarted;
  if (keepStream) {
    existing!.nonce = identity.nonce;
    existing!.pathFilter = identity.pathFilter ?? null;
  } else {
    // Carry the snapshot time across re-creation: a client that keeps
    // advancing its epoch must not get a fresh snapshot allowance each time.
    const lastSnapshotAt = existing?.lastSnapshotAt ?? 0;
    leaveFleet(ctx, session);
    session.fleet = createSessionState(ctx, identity);
    session.fleet.lastSnapshotAt = lastSnapshotAt;
  }
  session.fleet!.lastHelloTs = helloTs;
  ctx.fleet!.members.set(identity.self, session.key);
  refreshMemberCount(ctx);
  return !keepStream;
}

/**
 * Handle the fleet part of an authenticated HELLO. `restarted` is true when
 * the HELLO advanced the peer's epoch (client restart).
 */
export function handleFleetHello(
  ctx: ServerContext,
  session: ClientSession,
  info: Record<string, unknown>,
  restarted: boolean
): void {
  const helloTs = helloTimestamp(info.timestamp);
  // A client writes HELLO timestamps strictly increasing, so a HELLO that is
  // not newer than the one this fleet session was accepted with is a replay.
  // Checked before anything else: a replayed HELLO without a fleet request,
  // or with a broken identity, would otherwise take the session out of the
  // fleet and let an older HELLO claim the vessel from another address.
  if (session.fleet && helloTs <= session.fleet.lastHelloTs) {
    ensureFleetMetrics(ctx.metrics).replayedHellos++;
    ctx.app.debug(`[fleet] stale HELLO on fleet session ${session.key} ignored`);
    return;
  }
  const identity = readHelloIdentity(ctx, session, info);
  if (!identity) {
    return;
  }
  const answer = (accepted: boolean) =>
    sendHelloAck(ctx, session, accepted, identity.nonce).catch((err: unknown) => {
      ctx.app.debug(
        `[fleet] HELLO_ACK to ${session.key} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  if (!ctx.fleet) {
    // Explicit refusal, so the client reports `declined` instead of guessing.
    void answer(false);
    return;
  }
  if (identity.self === serverSelf(ctx)) {
    // A member declaring the server's own vessel would make that vessel
    // "a member" and bypass includeServerVessel.
    ensureFleetMetrics(ctx.metrics).identityRejected++;
    ctx.app.debug(`[fleet] ${session.key} declared the server's own vessel; refused`);
    leaveFleet(ctx, session);
    return;
  }
  if (helloReplayed(ctx, session, identity, memberSession(ctx, identity.self), info.timestamp)) {
    ensureFleetMetrics(ctx.metrics).replayedHellos++;
    ctx.app.debug(`[fleet] replayed fleet HELLO for ${identity.self} from ${session.key} ignored`);
    return;
  }
  const newStream = claimMembership(ctx, session, identity, restarted, helloTs);
  void answer(true);
  if (newStream) {
    queueJoinSnapshots(ctx, session, identity.self);
  }
}
