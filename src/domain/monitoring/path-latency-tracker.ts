"use strict";

/**
 * Per-path latency tracker.
 *
 * Tracks latency metrics per Signal K path, maintaining a sliding window of
 * latency samples per path.
 *
 * @module domain/monitoring/path-latency-tracker
 */

import { MONITORING_PATH_LATENCY_WINDOW } from "../../foundation/constants";

interface PathLatencyStats {
  path: string;
  sampleCount: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  lastUpdate: number;
}

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
  getPathStats(path: string): PathLatencyStats | null {
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
  getAllStats(topN: number = 20): PathLatencyStats[] {
    const limit = Math.max(0, topN);
    if (limit === 0) {
      return [];
    }

    const stats: PathLatencyStats[] = [];
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
  _calculateStats(
    path: string,
    entry: { samples: number[]; lastUpdate: number }
  ): PathLatencyStats {
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
