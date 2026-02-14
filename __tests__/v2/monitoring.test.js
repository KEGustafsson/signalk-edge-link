"use strict";

const {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
} = require("../../lib/monitoring");

// ── PacketLossTracker ──

describe("PacketLossTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new PacketLossTracker({
      maxBuckets: 10,
      bucketDuration: 100 // 100ms buckets for fast testing
    });
  });

  describe("Construction", () => {
    test("initializes with default config", () => {
      const t = new PacketLossTracker();
      expect(t.maxBuckets).toBe(60);
      expect(t.bucketDuration).toBe(5000);
      expect(t.buckets).toEqual([]);
    });

    test("accepts custom config", () => {
      expect(tracker.maxBuckets).toBe(10);
      expect(tracker.bucketDuration).toBe(100);
    });
  });

  describe("Recording", () => {
    test("records successful packet", () => {
      tracker.record(false);
      const data = tracker.getHeatmapData();
      // Current bucket isn't finalized yet, but it's tracked
      expect(data.length).toBe(0); // Only finalized buckets in getHeatmapData
    });

    test("records lost packet", () => {
      tracker.record(true);
      tracker.record(false);
      // Force a new bucket to finalize the first one
      tracker._lastBucketTime -= 200;
      tracker.record(false);
      const data = tracker.getHeatmapData();
      expect(data.length).toBe(1);
      expect(data[0].lost).toBe(1); // First bucket had 1 lost, 1 not lost
      expect(data[0].total).toBe(2);
    });

    test("records batch statistics", () => {
      tracker.recordBatch(100, 5);
      tracker._lastBucketTime -= 200;
      tracker.record(false);
      const data = tracker.getHeatmapData();
      expect(data[0].total).toBe(100);
      expect(data[0].lost).toBe(5);
      expect(data[0].lossRate).toBe(0.05);
    });
  });

  describe("Heatmap Data", () => {
    test("returns empty array when no data", () => {
      const data = tracker.getHeatmapData();
      expect(data).toEqual([]);
    });

    test("returns correct loss rates per bucket", () => {
      // Bucket 1: 10 packets, 2 lost (20% loss)
      tracker.recordBatch(10, 2);
      tracker._lastBucketTime -= 200;

      // Bucket 2: 20 packets, 0 lost (0% loss)
      tracker.recordBatch(20, 0);
      tracker._lastBucketTime -= 200;

      // Finalize bucket 2 by starting bucket 3
      tracker.record(false);

      const data = tracker.getHeatmapData();
      expect(data.length).toBe(2);
      expect(data[0].lossRate).toBe(0.2);
      expect(data[1].lossRate).toBe(0);
    });

    test("trims to maxBuckets", () => {
      for (let i = 0; i < 15; i++) {
        tracker.recordBatch(10, 1);
        tracker._lastBucketTime -= 200;
      }
      tracker.record(false);

      const data = tracker.getHeatmapData();
      expect(data.length).toBeLessThanOrEqual(10);
    });

    test("includes timestamp in each bucket", () => {
      tracker.recordBatch(10, 1);
      tracker._lastBucketTime -= 200;
      tracker.record(false);

      const data = tracker.getHeatmapData();
      expect(data[0].timestamp).toBeDefined();
      expect(typeof data[0].timestamp).toBe("number");
    });
  });

  describe("Summary", () => {
    test("returns zero values when no data", () => {
      const summary = tracker.getSummary();
      expect(summary.overallLossRate).toBe(0);
      expect(summary.maxLossRate).toBe(0);
      expect(summary.trend).toBe("stable");
      expect(summary.bucketCount).toBe(0);
    });

    test("calculates overall loss rate", () => {
      tracker.recordBatch(100, 10);
      tracker._lastBucketTime -= 200;
      tracker.recordBatch(100, 20);
      tracker._lastBucketTime -= 200;
      tracker.record(false);

      const summary = tracker.getSummary();
      expect(summary.overallLossRate).toBe(0.15); // 30/200
    });

    test("finds maximum loss rate", () => {
      tracker.recordBatch(10, 1); // 10%
      tracker._lastBucketTime -= 200;
      tracker.recordBatch(10, 5); // 50%
      tracker._lastBucketTime -= 200;
      tracker.recordBatch(10, 2); // 20%
      tracker._lastBucketTime -= 200;
      tracker.record(false);

      const summary = tracker.getSummary();
      expect(summary.maxLossRate).toBe(0.5);
    });

    test("detects worsening trend", () => {
      // First quarter: low loss
      for (let i = 0; i < 4; i++) {
        tracker.recordBatch(100, 1);
        tracker._lastBucketTime -= 200;
      }
      // Last quarter: high loss
      for (let i = 0; i < 4; i++) {
        tracker.recordBatch(100, 20);
        tracker._lastBucketTime -= 200;
      }
      tracker.record(false);

      const summary = tracker.getSummary();
      expect(summary.trend).toBe("worsening");
    });

    test("detects improving trend", () => {
      // First quarter: high loss
      for (let i = 0; i < 4; i++) {
        tracker.recordBatch(100, 20);
        tracker._lastBucketTime -= 200;
      }
      // Last quarter: low loss
      for (let i = 0; i < 4; i++) {
        tracker.recordBatch(100, 1);
        tracker._lastBucketTime -= 200;
      }
      tracker.record(false);

      const summary = tracker.getSummary();
      expect(summary.trend).toBe("improving");
    });
  });

  describe("Reset", () => {
    test("clears all data", () => {
      tracker.recordBatch(100, 10);
      tracker.reset();
      expect(tracker.buckets).toEqual([]);
      expect(tracker.getHeatmapData()).toEqual([]);
    });
  });
});

// ── PathLatencyTracker ──

describe("PathLatencyTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new PathLatencyTracker({ windowSize: 10, maxPaths: 5 });
  });

  describe("Construction", () => {
    test("initializes with default config", () => {
      const t = new PathLatencyTracker();
      expect(t.windowSize).toBe(50);
      expect(t.maxPaths).toBe(200);
    });

    test("accepts custom config", () => {
      expect(tracker.windowSize).toBe(10);
      expect(tracker.maxPaths).toBe(5);
    });
  });

  describe("Recording", () => {
    test("records latency for a path", () => {
      tracker.record("navigation.position", 50);
      const stats = tracker.getPathStats("navigation.position");
      expect(stats).not.toBeNull();
      expect(stats.sampleCount).toBe(1);
      expect(stats.avg).toBe(50);
    });

    test("maintains sliding window", () => {
      for (let i = 0; i < 15; i++) {
        tracker.record("test.path", i * 10);
      }
      const stats = tracker.getPathStats("test.path");
      expect(stats.sampleCount).toBe(10); // windowSize
    });

    test("evicts oldest path when at capacity", () => {
      tracker.record("path1", 10);
      tracker.record("path2", 20);
      tracker.record("path3", 30);
      tracker.record("path4", 40);
      tracker.record("path5", 50);
      tracker.record("path6", 60); // Should evict path1

      expect(tracker.getPathStats("path1")).toBeNull();
      expect(tracker.getPathStats("path6")).not.toBeNull();
    });
  });

  describe("Statistics", () => {
    test("calculates correct statistics", () => {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const v of values) {
        tracker.record("test.path", v);
      }

      const stats = tracker.getPathStats("test.path");
      expect(stats.avg).toBe(55);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(100);
      expect(stats.p50).toBe(60); // index 5
      expect(stats.p95).toBe(100); // index 9
      expect(stats.sampleCount).toBe(10);
    });

    test("returns null for unknown path", () => {
      expect(tracker.getPathStats("unknown.path")).toBeNull();
    });

    test("getAllStats returns sorted by avg latency descending", () => {
      tracker.record("fast.path", 10);
      tracker.record("slow.path", 100);
      tracker.record("medium.path", 50);

      const all = tracker.getAllStats();
      expect(all.length).toBe(3);
      expect(all[0].path).toBe("slow.path");
      expect(all[1].path).toBe("medium.path");
      expect(all[2].path).toBe("fast.path");
    });

    test("getAllStats respects topN limit", () => {
      tracker.record("path1", 10);
      tracker.record("path2", 20);
      tracker.record("path3", 30);

      const all = tracker.getAllStats(2);
      expect(all.length).toBe(2);
    });

    test("includes lastUpdate timestamp", () => {
      tracker.record("test.path", 50);
      const stats = tracker.getPathStats("test.path");
      expect(stats.lastUpdate).toBeDefined();
      expect(stats.lastUpdate).toBeGreaterThan(0);
    });
  });

  describe("Reset", () => {
    test("clears all data", () => {
      tracker.record("test.path", 50);
      tracker.reset();
      expect(tracker.paths.size).toBe(0);
      expect(tracker.getAllStats()).toEqual([]);
    });
  });
});

// ── RetransmissionTracker ──

describe("RetransmissionTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new RetransmissionTracker({ maxEntries: 10 });
  });

  describe("Construction", () => {
    test("initializes with default config", () => {
      const t = new RetransmissionTracker();
      expect(t.maxEntries).toBe(120);
      expect(t.history).toEqual([]);
    });

    test("accepts custom config", () => {
      expect(tracker.maxEntries).toBe(10);
    });
  });

  describe("Snapshots", () => {
    test("records a snapshot", () => {
      // Simulate time passing
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(100, 5);

      expect(tracker.history.length).toBe(1);
      expect(tracker.history[0].periodPackets).toBe(100);
      expect(tracker.history[0].periodRetransmissions).toBe(5);
      expect(tracker.history[0].rate).toBe(0.05); // 5/100
    });

    test("calculates rate correctly", () => {
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(200, 10);

      expect(tracker.history[0].rate).toBe(0.05);
    });

    test("handles zero packets sent", () => {
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(0, 0);

      expect(tracker.history[0].rate).toBe(0);
    });

    test("trims to maxEntries", () => {
      for (let i = 0; i < 15; i++) {
        tracker._lastSnapshot.timestamp -= 1000;
        tracker.snapshot(100 * (i + 1), i);
      }

      expect(tracker.history.length).toBe(10);
    });

    test("calculates retransmits per second", () => {
      tracker._lastSnapshot.timestamp -= 2000; // 2 seconds ago
      tracker.snapshot(100, 10);

      expect(tracker.history[0].retransmitsPerSec).toBe(5); // 10/2
    });
  });

  describe("Chart Data", () => {
    test("returns all history by default", () => {
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(100, 5);
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(200, 10);

      const data = tracker.getChartData();
      expect(data.length).toBe(2);
    });

    test("returns limited history", () => {
      for (let i = 0; i < 5; i++) {
        tracker._lastSnapshot.timestamp -= 1000;
        tracker.snapshot(100 * (i + 1), i);
      }

      const data = tracker.getChartData(3);
      expect(data.length).toBe(3);
    });
  });

  describe("Summary", () => {
    test("returns zero values when no data", () => {
      const summary = tracker.getSummary();
      expect(summary.avgRate).toBe(0);
      expect(summary.maxRate).toBe(0);
      expect(summary.currentRate).toBe(0);
      expect(summary.entries).toBe(0);
    });

    test("calculates summary statistics", () => {
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(100, 5);  // rate = 0.05
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(200, 30); // rate = 0.25 (30-5)/(200-100) = 25/100

      const summary = tracker.getSummary();
      expect(summary.entries).toBe(2);
      expect(summary.maxRate).toBeGreaterThanOrEqual(summary.avgRate);
    });
  });

  describe("Reset", () => {
    test("clears all data", () => {
      tracker._lastSnapshot.timestamp -= 1000;
      tracker.snapshot(100, 5);
      tracker.reset();
      expect(tracker.history).toEqual([]);
    });
  });
});

// ── AlertManager ──

describe("AlertManager", () => {
  let alertManager;
  let publishedMessages;

  const mockApp = {
    handleMessage: jest.fn((context, delta) => {
      publishedMessages.push(delta);
    }),
    debug: jest.fn()
  };

  beforeEach(() => {
    publishedMessages = [];
    mockApp.handleMessage.mockClear();
    mockApp.debug.mockClear();
    alertManager = new AlertManager(mockApp, {
      thresholds: {
        rtt: { warning: 200, critical: 500 },
        packetLoss: { warning: 0.05, critical: 0.10 }
      },
      cooldown: 0 // No cooldown for testing
    });
  });

  describe("Construction", () => {
    test("initializes with default thresholds", () => {
      const am = new AlertManager(mockApp);
      expect(am.thresholds.rtt).toBeDefined();
      expect(am.thresholds.packetLoss).toBeDefined();
      expect(am.thresholds.jitter).toBeDefined();
    });

    test("accepts custom thresholds", () => {
      expect(alertManager.thresholds.rtt.warning).toBe(200);
      expect(alertManager.thresholds.rtt.critical).toBe(500);
    });
  });

  describe("Checking Thresholds", () => {
    test("returns null when below threshold", () => {
      const result = alertManager.check("rtt", 100);
      expect(result).toBeNull();
    });

    test("returns warning alert when at warning threshold", () => {
      const result = alertManager.check("rtt", 200);
      expect(result).not.toBeNull();
      expect(result.level).toBe("warning");
      expect(result.metric).toBe("rtt");
      expect(result.value).toBe(200);
    });

    test("returns critical alert when at critical threshold", () => {
      const result = alertManager.check("rtt", 500);
      expect(result).not.toBeNull();
      expect(result.level).toBe("critical");
    });

    test("returns critical for values above critical", () => {
      const result = alertManager.check("rtt", 1000);
      expect(result.level).toBe("critical");
    });

    test("returns null for unknown metric", () => {
      const result = alertManager.check("unknownMetric", 100);
      expect(result).toBeNull();
    });

    test("emits Signal K notification on alert", () => {
      alertManager.check("rtt", 600);
      expect(mockApp.handleMessage).toHaveBeenCalledWith(
        "vessels.self",
        expect.objectContaining({
          updates: expect.any(Array)
        })
      );
    });

    test("clears alert when value returns to normal", () => {
      alertManager.check("rtt", 600); // Trigger
      alertManager.check("rtt", 100); // Clear

      // Should emit a normal notification
      const clearCall = publishedMessages[publishedMessages.length - 1];
      const values = clearCall.updates[0].values;
      expect(values[0].value.state).toBe("normal");
    });
  });

  describe("Check All", () => {
    test("checks multiple metrics at once", () => {
      const alerts = alertManager.checkAll({
        rtt: 600,
        packetLoss: 0.15
      });
      expect(alerts.length).toBe(2);
    });

    test("returns empty array when all normal", () => {
      const alerts = alertManager.checkAll({
        rtt: 50,
        packetLoss: 0.01
      });
      expect(alerts).toEqual([]);
    });

    test("only returns alerts for exceeded thresholds", () => {
      const alerts = alertManager.checkAll({
        rtt: 300, // warning
        packetLoss: 0.01 // ok
      });
      expect(alerts.length).toBe(1);
      expect(alerts[0].metric).toBe("rtt");
    });
  });

  describe("Threshold Updates", () => {
    test("updates a threshold", () => {
      alertManager.setThreshold("rtt", { warning: 100, critical: 300 });
      expect(alertManager.thresholds.rtt.warning).toBe(100);
      expect(alertManager.thresholds.rtt.critical).toBe(300);
    });

    test("updates partial threshold", () => {
      alertManager.setThreshold("rtt", { warning: 150 });
      expect(alertManager.thresholds.rtt.warning).toBe(150);
      expect(alertManager.thresholds.rtt.critical).toBe(500); // unchanged
    });

    test("creates new threshold for unknown metric", () => {
      alertManager.setThreshold("customMetric", { warning: 10, critical: 20 });
      expect(alertManager.thresholds.customMetric.warning).toBe(10);
    });
  });

  describe("State", () => {
    test("returns current state with active alerts", () => {
      alertManager.check("rtt", 600);
      const state = alertManager.getState();

      expect(state.thresholds).toBeDefined();
      expect(state.activeAlerts).toBeDefined();
      expect(state.activeAlerts.rtt).toBeDefined();
      expect(state.activeAlerts.rtt.level).toBe("critical");
    });

    test("returns empty active alerts when none triggered", () => {
      const state = alertManager.getState();
      expect(Object.keys(state.activeAlerts)).toEqual([]);
    });
  });

  describe("Reset", () => {
    test("clears all active alerts", () => {
      alertManager.check("rtt", 600);
      alertManager.reset();
      expect(alertManager.activeAlerts.size).toBe(0);
    });
  });

  describe("Cooldown", () => {
    test("respects cooldown period", () => {
      const am = new AlertManager(mockApp, {
        thresholds: { rtt: { warning: 200, critical: 500 } },
        cooldown: 60000 // 1 minute
      });

      // First alert should trigger
      const first = am.check("rtt", 600);
      expect(first).not.toBeNull();

      // Same level within cooldown should not trigger
      const second = am.check("rtt", 600);
      expect(second).toBeNull();
    });

    test("alerts again when level changes even during cooldown", () => {
      const am = new AlertManager(mockApp, {
        thresholds: { rtt: { warning: 200, critical: 500 } },
        cooldown: 60000
      });

      am.check("rtt", 300); // warning
      const critical = am.check("rtt", 600); // critical (different level)
      expect(critical).not.toBeNull();
      expect(critical.level).toBe("critical");
    });
  });
});
