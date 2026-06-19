"use strict";

/**
 * Packet-loss heatmap tracker.
 *
 * Tracks packet loss data in time buckets for heatmap visualization. Each
 * bucket covers a configurable time window and tracks its loss ratio.
 *
 * @module domain/monitoring/packet-loss-tracker
 */

import {
  MONITORING_HEATMAP_BUCKETS,
  MONITORING_HEATMAP_BUCKET_DURATION
} from "../../foundation/constants";

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
    if (!this._currentBucket) {
      return;
    }
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
  recordBatch(sent: number, lost: number): void {
    const now = Date.now();
    this._ensureBucket(now);
    if (!this._currentBucket) {
      return;
    }
    this._currentBucket.total += sent;
    this._currentBucket.lost += lost;
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
