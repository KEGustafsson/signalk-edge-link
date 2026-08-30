"use strict";

/**
 * Signal K Edge Link - reliable client pipeline context.
 *
 * Holds the shared dependencies + mutable runtime state that the v2 client
 * pipeline closures used to capture lexically. The factory in
 * `../reliable-client.ts` constructs one `ClientContext`, and the extracted
 * module-level operations (delta-sender, metadata-sender, reliability,
 * metrics, control-packets, lifecycle) take it as an explicit parameter.
 *
 * Mutable scalars live under `mut` so helpers can read/write them through the
 * shared reference (closures previously mutated free variables directly).
 *
 * @module transport/pipeline/reliable-client/context
 */

import CircularBuffer from "../../../foundation/circular-buffer";
import {
  HELLO_RETRY_BASE_MS,
  UDP_RATE_LIMIT_MAX_PACKETS,
  UDP_RATE_LIMIT_WINDOW
} from "../../../foundation/constants";
import { PacketBuilder, PacketParser } from "../../../codec/packet-codec";
import { RetransmitQueue } from "../../reliability/retransmit-queue";
import { MetricsPublisher } from "../../metrics/publisher";
import { CongestionControl } from "../../congestion";
import { BondingManager } from "../../bonding";
import { createPathThrottleState, type PathThrottleState } from "../../../codec/delta-sanitizer";
import { createValueDedupState, type ValueDedupState } from "../../../codec/value-dedup";
import type {
  SignalKApp,
  MetricsApi,
  InstanceState,
  MonitoringState
} from "../../../foundation/types";

/** Reliability tuning derived once from `state.options.reliability`. */
export interface ReliabilitySettings {
  retransmitMaxAge: number;
  retransmitMinAge: number;
  retransmitRttMultiplier: number;
  ackIdleDrainAge: number;
  forceDrainAfterAckIdle: boolean;
  forceDrainAfterMs: number;
  recoveryBurstEnabled: boolean;
  recoveryBurstSize: number;
  recoveryBurstIntervalMs: number;
  recoveryAckGapMs: number;
}

/** Mutable runtime state shared across the pipeline operations. */
export interface ClientMutableState {
  congestionAdjustInterval: ReturnType<typeof setInterval> | null;
  bondingManager: BondingManager | null;
  metricsInterval: ReturnType<typeof setInterval> | null;
  lastMetricsTime: number;
  lastBytesSent: number;
  lastPacketsSent: number;
  lastRetransmissions: number;
  monitoringHooks: MonitoringState | null;
  metaRequestHandler: (() => void) | null;
  fullStatusRequestHandler: (() => void) | null;
  metaEnvelopeSeq: number;
  sourceEnvelopeSeq: number;
  lastAckedSeq: number | null;
  lastAckAt: number;
  lastAckRinfo: { address: string; port: number } | null;
  recoveryDrainTimer: ReturnType<typeof setInterval> | null;
  /** Heartbeat interval; owned by the pipeline so stop() can clear it. */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** When the last HELLO (initial, retry, or refresh) was sent. */
  lastHelloSentAt: number;
  /** Pending HELLO retry timer; cleared once the handshake is confirmed. */
  helloRetryTimer: ReturnType<typeof setTimeout> | null;
  /** Current HELLO retry backoff in ms. */
  helloRetryDelay: number;
  /** True once any control packet has proved the server sees this source port. */
  helloAcknowledged: boolean;
  recoveryDrainInFlight: boolean;
  telemetrySendInFlight: boolean;
}

/** Shared dependencies + state for the reliable client pipeline. */
export interface ClientContext {
  app: SignalKApp;
  state: InstanceState;
  metricsApi: MetricsApi;
  setStatus: (message: string, healthyOverride?: boolean) => void;
  throttleState: PathThrottleState;
  dedupState: ValueDedupState;
  protocolVersion: number;
  stretchAsciiKey: boolean;
  /** Monotonic per-connection epoch (set once at pipeline construction). Sent
   *  in the HELLO so the server can tell a legitimate restart (higher epoch,
   *  resets its anti-replay window) from a replayed old HELLO (epoch <= last). */
  connectionEpoch: number;
  clientTelemetrySource: string;
  packetBuilder: PacketBuilder;
  packetParser: PacketParser;
  retransmitQueue: RetransmitQueue;
  metricsPublisher: MetricsPublisher;
  congestionControl: CongestionControl;
  reliability: ReliabilitySettings;
  rttSamples: CircularBuffer<number>;
  lossWindow: CircularBuffer<boolean>;
  mut: ClientMutableState;
}

const LOSS_WINDOW_SIZE = 50;

/**
 * Keep the recovery-burst rate at or below the receiver's per-session packet
 * budget, leaving headroom for the live delta stream sharing that budget.
 */
function clampRecoveryBurst(
  size: number,
  intervalMs: number
): { recoveryBurstSize: number; recoveryBurstIntervalMs: number } {
  const interval = Math.max(1, intervalMs);
  // Half the server budget: retransmits must not crowd out fresh DATA.
  const maxPacketsPerWindow = (UDP_RATE_LIMIT_MAX_PACKETS / UDP_RATE_LIMIT_WINDOW) * interval * 0.5;
  const cap = Math.max(1, Math.floor(maxPacketsPerWindow));
  return {
    recoveryBurstSize: Math.max(1, Math.min(size, cap)),
    recoveryBurstIntervalMs: interval
  };
}

/** Derive reliability settings from the connection's reliability options. */
export function buildReliabilitySettings(
  reliabilityConfig: NonNullable<InstanceState["options"]>["reliability"] | undefined
): ReliabilitySettings {
  const cfg = reliabilityConfig || {};
  return {
    retransmitMaxAge: cfg.retransmitMaxAge ?? 120000,
    retransmitMinAge: cfg.retransmitMinAge ?? 10000,
    retransmitRttMultiplier: cfg.retransmitRttMultiplier ?? 12,
    ackIdleDrainAge: cfg.ackIdleDrainAge ?? 20000,
    forceDrainAfterAckIdle:
      cfg.forceDrainAfterAckIdle !== undefined ? !!cfg.forceDrainAfterAckIdle : false,
    forceDrainAfterMs: cfg.forceDrainAfterMs ?? 45000,
    recoveryBurstEnabled:
      cfg.recoveryBurstEnabled !== undefined ? !!cfg.recoveryBurstEnabled : true,
    // Clamp the burst to the receiver's own per-session budget. The server
    // admits UDP_RATE_LIMIT_MAX_PACKETS per UDP_RATE_LIMIT_WINDOW *before*
    // decrypt, counting retransmits; the previous default (100 per 200ms =
    // 500/s against a 200/s budget) had the server discard ~60% of the burst,
    // which suppressed the very ACKs that would end it.
    ...clampRecoveryBurst(cfg.recoveryBurstSize ?? 100, cfg.recoveryBurstIntervalMs ?? 200),
    recoveryAckGapMs: cfg.recoveryAckGapMs ?? 4000
  };
}

/** Construct the initial mutable runtime state for a fresh pipeline. */
export function createMutableState(): ClientMutableState {
  const now = Date.now();
  return {
    congestionAdjustInterval: null,
    bondingManager: null,
    metricsInterval: null,
    lastMetricsTime: now,
    lastBytesSent: 0,
    lastPacketsSent: 0,
    lastRetransmissions: 0,
    monitoringHooks: null,
    metaRequestHandler: null,
    fullStatusRequestHandler: null,
    metaEnvelopeSeq: 0,
    sourceEnvelopeSeq: 0,
    lastAckedSeq: null,
    lastAckAt: now,
    lastAckRinfo: null,
    recoveryDrainTimer: null,
    heartbeatTimer: null,
    lastHelloSentAt: 0,
    helloRetryTimer: null,
    helloRetryDelay: HELLO_RETRY_BASE_MS,
    helloAcknowledged: false,
    recoveryDrainInFlight: false,
    telemetrySendInFlight: false
  };
}

export function createThrottleState(): PathThrottleState {
  return createPathThrottleState();
}

export function createDedupState(): ValueDedupState {
  return createValueDedupState();
}

export { LOSS_WINDOW_SIZE };
