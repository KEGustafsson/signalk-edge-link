"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: contexts members relay
 *
 * Which fleet vessels uplink each context (protocol-v3-spec §15.6). A member
 * is not sent a context it relays itself, such as an AIS target it receives
 * or a vessel behind a relay: getting it back over the fleet would make the
 * member's loop guard drop its own uplink of that context from then on.
 * Keyed by the member's declared vessel, so the rule survives the member
 * reconnecting from a new session; bounded and expiring like the client's
 * learned set.
 *
 * @module transport/pipeline/reliable-server/fleet-relay
 */

import { FLEET_RELAY_MAX_CONTEXTS, FLEET_RELAY_MEMORY_MS } from "../../../foundation/constants";
import type { ServerContext, ClientSession } from "./context";

/** Re-stamp a relay at most this often, so busy contexts cost one Map hit. */
const TOUCH_GRANULARITY_MS = 60_000;

/** Record that `session`'s vessel uplinked `context` (called before dispatch). */
export function noteUplink(
  ctx: ServerContext,
  session: ClientSession | null,
  context: unknown
): void {
  const fleet = ctx.fleet;
  const self = session?.fleet?.self;
  if (!fleet || !self || typeof context !== "string" || context === self) {
    return;
  }
  const now = Date.now();
  let relayers = fleet.relays.get(context);
  const last = relayers?.get(self);
  if (last !== undefined && now - last < TOUCH_GRANULARITY_MS) {
    return;
  }
  if (!relayers) {
    relayers = new Map();
  }
  relayers.set(self, now);
  // Delete-then-set keeps the outer map in least recently relayed order.
  fleet.relays.delete(context);
  fleet.relays.set(context, relayers);
  while (fleet.relays.size > FLEET_RELAY_MAX_CONTEXTS) {
    fleet.relays.delete(fleet.relays.keys().next().value as string);
  }
}

/** True when `session`'s vessel uplinked `context` within the memory window. */
export function relaysContext(
  ctx: ServerContext,
  session: ClientSession,
  context: string
): boolean {
  const self = session.fleet?.self;
  const at = self ? ctx.fleet?.relays.get(context)?.get(self) : undefined;
  return at !== undefined && Date.now() - at < FLEET_RELAY_MEMORY_MS;
}
