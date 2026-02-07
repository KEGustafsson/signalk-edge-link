"use strict";

const CircularBuffer = require("./CircularBuffer");
const {
  BANDWIDTH_HISTORY_MAX,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} = require("./constants");

/**
 * Creates the metrics tracking subsystem.
 * All metrics state and related functions are encapsulated here.
 * @returns {Object} Metrics API
 */
function createMetrics() {
  const metrics = {
    startTime: Date.now(),
    deltasSent: 0,
    deltasReceived: 0,
    udpSendErrors: 0,
    udpRetries: 0,
    compressionErrors: 0,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    lastError: null,
    lastErrorTime: null,
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
    metrics.lastError = message;
    metrics.lastErrorTime = Date.now();
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
      lastError: null,
      lastErrorTime: null
    });
    Object.assign(metrics.bandwidth, {
      bytesOut: 0, bytesIn: 0, bytesOutRaw: 0, bytesInRaw: 0,
      packetsOut: 0, packetsIn: 0, lastBytesOut: 0, lastBytesIn: 0,
      lastRateCalcTime: Date.now(), rateOut: 0, rateIn: 0, compressionRatio: 0,
      history: new CircularBuffer(BANDWIDTH_HISTORY_MAX)
    });
    metrics.pathStats.clear();
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

    for (const update of delta.updates) {
      if (update.values) {
        for (const value of update.values) {
          if (value.path) {
            const path = value.path;
            const stats = metrics.pathStats.get(path) || { count: 0, bytes: 0, lastUpdate: 0 };
            stats.count++;
            stats.bytes += Math.round(size / update.values.length);
            stats.lastUpdate = Date.now();
            metrics.pathStats.set(path, stats);
          }
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
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
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
