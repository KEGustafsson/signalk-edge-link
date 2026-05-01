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

/** A Signal K metadata entry attached to a delta update. */
export interface DeltaMeta {
  path: string;
  value: Record<string, unknown>;
}

/** A Signal K delta update block. */
export interface DeltaUpdate {
  source?: {
    label?: string;
    type?: string;
  };
  $source?: string;
  timestamp?: string;
  values: DeltaValue[];
  meta?: DeltaMeta[];
}

/** Metadata streaming configuration (optional block in subscription.json). */
export interface MetaConfig {
  enabled: boolean;
  intervalSec: number;
  includePathsMatching?: string | null;
  maxPathsPerPacket?: number;
}

/** A single metadata entry emitted on the wire. */
export interface MetaEntry {
  context: string;
  path: string;
  meta: Record<string, unknown>;
}

/** Envelope for a metadata packet payload (JSON or msgpack, pre-compression). */
export interface MetaEnvelope {
  v: 1;
  kind: "snapshot" | "diff";
  seq: number;
  idx: number;
  total: number;
  entries: MetaEntry[];
}

/** Envelope carrying a chunk of the Signal K `/sources` tree over METADATA. */
export interface SourceSnapshotEnvelope {
  v: 1;
  kind: "sources";
  seq: number;
  idx: number;
  total: number;
  sources: Record<string, unknown>;
}

/** A Signal K delta message. */
export interface Delta {
  context: string;
  updates: DeltaUpdate[];
}

export interface SourceReplicationRecord {
  schemaVersion: number;
  key: string;
  identity: {
    label: string;
    type: string;
    src?: string;
    instance?: string;
    pgn?: number;
    deviceId?: string;
  };
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUpdatedAt: string;
  provenance: {
    lastUpdatedBy: "source" | "$source" | "merge";
    sourceClientInstanceId: string;
    updateTimestamp?: string;
  };
  raw: {
    source?: Record<string, unknown>;
    $source?: string;
  };
  mergeHash: string;
}

export interface SourceRegistrySnapshot {
  schemaVersion: number;
  size: number;
  sources: SourceReplicationRecord[];
  legacy: {
    byLabel: Record<string, string>;
    bySourceRef: Record<string, string>;
  };
}

export interface SourceRegistryMetrics {
  upserts: number;
  noops: number;
  missingIdentity: number;
  conflicts: number;
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
  /** How often the server sends ACK packets to the client (ms). Default 100. */
  ackInterval?: number;
  /** Minimum gap between identical ACKs (duplicate suppression window, ms). Default 1000. */
  ackResendInterval?: number;
  /** Idle time after the last received sequence before a NAK is emitted (ms). Default 100. */
  nakTimeout?: number;
  /** Maximum number of entries held in the retransmit queue. Default 5000. */
  retransmitQueueSize?: number;
  /** Maximum retransmit attempts per packet before it is dropped. Default 3. */
  maxRetransmits?: number;
  /** Hard upper bound on retransmit queue entry age (ms). Default 120000. */
  retransmitMaxAge?: number;
  /** Lower bound on retransmit entry age; entries newer than this are never expired (ms). Default 10000. */
  retransmitMinAge?: number;
  /** Scale factor applied to the current RTT to compute the dynamic retransmit timeout. Default 12. */
  retransmitRttMultiplier?: number;
  /** Time without an ACK after which the retransmit queue is capped to this age (ms). Default 20000. */
  ackIdleDrainAge?: number;
  /** When true, force-clears the retransmit queue after `forceDrainAfterMs` of ACK silence. Default false. */
  forceDrainAfterAckIdle?: boolean;
  /** ACK-idle duration that triggers a force drain when `forceDrainAfterAckIdle` is enabled (ms). Default 45000. */
  forceDrainAfterMs?: number;
  /** Enable burst retransmission of the oldest queued packets after a long ACK gap. Default true. */
  recoveryBurstEnabled?: boolean;
  /** Maximum number of packets sent in a single recovery burst. Default 100. */
  recoveryBurstSize?: number;
  /** Interval between successive recovery burst rounds (ms). Default 200. */
  recoveryBurstIntervalMs?: number;
  /** ACK-gap threshold that triggers a recovery burst (ms). Default 4000. */
  recoveryAckGapMs?: number;
}

/** Congestion control configuration. */
export interface CongestionControlConfig {
  /** Enable automatic congestion-based delta timer adjustment. Default true. */
  enabled?: boolean;
  /** RTT target that the algorithm aims for (ms). Default 150. */
  targetRTT?: number;
  /** Normal delta send interval used as the starting point for adjustment (ms). Default 1000. */
  nominalDeltaTimer?: number;
  /** Minimum delta send interval the algorithm will set (ms). Default 100. */
  minDeltaTimer?: number;
  /** Maximum delta send interval the algorithm will set (ms). Default 10000. */
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
  /** RTT (ms) above which the primary link is considered degraded and failover is triggered. */
  rttThreshold?: number;
  /** Packet-loss ratio (0–1) above which failover is triggered. E.g. 0.05 = 5 %. */
  lossThreshold?: number;
  /** Interval between bonding health-check probes (ms). */
  healthCheckInterval?: number;
  /** Minimum time the backup link must remain healthy before failing back to primary (ms). */
  failbackDelay?: number;
  /** Duration without a heartbeat response before a link is declared dead (ms). */
  heartbeatTimeout?: number;
}

/** Connection bonding configuration. */
export interface BondingConfig {
  /** Enable dual-link bonding with automatic failover. Default false. */
  enabled?: boolean;
  /** Bonding mode. Currently only "failover" is supported. */
  mode?: string;
  /** Primary link address and port. */
  primary?: LinkConfig;
  /** Backup link address and port, used when primary is degraded. */
  backup?: LinkConfig;
  /** Thresholds and timing that control when failover and failback occur. */
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
  /** Stable per-connection identity used for config editing and secret restoration. */
  connectionId?: string;
  /** Human-readable label shown in the UI and logs. */
  name?: string;
  /** Role of this end of the connection: "client" or "server". */
  serverType: string;
  /** UDP port to send/receive data on. */
  udpPort: number;
  /** AES-256 encryption key: 64-char hex, 44-char base64, or 32-char ASCII string. */
  secretKey: string;
  /**
   * When true, 32-char ASCII keys are stretched via PBKDF2-SHA256
   * (600,000 iterations, salt "signalk-edge-link-v1") before being used as
   * the AES-256-GCM key. Hex/base64 keys are unaffected. **Both peers must
   * use the same setting** — mismatched values will fail authentication and
   * drop every packet. Default false (raw bytes used as-is).
   */
  stretchAsciiKey?: boolean;
  /** Wire protocol version (1, 2, or 3). Default 2. */
  protocolVersion?: number;
  /** Serialize deltas with MessagePack instead of JSON (smaller, faster). Default false. */
  useMsgpack?: boolean;
  /** Compress Signal K path strings with a shared dictionary to reduce packet size. Default false. */
  usePathDictionary?: boolean;
  /** Forward Signal K notification deltas over the link. Default false. */
  enableNotifications?: boolean;
  /**
   * When true, drop value entries this plugin publishes locally before they
   * are forwarded over the link. Targets paths under `networking.edgeLink.*`
   * and the v1 RTT publisher's `networking.modem.rtt` /
   * `networking.modem.<instanceId>.rtt` paths. Other paths under
   * `networking.modem.*` (signalStrength, txBytes, ...) come from external
   * providers and are left intact. Also suppresses the v2/v3 client-side
   * telemetry packet that mirrors the client's own link metrics to the
   * receiver. Default false (current behaviour: own data is forwarded along
   * with all other subscribed deltas).
   *
   * Client mode only. Ignored on server-mode connections.
   */
  skipOwnData?: boolean;
  /** Destination IP address for client mode. Not used in server mode. */
  udpAddress?: string;
  /**
   * Separate UDP port used by the v1 pipeline for metadata packets. Required
   * when `protocolVersion === 1` and metadata streaming is enabled, because v1
   * has no packet-type byte so meta cannot be multiplexed on the main data
   * port without corrupting existing receivers. Ignored on v2/v3. Default:
   * undefined (meta disabled on v1 unless operator sets this).
   */
  udpMetaPort?: number;
  /** Number of HELLO retransmits sent on connection start. Default 3. */
  helloMessageSender?: number;
  /** Override destination address used in automated tests. */
  testAddress?: string;
  /** Override destination port used in automated tests. */
  testPort?: number;
  /** Interval between PING keepalive packets (ms). Default 25000. */
  pingIntervalTime?: number;
  /** Interval between heartbeat packets (ms). */
  heartbeatInterval?: number;
  /** ARQ reliability layer configuration (ACK/NAK/retransmit). */
  reliability?: ReliabilityConfig;
  /** Automatic congestion-control configuration. */
  congestionControl?: CongestionControlConfig;
  /** Dual-link bonding and failover configuration. */
  bonding?: BondingConfig;
  /** Alert threshold overrides for the monitoring subsystem. */
  alertThresholds?: AlertThresholds;
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
  /** Cumulative bytes sent as METADATA packets (0x06 or v1 "SKM1"). */
  metaBytesOut?: number;
  /** Count of METADATA packets emitted. */
  metaPacketsOut?: number;
  /** Cumulative bytes received as METADATA packets. */
  metaBytesIn?: number;
  /** Count of METADATA packets received. */
  metaPacketsIn?: number;
  /** Count of "snapshot" envelopes successfully sent (one envelope may span
   *  multiple chunks counted in metaPacketsOut). */
  metaSnapshotsSent?: number;
  /** Count of "diff" envelopes successfully sent. */
  metaDiffsSent?: number;
  /** Count of incoming META packets dropped by the per-session UDP rate
   *  limiter — separate from the shared rateLimitedPackets counter so a
   *  noisy meta channel can be distinguished from a noisy data channel. */
  metaRateLimitedPackets?: number;
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
  rateLimitedPackets?: number;
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
  /** Stable identifier for this connection instance (used in registry lookups). */
  instanceId: string;
  /** Human-readable connection name shown in logs and the UI. */
  instanceName: string;
  /** Short status string forwarded to the Signal K plugin status indicator. */
  instanceStatus: string;
  /** True while the connection is operating normally and sending/receiving data. */
  isHealthy: boolean;
  /** Active configuration for this instance; null when the plugin is stopped. */
  options: ConnectionConfig | null;
  /** Bound UDP socket; null before `start()` or after `stop()`. */
  socketUdp: import("dgram").Socket | null;
  /** Second UDP socket bound to `udpMetaPort`, used only by the v1 server
   *  pipeline for receiving metadata packets. v2/v3 multiplex meta onto the
   *  main socket via packet type 0x06 and leave this null. */
  metaSocketUdp: import("dgram").Socket | null;
  /** True once the UDP socket is ready and a destination is known. */
  readyToSend: boolean;
  /** True after `stop()` has been called; prevents stale timer callbacks from acting. */
  stopped: boolean;
  /** True when running as a server (receiving) rather than a client (sending). */
  isServerMode: boolean;
  /** Delta batch being accumulated for the current send window. */
  deltas: Delta[];
  /** True while the batch-flush timer is armed. */
  timer: boolean;
  /** True while an async UDP batch send is in progress (back-pressure guard). */
  batchSendInFlight: boolean;
  /** Handle for the pending connection-retry timer; null when not retrying. */
  pendingRetry: ReturnType<typeof setTimeout> | null;
  /** Running total of delta batches dropped due to back-pressure. */
  droppedDeltaBatches: number;
  /** Running total of individual deltas dropped due to back-pressure. */
  droppedDeltaCount: number;
  /** Current delta send interval in ms (may be adjusted by congestion control). */
  deltaTimerTime: number;
  /** Exponentially smoothed estimate of bytes per delta (for smart batching). */
  avgBytesPerDelta: number;
  /** Current cap on deltas per batch computed from `avgBytesPerDelta`. */
  maxDeltasPerBatch: number;
  /** Path to the delta-timer override config file; null if not set. */
  deltaTimerFile: string | null;
  /** Path to the Signal K subscription filter file; null if not set. */
  subscriptionFile: string | null;
  /** Path to the NMEA sentence filter file; null if not set. */
  sentenceFilterFile: string | null;
  /** NMEA sentence types excluded from forwarding. */
  excludedSentences: string[];
  /** Timestamp (ms since epoch) of the last successfully received packet. */
  lastPacketTime: number;
  /** Cleanup callbacks registered by Signal K subscriptions. */
  unsubscribes: Array<() => void>;
  /** The active Signal K subscription handle; null when unsubscribed. */
  localSubscription: unknown | null;
  /** Periodic HELLO retransmit timer handle; null when not active. */
  helloMessageSender: ReturnType<typeof setInterval> | null;
  /** Ping-response watchdog timer handle; null when not active. */
  pingTimeout: ReturnType<typeof setTimeout> | null;
  /** Pending subscription retry timer; null when not scheduled. */
  subscriptionRetryTimer: ReturnType<typeof setTimeout> | null;
  /** Pending UDP socket recovery timer; null when not scheduled. */
  socketRecoveryTimer: ReturnType<typeof setTimeout> | null;
  /** True while a socket recovery is in progress; gates send operations during recovery. */
  socketRecoveryInProgress: boolean;
  /** Batch-flush timer handle; null when not armed. */
  deltaTimer: ReturnType<typeof setTimeout> | null;
  /** Active v2/v3 client pipeline instance; null in server mode or before start. */
  pipeline: ClientPipelineApi | null;
  /** Active v2/v3 server pipeline instance; null in client mode or before start. */
  pipelineServer: ServerPipelineApi | null;
  /** Heartbeat timer handle returned by `startHeartbeat()`; null when stopped. */
  heartbeatHandle: { stop(): void } | null;
  /** Enhanced monitoring subsystem instance; null when not initialised. */
  monitoring: MonitoringState | null;
  /** Ping/TCP monitor instance; null when not running. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pingMonitor: { on(event: string, handler: (...args: any[]) => void): void; stop(): void } | null;
  /** File-system watcher objects registered for config files. */
  configWatcherObjects: Array<{ close(): void }>;
  /** Per-config-file debounce timers, keyed by file path. */
  configDebounceTimers: Record<string, ReturnType<typeof setTimeout>>;
  /** Last-seen content hashes for watched config files, used to skip no-op reloads. */
  configContentHashes: Record<string, string>;
  /** Callback invoked for each incoming delta (set by the pipeline); null before ready. */
  processDelta: ((delta: Delta) => void) | null;
  /** Active metadata-streaming configuration from subscription.json; null when disabled. */
  metaConfig: MetaConfig | null;
  /**
   * Periodic full metadata resend owned by instance.ts. Created only while
   * metadata streaming is enabled, cleared and reset to null on stop/restart,
   * and its async callback must tolerate the connection disappearing mid-send.
   */
  metaTimer: ReturnType<typeof setInterval> | null;
  /**
   * Periodic `/sources` resend owned by instance.ts. Created for active v2/v3
   * client pipelines, cleared and reset to null when the pipeline stops or is
   * replaced, and its async callback must re-check current state before send.
   */
  sourceSnapshotTimer: ReturnType<typeof setInterval> | null;
  /** Coalescing buffer for live meta diff entries collected from delta stream. */
  metaDiffBuffer: MetaEntry[];
  /** Debounce timer for the live meta diff flush; null when not armed. */
  metaDiffFlushTimer: ReturnType<typeof setTimeout> | null;
  /** One-shot timers that fire a metadata snapshot after (re)subscribe or
   *  socket recovery. Tracked here so stop() can cancel them. */
  metaSnapshotTimers: Array<ReturnType<typeof setTimeout>>;
  /** Timestamp (ms) of the last receiver-requested snapshot; used for rate limiting. */
  lastMetaRequestAt: number;
  /** Replicated and normalized server-side source registry snapshot state. */
  sourceRegistry: {
    upsertFromDelta(delta: Delta, sourceClientInstanceId: string): void;
    snapshot(): SourceRegistrySnapshot;
    getMetrics(): SourceRegistryMetrics;
  };
  /** MetaConfig that was parsed from a new subscription.json but whose
   *  subscribe() call threw. Stashed here so the scheduled
   *  `subscriptionRetryTimer` callback can promote it into
   *  `state.metaConfig` once the retry actually succeeds; otherwise the
   *  new meta settings would be lost until the user re-saved the config. */
  pendingMetaConfig?: MetaConfig | null;
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
  readPluginOptions?: () => Record<string, unknown>;
  savePluginOptions?: (config: unknown, callback: (error: Error | null) => void) => void;
  subscriptionmanager: {
    subscribe: (
      subscription: unknown,
      unsubscribes: Array<() => void>,
      onError: (err: unknown) => void,
      onDelta: (delta: Delta) => void
    ) => void;
  };
  /** Full Signal K state tree including `meta` entries. Only present on real
   *  signalk-server runtimes; undefined in tests and minimal mocks. */
  signalk?: {
    retrieve: () => Record<string, unknown>;
  };
  /** Per-path stream bundle API. Only present on real signalk-server runtimes. */
  streambundle?: {
    getSelfBus: (path: string) => unknown;
  };
}

// ── Plugin Reference ─────────────────────────────────────────────────────────

/** Reference to the plugin object used by route handlers. */
export interface PluginRef {
  _currentOptions?: {
    managementApiToken?: string;
    requireManagementApiToken?: boolean;
    connections?: ConnectionConfig[];
    [key: string]: unknown;
  } | null;
  _restartPlugin?: ((config: unknown) => Promise<void>) | null;
  schema?: unknown;
}

// ── Effective Network Quality ────────────────────────────────────────────────

/** Resolved network quality snapshot (merges local and remote-telemetry sources). */
export interface EffectiveNetworkQuality {
  rtt: number;
  jitter: number;
  packetLoss: number;
  retransmissions: number;
  queueDepth: number;
  retransmitRate: number;
  activeLink: string;
  dataSource: string;
  lastUpdate: number;
}

// ── Monitoring State ─────────────────────────────────────────────────────────

/** Structural interface for the monitoring sub-system attached to each instance. */
export interface MonitoringState {
  packetLossTracker?: {
    record(lost: boolean): void;
    recordBatch(sent: number, lost: number): void;
    getHeatmapData(): Array<{ timestamp: number; total: number; lost: number; lossRate: number }>;
    getSummary(): {
      overallLossRate: number;
      maxLossRate: number;
      trend: string;
      bucketCount: number;
    };
    reset(): void;
  };
  pathLatencyTracker?: {
    record(path: string, latencyMs: number): void;
    getAllStats(topN?: number): unknown[];
    reset(): void;
  };
  retransmissionTracker?: {
    snapshot(totalPacketsSent: number, totalRetransmissions: number): void;
    getChartData(limit?: number): unknown[];
    getSummary(): { avgRate: number; maxRate: number; currentRate: number; entries: number };
    reset(): void;
  };
  alertManager?: {
    thresholds: Record<string, { warning?: number; critical?: number }>;
    checkAll(metrics: Record<string, number | undefined>): unknown[];
    getState(): { thresholds: unknown; activeAlerts: Record<string, unknown> };
    setThreshold(metric: string, thresholds: { warning?: number; critical?: number }): void;
    reset(): void;
  };
  packetCapture?: {
    capture(data: Buffer, direction: string, meta?: { address?: string; port?: number }): void;
    getStats(): unknown;
    exportPcap(): Buffer;
    start(): void;
    stop(): void;
    reset(): void;
  };
  packetInspector?: {
    inspect(data: Buffer, direction: string, meta?: { address?: string; port?: number }): void;
    getStats(): unknown;
    reset(): void;
  };
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
}

export {};
