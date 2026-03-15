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

import {
  MONITORING_HEATMAP_BUCKETS,
  MONITORING_HEATMAP_BUCKET_DURATION,
  MONITORING_RETRANSMIT_HISTORY_SIZE,
  MONITORING_PATH_LATENCY_WINDOW,
  MONITORING_ALERT_COOLDOWN
} from "./constants";

// ── Packet Loss Heatmap Tracker ──

/**
 * Tracks packet loss data in time buckets for heatmap visualization.
 * Each bucket covers a configurable time window and tracks loss ratio.
 */
export class PacketLossTracker {
  maxBuckets: number;
  bucketDuration: number;
  buckets: Array<{ timestamp: number; total: number; lost: number }>;
  _currentBucket: { timestamp: number; total: number; lost: number } | null;
  _lastBucketTime: number;

  /**
   * @param {Object} [config]
   * @param {number} [config.maxBuckets] - Number of time buckets to retain
   * @param {number} [config.bucketDuration] - Duration of each bucket (ms)
   */
  constructor(config: { maxBuckets?: number; bucketDuration?: number } = {}) {
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
  record(lost: boolean): void {
    const now = Date.now();
    this._ensureBucket(now);
    this._currentBucket!.total++;
    if (lost) {
      this._currentBucket!.lost++;
    }
  }

  /**
   * Record batch packet statistics
   * @param {number} sent - Packets sent in this period
   * @param {number} lost - Packets lost in this period
   */
  recordBatch(sent: number, lost: number): void {
    const now = Date.now();
    this._ensureBucket(now);
    this._currentBucket!.total += sent;
    this._currentBucket!.lost += lost;
  }

  /**
   * Get heatmap data for visualization
   * @returns {Array<Object>} Array of { timestamp, total, lost, lossRate }
   */
  getHeatmapData(): Array<{ timestamp: number; total: number; lost: number; lossRate: number }> {
    // Finalize current bucket
    this._ensureBucket(Date.now());

    return this.buckets.map((b) => ({
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
  getSummary(): {
    overallLossRate: number;
    maxLossRate: number;
    trend: string;
    bucketCount: number;
  } {
    const data = this.getHeatmapData();
    const bucketCount = data.length;
    if (bucketCount === 0) {
      return { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 };
    }

    let totalSent = 0;
    let totalLost = 0;
    let maxLossRate = 0;

    for (let i = 0; i < bucketCount; i++) {
      const bucket = data[i];
      totalSent += bucket.total;
      totalLost += bucket.lost;
      if (bucket.lossRate > maxLossRate) {
        maxLossRate = bucket.lossRate;
      }
    }

    const overallLossRate = totalSent > 0 ? totalLost / totalSent : 0;

    // Trend: compare last quarter to first quarter
    let trend = "stable";
    if (bucketCount >= 4) {
      const quarter = Math.floor(bucketCount / 4);
      let firstSum = 0;
      let lastSum = 0;

      for (let i = 0; i < quarter; i++) {
        firstSum += data[i].lossRate;
        lastSum += data[bucketCount - quarter + i].lossRate;
      }

      const firstAvg = firstSum / quarter;
      const lastAvg = lastSum / quarter;

      if (lastAvg > firstAvg * 1.5) {
        trend = "worsening";
      } else if (lastAvg < firstAvg * 0.5) {
        trend = "improving";
      }
    }

    return {
      overallLossRate,
      maxLossRate,
      trend,
      bucketCount
    };
  }

  /**
   * Ensure a valid current bucket exists for the given timestamp
   * @private
   */
  _ensureBucket(now: number): void {
    if (!this._currentBucket || now - this._lastBucketTime >= this.bucketDuration) {
      // Finalize previous bucket
      if (this._currentBucket) {
        this.buckets.push(this._currentBucket);
        // Trim to max buckets — we push exactly one bucket per interval, so at
        // most one needs to be dropped here (shift is O(n) but n = maxBuckets).
        if (this.buckets.length > this.maxBuckets) {
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
  reset(): void {
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
export class PathLatencyTracker {
  windowSize: number;
  maxPaths: number;
  paths: Map<string, { samples: number[]; lastUpdate: number }>;

  /**
   * @param {Object} [config]
   * @param {number} [config.windowSize] - Number of samples per path
   * @param {number} [config.maxPaths] - Maximum paths to track (prevent memory leaks)
   */
  constructor(config: { windowSize?: number; maxPaths?: number } = {}) {
    this.windowSize = config.windowSize ?? MONITORING_PATH_LATENCY_WINDOW;
    this.maxPaths = config.maxPaths ?? 200;
    this.paths = new Map(); // path -> { samples: [], stats: {} }
  }

  /**
   * Record a latency sample for a given path
   * @param {string} path - Signal K path
   * @param {number} latencyMs - Latency in milliseconds
   */
  record(path: string, latencyMs: number): void {
    let entry = this.paths.get(path);
    if (!entry) {
      // Evict oldest if at capacity
      if (this.paths.size >= this.maxPaths) {
        const firstKey = this.paths.keys().next().value;
        if (firstKey !== undefined) {
          this.paths.delete(firstKey);
        }
      }
      entry = { samples: [], lastUpdate: 0 };
      this.paths.set(path, entry);
    }

    entry.samples.push(latencyMs);
    if (entry.samples.length > this.windowSize) {
      entry.samples.splice(0, entry.samples.length - this.windowSize);
    }
    entry.lastUpdate = Date.now();
  }

  /**
   * Get latency statistics for a specific path
   * @param {string} path - Signal K path
   * @returns {Object|null} Latency stats or null
   */
  getPathStats(path: string): any | null {
    const entry = this.paths.get(path);
    if (!entry || entry.samples.length === 0) {
      return null;
    }

    return this._calculateStats(path, entry);
  }

  /**
   * Get latency data for all tracked paths
   * @param {number} [topN=20] - Maximum number of paths to return
   * @returns {Array<Object>} Sorted by average latency (descending)
   */
  getAllStats(topN: number = 20): any[] {
    const limit = Math.max(0, topN);
    if (limit === 0) {
      return [];
    }

    const stats: any[] = [];
    for (const [path, entry] of this.paths) {
      if (entry.samples.length === 0) {
        continue;
      }

      const stat = this._calculateStats(path, entry);
      if (stats.length === 0) {
        stats.push(stat);
        continue;
      }

      let insertAt = stats.length;
      while (insertAt > 0 && stat.avg > stats[insertAt - 1].avg) {
        insertAt--;
      }

      if (insertAt < limit) {
        stats.splice(insertAt, 0, stat);
        if (stats.length > limit) {
          stats.pop();
        }
      } else if (stats.length < limit) {
        stats.push(stat);
      }
    }

    return stats;
  }

  /**
   * Calculate statistics for a path entry
   * @private
   */
  _calculateStats(path: string, entry: { samples: number[]; lastUpdate: number }): any {
    const samples = entry.samples;
    const sampleCount = samples.length;
    const sorted = new Array(sampleCount);

    let sum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const value = samples[i];
      sum += value;
      sorted[i] = value;
    }

    sorted.sort((a: number, b: number) => a - b);
    const avg = sum / sampleCount;

    return {
      path,
      sampleCount,
      avg: Math.round(avg * 100) / 100,
      min: sorted[0],
      max: sorted[sampleCount - 1],
      p50: sorted[Math.floor(sampleCount * 0.5)],
      p95: sorted[Math.floor(sampleCount * 0.95)],
      p99: sorted[Math.floor(sampleCount * 0.99)],
      lastUpdate: entry.lastUpdate
    };
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.paths.clear();
  }
}

// ── Retransmission Rate Tracker ──

/**
 * Tracks retransmission rates over time for chart visualization.
 * Records periodic snapshots of retransmission activity.
 */
export class RetransmissionTracker {
  maxEntries: number;
  history: Array<{
    timestamp: number;
    rate: number;
    retransmitsPerSec: number;
    periodPackets: number;
    periodRetransmissions: number;
  }>;
  _lastSnapshot: { packetsSent: number; retransmissions: number; timestamp: number };

  /**
   * @param {Object} [config]
   * @param {number} [config.maxEntries] - Max history entries to retain
   */
  constructor(config: { maxEntries?: number } = {}) {
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
  snapshot(totalPacketsSent: number, totalRetransmissions: number): void {
    const now = Date.now();
    const elapsed = (now - this._lastSnapshot.timestamp) / 1000;
    if (elapsed <= 0) {
      return;
    }

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
    if (this.history.length > this.maxEntries) {
      this.history.splice(0, this.history.length - this.maxEntries);
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
  getChartData(limit?: number): any[] {
    if (limit && limit < this.history.length) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * Get summary statistics
   * @returns {Object}
   */
  getSummary(): { avgRate: number; maxRate: number; currentRate: number; entries: number } {
    if (this.history.length === 0) {
      return { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 };
    }

    let sumRate = 0;
    let maxRate = 0;
    for (const entry of this.history) {
      sumRate += entry.rate;
      if (entry.rate > maxRate) {
        maxRate = entry.rate;
      }
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
  reset(): void {
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
export class AlertManager {
  app: any;
  instanceId: string;
  sourceLabel: string;
  thresholds: any;
  cooldown: number;
  _perMetricCooldown: Map<string, number>;
  notificationsEnabled: boolean;
  activeAlerts: Map<
    string,
    { metric: string; level: string; value: number; threshold: number; timestamp: number }
  >;
  _lastAlertTime: Map<string, number>;

  /**
   * @param {Object} app - Signal K app instance
   * @param {Object} [config]
   * @param {Object} [config.thresholds] - Alert thresholds
   */
  constructor(app: any, config: any = {}) {
    this.app = app;
    // instanceId is used to namespace notification paths so multiple instances
    // don't overwrite each other's alerts in Signal K.
    this.instanceId = (config && config.instanceId) || "";
    this.sourceLabel = this.instanceId
      ? `signalk-edge-link:${this.instanceId}`
      : "signalk-edge-link";
    const thresholdsConfig =
      config &&
      typeof config === "object" &&
      config.thresholds &&
      typeof config.thresholds === "object"
        ? config.thresholds
        : config;
    this.thresholds = {
      rtt: thresholdsConfig?.rtt || { warning: 300, critical: 800 },
      packetLoss: thresholdsConfig?.packetLoss || { warning: 0.03, critical: 0.1 },
      retransmitRate: thresholdsConfig?.retransmitRate || { warning: 0.05, critical: 0.15 },
      jitter: thresholdsConfig?.jitter || { warning: 100, critical: 300 },
      queueDepth: thresholdsConfig?.queueDepth || { warning: 100, critical: 500 }
    };
    this.cooldown = config.cooldown || MONITORING_ALERT_COOLDOWN;
    // Per-metric cooldown overrides: e.g. { rtt: 30000, packetLoss: 120000 }
    this._perMetricCooldown = new Map();
    if (config.cooldowns && typeof config.cooldowns === "object") {
      for (const [metric, cd] of Object.entries(config.cooldowns)) {
        if (typeof cd === "number" && cd > 0) {
          this._perMetricCooldown.set(metric, cd);
        }
      }
    }
    this.notificationsEnabled = config.enabled === true;

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
  check(metricName: string, value: number): any | null {
    const threshold = this.thresholds[metricName];
    if (!threshold) {
      return null;
    }

    let level: string | null = null;
    if (value >= threshold.critical) {
      level = "critical";
    } else if (value >= threshold.warning) {
      level = "warning";
    }

    const currentAlert = this.activeAlerts.get(metricName);

    if (level) {
      // Check cooldown (per-metric override or global default)
      const lastTime = this._lastAlertTime.get(metricName) || 0;
      const effectiveCooldown = this._perMetricCooldown.get(metricName) ?? this.cooldown;
      const cooldownExpired = Date.now() - lastTime >= effectiveCooldown;

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
  checkAll(metrics: Record<string, number | undefined>): any[] {
    const alerts: any[] = [];
    for (const [name, value] of Object.entries(metrics)) {
      if (value !== undefined && this.thresholds[name]) {
        const alert = this.check(name, value);
        if (alert) {
          alerts.push(alert);
        }
      }
    }
    return alerts;
  }

  /**
   * Update threshold configuration
   * @param {string} metricName - Metric name
   * @param {Object} thresholds - { warning, critical }
   */
  setThreshold(metricName: string, thresholds: { warning?: number; critical?: number }): void {
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
  getState(): { thresholds: any; activeAlerts: Record<string, any> } {
    const alerts: Record<string, any> = {};
    for (const [name, alert] of this.activeAlerts) {
      alerts[name] = { ...alert };
    }
    return {
      thresholds: { ...this.thresholds },
      activeAlerts: alerts
    };
  }

  /**
   * Send a Signal K notification for a given path and state
   * @private
   */
  _emitNotification(path: string, state: string, message: string, method: string[]): void {
    if (!this.notificationsEnabled) {
      return;
    }
    try {
      this.app.handleMessage(this.sourceLabel, {
        context: "vessels.self",
        updates: [
          {
            source: { label: this.sourceLabel, type: "plugin" },
            timestamp: new Date().toISOString(),
            values: [{ path, value: { state, message, method } }]
          }
        ]
      });
    } catch (err: any) {
      this.app.debug(`[Alert] Failed to emit notification: ${err.message}`);
    }
  }

  /**
   * Emit an alert notification via Signal K
   * @private
   */
  _emitAlert(alert: {
    metric: string;
    level: string;
    value: number;
    threshold: number;
    timestamp: number;
  }): void {
    const stateMap: Record<string, string> = { warning: "warn", critical: "alert" };
    const ns = this.instanceId ? `${this.instanceId}.` : "";
    this._emitNotification(
      `notifications.signalk-edge-link.${ns}${alert.metric}`,
      stateMap[alert.level] || "alert",
      `${alert.metric}: ${alert.value} exceeds ${alert.level} threshold (${alert.threshold})`,
      ["visual"]
    );
  }

  /**
   * Emit a clear notification when alert condition resolves
   * @private
   */
  _emitClear(metricName: string): void {
    const ns = this.instanceId ? `${this.instanceId}.` : "";
    this._emitNotification(
      `notifications.signalk-edge-link.${ns}${metricName}`,
      "normal",
      `${metricName}: returned to normal`,
      []
    );
  }

  /**
   * Reset all active alerts
   */
  reset(): void {
    this.activeAlerts.clear();
    this._lastAlertTime.clear();
  }
}
