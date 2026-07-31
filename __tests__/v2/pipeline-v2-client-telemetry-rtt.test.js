"use strict";

/**
 * Tests for the client-telemetry block in pipeline-v2-client.ts.
 *
 * The whole quality set is always sent. skipOwnData used to strip everything
 * but RTT here, and these tests pinned that as intended behaviour — which is
 * how it survived: a receiver saw a real round trip from its client and 0 ms
 * jitter beside it, because the jitter was never sent and the receiver
 * substituted 0 for a value the peer never reported.
 *
 * skipOwnData means "do not forward my Signal K tree's networking.edgeLink.*
 * paths as ordinary data, so a chain cannot feed its own metrics back around".
 * This delta is not ordinary data — it is the dedicated, source-labelled link
 * telemetry the peer needs to report the link at all, and the receiver consumes
 * it rather than dispatching it into its own tree, so there is no loop to
 * prevent. RTT was already exempted on exactly that reasoning.
 */

const pipelineUtils = require("../../lib/pipeline-utils");
const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");

const SECRET_KEY = "12345678901234567890123456789012";
const TELEMETRY_LABEL = "signalk-edge-link-client-telemetry";

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeState(overrides = {}) {
  const { options: optionOverrides, ...stateOverrides } = overrides;
  return {
    deltaTimerTime: 1000,
    instanceId: null,
    avgBytesPerDelta: 200,
    maxDeltasPerBatch: 5,
    lastPacketTime: 0,
    readyToSend: true,
    socketUdp: {
      send: jest.fn((buf, port, addr, cb) => cb && cb(null))
    },
    ...stateOverrides,
    options: {
      secretKey: SECRET_KEY,
      udpAddress: "127.0.0.1",
      udpPort: 12345,
      protocolVersion: 2,
      useMsgpack: false,
      usePathDictionary: false,
      reliability: {},
      congestionControl: {},
      ...optionOverrides
    }
  };
}

function makeClient(stateOverrides = {}) {
  const app = makeApp();
  const state = makeState(stateOverrides);
  const metricsApi = createMetrics();
  const pipeline = createPipeline(2, "client", app, state, metricsApi);
  return { app, state, metricsApi, pipeline };
}

// Wraps deltaBuffer to capture every delta the client serializes for sending.
// useMsgpack is false in test setup, so the buffer is JSON we can parse back —
// but we keep the original delta object since it's already in memory.
function captureDeltas() {
  const captured = [];
  const orig = pipelineUtils.deltaBuffer;
  jest.spyOn(pipelineUtils, "deltaBuffer").mockImplementation((delta, useMsgpack) => {
    captured.push(delta);
    return orig(delta, useMsgpack);
  });
  return captured;
}

function findTelemetryDelta(captured) {
  for (const item of captured) {
    const deltas = Array.isArray(item) ? item : [item];
    for (const d of deltas) {
      const updates = d && Array.isArray(d.updates) ? d.updates : [];
      for (const u of updates) {
        if (u && u.source && u.source.label === TELEMETRY_LABEL) {
          return u;
        }
      }
    }
  }
  return null;
}

// Drive one _publishMetrics tick: capture the interval callback, advance the
// fake clock past the elapsed<=0 guard, then invoke directly so any send is
// observable in the same turn.
async function runOnePublishTick(pipeline) {
  let publishCb = null;
  const origSetInterval = global.setInterval;
  global.setInterval = jest.fn((cb, ms) => {
    publishCb = cb;
    return origSetInterval(cb, ms);
  });
  pipeline.startMetricsPublishing();
  global.setInterval = origSetInterval;
  await jest.advanceTimersByTimeAsync(1500);
  if (publishCb) {
    publishCb();
  }
  // Drain the async sendDelta chain so deltaBuffer has been called.
  await Promise.resolve();
  await Promise.resolve();
  pipeline.stopMetricsPublishing();
}

describe("client telemetry – the whole quality set is sent", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("skipOwnData=false: telemetry includes RTT plus all other edge-link metrics", async () => {
    const captured = captureDeltas();
    const { pipeline, metricsApi } = makeClient({
      options: { skipOwnData: false }
    });
    metricsApi.metrics.rtt = 42;
    metricsApi.metrics.jitter = 3;
    metricsApi.metrics.rttSamples = 6;
    metricsApi.metrics.retransmissions = 7;

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    const paths = update.values.map((v) => v.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "networking.edgeLink.rtt",
        "networking.edgeLink.jitter",
        "networking.edgeLink.packetLoss",
        "networking.edgeLink.retransmissions",
        "networking.edgeLink.queueDepth",
        "networking.edgeLink.retransmitRate",
        "networking.edgeLink.activeLink"
      ])
    );
    const rtt = update.values.find((v) => v.path === "networking.edgeLink.rtt");
    expect(rtt.value).toBe(42);
  });

  test("skipOwnData=true still sends the whole quality set, not just RTT", async () => {
    const captured = captureDeltas();
    const { pipeline, metricsApi } = makeClient({
      options: { skipOwnData: true }
    });
    metricsApi.metrics.rtt = 99;
    metricsApi.metrics.jitter = 5;
    metricsApi.metrics.rttSamples = 3;

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    const byPath = new Map(update.values.map((v) => [v.path, v.value]));

    // Jitter is the one the user actually saw missing: a server reporting a
    // real RTT and a hard 0 ms jitter next to it.
    expect(byPath.get("networking.edgeLink.rtt")).toBe(99);
    expect(byPath.get("networking.edgeLink.jitter")).toBe(5);
    // The rest went silent for the same reason and are just as load-bearing.
    for (const path of [
      "networking.edgeLink.packetLoss",
      "networking.edgeLink.retransmissions",
      "networking.edgeLink.queueDepth",
      "networking.edgeLink.retransmitRate",
      "networking.edgeLink.activeLink"
    ]) {
      expect(byPath.has(path)).toBe(true);
    }
  });

  // `metrics.rtt` is seeded to 0, not undefined, so publishing it before any
  // ACK has been timed hands the peer a 0 ms round trip indistinguishable from
  // a measured one — and the receiver has no way to tell the difference. The
  // rest of the quality set is still sent: loss, queue depth and the active
  // link are real observations from packet one.
  test("rtt unmeasured: the latency paths are omitted, the rest still sent", async () => {
    const captured = captureDeltas();
    const { pipeline } = makeClient({
      options: { skipOwnData: true }
    });
    // rttSamples left at 0 — no ACK has been timed.

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    const paths = new Set(update.values.map((v) => v.path));
    expect(paths.has("networking.edgeLink.rtt")).toBe(false);
    expect(paths.has("networking.edgeLink.jitter")).toBe(false);
    expect(paths.has("networking.edgeLink.packetLoss")).toBe(true);
    expect(paths.has("networking.edgeLink.queueDepth")).toBe(true);
    expect(paths.has("networking.edgeLink.activeLink")).toBe(true);
  });

  // The gate is on whether a sample exists, not on the value: a link that
  // genuinely round-trips in under half a millisecond must still report it.
  test("a measured 0 ms round trip is still published", async () => {
    const captured = captureDeltas();
    const { pipeline, metricsApi } = makeClient({
      options: { skipOwnData: true }
    });
    metricsApi.metrics.rtt = 0;
    metricsApi.metrics.jitter = 0;
    metricsApi.metrics.rttSamples = 4;

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    const rtt = update.values.find((v) => v.path === "networking.edgeLink.rtt");
    expect(rtt).toBeDefined();
    expect(rtt.value).toBe(0);
  });

  test("readyToSend=false suppresses telemetry entirely", async () => {
    const captured = captureDeltas();
    const { pipeline, metricsApi } = makeClient({
      readyToSend: false,
      options: { skipOwnData: true }
    });
    metricsApi.metrics.rtt = 10;

    await runOnePublishTick(pipeline);

    expect(findTelemetryDelta(captured)).toBeNull();
  });
});
