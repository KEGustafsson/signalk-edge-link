"use strict";

/** L0 foundation types — instance. */

import type { ConnectionConfig } from "./config";
import type { MetricsApi } from "./metrics";
import type { MonitoringState } from "./monitoring";
import type { ClientPipelineApi, ServerPipelineApi } from "./pipeline";
import type {
  Delta,
  MetaConfig,
  MetaEntry,
  SourceRegistryMetrics,
  SourceRegistrySnapshot
} from "./signalk";

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
  /** Monotonic per-(re)start connection epoch (H3 anti-replay), resolved from a
   *  persisted counter at client start so it survives an RTC-less reboot.
   *  Undefined until resolved; consumers fall back to `Date.now()`. */
  connectionEpoch?: number;
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
  /** True while `app.subscriptionmanager.subscribe()` is executing. signalk-
   *  server's subscribe() synchronously replays cached deltas (via
   *  `latest.forEach(callback)` in handleSubscribeRow) bypassing the
   *  `bufferWithTime`/`uniqBy` dedupe of the live listener — so a cached
   *  value is delivered twice (once via direct replay, once via the live
   *  pipeline) for every path that exists at subscribe time. Setting this
   *  flag lets `processDelta` skip the direct replay; `replayValuesSnapshot`
   *  ships the initial tree state explicitly right after subscribe() returns. */
  subscribing: boolean;
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
  /** Timestamp (ms) of the last full-status replay triggered by FULL_STATUS_REQUEST. */
  lastFullStatusRequestAt: number;
  /** Replicated and normalized server-side source registry snapshot state. */
  sourceRegistry: {
    upsertFromDelta(delta: Delta, sourceClientInstanceId: string): void;
    snapshot(): SourceRegistrySnapshot;
    getMetrics(): SourceRegistryMetrics;
    getSize(): number;
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
