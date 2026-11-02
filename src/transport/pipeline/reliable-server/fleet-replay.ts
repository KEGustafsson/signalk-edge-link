"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet HELLO replay guard
 * (protocol-v3-spec §15.7).
 *
 * @module transport/pipeline/reliable-server/fleet-replay
 */

import type { FleetIdentity } from "../../../codec/fleet-identity";
import type { ServerContext, ClientSession } from "./context";

/** Nonces remembered per vessel, and vessels remembered, for replay checks. */
const NONCES_PER_VESSEL = 32;
const MAX_NONCE_VESSELS = 1024;

/**
 * True when this HELLO's nonce was already presented for the same vessel by a
 * different session: a captured HELLO replayed from another address. HELLO
 * authentication does not bind the source address, so without this a replay
 * would move vessel ownership to the attacker's session and the origin check
 * would then drop the real vessel's uplink. A repeat from the same session
 * (HELLO retry) is accepted.
 */
export function helloReplayed(
  ctx: ServerContext,
  session: ClientSession,
  identity: FleetIdentity
): boolean {
  const seen = ctx.fleet!.seenNonces;
  let nonces = seen.get(identity.self);
  const firstSession = nonces?.get(identity.nonce);
  if (firstSession !== undefined) {
    return firstSession !== session.key;
  }
  if (!nonces) {
    if (seen.size >= MAX_NONCE_VESSELS) {
      seen.delete(seen.keys().next().value as string);
    }
    nonces = new Map();
    seen.set(identity.self, nonces);
  }
  nonces.set(identity.nonce, session.key);
  if (nonces.size > NONCES_PER_VESSEL) {
    nonces.delete(nonces.keys().next().value as string);
  }
  return false;
}
