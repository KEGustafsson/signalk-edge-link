"use strict";

/**
 * Signal K Edge Link - Reliable Client Pipeline
 *
 * Handles delta transmission over the v3 reliable transport:
 * - Packet building with sequence numbers
 * - Encryption and compression (reuses v1 pipeline logic)
 * - UDP transmission
 * - Retransmission queue for reliability
 * - ACK/NAK handling for packet delivery confirmation
 *
 * Thin wiring layer: the inner operations live in ./reliable-client/* and take
 * a shared `ClientContext` as an explicit parameter. This factory constructs
 * the context and returns the public `ClientPipelineApi`.
 *
 * @module transport/pipeline/reliable-client
 */

import CircularBuffer from "../../foundation/circular-buffer";
import * as nodeCrypto from "node:crypto";
import { PacketBuilder, PacketParser } from "../../codec/packet-codec";
import { RetransmitQueue } from "../reliability/retransmit-queue";
import { MetricsPublisher } from "../metrics/publisher";
import { CongestionControl } from "../congestion";
import { BondingManager } from "../bonding";
import type {
  SignalKApp,
  MetricsApi,
  InstanceState,
  Delta,
  MonitoringState,
  MetaEntry
} from "../../foundation/types";
import * as dgram from "dgram";
import {
  ClientContext,
  buildReliabilitySettings,
  createMutableState,
  createThrottleState,
  createDedupState,
  LOSS_WINDOW_SIZE
} from "./reliable-client/context";
import { sendDelta } from "./reliable-client/delta-sender";
import { sendMetadata } from "./reliable-client/metadata-sender";
import { sendSourceSnapshot } from "./reliable-client/source-snapshot";
import { receiveACK, receiveNAK } from "./reliable-client/reliability";
import { handleControlPacket } from "./reliable-client/control-packets";
import { startMetricsPublishing, stopMetricsPublishing } from "./reliable-client/metrics";
import {
  startCongestionControl,
  stopCongestionControl,
  sendHello,
  startHeartbeat,
  initBonding,
  stopBonding
} from "./reliable-client/lifecycle";

/** Seed the four meta bandwidth counters so consumers see numeric zeros. */
function seedMetaBandwidthCounters(metrics: MetricsApi["metrics"]): void {
  const bw = metrics.bandwidth;
  if (!bw) {
    return;
  }
  if (bw.metaBytesOut === undefined) {
    bw.metaBytesOut = 0;
  }
  if (bw.metaPacketsOut === undefined) {
    bw.metaPacketsOut = 0;
  }
  if (bw.metaBytesIn === undefined) {
    bw.metaBytesIn = 0;
  }
  if (bw.metaPacketsIn === undefined) {
    bw.metaPacketsIn = 0;
  }
  if (bw.metaSnapshotsSent === undefined) {
    bw.metaSnapshotsSent = 0;
  }
  if (bw.metaDiffsSent === undefined) {
    bw.metaDiffsSent = 0;
  }
}

/** Build the v3 packet builder + parser for this session. */
function buildPacketCodecs(
  state: InstanceState,
  protocolVersion: number,
  stretchAsciiKey: boolean
): { packetBuilder: PacketBuilder; packetParser: PacketParser } {
  // Default ON (v3): authenticate DATA/METADATA headers unless explicitly
  // disabled. Both ends must agree (see connection schema).
  const authenticatedHeaders = state.options?.authenticatedHeaders !== false;
  const secretKey = state.options?.secretKey ?? undefined;

  // Randomize the initial DATA sequence number per session start (anti-replay
  // hardening). An explicit numeric `options.initialSequence` forces a
  // deterministic start; it exists only as a test seam.
  const explicitInitialSequence = (state.options as { initialSequence?: unknown })?.initialSequence;
  const initialSequence = Number.isInteger(explicitInitialSequence)
    ? (explicitInitialSequence as number) >>> 0
    : nodeCrypto.randomInt(1, 0x80000000);

  return {
    packetBuilder: new PacketBuilder({
      protocolVersion,
      secretKey,
      stretchAsciiKey,
      authenticatedHeaders,
      initialSequence
    }),
    packetParser: new PacketParser({ secretKey, stretchAsciiKey, authenticatedHeaders })
  };
}

/** Build the congestion controller, defaulting the nominal timer from state. */
function buildCongestionControl(state: InstanceState): CongestionControl {
  const rawCongestionConfig = (state.options && state.options.congestionControl) || {};
  return new CongestionControl({
    ...rawCongestionConfig,
    nominalDeltaTimer:
      rawCongestionConfig.nominalDeltaTimer !== undefined
        ? rawCongestionConfig.nominalDeltaTimer
        : state.deltaTimerTime
  });
}

/** Construct the shared client context (dependencies + reliability config). */
function buildClientContext(
  app: SignalKApp,
  state: InstanceState,
  metricsApi: MetricsApi
): ClientContext {
  const { metrics } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});
  // The reliable pipeline serves protocol v3 only (v2 was removed); control
  // packets are always HMAC-authenticated.
  const protocolVersion = 3;
  const stretchAsciiKey = !!state.options?.stretchAsciiKey;

  const { packetBuilder, packetParser } = buildPacketCodecs(
    state,
    protocolVersion,
    stretchAsciiKey
  );

  // Reliability: extract config once to avoid repetitive deep-access chains
  const reliabilityConfig = (state.options && state.options.reliability) || {};
  const retransmitQueue = new RetransmitQueue({
    maxSize: reliabilityConfig.retransmitQueueSize ?? 5000,
    maxRetransmits: reliabilityConfig.maxRetransmits ?? 3
  });

  // Reliability metrics
  metrics.retransmissions = metrics.retransmissions || 0;
  metrics.queueDepth = metrics.queueDepth || 0;
  metrics.rtt = metrics.rtt || 0;
  metrics.jitter = metrics.jitter || 0;

  // Network metrics publisher (namespaced per instance when instanceId is set)
  const metricsPublisher = new MetricsPublisher(app, {
    pathPrefix: state.instanceId
      ? `networking.edgeLink.${state.instanceId}`
      : "networking.edgeLink",
    sourceLabel: state.instanceId ? `signalk-edge-link:${state.instanceId}` : "signalk-edge-link"
  });

  const congestionControl = buildCongestionControl(state);

  seedMetaBandwidthCounters(metrics);

  return {
    app,
    state,
    metricsApi,
    setStatus,
    throttleState: createThrottleState(),
    dedupState: createDedupState(),
    protocolVersion,
    stretchAsciiKey,
    clientTelemetrySource: "signalk-edge-link-client-telemetry",
    packetBuilder,
    packetParser,
    retransmitQueue,
    metricsPublisher,
    congestionControl,
    reliability: buildReliabilitySettings(reliabilityConfig),
    // RTT tracking for jitter (CircularBuffer gives O(1) push w/ auto-eviction)
    rttSamples: new CircularBuffer<number>(10),
    lossWindow: new CircularBuffer<boolean>(LOSS_WINDOW_SIZE),
    mut: createMutableState()
  };
}

/** Send-path public API (deltas, metadata, source snapshots, handlers). */
function buildSendApi(ctx: ClientContext) {
  return {
    sendDelta(delta: Delta | Delta[], secretKey: string, udpAddress: string, udpPort: number) {
      return sendDelta(ctx, delta, secretKey, udpAddress, udpPort);
    },
    sendMetadata(
      entries: MetaEntry[],
      kind: "snapshot" | "diff",
      secretKey: string,
      udpAddress: string,
      udpPort: number
    ) {
      return sendMetadata(ctx, entries, kind, secretKey, udpAddress, udpPort);
    },
    sendSourceSnapshot(
      sources: Record<string, unknown>,
      secretKey: string,
      udpAddress: string,
      udpPort: number
    ) {
      return sendSourceSnapshot(ctx, sources, secretKey, udpAddress, udpPort);
    },
    setMetaRequestHandler(handler: (() => void) | null) {
      ctx.mut.metaRequestHandler = handler;
    },
    setFullStatusRequestHandler(handler: (() => void) | null) {
      ctx.mut.fullStatusRequestHandler = handler;
    },
    sendHello(udpAddress: string, udpPort: number) {
      return sendHello(ctx, udpAddress, udpPort);
    },
    startHeartbeat(udpAddress: string, udpPort: number, options?: { heartbeatInterval?: number }) {
      return startHeartbeat(ctx, udpAddress, udpPort, options);
    }
  };
}

/** Accessor + receive + lifecycle public API. */
function buildControlApi(ctx: ClientContext) {
  return {
    getPacketBuilder(): PacketBuilder {
      return ctx.packetBuilder;
    },
    getRetransmitQueue(): RetransmitQueue {
      return ctx.retransmitQueue;
    },
    getMetricsPublisher(): MetricsPublisher {
      return ctx.metricsPublisher;
    },
    getCongestionControl(): CongestionControl {
      return ctx.congestionControl;
    },
    getBondingManager(): BondingManager | null {
      return ctx.mut.bondingManager;
    },
    receiveACK(parsed: Parameters<typeof receiveACK>[1], rinfo: dgram.RemoteInfo) {
      return receiveACK(ctx, parsed, rinfo);
    },
    receiveNAK(parsed: Parameters<typeof receiveNAK>[1], udpAddress: string, udpPort: number) {
      return receiveNAK(ctx, parsed, udpAddress, udpPort);
    },
    handleControlPacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
      return handleControlPacket(ctx, msg, rinfo);
    },
    startMetricsPublishing() {
      return startMetricsPublishing(ctx);
    },
    stopMetricsPublishing() {
      return stopMetricsPublishing(ctx);
    },
    startCongestionControl() {
      return startCongestionControl(ctx);
    },
    stopCongestionControl() {
      return stopCongestionControl(ctx);
    },
    initBonding(bondingConfig: Record<string, unknown>) {
      return initBonding(ctx, bondingConfig);
    },
    stopBonding() {
      return stopBonding(ctx);
    },
    setMonitoring(hooks: MonitoringState | null) {
      ctx.mut.monitoringHooks = hooks;
    }
  };
}

/**
 * Creates the reliable (v3) client pipeline
 * @param app       - SignalK app object (for logging)
 * @param state     - Shared mutable state
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API
 */
function createPipelineV2Client(app: SignalKApp, state: InstanceState, metricsApi: MetricsApi) {
  const ctx = buildClientContext(app, state, metricsApi);
  return { ...buildSendApi(ctx), ...buildControlApi(ctx) };
}

export { createPipelineV2Client };
