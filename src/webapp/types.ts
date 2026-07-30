export interface ConnectionInfo {
  id: string;
  name?: string;
  type: "server" | "client";
  healthy?: boolean;
  readyToSend?: boolean;
}

export interface BandwidthData {
  bytesOut: number;
  bytesOutRaw: number;
  bytesOutFormatted: string;
  bytesOutRawFormatted: string;
  bytesIn: number;
  bytesInRaw: number;
  bytesInFormatted: string;
  bytesInRawFormatted?: string;
  packetsOut: number;
  packetsIn: number;
  rateOutFormatted: string;
  rateInFormatted: string;
  compressionRatio: number;
  avgPacketSizeFormatted: string;
  metaBytesOut?: number;
  metaBytesIn?: number;
  metaPacketsOut?: number;
  metaPacketsIn?: number;
  metaSnapshotsSent?: number;
  metaDiffsSent?: number;
  metaRateLimitedPackets?: number;
  metaBytesOutFormatted?: string;
  metaBytesInFormatted?: string;
  history?: Array<{ rateOut: number; rateIn: number }>;
}

export interface NetworkQualityData {
  linkQuality?: number;
  rtt?: number;
  jitter?: number;
  packetLoss?: number;
  retransmitRate?: number;
  dataSource?: string;
  activeLink?: string;
  lastRemoteUpdate?: number;
  retransmissions?: number;
  queueDepth?: number;
  acksSent?: number;
  naksSent?: number;
}

export interface MetricsData {
  mode: "client" | "server";
  protocolVersion: number;
  stats: {
    deltasSent: number;
    deltasReceived: number;
    udpSendErrors: number;
    udpRetries: number;
    compressionErrors: number;
    encryptionErrors: number;
    subscriptionErrors: number;
    malformedPackets: number;
    errorCounts?: { crypto?: number };
    dataPacketsReceived?: number;
    rateLimitedPackets?: number;
    droppedDeltaBatches?: number;
    droppedDeltaCount?: number;
    duplicatePackets?: number;
    abandonedSequences?: number;
    packetsAbandoned?: number;
    rejectedControlPackets?: number;
  };
  status: {
    readyToSend: boolean;
    deltasBuffered?: number;
  };
  uptime: { formatted: string };
  bandwidth?: BandwidthData;
  networkQuality?: NetworkQualityData;
  pathStats?: Array<{
    path: string;
    updatesPerMinute: number;
    bytesFormatted: string;
    percentage: number;
  }>;
  smartBatching?: {
    avgBytesPerDelta: number;
    maxDeltasPerBatch: number;
    earlySends: number;
    timerSends: number;
    oversizedPackets: number;
  };
  lastError?: { message: string; timeAgo: number };
  recentErrors?: Array<{ category: string; message: string; timestamp: number }>;
}

export interface MonitoringData {
  alerts?: {
    activeAlerts: Record<string, string | { level: string; value?: unknown }>;
  };
  // These mirror GET /monitoring/packet-loss and /monitoring/retransmissions
  // verbatim. They previously named fields no producer emitted — `lossRate`
  // for `overallLossRate`, and the retransmission counters hoisted out of
  // `summary` — and because every field is optional TypeScript could not catch
  // it: each read produced `undefined`, which the card rendered as 0.
  packetLoss?: {
    summary?: {
      overallLossRate?: number;
      maxLossRate?: number;
      trend?: string;
      bucketCount?: number;
      totalLost?: number;
      totalExpected?: number;
    };
  };
  retransmissions?: {
    summary?: {
      avgRate?: number;
      maxRate?: number;
      currentRate?: number;
      entries?: number;
      totalRetransmissions?: number;
    };
  };
}

export interface CongestionData {
  enabled: boolean;
  manualMode?: boolean;
  currentDeltaTimer: number;
  nominalDeltaTimer: number;
  minDeltaTimer?: number;
  maxDeltaTimer?: number;
  targetRTT?: number;
  avgRTT?: number;
  avgLoss?: number;
}

export interface BondingData {
  enabled: boolean;
  mode?: string;
  activeLink?: string;
  links?: Record<string, { status: string; rtt?: number; loss?: number }>;
}

export interface DeltaTimerConfig {
  deltaTimer: number;
}

export interface SubscriptionConfig {
  context: string;
  /**
   * Signal K subscription entries. Beyond `path`, the backend subscription
   * manager honours `period`, `minPeriod`, `policy` and `format`; the type stays
   * open so those survive a UI round-trip instead of being silently dropped.
   */
  subscribe: Array<{ path: string } & Record<string, unknown>>;
  meta?: {
    enabled: boolean;
    intervalSec: number;
    includePathsMatching?: string | null;
    maxPathsPerPacket: number;
  };
}

export interface SentenceFilterConfig {
  excludedSentences: string[];
}

export type NotificationType = "success" | "warning" | "error";
