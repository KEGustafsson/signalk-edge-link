"use strict";

/** L0 foundation types — monitoring. */

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
