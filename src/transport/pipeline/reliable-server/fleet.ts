"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet sharing membership
 *
 * Who is in the fleet and what each member may receive (protocol-v3-spec
 * §15). Responsibilities:
 *
 * - Session state for an accepted member, and HELLO_ACK.
 * - Scope: select the contexts each session may receive (§15.6) and coalesce
 *   the newest value per (context, $source, path) into the session's queue.
 * - Join snapshots for a new member and for the members already present.
 * - Origin authority: uplink deltas for a context owned by another member are
 *   refused (§15.7).
 *
 * HELLO handling lives in `./fleet-hello`; sending, retransmission and
 * lifecycle in `./fleet-sender`.
 *
 * @module transport/pipeline/reliable-server/fleet
 */

import type { HelloOrder } from "./fleet-replay";
import * as crypto from "node:crypto";
import { RetransmitQueue } from "../../reliability/retransmit-queue";
import type { FleetIdentity } from "../../../codec/fleet-identity";
import { collectValuesSnapshot } from "../../../codec/values-snapshot";
import { resolveSelfContext } from "../../../codec/metadata/collect";
import {
  FLEET_CAPABILITY,
  FLEET_SNAPSHOT_MIN_INTERVAL_MS,
  FLEET_MAX_RETRANSMITS,
  FLEET_RETRANSMIT_QUEUE_SIZE,
  MAX_SAFE_UDP_PAYLOAD
} from "../../../foundation/constants";
import {
  ensureFleetMetrics,
  fleetPathAllowed,
  resolveFleetConfig,
  type ResolvedFleetConfig
} from "../../fleet/common";
import type { Delta, DeltaUpdate, PathFilterConfig } from "../../../foundation/types";
import type { ServerContext, ClientSession } from "./context";
import { bindBuilderEpochForPeer } from "./context";
import { sendUDP } from "./sessions";
import { enqueueMeta, pendingKey } from "./fleet-meta";
import { relaysContext } from "./fleet-relay";

/** One coalesced value (or metadata entry) waiting to be sent to a session. */
export interface PendingValue {
  /** `meta`: `value` is a Signal K meta object for `path`. */
  kind: "value" | "meta";
  context: string;
  $source: string | undefined;
  source: unknown;
  timestamp: string | undefined;
  path: string;
  value: unknown;
}

/** Per-session fleet state, present only while the session is accepted. */
export interface FleetSessionState {
  self: string;
  nonce: string;
  stream: number;
  nextSeq: number;
  pathFilter: PathFilterConfig | null;
  bytesPerSec: number;
  tokens: number;
  lastRefillAt: number;
  pending: Map<string, PendingValue>;
  retransmitQueue: RetransmitQueue;
  lastSentAt: number;
  lastSnapshotAt: number;
  /** A join snapshot was rate-limited; fleetTick sends it when allowed. */
  snapshotDue: boolean;
  flushing: boolean;
  /** `context\0path` keys whose metadata this session already has. */
  metaSent: Set<string>;
  /** Loss-adaptive share of `bytesPerSec` (0.1-1), see fleet-sender. */
  rateFactor: number;
  lastBackoffAt: number;
  lastRateIncreaseAt: number;
  /** Order of the newest fleet HELLO this session was accepted with. */
  lastHello: HelloOrder;
  /**
   * A FLEET_ACK or FLEET_NAK naming this stream has arrived, so the client
   * receives at its source address. Until then the stream has at most one
   * FLEET_DATA in flight and starts a new one at most once per keepalive
   * interval (§15.1), so a HELLO replayed with a spoofed source cannot make
   * the server stream fleet data to that address.
   */
  confirmed: boolean;
  /** When the last new FLEET_DATA went out while unconfirmed (0 = none yet). */
  unconfirmedSentAt: number;
  /** Highest sequence counted as lost on this stream, by NAK or timeout. */
  highestLost: number | null;
}

/** Server-wide fleet state, present only when `fleetSharing.enabled`. */
export interface FleetServerState {
  config: ResolvedFleetConfig;
  /** Declared vessel context → session key of its current owner. */
  members: Map<string, string>;
  /** Vessel context → order of its newest accepted HELLO (replay guard). */
  helloMarks: Map<string, HelloOrder>;
  /** Context → member vessels that uplink it → when last seen (fleet-relay). */
  relays: Map<string, Map<string, number>>;
  unsubscribes: Array<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** A tick is running; the next one is skipped rather than overlapping it. */
  ticking: boolean;
  serverSelf: string | null;
  /** When resolving serverSelf last failed; retried at most every few seconds. */
  serverSelfCheckedAt: number;
  /** When the operator was last warned that HELLOs wait for serverSelf. */
  unresolvedSelfWarnedAt: number;
}

/** Build the fleet state for a server whose options enable fleet sharing. */
export function createFleetServerState(ctx: Pick<ServerContext, "state">): FleetServerState | null {
  const fleetOptions = ctx.state.options?.fleetSharing;
  if (!fleetOptions?.enabled) {
    return null;
  }
  return {
    config: resolveFleetConfig(fleetOptions),
    members: new Map(),
    helloMarks: new Map(),
    relays: new Map(),
    unsubscribes: [],
    timer: null,
    ticking: false,
    serverSelf: null,
    serverSelfCheckedAt: 0,
    unresolvedSelfWarnedAt: 0
  };
}

/**
 * Put values that were taken but not sent back at the head of `pending`, so
 * they go out first once the budget allows. A key that has since received a
 * newer value keeps the newer one.
 */
export function requeuePending(fleetSession: FleetSessionState, values: PendingValue[]): void {
  if (values.length === 0) {
    return;
  }
  const head = new Map<string, PendingValue>();
  for (const value of values) {
    const key = pendingKey(value.kind, value.context, value.$source, value.path);
    head.set(key, fleetSession.pending.get(key) ?? value);
  }
  for (const [key, value] of fleetSession.pending) {
    if (!head.has(key)) {
      head.set(key, value);
    }
  }
  fleetSession.pending = head;
}

export function secretKeyOf(ctx: ServerContext): string {
  return ctx.state.options?.secretKey ?? "";
}

/** The accepted session owning `context`, or null. Prunes stale entries. */
export function memberSession(ctx: ServerContext, context: string): ClientSession | null {
  const key = ctx.fleet?.members.get(context);
  if (!key) {
    return null;
  }
  const session = ctx.clientSessions.get(key);
  if (!session || session.fleet?.self !== context) {
    // Session expired, was evicted, or left the fleet.
    ctx.fleet!.members.delete(context);
    return null;
  }
  return session;
}

export function acceptedSessions(ctx: ServerContext): ClientSession[] {
  const out: ClientSession[] = [];
  for (const session of ctx.clientSessions.values()) {
    if (session.fleet) {
      out.push(session);
    }
  }
  return out;
}

export function refreshMemberCount(ctx: ServerContext): void {
  ensureFleetMetrics(ctx.metrics).members = acceptedSessions(ctx).length;
}

/** How often an unresolved server vessel ID is looked up again. */
const SERVER_SELF_RETRY_MS = 5000;

export function serverSelf(ctx: ServerContext): string | null {
  const fleet = ctx.fleet!;
  const now = Date.now();
  // Resolving can read the whole tree; while it fails, retry at most every
  // SERVER_SELF_RETRY_MS instead of on every delta.
  if (fleet.serverSelf === null && now - fleet.serverSelfCheckedAt >= SERVER_SELF_RETRY_MS) {
    fleet.serverSelfCheckedAt = now;
    try {
      fleet.serverSelf = resolveSelfContext(ctx.app);
    } catch {
      fleet.serverSelf = null;
    }
    if (fleet.serverSelf !== null) {
      dropServerSelfClaim(ctx, fleet.serverSelf);
    }
  }
  return fleet.serverSelf;
}

/** Take `session` out of the fleet, releasing its vessel claim. */
export function leaveFleet(ctx: ServerContext, session: ClientSession): void {
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

/**
 * With includeServerVessel on, HELLOs are accepted before the server knows
 * its own vessel, so a member may already claim it. Once the ID resolves,
 * that claim is refused like a new one: the member leaves the fleet and its
 * next HELLO is answered with a refusal.
 */
function dropServerSelfClaim(ctx: ServerContext, self: string): void {
  const claimant = memberSession(ctx, self);
  if (!claimant) {
    return;
  }
  ensureFleetMetrics(ctx.metrics).identityRejected++;
  ctx.app.debug(`[fleet] ${claimant.key} declared the server's own vessel; removed from the fleet`);
  leaveFleet(ctx, claimant);
}

/** §15.6 rules 1-2: may `context` be sent to `session`? */
function contextInScope(ctx: ServerContext, session: ClientSession, context: string): boolean {
  const fleet = ctx.fleet!;
  if (!session.fleet || context === session.fleet.self || context === "vessels.self") {
    return false;
  }
  // The hub's own vessel goes out only when it is shared, in either scope.
  const self = serverSelf(ctx);
  if (!session.fleet) {
    // Resolving the ID just removed this session's claim on the hub vessel.
    return false;
  }
  if (context === self) {
    return fleet.config.includeServerVessel;
  }
  // A member's own vessel always goes out: its data enters the hub only from
  // its owner (origin authority), so a copy this session once uplinked (an
  // AIS target, say) is not its own data.
  if (memberSession(ctx, context)) {
    return true;
  }
  // Scope `all` adds every other context, except those this session's vessel
  // uplinked itself: sending them back would make its loop guard drop them
  // from its own uplink (§15.6).
  // While the hub does not know its own vessel yet, any other context might
  // be it, so scope `all` withholds them unless the hub vessel is shared.
  if (self === null && !fleet.config.includeServerVessel) {
    return false;
  }
  return fleet.config.scope === "all" && !relaysContext(ctx, session, context);
}

/** Queue one update's in-scope values for a session, newest value wins. */
function enqueueUpdate(
  ctx: ServerContext,
  fleetSession: FleetSessionState,
  context: string,
  update: DeltaUpdate
): void {
  const serverFilter = ctx.fleet!.config.pathFilter;
  const sourceRef = typeof update.$source === "string" ? update.$source : undefined;
  for (const entry of update.values ?? []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      continue;
    }
    if (!fleetPathAllowed(entry.path, serverFilter, fleetSession.pathFilter)) {
      continue;
    }
    const key = pendingKey("value", context, sourceRef, entry.path);
    // A key already waiting keeps its place and only takes the newer value,
    // so flushes go oldest-waiting first and a path that changes every
    // interval cannot be pushed behind the others forever.
    fleetSession.pending.set(key, {
      kind: "value",
      context,
      $source: sourceRef,
      source: update.source,
      timestamp: update.timestamp,
      path: entry.path,
      value: entry.value
    });
  }
  enqueueMeta(ctx, fleetSession, context, update);
}

/** Queue every in-scope value of `delta` for `session`. */
function enqueueDelta(ctx: ServerContext, session: ClientSession, delta: Delta): void {
  const context = delta.context;
  if (typeof context !== "string" || !Array.isArray(delta.updates)) {
    return;
  }
  if (!session.fleet || !contextInScope(ctx, session, context)) {
    return;
  }
  for (const update of delta.updates as DeltaUpdate[]) {
    if (update && typeof update === "object") {
      enqueueUpdate(ctx, session.fleet, context, update);
    }
  }
}

/** Live delta from the server's Signal K tree: fan out to accepted sessions. */
export function onFleetDelta(ctx: ServerContext, delta: Delta): void {
  if (!ctx.fleet || !delta) {
    return;
  }
  for (const session of ctx.clientSessions.values()) {
    if (session.fleet) {
      enqueueDelta(ctx, session, delta);
    }
  }
}

function takeSnapshot(ctx: ServerContext): Delta[] {
  if (!ctx.app.signalk) {
    return [];
  }
  try {
    return collectValuesSnapshot(ctx.app);
  } catch (err: unknown) {
    ctx.app.debug(`[fleet] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function createSessionState(ctx: ServerContext, identity: FleetIdentity): FleetSessionState {
  const fleet = ctx.fleet!;
  const requested = identity.maxBytesPerSec;
  const bytesPerSec =
    requested && requested > 0
      ? Math.min(fleet.config.maxBytesPerSec, requested)
      : fleet.config.maxBytesPerSec;
  const metrics = ensureFleetMetrics(ctx.metrics);
  const metaSent = new Set<string>();
  return {
    self: identity.self,
    nonce: identity.nonce,
    stream: crypto.randomBytes(4).readUInt32BE(0),
    nextSeq: 0,
    pathFilter: identity.pathFilter ?? null,
    bytesPerSec,
    // Start with one packet's worth so the join snapshot starts immediately.
    tokens: Math.max(bytesPerSec, MAX_SAFE_UDP_PAYLOAD),
    lastRefillAt: Date.now(),
    pending: new Map(),
    retransmitQueue: new RetransmitQueue({
      maxSize: FLEET_RETRANSMIT_QUEUE_SIZE,
      maxRetransmits: FLEET_MAX_RETRANSMITS,
      onPacketDropped: () => {
        metrics.packetsAbandoned++;
        // The dropped packet may have carried first-sight metadata; forget
        // what was sent so the next value of each path carries it again.
        metaSent.clear();
      }
    }),
    lastSentAt: 0,
    lastSnapshotAt: 0,
    snapshotDue: false,
    flushing: false,
    metaSent,
    rateFactor: 1,
    lastBackoffAt: 0,
    lastRateIncreaseAt: Date.now(),
    lastHello: { epoch: 0, ts: 0 },
    confirmed: false,
    unconfirmedSentAt: 0,
    highestLost: null
  };
}

/** Send HELLO_ACK: accepted (with stream) or an explicit refusal. */
export async function sendHelloAck(
  ctx: ServerContext,
  session: ClientSession,
  accepted: boolean,
  nonce: string | undefined
): Promise<void> {
  const body: Record<string, unknown> = {
    v: 1,
    accepted: accepted ? [FLEET_CAPABILITY] : []
  };
  if (nonce) {
    body.nonce = nonce;
  }
  if (accepted && session.fleet) {
    body.fleet = { stream: session.fleet.stream, maxBytesPerSec: session.fleet.bytesPerSec };
  }
  bindBuilderEpochForPeer(ctx, session.key);
  const packet = ctx.packetBuilder.buildHelloAckPacket(body, { secretKey: secretKeyOf(ctx) });
  await sendUDP(ctx, packet, { address: session.address, port: session.port });
  if (session.fleet) {
    session.fleet.lastSentAt = Date.now();
  }
}

/**
 * Snapshot for the new member, and the new member's values for the others.
 * Inside the rate limit the snapshot is deferred, not dropped: a client that
 * restarted has an empty stream and would otherwise wait for values to change.
 */
export function queueJoinSnapshots(ctx: ServerContext, session: ClientSession, self: string): void {
  const fleetSession = session.fleet!;
  const now = Date.now();
  if (now - fleetSession.lastSnapshotAt < FLEET_SNAPSHOT_MIN_INTERVAL_MS) {
    fleetSession.snapshotDue = true;
    return;
  }
  fleetSession.snapshotDue = false;
  fleetSession.lastSnapshotAt = now;
  const snapshot = takeSnapshot(ctx);
  for (const delta of snapshot) {
    enqueueDelta(ctx, session, delta);
  }
  for (const other of acceptedSessions(ctx)) {
    if (other === session) {
      continue;
    }
    for (const delta of snapshot) {
      if (delta.context === self) {
        enqueueDelta(ctx, other, delta);
      }
    }
  }
  ensureFleetMetrics(ctx.metrics).snapshotsSent++;
}

/** §15.7 origin authority: true when an uplink delta must be dropped. */
export function fleetOriginRejected(
  ctx: ServerContext,
  delta: Delta,
  session: ClientSession | null
): boolean {
  if (!ctx.fleet || !session || typeof delta.context !== "string") {
    return false;
  }
  const owner = memberSession(ctx, delta.context);
  if (!owner || owner === session) {
    return false;
  }
  ensureFleetMetrics(ctx.metrics).originDrops++;
  return true;
}
