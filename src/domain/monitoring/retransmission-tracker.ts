"use strict";

/**
 * Retransmission rate tracker.
 *
 * Tracks retransmission rates over time for chart visualization, recording
 * periodic snapshots of retransmission activity.
 *
 * @module domain/monitoring/retransmission-tracker
 */

import { MONITORING_RETRANSMIT_HISTORY_SIZE } from "../../foundation/constants";

interface RetransmissionEntry {
  timestamp: number;
  rate: number;
  retransmitsPerSec: number;
  periodPackets: number;
  periodRetransmissions: number;
}

export class RetransmissionTracker {
  maxEntries: number;
  history: RetransmissionEntry[];
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
  getChartData(limit?: number): RetransmissionEntry[] {
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
