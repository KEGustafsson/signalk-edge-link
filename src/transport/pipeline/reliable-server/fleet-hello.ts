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
  leaveFleet,
  memberSession,
  queueJoinSnapshots,
  refreshMemberCount,
  secretKeyOf,
  sendHelloAck,
  serverSelf
} from "./fleet";
import { helloNewer, helloOrder, helloReplayed, type HelloOrder } from "./fleet-replay";

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
  order: HelloOrder
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
  session.fleet!.lastHello = order;
  ctx.fleet!.members.set(identity.self, session.key);
  refreshMemberCount(ctx);
  return !keepStream;
}

/** At most one operator warning per this interval while HELLOs are deferred. */
const UNRESOLVED_SELF_WARN_MS = 10 * 60 * 1000;

/** Tell the operator, at most every ten minutes, why fleet members cannot join. */
function warnUnresolvedSelf(ctx: ServerContext): void {
  const fleet = ctx.fleet!;
  const now = Date.now();
  if (
    fleet.unresolvedSelfWarnedAt !== 0 &&
    now - fleet.unresolvedSelfWarnedAt < UNRESOLVED_SELF_WARN_MS
  ) {
    return;
  }
  fleet.unresolvedSelfWarnedAt = now;
  ctx.app.error(
    "[fleet] fleet sharing is waiting: this server's own vessel ID is not resolved " +
      "(set the vessel MMSI or UUID in Signal K). Fleet HELLOs are deferred until it is."
  );
}

/**
 * Until the server knows its own vessel, it cannot tell whether a client
 * claims it, and accepting such a claim would share the server's vessel with
 * every member. Leave the HELLO unanswered: the client asks again every
 * minute and joins, with a snapshot, once the ID resolves.
 */
function deferHello(ctx: ServerContext, session: ClientSession): void {
  ensureFleetMetrics(ctx.metrics).helloDeferred++;
  warnUnresolvedSelf(ctx);
  ctx.app.debug(`[fleet] own vessel ID not resolved yet; fleet HELLO from ${session.key} deferred`);
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
  const order = helloOrder(info);
  // A client's HELLOs are strictly ordered (fleet-replay HelloOrder), so a
  // HELLO not newer than the one this fleet session was accepted with is a
  // replay.
  // Checked before anything else: a replayed HELLO without a fleet request,
  // or with a broken identity, would otherwise take the session out of the
  // fleet and let an older HELLO claim the vessel from another address.
  if (session.fleet && !helloNewer(order, session.fleet.lastHello)) {
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
  const self = serverSelf(ctx);
  if (self === null && !ctx.fleet.config.includeServerVessel) {
    deferHello(ctx, session);
    return;
  }
  if (identity.self === self) {
    // A member declaring the server's own vessel would make that vessel
    // "a member" and bypass includeServerVessel.
    ensureFleetMetrics(ctx.metrics).identityRejected++;
    ctx.app.debug(`[fleet] ${session.key} declared the server's own vessel; refused`);
    leaveFleet(ctx, session);
    // Answer, so the client reports `declined` instead of waiting it out as
    // `not-offered` and blaming the server version.
    void answer(false);
    return;
  }
  if (helloReplayed(ctx, session, identity, memberSession(ctx, identity.self), order)) {
    ensureFleetMetrics(ctx.metrics).replayedHellos++;
    ctx.app.debug(`[fleet] replayed fleet HELLO for ${identity.self} from ${session.key} ignored`);
    return;
  }
  const newStream = claimMembership(ctx, session, identity, restarted, order);
  void answer(true);
  if (newStream) {
    queueJoinSnapshots(ctx, session, identity.self);
  }
}
