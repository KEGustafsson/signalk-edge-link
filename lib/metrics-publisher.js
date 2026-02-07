"use strict";

/**
 * Signal K Edge Link v2.0 - Metrics Publisher
 *
 * Publishes network quality metrics to Signal K paths.
 * Calculates link quality score from multiple factors.
 *
 * @module lib/metrics-publisher
 */

class MetricsPublisher {
  /**
   * @param {Object} app - Signal K app instance
   * @param {Object} config - Configuration
   */
  constructor(app, config = {}) {
    this.app = app;
    this.config = config;

    // Moving average windows
    this.rttWindow = [];
    this.jitterWindow = [];
    this.lossWindow = [];

    this.windowSize = 10; // 10 seconds

    // Last published values (for deduplication)
    this.lastPublished = {};
  }

  /**
   * Publish metrics to Signal K
   *
   * @param {Object} metrics - Metrics object
   */
  publish(metrics) {
    const values = [];

    // Core metrics
    if (metrics.rtt !== undefined) {
      this._addToWindow(this.rttWindow, metrics.rtt);
      const avgRtt = this._calculateAverage(this.rttWindow);
      values.push({ path: "networking.edgeLink.rtt", value: avgRtt });
    }

    if (metrics.jitter !== undefined) {
      this._addToWindow(this.jitterWindow, metrics.jitter);
      const avgJitter = this._calculateAverage(this.jitterWindow);
      values.push({ path: "networking.edgeLink.jitter", value: avgJitter });
    }

    if (metrics.packetLoss !== undefined) {
      this._addToWindow(this.lossWindow, metrics.packetLoss);
      const avgLoss = this._calculateAverage(this.lossWindow);
      values.push({ path: "networking.edgeLink.packetLoss", value: avgLoss });
    }

    // Bandwidth
    if (metrics.uploadBandwidth !== undefined) {
      values.push({
        path: "networking.edgeLink.bandwidth.upload",
        value: metrics.uploadBandwidth
      });
    }

    if (metrics.downloadBandwidth !== undefined) {
      values.push({
        path: "networking.edgeLink.bandwidth.download",
        value: metrics.downloadBandwidth
      });
    }

    // Performance
    if (metrics.packetsSentPerSec !== undefined) {
      values.push({
        path: "networking.edgeLink.packetsPerSecond.sent",
        value: metrics.packetsSentPerSec
      });
    }

    if (metrics.packetsReceivedPerSec !== undefined) {
      values.push({
        path: "networking.edgeLink.packetsPerSecond.received",
        value: metrics.packetsReceivedPerSec
      });
    }

    if (metrics.retransmissions !== undefined) {
      values.push({
        path: "networking.edgeLink.retransmissions",
        value: metrics.retransmissions
      });
    }

    if (metrics.sequenceNumber !== undefined) {
      values.push({
        path: "networking.edgeLink.sequenceNumber",
        value: metrics.sequenceNumber
      });
    }

    if (metrics.queueDepth !== undefined) {
      values.push({
        path: "networking.edgeLink.queueDepth",
        value: metrics.queueDepth
      });
    }

    // Calculate and publish link quality
    const quality = this.calculateLinkQuality({
      rtt: this._calculateAverage(this.rttWindow),
      jitter: this._calculateAverage(this.jitterWindow),
      packetLoss: this._calculateAverage(this.lossWindow),
      retransmitRate: metrics.retransmitRate || 0
    });

    values.push({
      path: "networking.edgeLink.linkQuality",
      value: quality
    });

    // Active link
    if (metrics.activeLink) {
      values.push({
        path: "networking.edgeLink.activeLink",
        value: metrics.activeLink
      });
    }

    // Compression ratio (from v1)
    if (metrics.compressionRatio !== undefined) {
      values.push({
        path: "networking.edgeLink.compressionRatio",
        value: metrics.compressionRatio
      });
    }

    // Only publish if values changed
    if (this._hasChanged(values)) {
      this.app.handleMessage("vessels.self", {
        updates: [{
          source: {
            label: "signalk-edge-link",
            type: "plugin"
          },
          timestamp: new Date().toISOString(),
          values: values
        }]
      });

      this._updateLastPublished(values);
    }
  }

  /**
   * Calculate link quality score (0-100)
   *
   * @param {Object} params
   * @returns {number} Quality score
   */
  calculateLinkQuality({ rtt, jitter, packetLoss, retransmitRate }) {
    // Normalize to 0-1 scores
    const rttScore = this._clamp(1 - (rtt / 1000), 0, 1);
    const jitterScore = this._clamp(1 - (jitter / 500), 0, 1);
    const lossScore = 1 - packetLoss;
    const retransmitScore = this._clamp(1 - (retransmitRate / 0.1), 0, 1);

    // Weighted average
    const quality = (
      lossScore * 40 +
      rttScore * 30 +
      jitterScore * 20 +
      retransmitScore * 10
    );

    return Math.round(quality);
  }

  /**
   * Publish per-link metrics (for bonding)
   *
   * @param {string} linkName - "primary" or "backup"
   * @param {Object} linkMetrics - Link-specific metrics
   */
  publishLinkMetrics(linkName, linkMetrics) {
    const basePath = `networking.edgeLink.links.${linkName}`;

    const values = [
      { path: `${basePath}.status`, value: linkMetrics.status },
      { path: `${basePath}.rtt`, value: linkMetrics.rtt },
      { path: `${basePath}.loss`, value: linkMetrics.loss },
      {
        path: `${basePath}.quality`,
        value: this.calculateLinkQuality(linkMetrics)
      }
    ];

    this.app.handleMessage("vessels.self", {
      updates: [{
        source: { label: "signalk-edge-link" },
        timestamp: new Date().toISOString(),
        values: values
      }]
    });
  }

  /**
   * Add value to moving average window
   *
   * @private
   */
  _addToWindow(window, value) {
    window.push(value);
    if (window.length > this.windowSize) {
      window.shift();
    }
  }

  /**
   * Calculate average of window
   *
   * @private
   */
  _calculateAverage(window) {
    if (window.length === 0) return 0;
    const sum = window.reduce((a, b) => a + b, 0);
    return sum / window.length;
  }

  /**
   * Clamp value between min and max
   *
   * @private
   */
  _clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Check if values have changed since last publish
   *
   * @private
   */
  _hasChanged(values) {
    for (const { path, value } of values) {
      if (this.lastPublished[path] !== value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update last published values
   *
   * @private
   */
  _updateLastPublished(values) {
    for (const { path, value } of values) {
      this.lastPublished[path] = value;
    }
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.rttWindow = [];
    this.jitterWindow = [];
    this.lossWindow = [];
    this.lastPublished = {};
  }
}

module.exports = { MetricsPublisher };
