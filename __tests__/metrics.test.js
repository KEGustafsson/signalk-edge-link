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
    metrics.pathStats.set("navigation.position", { count: 1, bytes: 1, lastUpdate: Date.now() });
    metrics.bandwidth.history.push({ timestamp: Date.now(), rateOut: 1, rateIn: 1, compressionRatio: 1 });

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
    expect(metrics.pathStats.size).toBe(0);
    expect(metrics.bandwidth.history.length).toBe(0);
  });

  test("evicts stale path stats when capacity is reached", () => {
    const api = createMetrics();
    const { metrics, trackPathStats } = api;

    for (let i = 0; i < PATH_STATS_MAX_SIZE; i++) {
      metrics.pathStats.set(`test.path.${i}`, { count: 1, bytes: 1, lastUpdate: i });
    }

    trackPathStats({
      updates: [{
        values: [{ path: "navigation.newPath", value: 1 }]
      }]
    }, 100);

    expect(metrics.pathStats.size).toBe(PATH_STATS_MAX_SIZE);
    expect(metrics.pathStats.has("navigation.newPath")).toBe(true);
  });
});
