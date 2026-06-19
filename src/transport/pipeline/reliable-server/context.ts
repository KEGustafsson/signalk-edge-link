"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: shared context
 *
 * Holds the shared mutable state and dependencies for the v3 reliable server
 * pipeline. The factory (`createPipelineV2Server`) constructs one `ServerContext`
 * and the per-packet-type handlers and helpers in sibling modules take it as an
 * explicit parameter, replacing the closures that previously captured this state.
 *
 * @module transport/pipeline/reliable-server/context
 */

import * as crypto from "node:crypto";
import { normalizeKey } from "../../../codec/crypto";
import { PacketBuilder, PacketParser } from "../../../codec/packet-codec";
import { SequenceTracker } from "../../reliability/sequence";
import { MetricsPublisher } from "../../metrics/publisher";
import type { ValueDedupState } from "../../../codec/value-dedup";
import type { SignalKApp, MetricsApi, InstanceState } from "../../../foundation/types";

import {
  MAX_CLIENT_SESSIONS,
  UDP_RATE_LIMIT_WINDOW,
  UDP_RATE_LIMIT_MAX_PACKETS
} from "../../../foundation/constants";

export interface ClientSession {
  key: string;
  sourceClientInstanceId: string | null;
  clientId: string | null;
  address: string;
  port: number;
  sequenceTracker: SequenceTracker;
  lastAckSeq: number | null;
  lastAckSentAt: number;
  hasReceivedData: boolean;
  lastPacketTime: number;
  lossBaseSeq: number | null;
  lossHighestSeq: number | null;
  lossReceivedCount: number;
  lastLossExpected: number;
  lastLossReceived: number;
  rateLimitCount: number;
  rateLimitWindowStart: number;
  /** True once we have emitted a META_REQUEST to this client. Used to cap
   *  outbound META_REQUEST traffic at exactly one per session lifetime. */
  metaRequested: boolean;
  /** True once we have emitted a FULL_STATUS_REQUEST to this client. Used to
   *  cap outbound requests at exactly one per session lifetime. Reset on
   *  sender-restart detection so a restarted client gets re-primed. */
  statusRequested: boolean;
  /** Last observed meta-envelope seq, used to drop stale/duplicate envelopes
   *  that UDP reorders or replays. null until the first envelope from this
   *  session arrives. */
  lastMetaEnvSeq: number | null;
  /** Set of chunk `idx` values already processed for `lastMetaEnvSeq`. Lets
   *  us drop exact duplicates of a chunk we've already applied without
   *  rejecting other chunks (different idx, same seq) of the same multi-
   *  chunk batch. Cleared when `lastMetaEnvSeq` advances. */
  seenMetaChunkIdx: Set<number>;
  /** Last observed source snapshot envelope seq; kept separate from metadata
   *  seq so source resends cannot make in-flight metadata chunks look stale. */
  lastSourceEnvSeq: number | null;
  /** Chunk indexes already applied for `lastSourceEnvSeq`. */
  seenSourceChunkIdx: Set<number>;
  /** Per-(context, path) cache for same-as-last value dedup expansion.
   *  Created lazily on first sentinel/absolute-value receipt. */
  valueDedupState: ValueDedupState | null;
}

/**
 * Mutable scalar state shared across handlers. Grouped into one object so
 * helper modules can mutate these "let"-style values by reference, exactly as
 * the original closures did.
 */
export interface ServerMutableState {
  ackTimer: ReturnType<typeof setInterval> | null;
  metricsInterval: ReturnType<typeof setInterval> | null;
  lastMetricsTime: number;
  lastBytesReceived: number;
  lastPacketsReceived: number;
  previousSourceMissingIdentity: number;
  previousSourceConflicts: number;
  lastProtocolVersionMismatchWarnAt: number;
  lastAuthHeaderMismatchWarnAt: number;
  telemetryOwnerSessionKey: string | null;
  telemetryOwnerLastSeen: number;
}

export interface ServerContext {
  app: SignalKApp;
  state: InstanceState;
  metricsApi: MetricsApi;
  metrics: MetricsApi["metrics"];
  recordError: MetricsApi["recordError"];
  trackPathStats: MetricsApi["trackPathStats"];
  updateBandwidthRates: MetricsApi["updateBandwidthRates"];

  protocolVersion: number;
  stretchAsciiKey: boolean;
  authenticatedHeaders: boolean;
  packetParser: PacketParser;
  packetBuilder: PacketBuilder;
  metricsPublisher: MetricsPublisher;

  // Config constants
  CLIENT_TELEMETRY_SOURCE: string;
  CLIENT_TELEMETRY_PATHS: Set<string>;
  REMOTE_TELEMETRY_TTL_MS: number;
  ackInterval: number;
  ackResendInterval: number;
  nakTimeout: number;
  SESSION_IDLE_TTL_MS: number;
  MAX_SESSIONS_PER_IP: number;
  META_RESTART_THRESHOLD: number;
  MAX_ENVELOPE_CHUNK_INDICES: number;
  BONDING_HMAC_TAG_LENGTH: number;
  PROTOCOL_VERSION_MISMATCH_WARN_INTERVAL_MS: number;

  // Shared state
  clientSessions: Map<string, ClientSession>;
  preAuthByIp: Map<string, { count: number; windowStart: number }>;
  mut: ServerMutableState;
}

export interface CreateContextDeps {
  app: SignalKApp;
  state: InstanceState;
  metricsApi: MetricsApi;
}

/** Seed the reliability counters so consumers always see numeric zeros. */
function seedServerReliabilityMetrics(metrics: MetricsApi["metrics"]): void {
  metrics.acksSent = metrics.acksSent || 0;
  metrics.naksSent = metrics.naksSent || 0;
  metrics.duplicatePackets = metrics.duplicatePackets || 0;
  metrics.dataPacketsReceived = metrics.dataPacketsReceived || 0;
}

/**
 * Construct the shared server context. Mirrors the original factory's setup of
 * deps, config constants and shared mutable state.
 */
export function createServerContext(deps: CreateContextDeps): ServerContext {
  const { app, state, metricsApi } = deps;
  const { metrics, recordError, trackPathStats, updateBandwidthRates } = metricsApi;

  const protocolVersion = 3;
  const stretchAsciiKey = !!state.options?.stretchAsciiKey;
  const authenticatedHeaders = !!state.options?.authenticatedHeaders;
  const packetParser = new PacketParser({
    secretKey: state.options?.secretKey ?? undefined,
    stretchAsciiKey,
    authenticatedHeaders
  });
  const packetBuilder = new PacketBuilder({
    protocolVersion,
    secretKey: state.options?.secretKey ?? undefined,
    stretchAsciiKey,
    authenticatedHeaders
  });

  const reliabilityConfig = (state.options && state.options.reliability) || {};
  const ackInterval: number = reliabilityConfig.ackInterval ?? 100;
  const ackResendInterval: number = reliabilityConfig.ackResendInterval ?? 1000;
  const nakTimeout: number = reliabilityConfig.nakTimeout || 100;

  seedServerReliabilityMetrics(metrics);

  const metricsPublisher = new MetricsPublisher(app, {
    pathPrefix: state.instanceId
      ? `networking.edgeLink.${state.instanceId}`
      : "networking.edgeLink",
    sourceLabel: state.instanceId ? `signalk-edge-link:${state.instanceId}` : "signalk-edge-link"
  });

  return {
    app,
    state,
    metricsApi,
    metrics,
    recordError,
    trackPathStats,
    updateBandwidthRates,

    protocolVersion,
    stretchAsciiKey,
    authenticatedHeaders,
    packetParser,
    packetBuilder,
    metricsPublisher,

    CLIENT_TELEMETRY_SOURCE: "signalk-edge-link-client-telemetry",
    CLIENT_TELEMETRY_PATHS: new Set([
      "networking.edgeLink.rtt",
      "networking.edgeLink.jitter",
      "networking.edgeLink.packetLoss",
      "networking.edgeLink.retransmissions",
      "networking.edgeLink.queueDepth",
      "networking.edgeLink.retransmitRate",
      "networking.edgeLink.activeLink"
    ]),
    REMOTE_TELEMETRY_TTL_MS: 15000,
    ackInterval,
    ackResendInterval,
    nakTimeout,
    SESSION_IDLE_TTL_MS: 300000,
    MAX_SESSIONS_PER_IP: 5,
    META_RESTART_THRESHOLD: 8,
    MAX_ENVELOPE_CHUNK_INDICES: 8192,
    BONDING_HMAC_TAG_LENGTH: 8,
    PROTOCOL_VERSION_MISMATCH_WARN_INTERVAL_MS: 60_000,

    clientSessions: new Map<string, ClientSession>(),
    preAuthByIp: new Map<string, { count: number; windowStart: number }>(),
    mut: {
      ackTimer: null,
      metricsInterval: null,
      lastMetricsTime: Date.now(),
      lastBytesReceived: 0,
      lastPacketsReceived: 0,
      previousSourceMissingIdentity: 0,
      previousSourceConflicts: 0,
      lastProtocolVersionMismatchWarnAt: 0,
      lastAuthHeaderMismatchWarnAt: 0,
      telemetryOwnerSessionKey: null,
      telemetryOwnerLastSeen: 0
    }
  };
}

/**
 * Pre-authentication per-source-IP packet limiter. Bounds the work an
 * unauthenticated peer can force before we have a long-lived session.
 */
export function preAuthRateLimited(ctx: ServerContext, address: string): boolean {
  const { preAuthByIp } = ctx;
  const now = Date.now();
  let entry = preAuthByIp.get(address);
  if (!entry || now - entry.windowStart >= UDP_RATE_LIMIT_WINDOW) {
    entry = { count: 0, windowStart: now };
    preAuthByIp.set(address, entry);
    // Opportunistically prune stale IP entries so the map cannot grow without
    // bound under source-IP spoofing.
    if (preAuthByIp.size > MAX_CLIENT_SESSIONS * 4) {
      for (const [ip, e] of preAuthByIp) {
        if (now - e.windowStart >= UDP_RATE_LIMIT_WINDOW) {
          preAuthByIp.delete(ip);
        }
      }
    }
  }
  entry.count++;
  return entry.count > UDP_RATE_LIMIT_MAX_PACKETS;
}

/**
 * Verify a bonding heartbeat probe's truncated HMAC tag. Returns true when no
 * secret is configured (open mode) or when the tag is valid.
 */
export function verifyHbProbe(ctx: ServerContext, packet: Buffer): boolean {
  const secretKey = ctx.state.options?.secretKey;
  if (!secretKey) {
    // No shared secret: probes are not authenticated (open mode). Still
    // require the minimal 12-byte header so we don't reflect junk.
    return packet.length >= 12;
  }
  const minLen = 12 + ctx.BONDING_HMAC_TAG_LENGTH;
  if (packet.length < minLen) {
    return false;
  }
  try {
    const header = packet.subarray(0, 12);
    const keyBuffer = normalizeKey(secretKey, { stretchAsciiKey: ctx.stretchAsciiKey });
    const expectedTag = crypto
      .createHmac("sha256", keyBuffer)
      .update(header)
      .digest()
      .subarray(0, ctx.BONDING_HMAC_TAG_LENGTH);
    const receivedTag = packet.subarray(12, 12 + ctx.BONDING_HMAC_TAG_LENGTH);
    return crypto.timingSafeEqual(expectedTag, receivedTag);
  } catch {
    return false;
  }
}
