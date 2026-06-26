"use strict";

/** L0 foundation types — metrics. */

import type { Delta } from "./signalk";

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
  history: import("../circular-buffer")<{
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
  /** DATA packets rejected by the anti-replay window (H3). */
  replayedPackets?: number;
  rateLimitedPackets?: number;
  droppedDeltaBatches?: number;
  droppedDeltaCount?: number;
  suppressedOutboundDuplicates?: number;
  suppressedOutboundDuplicateStats?: Map<
    string,
    { context: string; path: string; source: string; count: number; lastUpdate: number }
  >;
  /** Total invocations of processDelta on this instance. Should equal
   *  deltasSent + droppedDeltaCount + suppressedOutboundDuplicates +
   *  deltas-still-buffered + deltas-skipped-while-subscribing. A larger
   *  value indicates a delivery-doubling regression. */
  processDeltaCalls?: number;
  /** Snapshot replays performed, broken out by reason. */
  snapshotsReplayed?: {
    initialSubscribe: number;
    subscriptionRetry: number;
    socketRecovery: number;
    fullStatusRequest: number;
  };
  /** Total deltas emitted across all snapshot replays (sum of all reasons). */
  snapshotReplayDeltas?: number;
  /** Cascades emitted from this server instance to all connected clients. */
  fullStatusCascadeFired?: number;
  /** Peak observed length of state.deltas since reset. */
  deltasBufferHighWaterMark?: number;
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
