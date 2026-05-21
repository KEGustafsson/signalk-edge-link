"use strict";

/**
 * Unit tests for src/pipeline-v2-client.ts
 * Covers the exported API surface and key internal paths.
 */

const { createPipeline } = require("../lib/pipeline-factory");
const createMetrics = require("../lib/metrics");
const { PacketBuilder } = require("../lib/packet");

const SECRET_KEY = "12345678901234567890123456789012";

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
  return {
    options: {
      secretKey: SECRET_KEY,
      udpAddress: "127.0.0.1",
      udpPort: 12345,
      protocolVersion: 2,
      useMsgpack: false,
      usePathDictionary: false,
      reliability: {},
      congestionControl: {}
    },
    deltaTimerTime: 1000,
    instanceId: null,
    socketUdp: {
      send: jest.fn((buf, port, addr, cb) => cb && cb(null))
    },
    ...overrides
  };
}

function makeClient(stateOverrides = {}) {
  const app = makeApp();
  const state = makeState(stateOverrides);
  const metricsApi = createMetrics();
  const pipeline = createPipeline(2, "client", app, state, metricsApi);
  return { app, state, metricsApi, pipeline };
}

// ── API surface ───────────────────────────────────────────────────────────────

describe("createPipelineV2Client – API surface", () => {
  test("returns all expected methods", () => {
    const { pipeline } = makeClient();
    expect(typeof pipeline.sendDelta).toBe("function");
    expect(typeof pipeline.getPacketBuilder).toBe("function");
    expect(typeof pipeline.getRetransmitQueue).toBe("function");
    expect(typeof pipeline.getMetricsPublisher).toBe("function");
    expect(typeof pipeline.getCongestionControl).toBe("function");
    expect(typeof pipeline.getBondingManager).toBe("function");
    expect(typeof pipeline.receiveACK).toBe("function");
    expect(typeof pipeline.receiveNAK).toBe("function");
    expect(typeof pipeline.handleControlPacket).toBe("function");
    expect(typeof pipeline.startMetricsPublishing).toBe("function");
    expect(typeof pipeline.stopMetricsPublishing).toBe("function");
    expect(typeof pipeline.startCongestionControl).toBe("function");
    expect(typeof pipeline.stopCongestionControl).toBe("function");
    expect(typeof pipeline.startHeartbeat).toBe("function");
    expect(typeof pipeline.initBonding).toBe("function");
    expect(typeof pipeline.stopBonding).toBe("function");
    expect(typeof pipeline.setMonitoring).toBe("function");
  });
});

// ── getCongestionControl ──────────────────────────────────────────────────────

describe("getCongestionControl", () => {
  test("returns a congestion control object with getState", () => {
    const { pipeline } = makeClient();
    const cc = pipeline.getCongestionControl();
    expect(cc).not.toBeNull();
    expect(typeof cc.getState).toBe("function");
    expect(typeof cc.adjust).toBe("function");
    expect(typeof cc.getCurrentDeltaTimer).toBe("function");
  });
});

// ── getRetransmitQueue ────────────────────────────────────────────────────────

describe("getRetransmitQueue", () => {
  test("returns a retransmit queue with expected interface", () => {
    const { pipeline } = makeClient();
    const q = pipeline.getRetransmitQueue();
    expect(q).not.toBeNull();
    expect(typeof q.getSize).toBe("function");
    expect(q.getSize()).toBe(0);
  });
});

// ── getPacketBuilder ──────────────────────────────────────────────────────────

describe("getPacketBuilder", () => {
  test("returns a PacketBuilder with getCurrentSequence", () => {
    const { pipeline } = makeClient();
    const pb = pipeline.getPacketBuilder();
    expect(pb).not.toBeNull();
    expect(typeof pb.getCurrentSequence).toBe("function");
    expect(typeof pb.buildDataPacket).toBe("function");
  });
});

// ── startCongestionControl / stopCongestionControl ───────────────────────────

describe("startCongestionControl / stopCongestionControl", () => {
  afterEach(() => jest.useRealTimers());

  test("start arms the interval and stop clears it", () => {
    jest.useFakeTimers();
    const startCount = jest.getTimerCount();
    const { pipeline } = makeClient();
    pipeline.startCongestionControl();
    expect(jest.getTimerCount()).toBe(startCount + 1);
    pipeline.startCongestionControl();
    expect(jest.getTimerCount()).toBe(startCount + 1);
    pipeline.stopCongestionControl();
    expect(jest.getTimerCount()).toBe(startCount);
    pipeline.stopCongestionControl();
    expect(jest.getTimerCount()).toBe(startCount);
  });
});

// ── startMetricsPublishing / stopMetricsPublishing ───────────────────────────

describe("startMetricsPublishing / stopMetricsPublishing", () => {
  afterEach(() => jest.useRealTimers());

  test("start and stop are idempotent and leave no leaked timers", () => {
    jest.useFakeTimers();
    const baseline = jest.getTimerCount();
    const { pipeline } = makeClient();
    pipeline.startMetricsPublishing();
    expect(jest.getTimerCount()).toBe(baseline + 1);
    pipeline.startMetricsPublishing();
    expect(jest.getTimerCount()).toBe(baseline + 1);
    pipeline.stopMetricsPublishing();
    expect(jest.getTimerCount()).toBe(baseline);
    pipeline.stopMetricsPublishing();
    expect(jest.getTimerCount()).toBe(baseline);
  });
});

// ── startHeartbeat ────────────────────────────────────────────────────────────

describe("startHeartbeat", () => {
  afterEach(() => jest.useRealTimers());

  test("returns an object with a stop() method", () => {
    const { pipeline } = makeClient();
    const hb = pipeline.startHeartbeat("127.0.0.1", 12345, { heartbeatInterval: 100 });
    expect(typeof hb.stop).toBe("function");
    hb.stop();
  });

  test("stop is idempotent", () => {
    const { pipeline } = makeClient();
    const hb = pipeline.startHeartbeat("127.0.0.1", 12345);
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });
});

// ── getBondingManager ─────────────────────────────────────────────────────────

describe("getBondingManager", () => {
  test("returns null before initBonding is called", () => {
    const { pipeline } = makeClient();
    expect(pipeline.getBondingManager()).toBeNull();
  });
});

// ── stopBonding ───────────────────────────────────────────────────────────────

describe("stopBonding", () => {
  test("does not throw when bonding manager is null", () => {
    const { pipeline } = makeClient();
    expect(() => pipeline.stopBonding()).not.toThrow();
  });
});

// ── setMonitoring ─────────────────────────────────────────────────────────────

describe("setMonitoring", () => {
  test("accepts a hooks object without throwing", () => {
    const { pipeline } = makeClient();
    expect(() =>
      pipeline.setMonitoring({
        pathLatencyTracker: { record: jest.fn() },
        packetLossTracker: { record: jest.fn() }
      })
    ).not.toThrow();
  });
});

// ── receiveACK ────────────────────────────────────────────────────────────────

describe("receiveACK", () => {
  test("handles an ACK packet built by PacketBuilder", () => {
    const { pipeline } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const ackPacket = builder.buildACKPacket(0);
    expect(() =>
      pipeline.receiveACK(ackPacket, { address: "127.0.0.1", port: 12345 })
    ).not.toThrow();
  });

  test("does not throw on short/invalid buffer", () => {
    const { pipeline } = makeClient();
    expect(() => pipeline.receiveACK(Buffer.alloc(0), {})).not.toThrow();
  });
});

// ── receiveNAK ────────────────────────────────────────────────────────────────

describe("receiveNAK", () => {
  test("does not throw on short/invalid buffer", () => {
    const { pipeline } = makeClient();
    expect(() => pipeline.receiveNAK(Buffer.alloc(4), {})).not.toThrow();
  });
});

// ── sendDelta – plugin stopped ────────────────────────────────────────────────

describe("sendDelta – plugin stopped", () => {
  test("returns early without throwing when state.options is null", async () => {
    const { pipeline, state } = makeClient();
    state.options = null;
    await expect(
      pipeline.sendDelta({ context: "vessels.self", updates: [] }, SECRET_KEY, "127.0.0.1", 12345)
    ).resolves.toBeUndefined();
  });
});

// ── v3 protocol ───────────────────────────────────────────────────────────────

describe("v3 protocol variant", () => {
  test("creates a v3 client pipeline with the same API surface", () => {
    const app = makeApp();
    const state = makeState();
    state.options.protocolVersion = 3;
    const metricsApi = createMetrics();
    const pipeline = createPipeline(3, "client", app, state, metricsApi);
    expect(typeof pipeline.sendDelta).toBe("function");
    expect(typeof pipeline.getCongestionControl).toBe("function");
  });
});
