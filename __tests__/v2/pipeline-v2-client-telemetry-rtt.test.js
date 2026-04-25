"use strict";

/**
 * Tests for the client-telemetry block in pipeline-v2-client.ts:
 * RTT must always be sent; the rest of the metrics are suppressed when
 * skipOwnData is true.
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

describe("client telemetry – RTT is always sent", () => {
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

  test("skipOwnData=true: telemetry contains ONLY RTT", async () => {
    const captured = captureDeltas();
    const { pipeline, metricsApi } = makeClient({
      options: { skipOwnData: true }
    });
    metricsApi.metrics.rtt = 99;
    metricsApi.metrics.jitter = 5;

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    const paths = update.values.map((v) => v.path);
    expect(paths).toEqual(["networking.edgeLink.rtt"]);
    expect(update.values[0].value).toBe(99);
  });

  test("skipOwnData=true with rtt unmeasured: still emits RTT path with value 0", async () => {
    const captured = captureDeltas();
    const { pipeline } = makeClient({
      options: { skipOwnData: true }
    });
    // metrics.rtt left undefined

    await runOnePublishTick(pipeline);

    const update = findTelemetryDelta(captured);
    expect(update).not.toBeNull();
    expect(update.values).toEqual([{ path: "networking.edgeLink.rtt", value: 0 }]);
  });

  test("readyToSend=false suppresses telemetry entirely (even RTT)", async () => {
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
