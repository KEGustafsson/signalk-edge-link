"use strict";

/**
 * Signal K Edge Link v2.0 - Dynamic Congestion Control
 *
 * Uses an AIMD (Additive Increase, Multiplicative Decrease) algorithm
 * to dynamically adjust the delta timer based on network conditions.
 *
 * When the network is healthy (low RTT, low loss), the timer decreases
 * (increasing send rate). When congestion is detected (high RTT or loss),
 * the timer increases (decreasing send rate) more aggressively.
 *
 * @module lib/congestion
 */

const {
  CONGESTION_MIN_DELTA_TIMER,
  CONGESTION_MAX_DELTA_TIMER,
  CONGESTION_TARGET_RTT,
  CONGESTION_ADJUST_INTERVAL,
  CONGESTION_MAX_ADJUSTMENT,
  CONGESTION_SMOOTHING_FACTOR,
  CONGESTION_LOSS_THRESHOLD_LOW,
  CONGESTION_LOSS_THRESHOLD_HIGH,
  CONGESTION_RTT_MULTIPLIER_HIGH,
  CONGESTION_INCREASE_FACTOR,
  CONGESTION_DECREASE_FACTOR
} = require("./constants");

class CongestionControl {
  /**
   * @param {Object} config
   * @param {boolean} [config.enabled=false] - Whether congestion control is active
   * @param {number} [config.minDeltaTimer] - Minimum delta timer (ms)
   * @param {number} [config.maxDeltaTimer] - Maximum delta timer (ms)
   * @param {number} [config.targetRTT] - Target RTT threshold (ms)
   * @param {number} [config.adjustInterval] - Interval between adjustments (ms)
   * @param {number} [config.maxAdjustment] - Maximum adjustment per step (fraction)
   * @param {number} [config.initialDeltaTimer] - Starting delta timer (ms)
   */
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.minDeltaTimer = config.minDeltaTimer || CONGESTION_MIN_DELTA_TIMER;
    this.maxDeltaTimer = config.maxDeltaTimer || CONGESTION_MAX_DELTA_TIMER;
    this.targetRTT = config.targetRTT || CONGESTION_TARGET_RTT;
    this.adjustInterval = config.adjustInterval || CONGESTION_ADJUST_INTERVAL;
    this.maxAdjustment = config.maxAdjustment || CONGESTION_MAX_ADJUSTMENT;

    this.currentDeltaTimer = config.initialDeltaTimer || 1000;
    this.lastAdjustment = Date.now();

    // Exponential moving average state
    this.avgRTT = 0;
    this.avgLoss = 0;
    this.alpha = config.smoothingFactor || CONGESTION_SMOOTHING_FACTOR;

    // Track whether we are in manual mode
    this._manualMode = false;
  }

  /**
   * Update network metrics using exponential moving average.
   *
   * @param {Object} params
   * @param {number} params.rtt - Latest RTT measurement (ms)
   * @param {number} params.packetLoss - Latest packet loss ratio (0-1)
   */
  updateMetrics({ rtt, packetLoss }) {
    if (rtt !== undefined && rtt >= 0) {
      this.avgRTT = this.avgRTT === 0
        ? rtt
        : (this.alpha * rtt + (1 - this.alpha) * this.avgRTT);
    }

    if (packetLoss !== undefined && packetLoss >= 0) {
      this.avgLoss = this.avgLoss === 0
        ? packetLoss
        : (this.alpha * packetLoss + (1 - this.alpha) * this.avgLoss);
    }
  }

  /**
   * Check whether an adjustment is due based on the interval.
   *
   * @returns {boolean}
   */
  shouldAdjust() {
    if (!this.enabled || this._manualMode) {return false;}
    return (Date.now() - this.lastAdjustment) >= this.adjustInterval;
  }

  /**
   * Perform AIMD adjustment of the delta timer.
   *
   * - Additive increase: when loss < 1% AND RTT < target, decrease timer by 5%
   * - Multiplicative decrease: when loss > 5% OR RTT > 1.5x target, increase timer by 50%
   * - Neutral: no change when conditions are moderate
   *
   * @returns {number} The (potentially adjusted) delta timer value
   */
  adjust() {
    if (!this.shouldAdjust()) {return this.currentDeltaTimer;}

    const oldTimer = this.currentDeltaTimer;
    let newTimer = oldTimer;

    // AIMD algorithm
    if (this.avgLoss < CONGESTION_LOSS_THRESHOLD_LOW && this.avgRTT < this.targetRTT) {
      // Additive increase (decrease timer = increase rate)
      newTimer = oldTimer * CONGESTION_INCREASE_FACTOR;
    } else if (this.avgLoss > CONGESTION_LOSS_THRESHOLD_HIGH || this.avgRTT > this.targetRTT * CONGESTION_RTT_MULTIPLIER_HIGH) {
      // Multiplicative decrease (increase timer = decrease rate)
      newTimer = oldTimer * CONGESTION_DECREASE_FACTOR;
    }

    // Apply limits
    newTimer = Math.max(this.minDeltaTimer, Math.min(this.maxDeltaTimer, newTimer));

    // Apply max adjustment constraint
    const maxChange = oldTimer * this.maxAdjustment;
    const change = newTimer - oldTimer;
    if (Math.abs(change) > maxChange) {
      newTimer = oldTimer + Math.sign(change) * maxChange;
    }

    this.currentDeltaTimer = Math.round(newTimer);
    this.lastAdjustment = Date.now();

    return this.currentDeltaTimer;
  }

  /**
   * Get the current delta timer value.
   *
   * @returns {number} Current delta timer in ms
   */
  getCurrentDeltaTimer() {
    return this.currentDeltaTimer;
  }

  /**
   * Get the current averaged RTT.
   *
   * @returns {number} Smoothed average RTT
   */
  getAvgRTT() {
    return this.avgRTT;
  }

  /**
   * Get the current averaged loss.
   *
   * @returns {number} Smoothed average loss ratio
   */
  getAvgLoss() {
    return this.avgLoss;
  }

  /**
   * Check if congestion control is in manual mode.
   *
   * @returns {boolean}
   */
  isManualMode() {
    return this._manualMode;
  }

  /**
   * Set the delta timer to a manual override value.
   * Disables automatic congestion control adjustments.
   *
   * @param {number} value - Manual delta timer value (ms)
   */
  setManualDeltaTimer(value) {
    this._manualMode = true;
    this.currentDeltaTimer = value;
  }

  /**
   * Re-enable automatic congestion control after manual override.
   */
  enableAutoMode() {
    this._manualMode = false;
    this.lastAdjustment = Date.now();
  }

  /**
   * Get the current state for diagnostics/API.
   *
   * @returns {Object} Current congestion control state
   */
  getState() {
    return {
      enabled: this.enabled,
      manualMode: this._manualMode,
      currentDeltaTimer: this.currentDeltaTimer,
      avgRTT: Math.round(this.avgRTT * 100) / 100,
      avgLoss: Math.round(this.avgLoss * 10000) / 10000,
      targetRTT: this.targetRTT,
      minDeltaTimer: this.minDeltaTimer,
      maxDeltaTimer: this.maxDeltaTimer,
      adjustInterval: this.adjustInterval,
      maxAdjustment: this.maxAdjustment
    };
  }
}

module.exports = { CongestionControl };
