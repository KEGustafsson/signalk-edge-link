"use strict";

/** L0 foundation types — pipeline. */

import type { MonitoringState } from "./monitoring";
import type { Delta, MetaEntry } from "./signalk";

// ── Protocol Types ──────────────────────────────────────────────────────────

/** Packet flag bits. */
export interface PacketFlags {
  compressed: boolean;
  encrypted: boolean;
  messagepack: boolean;
  pathDictionary: boolean;
}

/** Parsed v2/v3 packet header. */
export interface PacketHeader {
  version: number;
  type: number;
  typeName: string;
  flags: PacketFlags;
  sequence: number;
  payloadLength: number;
  payload: Buffer;
}

// ── Pipeline API Interfaces ──────────────────────────────────────────────────

/** Structural interface for the bonding manager returned by getBondingManager(). */
export interface BondingManagerApi {
  getState(): {
    enabled: boolean;
    mode: string;
    activeLink: string;
    lastFailoverTime: number;
    failoverThresholds: Record<string, number>;
    links: Record<string, unknown>;
  };
  forceFailover(): void;
  getActiveLinkName(): string;
  getLinkHealth(): Record<
    string,
    {
      address: string;
      port: number;
      status: string;
      rtt: number;
      loss: number;
      quality: number;
      heartbeatsSent: number;
      heartbeatResponses: number;
    }
  >;
  failoverThresholds: Record<string, number>;
}

/** Structural interface for the congestion controller returned by getCongestionControl(). */
export interface CongestionControlApi {
  getState(): {
    enabled: boolean;
    manualMode: boolean;
    currentDeltaTimer: number;
    nominalDeltaTimer: number;
    avgRTT: number;
    avgLoss: number;
    targetRTT: number;
    minDeltaTimer: number;
    maxDeltaTimer: number;
    adjustInterval: number;
    maxAdjustment: number;
  };
  enableAutoMode(): void;
  getCurrentDeltaTimer(): number;
  setManualDeltaTimer(value: number): void;
}

/** Structural interface for the metrics publisher exposed by getMetricsPublisher(). */
export interface MetricsPublisherApi {
  calculateLinkQuality(params: {
    rtt: number;
    jitter: number;
    packetLoss: number;
    retransmitRate: number;
  }): number;
  publish(metrics: Record<string, number | string | undefined>): void;
  publishLinkMetrics(linkName: string, metrics: Record<string, number | undefined>): void;
}

/** Public API returned by createPipelineV2Client(). */
export interface ClientPipelineApi {
  sendDelta(
    deltas: Delta | Delta[],
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
  /**
   * Send a batch of metadata entries to the receiver. Handles chunking, the
   * shared compress/encrypt pipeline, and the appropriate transport envelope
   * (packet type 0x06 on v2/v3; "SKM1" magic on a separate UDP port for v1).
   */
  sendMetadata?(
    entries: MetaEntry[],
    kind: "snapshot" | "diff",
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
  /**
   * Transmit the current Signal K `/sources` tree to the receiver. The client
   * pipeline owns packetization and best-effort UDP sending; callers provide a
   * point-in-time snapshot and may omit the call when no sources are available.
   */
  sendSourceSnapshot?(
    sources: Record<string, unknown>,
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
  /** Register a callback fired when the receiver sends a META_REQUEST packet. */
  setMetaRequestHandler?(handler: (() => void) | null): void;
  /** Register a callback fired when the server sends a FULL_STATUS_REQUEST packet. */
  setFullStatusRequestHandler?(handler: (() => void) | null): void;
  handleControlPacket(msg: Buffer, rinfo: import("dgram").RemoteInfo): Promise<void>;
  startMetricsPublishing(): void;
  stopMetricsPublishing(): void;
  startCongestionControl(): void;
  stopCongestionControl(): void;
  startHeartbeat(
    address: string,
    port: number,
    options?: { heartbeatInterval?: number }
  ): { stop(): void };
  /**
   * Send a HELLO packet so the server can populate `session.clientId` and
   * admit subsequent telemetry through its `peerIdentified` gate. Required
   * after socket creation and after every socket recovery; safe to call
   * periodically as a re-identification refresh.
   */
  sendHello(address: string, port: number): Promise<void>;
  initBonding(config: Record<string, unknown>): Promise<BondingManagerApi>;
  stopBonding(): void;
  getBondingManager(): BondingManagerApi | null;
  getCongestionControl(): CongestionControlApi;
  getMetricsPublisher(): MetricsPublisherApi;
  getPacketBuilder(): unknown;
  getRetransmitQueue(): unknown;
  setMonitoring(hooks: MonitoringState | null): void;
}

/** Public API returned by createPipelineV2Server(). */
export interface ServerPipelineApi {
  receivePacket(
    packet: Buffer,
    secretKey: string,
    rinfo: import("dgram").RemoteInfo
  ): Promise<void>;
  startACKTimer(): void;
  stopACKTimer(): void;
  startMetricsPublishing(): void;
  stopMetricsPublishing(): void;
  getSequenceTracker(): { reset(): void } | undefined;
  getPacketBuilder(): unknown;
  getMetrics(): unknown;
  getMetricsPublisher(): MetricsPublisherApi;
  requestFullStatusFromAllClients(): void;
}

export {};
