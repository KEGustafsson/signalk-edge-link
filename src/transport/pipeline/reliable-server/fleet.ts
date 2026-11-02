"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet sharing membership
 *
 * Who is in the fleet and what each member may receive (protocol-v3-spec
 * §15). Responsibilities:
 *
 * - HELLO handling: decrypt the client's `fleet` identity, accept or decline,
 *   answer with HELLO_ACK, resolve duplicate vessel claims (newest wins).
 * - Scope: select the contexts each session may receive (§15.6) and coalesce
 *   the newest value per (context, $source, path) into the session's queue.
 * - Join snapshots for a new member and for the members already present.
 * - Origin authority: uplink deltas for a context owned by another member are
 *   refused (§15.7).
 *
 * Sending, retransmission and lifecycle live in `./fleet-sender`.
 *
 * @module transport/pipeline/reliable-server/fleet
 */

import * as crypto from "node:crypto";
import { RetransmitQueue } from "../../reliability/retransmit-queue";
import { decodeFleetIdentity, type FleetIdentity } from "../../../codec/fleet-identity";
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
import { enqueueMeta } from "./fleet-meta";
import { helloReplayed, type HelloMark } from "./fleet-replay";

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
  flushing: boolean;
  /** `context\0path` keys whose metadata this session already has. */
  metaSent: Set<string>;
  /** Loss-adaptive share of `bytesPerSec` (0.1-1), see fleet-sender. */
  rateFactor: number;
  lastBackoffAt: number;
  lastRateIncreaseAt: number;
}

/** Server-wide fleet state, present only when `fleetSharing.enabled`. */
export interface FleetServerState {
  config: ResolvedFleetConfig;
  /** Declared vessel context → session key of its current owner. */
  members: Map<string, string>;
  /** Vessel context → newest accepted HELLO, for the replay guard. */
  helloMarks: Map<string, HelloMark>;
  unsubscribes: Array<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  serverSelf: string | null;
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
    unsubscribes: [],
    timer: null,
    serverSelf: null
  };
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

function serverSelf(ctx: ServerContext): string | null {
  const fleet = ctx.fleet!;
  if (fleet.serverSelf === null) {
    try {
      fleet.serverSelf = resolveSelfContext(ctx.app);
    } catch {
      fleet.serverSelf = null;
    }
  }
  return fleet.serverSelf;
}

/** §15.6 rules 1-2: may `context` be sent to `session`? */
function contextInScope(ctx: ServerContext, session: ClientSession, context: string): boolean {
  const fleet = ctx.fleet!;
  if (!session.fleet || context === session.fleet.self || context === "vessels.self") {
    return false;
  }
  if (fleet.config.scope === "all") {
    return true;
  }
  if (memberSession(ctx, context)) {
    return true;
  }
  return fleet.config.includeServerVessel && context === serverSelf(ctx);
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
    const key = `${context}\u0000${sourceRef ?? ""}\u0000${entry.path}`;
    // Delete-then-set moves the key to the end, so flush order follows the
    // most recent change and a constantly-updating path cannot starve others.
    fleetSession.pending.delete(key);
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

function createSessionState(ctx: ServerContext, identity: FleetIdentity): FleetSessionState {
  const fleet = ctx.fleet!;
  const requested = identity.maxBytesPerSec;
  const bytesPerSec =
    requested && requested > 0
      ? Math.min(fleet.config.maxBytesPerSec, requested)
      : fleet.config.maxBytesPerSec;
  const metrics = ensureFleetMetrics(ctx.metrics);
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
      }
    }),
    lastSentAt: 0,
    lastSnapshotAt: 0,
    flushing: false,
    metaSent: new Set(),
    rateFactor: 1,
    lastBackoffAt: 0,
    lastRateIncreaseAt: Date.now()
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
  restarted: boolean
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
  ctx.fleet!.members.set(identity.self, session.key);
  refreshMemberCount(ctx);
  return !keepStream;
}

/** Snapshot for the new member, and the new member's values for the others. */
function queueJoinSnapshots(ctx: ServerContext, session: ClientSession, self: string): void {
  const fleetSession = session.fleet!;
  const now = Date.now();
  if (now - fleetSession.lastSnapshotAt < FLEET_SNAPSHOT_MIN_INTERVAL_MS) {
    return;
  }
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
  if (helloReplayed(ctx, session, identity, memberSession(ctx, identity.self), info.timestamp)) {
    ensureFleetMetrics(ctx.metrics).replayedHellos++;
    ctx.app.debug(`[fleet] replayed fleet HELLO for ${identity.self} from ${session.key} ignored`);
    return;
  }
  const newStream = claimMembership(ctx, session, identity, restarted);
  void answer(true);
  if (newStream) {
    queueJoinSnapshots(ctx, session, identity.self);
  }
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
