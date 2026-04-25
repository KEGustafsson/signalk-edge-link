"use strict";

const createMetrics = require("../lib/metrics");
const {
  SMART_BATCH_INITIAL_ESTIMATE,
  PATH_STATS_MAX_SIZE,
  calculateMaxDeltasPerBatch
} = require("../lib/constants");

describe("Metrics Reset", () => {
  test("resets smart batching counters and estimates", () => {
    const api = createMetrics();
    const { metrics, resetMetrics } = api;

    metrics.smartBatching.earlySends = 10;
    metrics.smartBatching.timerSends = 20;
    metrics.smartBatching.oversizedPackets = 3;
    metrics.smartBatching.avgBytesPerDelta = 999;
    metrics.smartBatching.maxDeltasPerBatch = 1;

    resetMetrics();

    expect(metrics.smartBatching.earlySends).toBe(0);
    expect(metrics.smartBatching.timerSends).toBe(0);
    expect(metrics.smartBatching.oversizedPackets).toBe(0);
    expect(metrics.smartBatching.avgBytesPerDelta).toBe(SMART_BATCH_INITIAL_ESTIMATE);
    expect(metrics.smartBatching.maxDeltasPerBatch).toBe(
      calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE)
    );
  });

  test("resets v2 runtime counters and maps", () => {
    const api = createMetrics();
    const { metrics, resetMetrics } = api;

    metrics.retransmissions = 55;
    metrics.queueDepth = 9;
    metrics.rtt = 123;
    metrics.jitter = 42;
    metrics.packetLoss = 0.25;
    metrics.acksSent = 7;
    metrics.naksSent = 2;
    metrics.duplicatePackets = 11;
    metrics.dataPacketsReceived = 99;
    metrics.rateLimitedPackets = 4;
    metrics.droppedDeltaBatches = 3;
    metrics.droppedDeltaCount = 12;
    metrics.bandwidth.metaBytesOut = 1234;
    metrics.bandwidth.metaPacketsOut = 5;
    metrics.bandwidth.metaBytesIn = 4321;
    metrics.bandwidth.metaPacketsIn = 6;
    metrics.bandwidth.metaSnapshotsSent = 2;
    metrics.bandwidth.metaDiffsSent = 3;
    metrics.bandwidth.metaRateLimitedPackets = 1;
    metrics.pathStats.set("navigation.position", { count: 1, bytes: 1, lastUpdate: Date.now() });
    metrics.bandwidth.history.push({
      timestamp: Date.now(),
      rateOut: 1,
      rateIn: 1,
      compressionRatio: 1
    });

    resetMetrics();

    expect(metrics.retransmissions).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.rtt).toBe(0);
    expect(metrics.jitter).toBe(0);
    expect(metrics.packetLoss).toBe(0);
    expect(metrics.acksSent).toBe(0);
    expect(metrics.naksSent).toBe(0);
    expect(metrics.duplicatePackets).toBe(0);
    expect(metrics.dataPacketsReceived).toBe(0);
    expect(metrics.rateLimitedPackets).toBe(0);
    expect(metrics.droppedDeltaBatches).toBe(0);
    expect(metrics.droppedDeltaCount).toBe(0);
    expect(metrics.bandwidth.metaBytesOut).toBe(0);
    expect(metrics.bandwidth.metaPacketsOut).toBe(0);
    expect(metrics.bandwidth.metaBytesIn).toBe(0);
    expect(metrics.bandwidth.metaPacketsIn).toBe(0);
    expect(metrics.bandwidth.metaSnapshotsSent).toBe(0);
    expect(metrics.bandwidth.metaDiffsSent).toBe(0);
    expect(metrics.bandwidth.metaRateLimitedPackets).toBe(0);
    expect(metrics.pathStats.size).toBe(0);
    expect(metrics.bandwidth.history.length).toBe(0);
  });

  test("tracks categorized recent errors and resets them", () => {
    const api = createMetrics();
    const { metrics, recordError, resetMetrics } = api;

    recordError("subscription", "sub failed");
    recordError("udpSend", "send failed");
    recordError("weird", "unknown failed");

    expect(metrics.errorCounts.subscription).toBe(1);
    expect(metrics.errorCounts.udpSend).toBe(1);
    expect(metrics.errorCounts.general).toBe(1);
    expect(metrics.recentErrors.length).toBe(3);
    expect(metrics.recentErrors[2]).toEqual(
      expect.objectContaining({ category: "general", message: "unknown failed" })
    );

    resetMetrics();

    expect(metrics.recentErrors).toEqual([]);
    expect(metrics.errorCounts.subscription).toBe(0);
    expect(metrics.errorCounts.udpSend).toBe(0);
    expect(metrics.errorCounts.general).toBe(0);
  });

  test("evicts stale path stats when capacity is reached", () => {
    const api = createMetrics();
    const { metrics, trackPathStats } = api;

    for (let i = 0; i < PATH_STATS_MAX_SIZE; i++) {
      metrics.pathStats.set(`test.path.${i}`, { count: 1, bytes: 1, lastUpdate: i });
    }

    trackPathStats(
      {
        updates: [
          {
            values: [{ path: "navigation.newPath", value: 1 }]
          }
        ]
      },
      100
    );

    expect(metrics.pathStats.size).toBe(PATH_STATS_MAX_SIZE);
    expect(metrics.pathStats.has("navigation.newPath")).toBe(true);
  });
});
