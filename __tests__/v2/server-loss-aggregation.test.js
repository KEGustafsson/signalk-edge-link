"use strict";

/**
 * Server-side per-session packet-loss aggregation.
 *
 * `metrics-publish.ts` sat at ~8% statement coverage with 0% branch coverage,
 * despite containing uint32 wraparound arithmetic and baseline advancement.
 * A regression here reports 0% loss forever after a sequence wrap, feeding
 * wrong data to congestion control and to the operator's dashboard.
 *
 * `aggregatePacketLoss` is module-private, so it is exercised through the
 * exported `publishServerMetrics`.
 */

const {
  publishServerMetrics
} = require("../../lib/transport/pipeline/reliable-server/metrics-publish");
const { createServerContext } = require("../../lib/transport/pipeline/reliable-server/context");
const createMetrics = require("../../lib/metrics");

function makeCtx() {
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
  const state = {
    instanceId: "server-1",
    options: { secretKey: "12345678901234567890123456789012", protocolVersion: 3 },
    socketUdp: { send: jest.fn((_d, _p, _a, cb) => cb && cb(null)) }
  };
  const ctx = createServerContext({ app, state, metricsApi: createMetrics() });
  // Ensure a non-zero elapsed window so publishServerMetrics does not bail.
  ctx.mut.lastMetricsTime = Date.now() - 1000;
  return ctx;
}

/** Minimal session shape for the loss aggregator. */
function addSession(ctx, key, fields) {
  const session = {
    key,
    address: "10.0.0.5",
    port: 6000,
    lossBaseSeq: null,
    lossHighestSeq: null,
    lossReceivedCount: 0,
    lastLossExpected: 0,
    lastLossReceived: 0,
    lastPacketTime: Date.now(),
    hasReceivedData: true,
    sequenceTracker: { expectedSeq: 0, getMissingSequences: () => [] },
    ...fields
  };
  ctx.clientSessions.set(key, session);
  return session;
}

describe("server packet-loss aggregation", () => {
  test("reports zero loss when every expected packet arrived", () => {
    const ctx = makeCtx();
    addSession(ctx, "a", { lossBaseSeq: 100, lossHighestSeq: 199, lossReceivedCount: 100 });

    publishServerMetrics(ctx);

    expect(ctx.metrics.packetLoss).toBe(0);
  });

  test("computes the loss ratio for a lossy session", () => {
    const ctx = makeCtx();
    // 100 expected (100..199 inclusive), 90 received → 10% loss.
    addSession(ctx, "a", { lossBaseSeq: 100, lossHighestSeq: 199, lossReceivedCount: 90 });

    publishServerMetrics(ctx);

    expect(ctx.metrics.packetLoss).toBeCloseTo(0.1, 6);
  });

  test("aggregates across multiple sessions", () => {
    const ctx = makeCtx();
    addSession(ctx, "a", { lossBaseSeq: 0, lossHighestSeq: 99, lossReceivedCount: 100 });
    addSession(ctx, "b", { lossBaseSeq: 0, lossHighestSeq: 99, lossReceivedCount: 80 });

    publishServerMetrics(ctx);

    // 200 expected, 180 received across both sessions.
    expect(ctx.metrics.packetLoss).toBeCloseTo(0.1, 6);
  });

  test("handles uint32 sequence wraparound without reporting bogus loss", () => {
    const ctx = makeCtx();
    // Base near the top of the sequence space, highest just past the wrap:
    // 0xFFFFFFF0 .. 0x0000000F is 32 sequences in uint32 serial space.
    addSession(ctx, "a", {
      lossBaseSeq: 0xfffffff0,
      lossHighestSeq: 0x0000000f,
      lossReceivedCount: 32
    });

    publishServerMetrics(ctx);

    // Naive (highest - base) arithmetic would go hugely negative or overflow and
    // report ~100% loss on every wrap.
    expect(ctx.metrics.packetLoss).toBe(0);
  });

  test("advances baselines so the next period measures only new packets", () => {
    const ctx = makeCtx();
    const session = addSession(ctx, "a", {
      lossBaseSeq: 0,
      lossHighestSeq: 99,
      lossReceivedCount: 90
    });

    publishServerMetrics(ctx);
    expect(ctx.metrics.packetLoss).toBeCloseTo(0.1, 6);
    expect(session.lastLossExpected).toBe(100);
    expect(session.lastLossReceived).toBe(90);

    // Second period: 100 more expected, all received → this period is clean,
    // even though the session's cumulative counters still carry the old loss.
    session.lossHighestSeq = 199;
    session.lossReceivedCount = 190;
    ctx.mut.lastMetricsTime = Date.now() - 1000;

    publishServerMetrics(ctx);
    expect(ctx.metrics.packetLoss).toBe(0);
  });

  test("keeps the previous value when nothing was expected this period", () => {
    const ctx = makeCtx();
    ctx.metrics.packetLoss = 0.25;
    // A session with no baseline contributes nothing.
    addSession(ctx, "a", { lossBaseSeq: null, lossHighestSeq: null });

    publishServerMetrics(ctx);

    expect(ctx.metrics.packetLoss).toBe(0.25);
  });

  test("never reports a negative loss ratio", () => {
    const ctx = makeCtx();
    // More received than expected (duplicates counted) must clamp at 0.
    addSession(ctx, "a", { lossBaseSeq: 0, lossHighestSeq: 9, lossReceivedCount: 50 });

    publishServerMetrics(ctx);

    expect(ctx.metrics.packetLoss).toBeGreaterThanOrEqual(0);
  });
});
