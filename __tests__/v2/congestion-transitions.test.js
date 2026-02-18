"use strict";

const { CongestionControl } = require("../../lib/congestion");
const {
  CONGESTION_ADJUST_INTERVAL,
  CONGESTION_MAX_ADJUSTMENT,
  CONGESTION_INCREASE_FACTOR,
  CONGESTION_DECREASE_FACTOR,
  CONGESTION_LOSS_THRESHOLD_LOW,
  CONGESTION_LOSS_THRESHOLD_HIGH,
  CONGESTION_RTT_MULTIPLIER_HIGH
} = require("../../lib/constants");

/**
 * Helper: force an adjustment cycle by backdating lastAdjustment
 */
function forceAdjustable(cc) {
  cc.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
}

/**
 * Helper: run multiple adjustment cycles with given metrics
 */
function runCycles(cc, rtt, packetLoss, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    forceAdjustable(cc);
    cc.updateMetrics({ rtt, packetLoss });
    results.push(cc.adjust());
  }
  return results;
}

describe("Congestion Control - Network Transitions", () => {
  let cc;

  beforeEach(() => {
    cc = new CongestionControl({
      enabled: true,
      initialDeltaTimer: 1000,
      targetRTT: 200
    });
  });

  describe("Good Network → Rate Increase", () => {
    test("increases rate on good network (timer decreases)", () => {
      const timers = runCycles(cc, 50, 0.005, 5);

      // Each timer should be <= previous (rate increasing)
      for (let i = 1; i < timers.length; i++) {
        expect(timers[i]).toBeLessThanOrEqual(timers[i - 1]);
      }
      // With nominal timer at 1000, healthy network should not go above nominal.
      expect(timers[timers.length - 1]).toBeLessThanOrEqual(1000);
    });

    test("rate increase stays above minimum timer", () => {
      cc = new CongestionControl({
        enabled: true,
        initialDeltaTimer: 200,
        minDeltaTimer: 100,
        targetRTT: 200
      });

      const timers = runCycles(cc, 10, 0, 50);

      // All timers should respect minimum
      for (const t of timers) {
        expect(t).toBeGreaterThanOrEqual(100);
      }
    });
  });

  describe("Congestion Detected → Rate Decrease", () => {
    test("decreases rate on congestion (timer increases)", () => {
      const timers = runCycles(cc, 100, 0.1, 5);

      // Each timer should be >= previous (rate decreasing)
      for (let i = 1; i < timers.length; i++) {
        expect(timers[i]).toBeGreaterThanOrEqual(timers[i - 1]);
      }
      expect(timers[timers.length - 1]).toBeGreaterThan(1000);
    });

    test("rate decrease stops at maximum timer", () => {
      cc = new CongestionControl({
        enabled: true,
        initialDeltaTimer: 4000,
        maxDeltaTimer: 5000,
        targetRTT: 200
      });

      const timers = runCycles(cc, 500, 0.2, 50);

      for (const t of timers) {
        expect(t).toBeLessThanOrEqual(5000);
      }
    });
  });

  describe("Satellite Latency Adaptation", () => {
    test("adapts to satellite latency (50ms → 600ms RTT)", () => {
      // Start with good terrestrial connection
      runCycles(cc, 50, 0.005, 5);
      const lowLatencyTimer = cc.getCurrentDeltaTimer();
      expect(lowLatencyTimer).toBeLessThanOrEqual(1000);

      // Switch to satellite (high RTT)
      const highLatencyTimers = runCycles(cc, 600, 0.02, 10);

      // Timer should increase to handle satellite latency
      const finalTimer = highLatencyTimers[highLatencyTimers.length - 1];
      expect(finalTimer).toBeGreaterThan(lowLatencyTimer);
      // But still within bounds
      expect(finalTimer).toBeGreaterThanOrEqual(cc.minDeltaTimer);
      expect(finalTimer).toBeLessThanOrEqual(cc.maxDeltaTimer);
    });

    test("handles very high satellite RTT without exceeding max", () => {
      runCycles(cc, 800, 0.03, 20);
      expect(cc.getCurrentDeltaTimer()).toBeLessThanOrEqual(cc.maxDeltaTimer);
    });
  });

  describe("Packet Loss Spike and Recovery", () => {
    test("recovers from packet loss spike (0% → 20% → 0%)", () => {
      // Start healthy
      runCycles(cc, 50, 0, 5);
      const healthyTimer = cc.getCurrentDeltaTimer();

      // Spike in packet loss
      runCycles(cc, 50, 0.2, 5);
      const spikeTimer = cc.getCurrentDeltaTimer();
      expect(spikeTimer).toBeGreaterThan(healthyTimer);

      // Loss recovers to 0 - need enough cycles for EMA to decay
      // and enough for timer to decrease back
      runCycles(cc, 50, 0, 50);
      const recoveredTimer = cc.getCurrentDeltaTimer();

      // Should recover toward healthy levels
      expect(recoveredTimer).toBeLessThan(spikeTimer);
    });

    test("brief loss spike does not cause large timer increase due to smoothing", () => {
      // Establish a baseline with small non-zero loss to initialize EMA
      cc.updateMetrics({ rtt: 50, packetLoss: 0.001 });
      // Now feed zero loss many times to drive avgLoss down
      for (let i = 0; i < 30; i++) {
        cc.updateMetrics({ rtt: 50, packetLoss: 0 });
      }
      // avgLoss should be very close to 0 now
      expect(cc.getAvgLoss()).toBeLessThan(0.001);

      // Single spike measurement
      cc.updateMetrics({ rtt: 50, packetLoss: 0.5 });
      const avgLossAfterSpike = cc.getAvgLoss();
      // EMA: 0.2 * 0.5 + 0.8 * ~0 = ~0.1
      expect(avgLossAfterSpike).toBeLessThan(0.15);
    });
  });

  describe("Network Stability", () => {
    test("no oscillation with stable network", () => {
      // Stable network conditions (moderate, not triggering either branch)
      const timers = runCycles(cc, 150, 0.02, 20);

      // Timer should stay near initial value (within 10%)
      const maxTimer = Math.max(...timers);
      const minTimer = Math.min(...timers);

      // With moderate conditions, neither increase nor decrease triggers
      // Timer should remain at 1000
      expect(minTimer).toBe(1000);
      expect(maxTimer).toBe(1000);
    });

    test("stable good network converges to minimum region", () => {
      const timers = runCycles(cc, 30, 0, 100);

      // Should converge to nominal (default nominal is initial timer).
      const finalTimer = timers[timers.length - 1];
      expect(finalTimer).toBeGreaterThanOrEqual(cc.minDeltaTimer);
      expect(finalTimer).toBe(1000);
    });
  });

  describe("Transition Scenarios", () => {
    test("WiFi → Cellular transition (good → moderate)", () => {
      // WiFi: low RTT, no loss
      runCycles(cc, 20, 0, 10);
      cc.getCurrentDeltaTimer();

      // Cellular: higher RTT, some loss
      runCycles(cc, 150, 0.03, 10);
      const cellularTimer = cc.getCurrentDeltaTimer();

      // Cellular timer should stay neutral (moderate conditions)
      // Not necessarily higher since conditions don't trigger decrease
      expect(cellularTimer).toBeGreaterThanOrEqual(cc.minDeltaTimer);
    });

    test("Good → Bad → Good network transition", () => {
      // Good network
      runCycles(cc, 50, 0, 5);
      const goodTimer1 = cc.getCurrentDeltaTimer();

      // Bad network
      runCycles(cc, 400, 0.1, 10);
      const badTimer = cc.getCurrentDeltaTimer();
      expect(badTimer).toBeGreaterThan(goodTimer1);

      // Good network recovery
      runCycles(cc, 50, 0, 20);
      const goodTimer2 = cc.getCurrentDeltaTimer();
      expect(goodTimer2).toBeLessThan(badTimer);
    });

    test("gradual degradation is handled smoothly", () => {
      const timers = [];
      // Gradually increase RTT
      for (let rtt = 50; rtt <= 500; rtt += 50) {
        forceAdjustable(cc);
        cc.updateMetrics({ rtt, packetLoss: 0.01 });
        timers.push(cc.adjust());
      }

      // No sudden jumps (each step change <= 20% = maxAdjustment)
      for (let i = 1; i < timers.length; i++) {
        const change = Math.abs(timers[i] - timers[i - 1]);
        const maxAllowed = timers[i - 1] * 0.2 + 1; // +1 for rounding
        expect(change).toBeLessThanOrEqual(maxAllowed);
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles zero RTT and zero loss", () => {
      runCycles(cc, 0, 0, 5);
      expect(cc.getCurrentDeltaTimer()).toBeLessThanOrEqual(1000);
    });

    test("handles very high RTT (10s)", () => {
      runCycles(cc, 10000, 0.5, 10);
      expect(cc.getCurrentDeltaTimer()).toBeLessThanOrEqual(cc.maxDeltaTimer);
    });

    test("handles loss = 1.0 (100%)", () => {
      runCycles(cc, 100, 1.0, 5);
      expect(cc.getCurrentDeltaTimer()).toBeLessThanOrEqual(cc.maxDeltaTimer);
      expect(cc.getCurrentDeltaTimer()).toBeGreaterThan(1000);
    });

    test("disabled congestion control returns same timer", () => {
      const disabled = new CongestionControl({ enabled: false, initialDeltaTimer: 1000 });
      disabled.lastAdjustment = Date.now() - CONGESTION_ADJUST_INTERVAL - 1;
      disabled.updateMetrics({ rtt: 1000, packetLoss: 0.5 });
      expect(disabled.adjust()).toBe(1000);
    });

    test("manual mode overrides regardless of metrics", () => {
      cc.setManualDeltaTimer(750);
      forceAdjustable(cc);
      cc.updateMetrics({ rtt: 10, packetLoss: 0 });
      expect(cc.adjust()).toBe(750);
    });

    test("re-enabling auto after manual continues from manual timer value", () => {
      cc.setManualDeltaTimer(750);
      cc.enableAutoMode();
      forceAdjustable(cc);
      cc.updateMetrics({ rtt: 10, packetLoss: 0 });
      const result = cc.adjust();
      // Starts from manual value and moves toward nominal in auto mode.
      expect(result).toBeGreaterThan(750);
    });
  });

  describe("Constants Integration", () => {
    test("increase factor reduces timer", () => {
      expect(CONGESTION_INCREASE_FACTOR).toBeLessThan(1);
    });

    test("decrease factor increases timer", () => {
      expect(CONGESTION_DECREASE_FACTOR).toBeGreaterThan(1);
    });

    test("low loss threshold < high loss threshold", () => {
      expect(CONGESTION_LOSS_THRESHOLD_LOW).toBeLessThan(CONGESTION_LOSS_THRESHOLD_HIGH);
    });

    test("RTT multiplier > 1", () => {
      expect(CONGESTION_RTT_MULTIPLIER_HIGH).toBeGreaterThan(1);
    });

    test("max adjustment is between 0 and 1", () => {
      expect(CONGESTION_MAX_ADJUSTMENT).toBeGreaterThan(0);
      expect(CONGESTION_MAX_ADJUSTMENT).toBeLessThan(1);
    });
  });
});
