// @ts-nocheck
"use strict";

const CircularBuffer = require("./CircularBuffer.ts");
const {
  BANDWIDTH_HISTORY_MAX,
  PATH_STATS_MAX_SIZE,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} = require("./constants.ts");

/**
 * Creates the metrics tracking subsystem.
 * All metrics state and related functions are encapsulated here.
 * @returns {Object} Metrics API
 */
function createMetrics() {
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

  const metrics = {
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
    // Latest client-reported network quality snapshot (used in server mode UI/API)
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
    // Bandwidth tracking
    bandwidth: {
      bytesOut: 0, // Compressed bytes sent
      bytesIn: 0, // Compressed bytes received
      bytesOutRaw: 0, // Raw bytes before compression
      bytesInRaw: 0, // Raw bytes after decompression
      packetsOut: 0,
      packetsIn: 0,
      lastBytesOut: 0, // For rate calculation
      lastBytesIn: 0,
      lastRateCalcTime: Date.now(),
      rateOut: 0, // bytes per second
      rateIn: 0,
      compressionRatio: 0, // percentage saved
      history: new CircularBuffer(BANDWIDTH_HISTORY_MAX)
    },
    // Path-level analytics
    pathStats: new Map(), // path -> { count, bytes, lastUpdate }
    _pathStatsStalest: null, // cached { path, ts } for O(1) eviction
    // Smart batching metrics
    smartBatching: {
      earlySends: 0,
      timerSends: 0,
      oversizedPackets: 0,
      avgBytesPerDelta: SMART_BATCH_INITIAL_ESTIMATE,
      maxDeltasPerBatch: calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE)
    }
  };

  /**
   * Records an error in metrics tracking
   * @param {string} category - Error category ('compression', 'encryption', 'subscription', 'udpSend', 'general')
   * @param {string} message - Error message
   */
  function recordError(category, message) {
    const counterMap = {
      compression: "compressionErrors",
      encryption: "encryptionErrors",
      subscription: "subscriptionErrors",
      udpSend: "udpSendErrors"
    };
    const counter = counterMap[category];
    if (counter) {
      metrics[counter]++;
    }

    const normalizedCategory = normalizeErrorCategory(category);
    if (metrics.errorCounts[normalizedCategory] === undefined) {
      metrics.errorCounts[normalizedCategory] = 0;
    }
    metrics.errorCounts[normalizedCategory]++;

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

  function normalizeErrorCategory(category) {
    switch (category) {
      case "compression":
      case "encryption":
      case "subscription":
      case "udpSend":
      case "pingTimeout":
      case "sendFailure":
      case "crypto":
      case "general":
        return category;
      default:
        return "general";
    }
  }

  /**
   * Resets all metrics to initial state (used during plugin stop for clean restart)
   */
  function resetMetrics() {
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
      // v2 runtime metrics
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
      dataPacketsReceived: 0
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

  /**
   * Calculates bandwidth rates and updates history
   * @param {boolean} isServerMode - Whether plugin is in server mode
   */
  function updateBandwidthRates(isServerMode) {
    const now = Date.now();
    const elapsed = (now - metrics.bandwidth.lastRateCalcTime) / 1000;

    if (elapsed > 0) {
      const bytesDeltaOut = metrics.bandwidth.bytesOut - metrics.bandwidth.lastBytesOut;
      const bytesDeltaIn = metrics.bandwidth.bytesIn - metrics.bandwidth.lastBytesIn;

      metrics.bandwidth.rateOut = Math.round(bytesDeltaOut / elapsed);
      metrics.bandwidth.rateIn = Math.round(bytesDeltaIn / elapsed);

      // Update compression ratio (server: bytesIn/bytesInRaw, client: bytesOut/bytesOutRaw)
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

  /**
   * Tracks path-level statistics
   * @param {Object} delta - The delta object to analyze
   * @param {number} deltaSize - Precomputed delta size (optional)
   */
  function trackPathStats(delta, deltaSize = null) {
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
          // Evict stalest entry using cached pointer for O(1) amortized cost.
          // If the cached entry was already updated/deleted, do a full scan
          // to refresh the cache — this happens rarely (once per eviction miss).
          let stalestPath = null;
          const cached = metrics._pathStatsStalest;

          if (cached) {
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

        // Track stalest candidate for next eviction
        if (!metrics._pathStatsStalest || now < metrics._pathStatsStalest.ts) {
          metrics._pathStatsStalest = { path, ts: now };
        }
      }
    }
  }

  /**
   * Formats bytes to human readable string
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted string
   */
  function formatBytes(bytes) {
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

  /**
   * Get top N paths by bytes (optimized partial sort)
   * @param {number} n - Number of top paths to return
   * @param {number} uptimeSeconds - Plugin uptime in seconds
   * @returns {Array} Top N paths sorted by bytes
   */
  function getTopNPaths(n, uptimeSeconds) {
    const entries = Array.from(metrics.pathStats.entries());
    const result = [];

    for (const [path, stats] of entries) {
      const item = {
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

module.exports = createMetrics;
