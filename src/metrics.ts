"use strict";

import CircularBuffer = require("./CircularBuffer");
import {
  BANDWIDTH_HISTORY_MAX,
  PATH_STATS_MAX_SIZE,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} from "./constants";
import type { Metrics, MetricsApi } from "./types";

interface PathStat {
  count: number;
  bytes: number;
  lastUpdate: number;
}

interface PathStatEntry {
  path: string;
  count: number;
  bytes: number;
  bytesFormatted: string;
  lastUpdate: number;
  updatesPerMinute: number;
}

type ErrorCategory =
  | "compression"
  | "encryption"
  | "subscription"
  | "udpSend"
  | "pingTimeout"
  | "sendFailure"
  | "crypto"
  | "general";

/**
 * Creates the metrics tracking subsystem.
 * All metrics state and related functions are encapsulated here.
 */
function createMetrics(): MetricsApi {
  const RECENT_ERRORS_LIMIT = 20;
  const DEFAULT_ERROR_COUNTS = {
    compression: 0,
    encryption: 0,
    subscription: 0,
    udpSend: 0,
    general: 0,
    pingTimeout: 0,
    sendFailure: 0,
    crypto: 0
  };

  const metrics: Metrics = {
    startTime: Date.now(),
    deltasSent: 0,
    deltasReceived: 0,
    udpSendErrors: 0,
    udpRetries: 0,
    compressionErrors: 0,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    malformedPackets: 0,
    errorCounts: { ...DEFAULT_ERROR_COUNTS },
    recentErrors: [],
    lastError: null,
    lastErrorTime: null,
    packetLoss: 0,
    dataPacketsReceived: 0,
    rateLimitedPackets: 0,
    droppedDeltaBatches: 0,
    droppedDeltaCount: 0,
    remoteNetworkQuality: {
      rtt: 0,
      jitter: 0,
      packetLoss: 0,
      retransmissions: 0,
      queueDepth: 0,
      retransmitRate: 0,
      activeLink: "primary",
      lastUpdate: 0
    },
    bandwidth: {
      bytesOut: 0,
      bytesIn: 0,
      bytesOutRaw: 0,
      bytesInRaw: 0,
      packetsOut: 0,
      packetsIn: 0,
      lastBytesOut: 0,
      lastBytesIn: 0,
      lastRateCalcTime: Date.now(),
      rateOut: 0,
      rateIn: 0,
      compressionRatio: 0,
      metaBytesOut: 0,
      metaPacketsOut: 0,
      metaBytesIn: 0,
      metaPacketsIn: 0,
      metaSnapshotsSent: 0,
      metaDiffsSent: 0,
      metaRateLimitedPackets: 0,
      // Explicit generic parameter so the type matches BandwidthMetrics.history
      // and removes the need for the `as any` cast on the whole object.
      history: new CircularBuffer<{
        timestamp: number;
        rateOut: number;
        rateIn: number;
        compressionRatio: number;
      }>(BANDWIDTH_HISTORY_MAX)
    },
    pathStats: new Map<string, PathStat>(),
    _pathStatsStalest: null,
    smartBatching: {
      earlySends: 0,
      timerSends: 0,
      oversizedPackets: 0,
      avgBytesPerDelta: SMART_BATCH_INITIAL_ESTIMATE,
      maxDeltasPerBatch: calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE)
    }
  };

  // Keys in the Metrics interface that map to raw error counters.
  type MetricCounterKey =
    | "compressionErrors"
    | "encryptionErrors"
    | "subscriptionErrors"
    | "udpSendErrors";

  function recordError(category: string, message: string): void {
    const counterMap = {
      compression: "compressionErrors",
      encryption: "encryptionErrors",
      subscription: "subscriptionErrors",
      udpSend: "udpSendErrors"
    } as const satisfies Record<string, MetricCounterKey>;

    const counter = (counterMap as Record<string, MetricCounterKey | undefined>)[category];
    if (counter !== undefined) {
      (metrics[counter] as number)++;
    }

    const normalizedCategory = normalizeErrorCategory(category);
    // Use ?? 0 to handle unknown categories that weren't seeded in DEFAULT_ERROR_COUNTS.
    metrics.errorCounts[normalizedCategory] = (metrics.errorCounts[normalizedCategory] ?? 0) + 1;

    metrics.recentErrors.push({
      category: normalizedCategory,
      message,
      timestamp: Date.now()
    });
    if (metrics.recentErrors.length > RECENT_ERRORS_LIMIT) {
      metrics.recentErrors.splice(0, metrics.recentErrors.length - RECENT_ERRORS_LIMIT);
    }

    metrics.lastError = message;
    metrics.lastErrorTime = Date.now();
  }

  function normalizeErrorCategory(category: string): ErrorCategory {
    switch (category) {
      case "compression":
      case "encryption":
      case "subscription":
      case "udpSend":
      case "pingTimeout":
      case "sendFailure":
      case "crypto":
      case "general":
        return category as ErrorCategory;
      default:
        return "general";
    }
  }

  function resetMetrics(): void {
    Object.assign(metrics, {
      startTime: Date.now(),
      deltasSent: 0,
      deltasReceived: 0,
      udpSendErrors: 0,
      udpRetries: 0,
      compressionErrors: 0,
      encryptionErrors: 0,
      subscriptionErrors: 0,
      malformedPackets: 0,
      errorCounts: { ...DEFAULT_ERROR_COUNTS },
      recentErrors: [],
      lastError: null,
      lastErrorTime: null,
      retransmissions: 0,
      queueDepth: 0,
      rtt: 0,
      jitter: 0,
      packetLoss: 0,
      remoteNetworkQuality: {
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        retransmissions: 0,
        queueDepth: 0,
        retransmitRate: 0,
        activeLink: "primary",
        lastUpdate: 0
      },
      acksSent: 0,
      naksSent: 0,
      duplicatePackets: 0,
      dataPacketsReceived: 0,
      rateLimitedPackets: 0,
      droppedDeltaBatches: 0,
      droppedDeltaCount: 0
    });
    Object.assign(metrics.bandwidth, {
      bytesOut: 0,
      bytesIn: 0,
      bytesOutRaw: 0,
      bytesInRaw: 0,
      packetsOut: 0,
      packetsIn: 0,
      lastBytesOut: 0,
      lastBytesIn: 0,
      lastRateCalcTime: Date.now(),
      rateOut: 0,
      rateIn: 0,
      compressionRatio: 0,
      metaBytesOut: 0,
      metaPacketsOut: 0,
      metaBytesIn: 0,
      metaPacketsIn: 0,
      metaSnapshotsSent: 0,
      metaDiffsSent: 0,
      metaRateLimitedPackets: 0,
      history: new CircularBuffer(BANDWIDTH_HISTORY_MAX)
    });
    metrics.pathStats.clear();
    metrics._pathStatsStalest = null;
    Object.assign(metrics.smartBatching, {
      earlySends: 0,
      timerSends: 0,
      oversizedPackets: 0,
      avgBytesPerDelta: SMART_BATCH_INITIAL_ESTIMATE,
      maxDeltasPerBatch: calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE)
    });
  }

  function updateBandwidthRates(isServerMode: boolean): void {
    const now = Date.now();
    const elapsed = (now - metrics.bandwidth.lastRateCalcTime) / 1000;

    if (elapsed > 0) {
      const bytesDeltaOut = metrics.bandwidth.bytesOut - metrics.bandwidth.lastBytesOut;
      const bytesDeltaIn = metrics.bandwidth.bytesIn - metrics.bandwidth.lastBytesIn;

      metrics.bandwidth.rateOut = Math.round(bytesDeltaOut / elapsed);
      metrics.bandwidth.rateIn = Math.round(bytesDeltaIn / elapsed);

      const compressed = isServerMode ? metrics.bandwidth.bytesIn : metrics.bandwidth.bytesOut;
      const raw = isServerMode ? metrics.bandwidth.bytesInRaw : metrics.bandwidth.bytesOutRaw;
      if (raw > 0) {
        metrics.bandwidth.compressionRatio = Math.round((1 - compressed / raw) * 100);
      }

      metrics.bandwidth.history.push({
        timestamp: now,
        rateOut: metrics.bandwidth.rateOut,
        rateIn: metrics.bandwidth.rateIn,
        compressionRatio: metrics.bandwidth.compressionRatio
      });

      metrics.bandwidth.lastBytesOut = metrics.bandwidth.bytesOut;
      metrics.bandwidth.lastBytesIn = metrics.bandwidth.bytesIn;
      metrics.bandwidth.lastRateCalcTime = now;
    }
  }

  function trackPathStats(delta: any, deltaSize: number | null = null): void {
    if (!delta || !delta.updates) {
      return;
    }

    const size = deltaSize !== null ? deltaSize : JSON.stringify(delta).length;
    const pathStats = metrics.pathStats;

    for (const update of delta.updates) {
      const values = update.values;
      if (!values || values.length === 0) {
        continue;
      }

      const bytesPerPath = Math.round(size / values.length);
      const now = Date.now();

      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        const path = value.path;
        if (!path) {
          continue;
        }

        const stats = pathStats.get(path);
        if (stats) {
          stats.count++;
          stats.bytes += bytesPerPath;
          stats.lastUpdate = now;
          continue;
        }

        if (pathStats.size >= PATH_STATS_MAX_SIZE) {
          let stalestPath: string | null = null;
          const cached = metrics._pathStatsStalest as { path: string; ts: number } | null;

          if (cached !== null) {
            const entry = pathStats.get(cached.path);
            if (entry && (entry.lastUpdate || 0) === cached.ts) {
              stalestPath = cached.path;
            }
          }

          if (!stalestPath) {
            let stalestTs = Infinity;
            for (const [existingPath, existingStats] of pathStats) {
              const ts = existingStats.lastUpdate || 0;
              if (ts < stalestTs) {
                stalestTs = ts;
                stalestPath = existingPath;
              }
            }
          }

          if (stalestPath !== null) {
            pathStats.delete(stalestPath);
            metrics._pathStatsStalest = null;
          }
        }

        pathStats.set(path, {
          count: 1,
          bytes: bytesPerPath,
          lastUpdate: now
        });

        // Do not cache the newly added path as "stalest" — it has lastUpdate = now
        // (the most recent timestamp) and is never the actual stalest entry.
        // The cache was cleared during eviction (L290); the next eviction will
        // trigger a correct linear scan to find the true stalest path.
      }
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) {
      return "0 B";
    }
    if (bytes < 0) {
      return "-" + formatBytes(-bytes);
    }
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function getTopNPaths(n: number, uptimeSeconds: number): PathStatEntry[] {
    const pathStats = metrics.pathStats;
    const entries = Array.from(pathStats.entries());
    const result: PathStatEntry[] = [];

    for (const [path, stats] of entries) {
      const item: PathStatEntry = {
        path,
        count: stats.count,
        bytes: stats.bytes,
        bytesFormatted: formatBytes(stats.bytes),
        lastUpdate: stats.lastUpdate,
        updatesPerMinute: uptimeSeconds > 0 ? Math.round((stats.count / uptimeSeconds) * 60) : 0
      };

      if (result.length < n) {
        result.push(item);
        if (result.length === n) {
          result.sort((a, b) => b.bytes - a.bytes);
        }
      } else if (item.bytes > result[n - 1].bytes) {
        result[n - 1] = item;
        for (let i = n - 1; i > 0 && result[i].bytes > result[i - 1].bytes; i--) {
          [result[i], result[i - 1]] = [result[i - 1], result[i]];
        }
      }
    }

    if (result.length < n && result.length > 0) {
      result.sort((a, b) => b.bytes - a.bytes);
    }

    return result;
  }

  return {
    metrics,
    recordError,
    resetMetrics,
    updateBandwidthRates,
    trackPathStats,
    formatBytes,
    getTopNPaths
  };
}

export = createMetrics;
