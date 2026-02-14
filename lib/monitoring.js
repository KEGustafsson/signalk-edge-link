"use strict";

/**
 * Signal K Edge Link v2.0 - Enhanced Monitoring
 *
 * Provides advanced monitoring data structures for:
 * - Packet loss heatmap visualization (time-bucketed loss tracking)
 * - Per-path latency tracking (latency per Signal K path)
 * - Retransmission rate chart data (time-series retransmission rates)
 * - Alert thresholds with Signal K notifications
 *
 * @module lib/monitoring
 */

const {
  MONITORING_HEATMAP_BUCKETS,
  MONITORING_HEATMAP_BUCKET_DURATION,
  MONITORING_RETRANSMIT_HISTORY_SIZE,
  MONITORING_PATH_LATENCY_WINDOW,
  MONITORING_ALERT_COOLDOWN
} = require("./constants");

// ── Packet Loss Heatmap Tracker ──

/**
 * Tracks packet loss data in time buckets for heatmap visualization.
 * Each bucket covers a configurable time window and tracks loss ratio.
 */
class PacketLossTracker {
  /**
   * @param {Object} [config]
   * @param {number} [config.maxBuckets] - Number of time buckets to retain
   * @param {number} [config.bucketDuration] - Duration of each bucket (ms)
   */
  constructor(config = {}) {
    this.maxBuckets = config.maxBuckets || MONITORING_HEATMAP_BUCKETS;
    this.bucketDuration = config.bucketDuration || MONITORING_HEATMAP_BUCKET_DURATION;
    this.buckets = [];
    this._currentBucket = null;
    this._lastBucketTime = 0;
  }

  /**
   * Record a packet event (sent or lost)
   * @param {boolean} lost - Whether the packet was lost
   */
  record(lost) {
    const now = Date.now();
    this._ensureBucket(now);
    this._currentBucket.total++;
    if (lost) {
      this._currentBucket.lost++;
    }
  }

  /**
   * Record batch packet statistics
   * @param {number} sent - Packets sent in this period
   * @param {number} lost - Packets lost in this period
   */
  recordBatch(sent, lost) {
    const now = Date.now();
    this._ensureBucket(now);
    this._currentBucket.total += sent;
    this._currentBucket.lost += lost;
  }

  /**
   * Get heatmap data for visualization
   * @returns {Array<Object>} Array of { timestamp, total, lost, lossRate }
   */
  getHeatmapData() {
    // Finalize current bucket
    this._ensureBucket(Date.now());

    return this.buckets.map(b => ({
      timestamp: b.timestamp,
      total: b.total,
      lost: b.lost,
      lossRate: b.total > 0 ? b.lost / b.total : 0
    }));
  }

  /**
   * Get summary statistics
   * @returns {Object} Summary with overall loss rate and trends
   */
  getSummary() {
    const data = this.getHeatmapData();
    if (data.length === 0) {
      return { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 };
    }

    let totalSent = 0;
    let totalLost = 0;
    let maxLossRate = 0;

    for (const bucket of data) {
      totalSent += bucket.total;
      totalLost += bucket.lost;
      if (bucket.lossRate > maxLossRate) {
        maxLossRate = bucket.lossRate;
      }
    }

    const overallLossRate = totalSent > 0 ? totalLost / totalSent : 0;

    // Trend: compare last quarter to first quarter
    let trend = "stable";
    if (data.length >= 4) {
      const quarter = Math.floor(data.length / 4);
      const firstAvg = data.slice(0, quarter).reduce((s, b) => s + b.lossRate, 0) / quarter;
      const lastAvg = data.slice(-quarter).reduce((s, b) => s + b.lossRate, 0) / quarter;
      if (lastAvg > firstAvg * 1.5) {trend = "worsening";}
      else if (lastAvg < firstAvg * 0.5) {trend = "improving";}
    }

    return {
      overallLossRate,
      maxLossRate,
      trend,
      bucketCount: data.length
    };
  }

  /**
   * Ensure a valid current bucket exists for the given timestamp
   * @private
   */
  _ensureBucket(now) {
    if (!this._currentBucket || now - this._lastBucketTime >= this.bucketDuration) {
      // Finalize previous bucket
      if (this._currentBucket) {
        this.buckets.push(this._currentBucket);
        // Trim to max buckets
        while (this.buckets.length > this.maxBuckets) {
          this.buckets.shift();
        }
      }
      this._currentBucket = {
        timestamp: now,
        total: 0,
        lost: 0
      };
      this._lastBucketTime = now;
    }
  }

  /**
   * Reset all tracking data
   */
  reset() {
    this.buckets = [];
    this._currentBucket = null;
    this._lastBucketTime = 0;
  }
}

// ── Per-Path Latency Tracker ──

/**
 * Tracks latency metrics per Signal K path.
 * Maintains a sliding window of latency samples per path.
 */
class PathLatencyTracker {
  /**
   * @param {Object} [config]
   * @param {number} [config.windowSize] - Number of samples per path
   * @param {number} [config.maxPaths] - Maximum paths to track (prevent memory leaks)
   */
  constructor(config = {}) {
    this.windowSize = config.windowSize || MONITORING_PATH_LATENCY_WINDOW;
    this.maxPaths = config.maxPaths || 200;
    this.paths = new Map(); // path -> { samples: [], stats: {} }
  }

  /**
   * Record a latency sample for a given path
   * @param {string} path - Signal K path
   * @param {number} latencyMs - Latency in milliseconds
   */
  record(path, latencyMs) {
    let entry = this.paths.get(path);
    if (!entry) {
      // Evict oldest if at capacity
      if (this.paths.size >= this.maxPaths) {
        const firstKey = this.paths.keys().next().value;
        this.paths.delete(firstKey);
      }
      entry = { samples: [], lastUpdate: 0 };
      this.paths.set(path, entry);
    }

    entry.samples.push(latencyMs);
    if (entry.samples.length > this.windowSize) {
      entry.samples.shift();
    }
    entry.lastUpdate = Date.now();
  }

  /**
   * Get latency statistics for a specific path
   * @param {string} path - Signal K path
   * @returns {Object|null} Latency stats or null
   */
  getPathStats(path) {
    const entry = this.paths.get(path);
    if (!entry || entry.samples.length === 0) {return null;}

    return this._calculateStats(path, entry);
  }

  /**
   * Get latency data for all tracked paths
   * @param {number} [topN=20] - Maximum number of paths to return
   * @returns {Array<Object>} Sorted by average latency (descending)
   */
  getAllStats(topN = 20) {
    const stats = [];
    for (const [path, entry] of this.paths) {
      if (entry.samples.length > 0) {
        stats.push(this._calculateStats(path, entry));
      }
    }

    // Sort by average latency descending
    stats.sort((a, b) => b.avg - a.avg);

    return stats.slice(0, topN);
  }

  /**
   * Calculate statistics for a path entry
   * @private
   */
  _calculateStats(path, entry) {
    const samples = entry.samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const avg = sum / samples.length;

    return {
      path,
      sampleCount: samples.length,
      avg: Math.round(avg * 100) / 100,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      lastUpdate: entry.lastUpdate
    };
  }

  /**
   * Reset all tracking data
   */
  reset() {
    this.paths.clear();
  }
}

// ── Retransmission Rate Tracker ──

/**
 * Tracks retransmission rates over time for chart visualization.
 * Records periodic snapshots of retransmission activity.
 */
class RetransmissionTracker {
  /**
   * @param {Object} [config]
   * @param {number} [config.maxEntries] - Max history entries to retain
   */
  constructor(config = {}) {
    this.maxEntries = config.maxEntries || MONITORING_RETRANSMIT_HISTORY_SIZE;
    this.history = [];
    this._lastSnapshot = {
      packetsSent: 0,
      retransmissions: 0,
      timestamp: Date.now()
    };
  }

  /**
   * Record a periodic snapshot of retransmission state
   * @param {number} totalPacketsSent - Total packets sent since start
   * @param {number} totalRetransmissions - Total retransmissions since start
   */
  snapshot(totalPacketsSent, totalRetransmissions) {
    const now = Date.now();
    const elapsed = (now - this._lastSnapshot.timestamp) / 1000;
    if (elapsed <= 0) {return;}

    const periodPackets = totalPacketsSent - this._lastSnapshot.packetsSent;
    const periodRetransmissions = totalRetransmissions - this._lastSnapshot.retransmissions;

    const rate = periodPackets > 0 ? periodRetransmissions / periodPackets : 0;
    const retransmitsPerSec = elapsed > 0 ? periodRetransmissions / elapsed : 0;

    this.history.push({
      timestamp: now,
      rate: Math.round(rate * 10000) / 10000, // 4 decimal places
      retransmitsPerSec: Math.round(retransmitsPerSec * 100) / 100,
      periodPackets,
      periodRetransmissions
    });

    // Trim to max entries
    while (this.history.length > this.maxEntries) {
      this.history.shift();
    }

    this._lastSnapshot = {
      packetsSent: totalPacketsSent,
      retransmissions: totalRetransmissions,
      timestamp: now
    };
  }

  /**
   * Get chart data for retransmission rates
   * @param {number} [limit] - Maximum entries to return
   * @returns {Array<Object>} Time series data
   */
  getChartData(limit) {
    if (limit && limit < this.history.length) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * Get summary statistics
   * @returns {Object}
   */
  getSummary() {
    if (this.history.length === 0) {
      return { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 };
    }

    let sumRate = 0;
    let maxRate = 0;
    for (const entry of this.history) {
      sumRate += entry.rate;
      if (entry.rate > maxRate) {maxRate = entry.rate;}
    }

    const current = this.history[this.history.length - 1];

    return {
      avgRate: Math.round((sumRate / this.history.length) * 10000) / 10000,
      maxRate,
      currentRate: current.rate,
      entries: this.history.length
    };
  }

  /**
   * Reset all tracking data
   */
  reset() {
    this.history = [];
    this._lastSnapshot = {
      packetsSent: 0,
      retransmissions: 0,
      timestamp: Date.now()
    };
  }
}

// ── Alert Manager ──

/**
 * Manages alert thresholds and emits Signal K notifications
 * when network metrics exceed configured limits.
 */
class AlertManager {
  /**
   * @param {Object} app - Signal K app instance
   * @param {Object} [config]
   * @param {Object} [config.thresholds] - Alert thresholds
   */
  constructor(app, config = {}) {
    this.app = app;
    this.thresholds = {
      rtt: config.thresholds?.rtt || { warning: 300, critical: 800 },
      packetLoss: config.thresholds?.packetLoss || { warning: 0.03, critical: 0.10 },
      retransmitRate: config.thresholds?.retransmitRate || { warning: 0.05, critical: 0.15 },
      jitter: config.thresholds?.jitter || { warning: 100, critical: 300 },
      queueDepth: config.thresholds?.queueDepth || { warning: 100, critical: 500 }
    };
    this.cooldown = config.cooldown || MONITORING_ALERT_COOLDOWN;

    // Track active alerts and last alert time for cooldown
    this.activeAlerts = new Map(); // metricName -> { level, timestamp, value }
    this._lastAlertTime = new Map(); // metricName -> timestamp
  }

  /**
   * Check a metric value against thresholds and emit alerts
   * @param {string} metricName - Name of the metric (e.g., 'rtt', 'packetLoss')
   * @param {number} value - Current metric value
   * @returns {Object|null} Alert object if threshold exceeded, null otherwise
   */
  check(metricName, value) {
    const threshold = this.thresholds[metricName];
    if (!threshold) {return null;}

    let level = null;
    if (value >= threshold.critical) {
      level = "critical";
    } else if (value >= threshold.warning) {
      level = "warning";
    }

    const currentAlert = this.activeAlerts.get(metricName);

    if (level) {
      // Check cooldown
      const lastTime = this._lastAlertTime.get(metricName) || 0;
      const cooldownExpired = Date.now() - lastTime >= this.cooldown;

      // Only alert if level changed or cooldown expired
      if (!currentAlert || currentAlert.level !== level || cooldownExpired) {
        const alert = {
          metric: metricName,
          level,
          value,
          threshold: threshold[level],
          timestamp: Date.now()
        };

        this.activeAlerts.set(metricName, alert);
        this._lastAlertTime.set(metricName, Date.now());
        this._emitAlert(alert);
        return alert;
      }
    } else if (currentAlert) {
      // Clear alert
      this.activeAlerts.delete(metricName);
      this._emitClear(metricName);
    }

    return null;
  }

  /**
   * Check all metrics at once
   * @param {Object} metrics - { rtt, packetLoss, retransmitRate, jitter, queueDepth }
   * @returns {Array<Object>} Array of triggered alerts
   */
  checkAll(metrics) {
    const alerts = [];
    for (const [name, value] of Object.entries(metrics)) {
      if (value !== undefined && this.thresholds[name]) {
        const alert = this.check(name, value);
        if (alert) {alerts.push(alert);}
      }
    }
    return alerts;
  }

  /**
   * Update threshold configuration
   * @param {string} metricName - Metric name
   * @param {Object} thresholds - { warning, critical }
   */
  setThreshold(metricName, thresholds) {
    if (!this.thresholds[metricName]) {
      this.thresholds[metricName] = {};
    }
    if (thresholds.warning !== undefined) {
      this.thresholds[metricName].warning = thresholds.warning;
    }
    if (thresholds.critical !== undefined) {
      this.thresholds[metricName].critical = thresholds.critical;
    }
  }

  /**
   * Get current alert state
   * @returns {Object} Active alerts and thresholds
   */
  getState() {
    const alerts = {};
    for (const [name, alert] of this.activeAlerts) {
      alerts[name] = { ...alert };
    }
    return {
      thresholds: { ...this.thresholds },
      activeAlerts: alerts
    };
  }

  /**
   * Emit an alert notification via Signal K
   * @private
   */
  _emitAlert(alert) {
    const stateMap = { warning: "warn", critical: "alert" };
    try {
      this.app.handleMessage("vessels.self", {
        updates: [{
          source: { label: "signalk-edge-link", type: "plugin" },
          timestamp: new Date().toISOString(),
          values: [{
            path: `notifications.signalk-edge-link.${alert.metric}`,
            value: {
              state: stateMap[alert.level] || "alert",
              message: `${alert.metric}: ${alert.value} exceeds ${alert.level} threshold (${alert.threshold})`,
              method: ["visual"]
            }
          }]
        }]
      });
    } catch (err) {
      this.app.debug(`[Alert] Failed to emit notification: ${err.message}`);
    }
  }

  /**
   * Emit a clear notification when alert condition resolves
   * @private
   */
  _emitClear(metricName) {
    try {
      this.app.handleMessage("vessels.self", {
        updates: [{
          source: { label: "signalk-edge-link", type: "plugin" },
          timestamp: new Date().toISOString(),
          values: [{
            path: `notifications.signalk-edge-link.${metricName}`,
            value: {
              state: "normal",
              message: `${metricName}: returned to normal`,
              method: []
            }
          }]
        }]
      });
    } catch (err) {
      this.app.debug(`[Alert] Failed to emit clear notification: ${err.message}`);
    }
  }

  /**
   * Reset all active alerts
   */
  reset() {
    this.activeAlerts.clear();
    this._lastAlertTime.clear();
  }
}

module.exports = {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
};
