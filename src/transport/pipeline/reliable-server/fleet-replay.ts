"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet HELLO replay guard
 * (protocol-v3-spec §15.7).
 *
 * @module transport/pipeline/reliable-server/fleet-replay
 */

import type { FleetIdentity } from "../../../codec/fleet-identity";
import type { ServerContext, ClientSession } from "./context";

const MAX_TRACKED_VESSELS = 1024;

/**
 * Where a HELLO sits in its client's sequence: the connection `epoch`, which
 * the client persists and raises on every restart (connection-epoch.ts),
 * then the `timestamp`, which it writes strictly increasing within a run
 * (PacketBuilder). Both are covered by the HELLO tag. Ordering on the epoch
 * first lets a client restarted with its clock set back be recognised as
 * newer, while a replayed HELLO, which carries an epoch no higher than the
 * client's current one, still is not.
 */
export interface HelloOrder {
  epoch: number;
  ts: number;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The order of a HELLO; a missing or non-numeric field counts as 0. */
export function helloOrder(info: Record<string, unknown>): HelloOrder {
  return { epoch: finiteOrZero(info.epoch), ts: finiteOrZero(info.timestamp) };
}

/** True when `a` comes strictly after `b`. */
export function helloNewer(a: HelloOrder, b: HelloOrder): boolean {
  return a.epoch !== b.epoch ? a.epoch > b.epoch : a.ts > b.ts;
}

function remember(ctx: ServerContext, self: string, order: HelloOrder): void {
  const marks = ctx.fleet!.helloMarks;
  marks.delete(self);
  if (marks.size >= MAX_TRACKED_VESSELS) {
    marks.delete(marks.keys().next().value as string);
  }
  marks.set(self, order);
}

/**
 * True when a HELLO from a session other than the vessel's live owner is not
 * strictly newer than the owner's newest accepted HELLO: a captured HELLO
 * replayed from another address. HELLO authentication does not bind the
 * source address, so without this a replay would move ownership to the
 * attacker's session and the origin check would then drop the real vessel's
 * uplink. No clock agreement with the server is needed: both fields of the
 * order are the client's own.
 */
export function helloReplayed(
  ctx: ServerContext,
  session: ClientSession,
  identity: FleetIdentity,
  owner: ClientSession | null,
  order: HelloOrder
): boolean {
  const mark = ctx.fleet!.helloMarks.get(identity.self);
  const newer = mark === undefined || helloNewer(order, mark);
  if (owner && owner !== session && (mark === undefined || !newer)) {
    return true;
  }
  // The owner repeating its own HELLO is accepted but does not move the mark
  // back. With no live owner there is no one to displace.
  if (owner !== session || newer) {
    remember(ctx, identity.self, order);
  }
  return false;
}
