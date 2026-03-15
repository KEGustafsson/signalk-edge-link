"use strict";

/**
 * Signal K Edge Link - Shared Type Definitions
 *
 * TypeScript interfaces and types for core data structures used across the codebase.
 *
 * @module lib/types
 */

// ── Signal K Types ──────────────────────────────────────────────────────────

/** A Signal K delta value entry. */
export interface DeltaValue {
  path: string;
  value: unknown;
}

/** A Signal K delta update block. */
export interface DeltaUpdate {
  source?: {
    label?: string;
    type?: string;
  };
  timestamp?: string;
  values: DeltaValue[];
}

/** A Signal K delta message. */
export interface Delta {
  context: string;
  updates: DeltaUpdate[];
}

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

// ── Configuration Types ─────────────────────────────────────────────────────

/** Reliability configuration for v2+ protocol. */
export interface ReliabilityConfig {
  ackInterval?: number;
  ackResendInterval?: number;
  nakTimeout?: number;
  retransmitQueueSize?: number;
  maxRetransmits?: number;
  retransmitMaxAge?: number;
  retransmitMinAge?: number;
  retransmitRttMultiplier?: number;
  ackIdleDrainAge?: number;
  forceDrainAfterAckIdle?: boolean;
  forceDrainAfterMs?: number;
  recoveryBurstEnabled?: boolean;
  recoveryBurstSize?: number;
  recoveryBurstIntervalMs?: number;
  recoveryAckGapMs?: number;
}

/** Congestion control configuration. */
export interface CongestionControlConfig {
  enabled?: boolean;
  targetRTT?: number;
  nominalDeltaTimer?: number;
  minDeltaTimer?: number;
  maxDeltaTimer?: number;
}

/** Link configuration (address + port). */
export interface LinkConfig {
  address: string;
  port: number;
  interface?: string;
}

/** Failover threshold configuration. */
export interface FailoverConfig {
  rttThreshold?: number;
  lossThreshold?: number;
  healthCheckInterval?: number;
  failbackDelay?: number;
  heartbeatTimeout?: number;
}

/** Connection bonding configuration. */
export interface BondingConfig {
  enabled?: boolean;
  mode?: string;
  primary?: LinkConfig;
  backup?: LinkConfig;
  failover?: FailoverConfig;
}

/** Alert threshold pair. */
export interface AlertThresholdPair {
  warning?: number;
  critical?: number;
}

/** Alert threshold configuration. */
export interface AlertThresholds {
  rtt?: AlertThresholdPair;
  packetLoss?: AlertThresholdPair;
  retransmitRate?: AlertThresholdPair;
  jitter?: AlertThresholdPair;
  queueDepth?: AlertThresholdPair;
}

/** Per-connection configuration. */
export interface ConnectionConfig {
  name?: string;
  serverType: string;
  udpPort: number;
  secretKey: string;
  protocolVersion?: number;
  useMsgpack?: boolean;
  usePathDictionary?: boolean;
  enableNotifications?: boolean;
  udpAddress?: string;
  helloMessageSender?: number;
  testAddress?: string;
  testPort?: number;
  pingIntervalTime?: number;
  reliability?: ReliabilityConfig;
  congestionControl?: CongestionControlConfig;
  bonding?: BondingConfig;
  alertThresholds?: AlertThresholds;
  managementApiToken?: string;
}

// ── Metrics Types ───────────────────────────────────────────────────────────

/** Per-path statistics entry. */
export interface PathStat {
  count: number;
  bytes: number;
  lastUpdate: number;
}

/** Bandwidth metrics. */
export interface BandwidthMetrics {
  bytesOut: number;
  bytesIn: number;
  bytesOutRaw: number;
  bytesInRaw: number;
  packetsOut: number;
  packetsIn: number;
  lastBytesOut: number;
  lastBytesIn: number;
  lastRateCalcTime: number;
  rateOut: number;
  rateIn: number;
  compressionRatio: number;
  history: import("./CircularBuffer")<{
    timestamp: number;
    rateOut: number;
    rateIn: number;
    compressionRatio: number;
  }>;
}

/** Smart batching metrics. */
export interface SmartBatchingMetrics {
  earlySends: number;
  timerSends: number;
  oversizedPackets: number;
  avgBytesPerDelta: number;
  maxDeltasPerBatch: number;
}

/** Remote network quality snapshot. */
export interface RemoteNetworkQuality {
  rtt: number;
  jitter: number;
  packetLoss: number;
  retransmissions: number;
  queueDepth: number;
  retransmitRate: number;
  activeLink: string;
  lastUpdate: number;
}

/** Runtime metrics snapshot. */
export interface Metrics {
  startTime: number;
  deltasSent: number;
  deltasReceived: number;
  udpSendErrors: number;
  udpRetries: number;
  compressionErrors: number;
  encryptionErrors: number;
  subscriptionErrors: number;
  malformedPackets: number;
  errorCounts: Record<string, number>;
  recentErrors: Array<{ category: string; message: string; timestamp: number }>;
  lastError: string | null;
  lastErrorTime: number | null;
  packetLoss: number;
  remoteNetworkQuality: RemoteNetworkQuality;
  bandwidth: BandwidthMetrics;
  pathStats: Map<string, PathStat>;
  _pathStatsStalest: { path: string; ts: number } | null;
  smartBatching: SmartBatchingMetrics;
  rtt?: number;
  jitter?: number;
  retransmissions?: number;
  queueDepth?: number;
  acksSent?: number;
  naksSent?: number;
  duplicatePackets?: number;
  dataPacketsReceived?: number;
  droppedDeltaBatches?: number;
  droppedDeltaCount?: number;
}

/** Metrics API returned by createMetrics(). */
export interface MetricsApi {
  metrics: Metrics;
  recordError: (category: string, message: string) => void;
  resetMetrics: () => void;
  updateBandwidthRates: (isServerMode: boolean) => void;
  trackPathStats: (delta: Delta, deltaSize?: number | null) => void;
  formatBytes: (bytes: number) => string;
  getTopNPaths: (n: number, uptimeSeconds: number) => PathStatEntry[];
}

/** Top-N path stats entry (for API responses). */
export interface PathStatEntry {
  path: string;
  count: number;
  bytes: number;
  bytesFormatted: string;
  lastUpdate: number;
  updatesPerMinute: number;
  percentage?: number;
}

// ── Instance State ───────────────────────────────────────────────────────────

/** Shared mutable per-instance state. */
export interface InstanceState {
  instanceId: string;
  instanceName: string;
  instanceStatus: string;
  isHealthy: boolean;
  options: ConnectionConfig | null;
  socketUdp: import("dgram").Socket | null;
  readyToSend: boolean;
  stopped: boolean;
  isServerMode: boolean;
  deltas: Delta[];
  timer: boolean;
  batchSendInFlight: boolean;
  pendingRetry: ReturnType<typeof setTimeout> | null;
  droppedDeltaBatches: number;
  droppedDeltaCount: number;
  deltaTimerTime: number;
  avgBytesPerDelta: number;
  maxDeltasPerBatch: number;
  deltaTimerFile: string | null;
  subscriptionFile: string | null;
  sentenceFilterFile: string | null;
  excludedSentences: string[];
  lastPacketTime: number;
  unsubscribes: Array<() => void>;
  localSubscription: unknown | null;
  helloMessageSender: ReturnType<typeof setInterval> | null;
  pingTimeout: ReturnType<typeof setTimeout> | null;
  pingMonitor: unknown | null;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  pipeline: unknown | null;
  pipelineServer: unknown | null;
  heartbeatHandle: unknown | null;
  monitoring: unknown | null;
  networkSimulator: unknown | null;
  configDebounceTimers: Record<string, ReturnType<typeof setTimeout>>;
  configContentHashes: Record<string, string>;
  processDelta: ((delta: Delta) => void) | null;
}

/** Instance bundle returned by instanceRegistry. */
export interface InstanceBundle {
  id: string;
  name: string;
  state: InstanceState;
  metricsApi: MetricsApi;
}

/** Instance registry for looking up active plugin instances. */
export interface InstanceRegistry {
  get(id: string): InstanceBundle | null;
  getFirst(): InstanceBundle | null;
  getAll(): InstanceBundle[];
}

/** Signal K app object (partial interface). */
export interface SignalKApp {
  setPluginStatus?: (msg: string) => void;
  setProviderStatus?: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
  handleMessage: (pluginId: string, delta: unknown) => void;
  reportOutputMessages: () => void;
  getSelfPath: (path: string) => unknown;
  getDataDirPath: () => string;
  subscriptionmanager: {
    subscribe: (
      subscription: unknown,
      unsubscribes: Array<() => void>,
      onError: (err: unknown) => void,
      onDelta: (delta: Delta) => void
    ) => void;
  };
}

export {};
