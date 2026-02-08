"use strict";

const { CongestionControl } = require("../../lib/congestion");
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
} = require("../../lib/constants");

describe("CongestionControl", () => {
  let cc;

  beforeEach(() => {
    cc = new CongestionControl({ enabled: true, initialDeltaTimer: 1000 });
  });

  describe("Construction", () => {
    test("initializes with default values when no config provided", () => {
      const defaultCC = new CongestionControl();
      expect(defaultCC.enabled).toBe(false);
      expect(defaultCC.minDeltaTimer).toBe(CONGESTION_MIN_DELTA_TIMER);
      expect(defaultCC.maxDeltaTimer).toBe(CONGESTION_MAX_DELTA_TIMER);
      expect(defaultCC.targetRTT).toBe(CONGESTION_TARGET_RTT);
      expect(defaultCC.adjustInterval).toBe(CONGESTION_ADJUST_INTERVAL);
      expect(defaultCC.maxAdjustment).toBe(CONGESTION_MAX_ADJUSTMENT);
      expect(defaultCC.currentDeltaTimer).toBe(1000);
      expect(defaultCC.avgRTT).toBe(0);
      expect(defaultCC.avgLoss).toBe(0);
      expect(defaultCC.alpha).toBe(CONGESTION_SMOOTHING_FACTOR);
    });

    test("respects custom config values", () => {
      const custom = new CongestionControl({
        enabled: true,
        minDeltaTimer: 200,
        maxDeltaTimer: 3000,
        targetRTT: 300,
        adjustInterval: 10000,
        maxAdjustment: 0.3,
        initialDeltaTimer: 500,
        smoothingFactor: 0.5
      });
      expect(custom.enabled).toBe(true);
      expect(custom.minDeltaTimer).toBe(200);
      expect(custom.maxDeltaTimer).toBe(3000);
      expect(custom.targetRTT).toBe(300);
      expect(custom.adjustInterval).toBe(10000);
      expect(custom.maxAdjustment).toBe(0.3);
      expect(custom.currentDeltaTimer).toBe(500);
      expect(custom.alpha).toBe(0.5);
    });

    test("starts in non-manual mode", () => {
      expect(cc.isManualMode()).toBe(false);
    });
  });

  describe("updateMetrics", () => {
    test("initializes avgRTT on first update", () => {
      cc.updateMetrics({ rtt: 100, packetLoss: 0 });
      expect(cc.avgRTT).toBe(100);
    });

    test("initializes avgLoss on first update", () => {
      cc.updateMetrics({ rtt: 0, packetLoss: 0.05 });
      expect(cc.avgLoss).toBe(0.05);
    });

    test("applies exponential moving average on subsequent updates", () => {
      cc.updateMetrics({ rtt: 100, packetLoss: 0 });
      cc.updateMetrics({ rtt: 200, packetLoss: 0 });
      // EMA: 0.2 * 200 + 0.8 * 100 = 40 + 80 = 120
      expect(cc.avgRTT).toBe(120);
    });

    test("applies EMA to loss", () => {
      cc.updateMetrics({ rtt: 0, packetLoss: 0.1 });
      cc.updateMetrics({ rtt: 0, packetLoss: 0.0 });
      // EMA: 0.2 * 0.0 + 0.8 * 0.1 = 0.08
      expect(cc.avgLoss).toBeCloseTo(0.08, 5);
    });

    test("smoothing converges toward new value over many updates", () => {
      cc.updateMetrics({ rtt: 100, packetLoss: 0 });
      for (let i = 0; i < 50; i++) {
        cc.updateMetrics({ rtt: 200, packetLoss: 0 });
      }
      // Should converge close to 200
      expect(cc.avgRTT).toBeGreaterThan(195);
      expect(cc.avgRTT).toBeLessThanOrEqual(200);
    });

    test("ignores negative RTT values", () => {
      cc.updateMetrics({ rtt: 100, packetLoss: 0 });
      cc.updateMetrics({ rtt: -50, packetLoss: 0 });
      // avgRTT should still be 100 since negative is ignored
      expect(cc.avgRTT).toBe(100);
    });

    test("ignores negative packetLoss values", () => {
      cc.updateMetrics({ rtt: 0, packetLoss: 0.05 });
      cc.updateMetrics({ rtt: 0, packetLoss: -0.1 });
      expect(cc.avgLoss).toBe(0.05);
    });

    test("handles undefined RTT gracefully", () => {
      cc.updateMetrics({ packetLoss: 0.01 });
      expect(cc.avgRTT).toBe(0);
      expect(cc.avgLoss).toBe(0.01);
    });

    test("handles undefined packetLoss gracefully", () => {
      cc.updateMetrics({ rtt: 50 });
      expect(cc.avgRTT).toBe(50);
      expect(cc.avgLoss).toBe(0);
    });
  });

  describe("shouldAdjust", () => {
    test("returns false when disabled", () => {
      const disabled = new CongestionControl({ enabled: false });
      expect(disabled.shouldAdjust()).toBe(false);
    });

    test("returns false when in manual mode", () => {
      cc.setManualDeltaTimer(500);
      expect(cc.shouldAdjust()).toBe(false);
    });

    test("returns false when adjust interval has not elapsed", () => {
      // Just created, so lastAdjustment = now
      expect(cc.shouldAdjust()).toBe(false);
    });

    test("returns true when adjust interval has elapsed", () => {
      // Set lastAdjustment to past
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      expect(cc.shouldAdjust()).toBe(true);
    });
  });

  describe("adjust - AIMD Algorithm", () => {
    beforeEach(() => {
      // Force adjustment to be due by setting lastAdjustment to past
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
    });

    test("returns current timer when adjustment not due", () => {
      cc.lastAdjustment = Date.now(); // reset to now
      const result = cc.adjust();
      expect(result).toBe(1000);
    });

    test("decreases timer (additive increase) on good network", () => {
      // Low loss, low RTT → should decrease timer
      cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
      const result = cc.adjust();
      expect(result).toBeLessThan(1000);
    });

    test("increases timer (multiplicative decrease) on high loss", () => {
      // High packet loss
      cc.updateMetrics({ rtt: 100, packetLoss: 0.1 });
      const result = cc.adjust();
      expect(result).toBeGreaterThan(1000);
    });

    test("increases timer when RTT exceeds threshold", () => {
      // RTT > targetRTT * 1.5
      cc.updateMetrics({ rtt: 350, packetLoss: 0.005 });
      const result = cc.adjust();
      expect(result).toBeGreaterThan(1000);
    });

    test("does not change timer in moderate conditions", () => {
      // Loss between thresholds, RTT between target and target*1.5
      cc.updateMetrics({ rtt: 250, packetLoss: 0.03 });
      const result = cc.adjust();
      // Should stay at 1000 (no change path)
      expect(result).toBe(1000);
    });

    test("respects minimum delta timer", () => {
      cc = new CongestionControl({
        enabled: true,
        initialDeltaTimer: 110,
        minDeltaTimer: 100
      });
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc.updateMetrics({ rtt: 10, packetLoss: 0 });
      const result = cc.adjust();
      expect(result).toBeGreaterThanOrEqual(100);
    });

    test("respects maximum delta timer", () => {
      cc = new CongestionControl({
        enabled: true,
        initialDeltaTimer: 4900,
        maxDeltaTimer: 5000
      });
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc.updateMetrics({ rtt: 500, packetLoss: 0.2 });
      const result = cc.adjust();
      expect(result).toBeLessThanOrEqual(5000);
    });

    test("limits adjustment to maxAdjustment (20%)", () => {
      cc.updateMetrics({ rtt: 1000, packetLoss: 0.5 });
      const result = cc.adjust();
      // Max change = 1000 * 0.2 = 200
      // So max allowed = 1000 + 200 = 1200
      expect(result).toBeLessThanOrEqual(1200);
    });

    test("limits decrease adjustment to maxAdjustment", () => {
      cc = new CongestionControl({
        enabled: true,
        initialDeltaTimer: 1000,
        maxAdjustment: 0.1 // 10%
      });
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc.updateMetrics({ rtt: 10, packetLoss: 0 });
      const result = cc.adjust();
      // Desired: 1000 * 0.95 = 950, change = -50
      // Max change: 1000 * 0.1 = 100
      // 50 < 100 so it should be allowed
      expect(result).toBe(950);
    });

    test("rounds result to integer", () => {
      cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
      const result = cc.adjust();
      expect(Number.isInteger(result)).toBe(true);
    });

    test("updates lastAdjustment timestamp after adjust", () => {
      const before = Date.now();
      cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
      cc.adjust();
      expect(cc.lastAdjustment).toBeGreaterThanOrEqual(before);
    });

    test("successive additive increases keep decreasing timer", () => {
      const timers = [1000];
      for (let i = 0; i < 5; i++) {
        cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
        cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
        const result = cc.adjust();
        timers.push(result);
      }
      // Each step should be <= previous
      for (let i = 1; i < timers.length; i++) {
        expect(timers[i]).toBeLessThanOrEqual(timers[i - 1]);
      }
    });

    test("multiplicative decrease is more aggressive than additive increase", () => {
      // Start with a decrease step
      cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
      const decreased = cc.adjust();
      const decreaseAmount = 1000 - decreased;

      // Reset and do an increase step
      const cc2 = new CongestionControl({ enabled: true, initialDeltaTimer: 1000 });
      cc2.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc2.updateMetrics({ rtt: 500, packetLoss: 0.1 });
      const increased = cc2.adjust();
      const increaseAmount = increased - 1000;

      // Multiplicative decrease (timer increase) should be more aggressive
      expect(increaseAmount).toBeGreaterThan(decreaseAmount);
    });
  });

  describe("getCurrentDeltaTimer", () => {
    test("returns current timer value", () => {
      expect(cc.getCurrentDeltaTimer()).toBe(1000);
    });

    test("returns updated value after adjustment", () => {
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc.updateMetrics({ rtt: 50, packetLoss: 0.005 });
      cc.adjust();
      expect(cc.getCurrentDeltaTimer()).toBeLessThan(1000);
    });
  });

  describe("getAvgRTT / getAvgLoss", () => {
    test("getAvgRTT returns smoothed RTT", () => {
      cc.updateMetrics({ rtt: 100, packetLoss: 0 });
      expect(cc.getAvgRTT()).toBe(100);
    });

    test("getAvgLoss returns smoothed loss", () => {
      cc.updateMetrics({ rtt: 0, packetLoss: 0.05 });
      expect(cc.getAvgLoss()).toBe(0.05);
    });
  });

  describe("Manual Mode", () => {
    test("setManualDeltaTimer sets value and enables manual mode", () => {
      cc.setManualDeltaTimer(500);
      expect(cc.getCurrentDeltaTimer()).toBe(500);
      expect(cc.isManualMode()).toBe(true);
    });

    test("adjust returns current timer in manual mode", () => {
      cc.setManualDeltaTimer(500);
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      expect(cc.adjust()).toBe(500);
    });

    test("enableAutoMode re-enables automatic control", () => {
      cc.setManualDeltaTimer(500);
      expect(cc.isManualMode()).toBe(true);
      cc.enableAutoMode();
      expect(cc.isManualMode()).toBe(false);
    });

    test("enableAutoMode resets lastAdjustment to prevent immediate adjustment", () => {
      cc.setManualDeltaTimer(500);
      cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      cc.enableAutoMode();
      expect(cc.shouldAdjust()).toBe(false);
    });
  });

  describe("getState", () => {
    test("returns complete state object", () => {
      cc.updateMetrics({ rtt: 150, packetLoss: 0.03 });
      const state = cc.getState();

      expect(state).toEqual(expect.objectContaining({
        enabled: true,
        manualMode: false,
        currentDeltaTimer: 1000,
        avgRTT: expect.any(Number),
        avgLoss: expect.any(Number),
        targetRTT: CONGESTION_TARGET_RTT,
        minDeltaTimer: CONGESTION_MIN_DELTA_TIMER,
        maxDeltaTimer: CONGESTION_MAX_DELTA_TIMER,
        adjustInterval: CONGESTION_ADJUST_INTERVAL,
        maxAdjustment: CONGESTION_MAX_ADJUSTMENT
      }));
    });

    test("rounds avgRTT to 2 decimal places", () => {
      cc.updateMetrics({ rtt: 123.456789, packetLoss: 0 });
      const state = cc.getState();
      expect(state.avgRTT).toBe(123.46);
    });

    test("rounds avgLoss to 4 decimal places", () => {
      cc.updateMetrics({ rtt: 0, packetLoss: 0.0123456 });
      const state = cc.getState();
      expect(state.avgLoss).toBe(0.0123);
    });

    test("reflects manual mode in state", () => {
      cc.setManualDeltaTimer(750);
      const state = cc.getState();
      expect(state.manualMode).toBe(true);
      expect(state.currentDeltaTimer).toBe(750);
    });
  });
});
