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

function remember(ctx: ServerContext, self: string, timestamp: number): void {
  const marks = ctx.fleet!.helloMarks;
  marks.delete(self);
  if (marks.size >= MAX_TRACKED_VESSELS) {
    marks.delete(marks.keys().next().value as string);
  }
  marks.set(self, timestamp);
}

/**
 * True when a HELLO from a session other than the vessel's live owner is not
 * strictly newer than the owner's newest accepted HELLO: a captured HELLO
 * replayed from another address. HELLO authentication does not bind the
 * source address, so without this a replay would move ownership to the
 * attacker's session and the origin check would then drop the real vessel's
 * uplink.
 *
 * "Newer" compares the HMAC-covered HELLO `timestamp`, which the vessel writes
 * strictly increasing (PacketBuilder), so no clock agreement with the server
 * is needed and no two HELLOs of one client share a value.
 */
export function helloReplayed(
  ctx: ServerContext,
  session: ClientSession,
  identity: FleetIdentity,
  owner: ClientSession | null,
  timestamp: unknown
): boolean {
  const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
  const mark = ctx.fleet!.helloMarks.get(identity.self);
  const newer = mark === undefined || ts > mark;
  if (owner && owner !== session && (mark === undefined || !newer)) {
    return true;
  }
  // The owner repeating its own HELLO is accepted but does not move the mark
  // back. With no live owner there is no one to displace.
  if (owner !== session || newer) {
    remember(ctx, identity.self, ts);
  }
  return false;
}
