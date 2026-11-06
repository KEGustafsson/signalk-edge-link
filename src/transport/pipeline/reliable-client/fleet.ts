"use strict";

/**
 * Signal K Edge Link - reliable client: fleet sharing receiver
 *
 * Requests other vessels' data from the server and writes it into the local
 * Signal K tree (protocol-v3-spec §15). Responsibilities:
 *
 * - HELLO fields: `fleet-v1` capability plus the encrypted identity with a
 *   fresh nonce per HELLO. Disabled → no fields, HELLO bytes unchanged.
 * - HELLO_ACK: adopt the server's stream only for the latest nonce; report
 *   `active`, `declined` or (after silence) `not-offered`.
 * - FLEET_DATA: rate cap, stream check, decrypt, replay window, sequence
 *   tracking, dispatch, FLEET_ACK / FLEET_NAK.
 * - Loop guard: every context received here is recorded in
 *   `state.fleetLearnedContexts`, which the uplink drops (§15.7).
 *
 * @module transport/pipeline/reliable-client/fleet
 */

import { SequenceTracker } from "../../reliability/sequence";
import { ReplayWindow } from "../../reliability/replay-window";
import { encodeFleetIdentity, newFleetNonce } from "../../../codec/fleet-identity";
import { decodeFleetPayload } from "../../../codec/fleet-payload";
import { resolveSelfContext } from "../../../codec/metadata/collect";
import { ParsedPacket } from "../../../codec/packet-codec";
import {
  FLEET_CAPABILITY,
  FLEET_LIVENESS_TIMEOUT_MS,
  FLEET_HELLO_ATTEMPTS_BEFORE_NOT_OFFERED,
  FLEET_ACK_MIN_INTERVAL_MS,
  FLEET_MAX_INBOUND_PACKETS_PER_SEC,
  FLEET_MAX_NAK_SEQUENCES,
  HELLO_PAYLOAD_MAX_BYTES
} from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type {
  Delta,
  FleetClientState,
  InstanceState,
  PathFilterConfig
} from "../../../foundation/types";
import type { ClientContext } from "./context";
import { udpSendAsync } from "./lifecycle";
import { dispatchFleetDeltas } from "./fleet-dispatch";

/** Capabilities a current client advertises without fleet sharing. */
const BASE_CAPABILITIES = ["compression", "encryption", "reliability", "authenticated-control"];
const RECENT_NONCES = 4;

/** Client fleet runtime; null on the context when fleet sharing is off. */
export interface FleetClientRuntime {
  pathFilter: PathFilterConfig | null;
  maxBytesPerSec: number | null;
  self: string | null;
  /** Nonce of the most recent HELLO. Only its HELLO_ACK may change the stream. */
  nonce: string | null;
  recentNonces: string[];
  helloAttemptsWithoutAck: number;
  stream: number | null;
  tracker: SequenceTracker;
  replay: ReplayWindow;
  learnedContexts: Set<string>;
  /** Newest applied timestamp per (context, $source, path). A retransmitted
   *  packet can arrive after a newer one; its older values must not win. */
  appliedTimes: Map<string, number>;
  lastFleetPacketAt: number;
  lastAckSentAt: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  inboundWindowStart: number;
  inboundCount: number;
}

/** Build the runtime when the connection asks for fleet sharing. */
export function createFleetClientRuntime(
  state: InstanceState,
  onLoss: (missing: number[]) => void
): FleetClientRuntime | null {
  const options = state.options;
  const fleet = options?.fleetSharing;
  // Fleet sharing over bonded links is out of scope (FLEET-FUT-001).
  if (!fleet?.enabled || options?.bonding?.enabled) {
    return null;
  }
  const learnedContexts = new Set<string>();
  state.fleetLearnedContexts = learnedContexts;
  const reliability = options?.reliability || {};
  return {
    pathFilter:
      fleet.pathFilter && (fleet.pathFilter.allow?.length || fleet.pathFilter.deny?.length)
        ? { allow: fleet.pathFilter.allow ?? [], deny: fleet.pathFilter.deny ?? [] }
        : null,
    maxBytesPerSec:
      typeof fleet.maxBytesPerSec === "number" && fleet.maxBytesPerSec > 0
        ? Math.floor(fleet.maxBytesPerSec)
        : null,
    self: null,
    nonce: null,
    recentNonces: [],
    helloAttemptsWithoutAck: 0,
    stream: null,
    tracker: new SequenceTracker({
      nakTimeout: reliability.nakTimeout || 100,
      maxNakRounds: reliability.maxNakRounds || 5,
      onLossDetected: onLoss
    }),
    replay: new ReplayWindow(),
    learnedContexts,
    appliedTimes: new Map(),
    lastFleetPacketAt: Date.now(),
    lastAckSentAt: 0,
    ackTimer: null,
    inboundWindowStart: 0,
    inboundCount: 0
  };
}

function setState(ctx: ClientContext, value: FleetClientState): void {
  ensureFleetMetrics(ctx.metricsApi.metrics).state = value;
}

/**
 * Extra HELLO fields for fleet sharing, or `{}` when disabled. Each call mints
 * a new nonce, so it must be called once per HELLO actually sent.
 */
export function fleetHelloFields(ctx: ClientContext): { capabilities?: string[]; fleet?: string } {
  const fleet = ctx.fleet;
  const secretKey = ctx.state.options?.secretKey;
  if (!fleet || !secretKey) {
    return {};
  }
  if (!fleet.self) {
    try {
      fleet.self = resolveSelfContext(ctx.app);
    } catch {
      fleet.self = null;
    }
  }
  if (!fleet.self) {
    // Own vessel not known yet (tree still empty at startup); a later HELLO
    // retry, refresh or liveness HELLO will carry the request.
    ctx.app.debug("[fleet] own vessel context unknown; HELLO sent without fleet request");
    // Fleet sharing is requested but cannot be offered yet: report `offered`,
    // which is what troubleshooting tells operators to look for here.
    if (ensureFleetMetrics(ctx.metricsApi.metrics).state === "disabled") {
      setState(ctx, "offered");
    }
    return {};
  }
  const nonce = newFleetNonce();
  let field: string;
  try {
    field = encodeFleetIdentity(
      {
        self: fleet.self,
        nonce,
        ...(fleet.pathFilter ? { pathFilter: fleet.pathFilter } : {}),
        ...(fleet.maxBytesPerSec ? { maxBytesPerSec: fleet.maxBytesPerSec } : {})
      },
      secretKey,
      { stretchAsciiKey: ctx.stretchAsciiKey }
    );
  } catch (err: unknown) {
    ctx.app.error(`[fleet] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  fleet.nonce = nonce;
  fleet.recentNonces.push(nonce);
  if (fleet.recentNonces.length > RECENT_NONCES) {
    fleet.recentNonces.shift();
  }
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  if (metrics.state !== "active") {
    fleet.helloAttemptsWithoutAck++;
    if (metrics.state === "disabled") {
      setState(ctx, "offered");
    }
  }
  return { capabilities: [...BASE_CAPABILITIES, FLEET_CAPABILITY], fleet: field };
}

function peer(ctx: ClientContext): { address: string; port: number } | null {
  const options = ctx.state.options;
  if (!options?.udpAddress || !options.udpPort) {
    return null;
  }
  return { address: options.udpAddress, port: options.udpPort };
}

async function sendFleetControl(ctx: ClientContext, packet: Buffer): Promise<void> {
  const dest = peer(ctx);
  if (!dest) {
    return;
  }
  await udpSendAsync(ctx, packet, dest.address, dest.port);
}

/** Send the cumulative FLEET_ACK now. */
function sendAck(ctx: ClientContext): void {
  const fleet = ctx.fleet;
  if (!fleet || fleet.stream === null || fleet.tracker.expectedSeq === null) {
    return;
  }
  const cumulative = (fleet.tracker.expectedSeq - 1) >>> 0;
  fleet.lastAckSentAt = Date.now();
  const packet = ctx.packetBuilder.buildFleetAckPacket(fleet.stream, cumulative);
  ensureFleetMetrics(ctx.metricsApi.metrics).acksSent++;
  sendFleetControl(ctx, packet).catch((err: unknown) => {
    ctx.app.debug(
      `[fleet] FLEET_ACK send failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

/** ACK at most every FLEET_ACK_MIN_INTERVAL_MS; a trailing ACK covers bursts. */
function scheduleAck(ctx: ClientContext): void {
  const fleet = ctx.fleet;
  if (!fleet || fleet.ackTimer) {
    return;
  }
  const wait = FLEET_ACK_MIN_INTERVAL_MS - (Date.now() - fleet.lastAckSentAt);
  if (wait <= 0) {
    sendAck(ctx);
    return;
  }
  fleet.ackTimer = setTimeout(() => {
    fleet.ackTimer = null;
    sendAck(ctx);
  }, wait);
  if (typeof fleet.ackTimer.unref === "function") {
    fleet.ackTimer.unref();
  }
}

/** SequenceTracker loss callback: NAK the gaps on the current stream. */
export function sendFleetNak(ctx: ClientContext, missing: number[]): void {
  const fleet = ctx.fleet;
  if (!fleet || fleet.stream === null || missing.length === 0) {
    return;
  }
  const packet = ctx.packetBuilder.buildFleetNakPacket(
    fleet.stream,
    missing.slice(0, FLEET_MAX_NAK_SEQUENCES)
  );
  ensureFleetMetrics(ctx.metricsApi.metrics).naksSent++;
  sendFleetControl(ctx, packet).catch((err: unknown) => {
    ctx.app.debug(
      `[fleet] FLEET_NAK send failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

function adoptStream(fleet: FleetClientRuntime, stream: number): void {
  fleet.stream = stream;
  fleet.tracker.reset();
  // Every stream starts at sequence 0 (§15.4); seeding the baseline lets a
  // lost first packet be NAKed instead of silently skipped.
  fleet.tracker.expectedSeq = 0;
  fleet.replay.reset();
}

/** HELLO_ACK (0x09): capability answer and fleet keepalive. */
export function handleHelloAck(ctx: ClientContext, parsed: ParsedPacket): void {
  const fleet = ctx.fleet;
  if (!fleet || parsed.payload.length > HELLO_PAYLOAD_MAX_BYTES) {
    return;
  }
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(parsed.payload.toString("utf8"));
  } catch {
    metrics.rejectedPackets++;
    return;
  }
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!fleet.recentNonces.includes(nonce)) {
    // Answer to a HELLO we did not send recently: replayed or stale.
    metrics.rejectedPackets++;
    return;
  }
  fleet.lastFleetPacketAt = Date.now();
  fleet.helloAttemptsWithoutAck = 0;
  const accepted = Array.isArray(body.accepted) && body.accepted.includes(FLEET_CAPABILITY);
  const info = body.fleet as Record<string, unknown> | undefined;
  const stream = typeof info?.stream === "number" ? info.stream >>> 0 : null;
  if (!accepted || stream === null) {
    if (nonce === fleet.nonce) {
      fleet.stream = null;
      setState(ctx, "declined");
    }
    return;
  }
  if (nonce === fleet.nonce && stream !== fleet.stream) {
    adoptStream(fleet, stream);
    ctx.app.debug(`[fleet] fleet stream ${stream} active`);
    // Confirms the stream from this address (§15.4): the server holds all but
    // one FLEET_DATA until a FLEET_ACK or FLEET_NAK for the stream arrives.
    sendAck(ctx);
  }
  if (fleet.stream !== null) {
    setState(ctx, "active");
  }
}

function inboundRateLimited(fleet: FleetClientRuntime, now: number): boolean {
  if (now - fleet.inboundWindowStart >= 1000) {
    fleet.inboundWindowStart = now;
    fleet.inboundCount = 0;
  }
  fleet.inboundCount++;
  return fleet.inboundCount > FLEET_MAX_INBOUND_PACKETS_PER_SEC;
}

/** Rate cap, stream check and decrypt. Null when the packet is rejected. */
async function admitFleetPacket(
  ctx: ClientContext,
  fleet: FleetClientRuntime,
  parsed: ParsedPacket,
  now: number
): Promise<{ stream: number; deltas: Delta[] } | null> {
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  const secretKey = ctx.state.options?.secretKey;
  if (!secretKey || fleet.stream === null || inboundRateLimited(fleet, now)) {
    metrics.rejectedPackets++;
    return null;
  }
  const { stream, encrypted } = ctx.packetParser.parseFleetDataPayload(parsed.payload);
  if (stream !== fleet.stream) {
    metrics.rejectedPackets++;
    return null;
  }
  try {
    const deltas = await decodeFleetPayload(encrypted, parsed.flags, {
      secretKey,
      stretchAsciiKey: ctx.stretchAsciiKey
    });
    return { stream, deltas };
  } catch (err: unknown) {
    metrics.rejectedPackets++;
    ctx.app.debug(
      `[fleet] FLEET_DATA decode failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** FLEET_DATA (0x0A): verify, decode and write other vessels into the tree. */
export async function handleFleetData(ctx: ClientContext, parsed: ParsedPacket): Promise<void> {
  const fleet = ctx.fleet;
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  if (!fleet) {
    metrics.rejectedPackets++;
    return;
  }
  const now = Date.now();
  const admitted = await admitFleetPacket(ctx, fleet, parsed, now);
  if (!admitted || fleet.stream !== admitted.stream) {
    return;
  }
  const seq = parsed.sequence >>> 0;
  const fresh = fleet.replay.accept(seq);
  const seqResult = fresh ? fleet.tracker.processSequence(seq) : null;
  if (!seqResult || seqResult.duplicate || seqResult.lateArrival) {
    metrics.duplicatePackets++;
    scheduleAck(ctx);
    return;
  }
  fleet.lastFleetPacketAt = now;
  metrics.packetsReceived++;
  dispatchFleetDeltas(ctx, fleet, admitted.deltas);
  scheduleAck(ctx);
}

/**
 * Periodic fleet liveness (called from the metrics tick). Re-HELLOs when no
 * fleet packet has arrived for FLEET_LIVENESS_TIMEOUT_MS, and reports
 * `not-offered` after repeated unanswered HELLOs. `resendHello` sends a HELLO
 * through the normal path so it carries a fresh nonce.
 */
export function fleetMaintenance(ctx: ClientContext, resendHello: () => void): void {
  const fleet = ctx.fleet;
  if (!fleet || ctx.state.stopped) {
    return;
  }
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  const now = Date.now();
  if (
    metrics.state !== "active" &&
    fleet.helloAttemptsWithoutAck >= FLEET_HELLO_ATTEMPTS_BEFORE_NOT_OFFERED
  ) {
    // Old server or feature unreachable: stop the extra HELLOs and rely on
    // the normal HELLO refresh, which still carries the request.
    if (metrics.state !== "not-offered" && metrics.state !== "declined") {
      setState(ctx, "not-offered");
    }
    return;
  }
  if (metrics.state === "declined" || metrics.state === "not-offered") {
    return;
  }
  const silentFor = now - fleet.lastFleetPacketAt;
  const sinceHello = now - ctx.mut.lastHelloSentAt;
  if (silentFor >= FLEET_LIVENESS_TIMEOUT_MS && sinceHello >= FLEET_LIVENESS_TIMEOUT_MS) {
    ctx.app.debug(`[fleet] no fleet packet for ${silentFor}ms; re-sending HELLO`);
    if (metrics.state === "active") {
      setState(ctx, "offered");
    }
    resendHello();
  }
}

/** Clear timers and sequence state (pipeline stop). */
export function stopFleetClient(ctx: ClientContext): void {
  const fleet = ctx.fleet;
  if (!fleet) {
    return;
  }
  if (fleet.ackTimer) {
    clearTimeout(fleet.ackTimer);
    fleet.ackTimer = null;
  }
  // Clearing the stream makes a FLEET_DATA still decoding when stop() runs
  // fail the stream check instead of being dispatched and ACKed after stop.
  fleet.stream = null;
  fleet.tracker.reset();
}
