"use strict";

/**
 * Unit tests for src/pipeline-v2-server.ts
 * Covers the exported API, packet routing, session management, and error paths.
 */

const { createPipeline } = require("../lib/pipeline-factory");
const createMetrics = require("../lib/metrics");
const { PacketBuilder, PacketParser, PacketType } = require("../lib/packet");
const zlib = require("zlib");
const { promisify } = require("util");

const brotliCompressAsync = promisify(zlib.brotliCompress);

const SECRET_KEY = "12345678901234567890123456789012";

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn()
  };
}

function makeSocketUdp() {
  return {
    send: jest.fn((buf, port, addr, cb) => cb && cb(null))
  };
}

function makeState(overrides = {}) {
  return {
    options: {
      secretKey: SECRET_KEY,
      udpPort: 12345,
      protocolVersion: 2,
      useMsgpack: false,
      usePathDictionary: false,
      reliability: {}
    },
    socketUdp: makeSocketUdp(),
    instanceId: null,
    ...overrides
  };
}

function makeServer(stateOverrides = {}) {
  const app = makeApp();
  const state = makeState(stateOverrides);
  const metricsApi = createMetrics();
  const pipeline = createPipeline(2, "server", app, state, metricsApi);
  return { app, state, metricsApi, pipeline };
}

// ── API surface ───────────────────────────────────────────────────────────────

describe("createPipelineV2Server – API surface", () => {
  test("returns all expected methods", () => {
    const { pipeline } = makeServer();
    expect(typeof pipeline.receivePacket).toBe("function");
    expect(typeof pipeline.getSequenceTracker).toBe("function");
    expect(typeof pipeline.getPacketBuilder).toBe("function");
    expect(typeof pipeline.getMetrics).toBe("function");
    expect(typeof pipeline.getMetricsPublisher).toBe("function");
    expect(typeof pipeline.startACKTimer).toBe("function");
    expect(typeof pipeline.stopACKTimer).toBe("function");
    expect(typeof pipeline.startMetricsPublishing).toBe("function");
    expect(typeof pipeline.stopMetricsPublishing).toBe("function");
  });
});

// ── getSequenceTracker ────────────────────────────────────────────────────────

describe("getSequenceTracker", () => {
  test("returns a SequenceTracker with null expectedSeq before any packet is received", () => {
    const { pipeline } = makeServer();
    const tracker = pipeline.getSequenceTracker();
    // backward-compat: always returns a tracker (never null)
    expect(tracker).not.toBeNull();
    expect(tracker.expectedSeq).toBeNull();
  });
});

// ── getPacketBuilder ──────────────────────────────────────────────────────────

describe("getPacketBuilder", () => {
  test("returns a PacketBuilder", () => {
    const { pipeline } = makeServer();
    const pb = pipeline.getPacketBuilder();
    expect(pb).not.toBeNull();
    expect(typeof pb.buildACKPacket).toBe("function");
  });
});

// ── getMetrics ────────────────────────────────────────────────────────────────

describe("getMetrics", () => {
  test("returns session list and counters with no sessions", () => {
    const { pipeline } = makeServer();
    const m = pipeline.getMetrics();
    expect(Array.isArray(m.sessions)).toBe(true);
    expect(m.sessions).toHaveLength(0);
    expect(m.totalSessions).toBe(0);
    expect(typeof m.acksSent).toBe("number");
    expect(typeof m.naksSent).toBe("number");
  });
});

// ── startACKTimer / stopACKTimer ──────────────────────────────────────────────

describe("startACKTimer / stopACKTimer", () => {
  afterEach(() => jest.useRealTimers());

  test("start is idempotent", () => {
    jest.useFakeTimers();
    const { pipeline } = makeServer();
    pipeline.startACKTimer();
    pipeline.startACKTimer(); // second call is a no-op
    pipeline.stopACKTimer();
  });

  test("stop is idempotent", () => {
    jest.useFakeTimers();
    const { pipeline } = makeServer();
    pipeline.stopACKTimer(); // stop before start
    pipeline.startACKTimer();
    pipeline.stopACKTimer();
    pipeline.stopACKTimer(); // stop twice is fine
  });
});

// ── startMetricsPublishing / stopMetricsPublishing ────────────────────────────

describe("startMetricsPublishing / stopMetricsPublishing", () => {
  afterEach(() => jest.useRealTimers());

  test("are idempotent", () => {
    jest.useFakeTimers();
    const { pipeline } = makeServer();
    pipeline.startMetricsPublishing();
    pipeline.startMetricsPublishing();
    pipeline.stopMetricsPublishing();
    pipeline.stopMetricsPublishing();
  });
});

// ── receivePacket – plugin stopped ────────────────────────────────────────────

describe("receivePacket – plugin stopped", () => {
  test("returns early when state.options is null", async () => {
    const { pipeline, state } = makeServer();
    state.options = null;
    const dummy = Buffer.alloc(32);
    await expect(
      pipeline.receivePacket(dummy, SECRET_KEY, { address: "127.0.0.1", port: 5000 })
    ).resolves.toBeUndefined();
  });
});

// ── receivePacket – heartbeat probe ───────────────────────────────────────────

describe("receivePacket – heartbeat probe (HBPROBE)", () => {
  test("echoes heartbeat probe back to sender via UDP", async () => {
    const { pipeline, state } = makeServer();
    // Minimal HBPROBE packet: 7 ASCII bytes + padding to >= 12 bytes
    const probe = Buffer.alloc(16);
    Buffer.from("HBPROBE", "ascii").copy(probe, 0);
    const rinfo = { address: "10.0.0.1", port: 9999 };

    await pipeline.receivePacket(probe, SECRET_KEY, rinfo);

    expect(state.socketUdp.send).toHaveBeenCalledWith(
      probe,
      rinfo.port,
      rinfo.address,
      expect.any(Function)
    );
  });

  test("does not echo when no rinfo", async () => {
    const { pipeline, state } = makeServer();
    const probe = Buffer.alloc(16);
    Buffer.from("HBPROBE", "ascii").copy(probe, 0);

    await pipeline.receivePacket(probe, SECRET_KEY, undefined);

    expect(state.socketUdp.send).not.toHaveBeenCalled();
  });
});

// ── receivePacket – non-v2 packet ─────────────────────────────────────────────

describe("receivePacket – non-v2 packet", () => {
  test("increments malformedPackets counter and returns", async () => {
    const { pipeline, metricsApi } = makeServer();
    const nonV2 = Buffer.from("not-a-v2-packet-at-all-padding");

    await pipeline.receivePacket(nonV2, SECRET_KEY, { address: "127.0.0.1", port: 6000 });

    expect(metricsApi.metrics.malformedPackets).toBeGreaterThanOrEqual(1);
  });
});

// ── receivePacket – wrong key ─────────────────────────────────────────────────

describe("receivePacket – wrong decryption key", () => {
  test("logs an auth error when the wrong key is used", async () => {
    const { pipeline, app } = makeServer();

    // Build a valid v2 packet with the correct key
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    // We need a minimal brotli-compressed + encrypted payload
    const payload = JSON.stringify([{ context: "vessels.self", updates: [] }]);
    const compressed = await brotliCompressAsync(Buffer.from(payload));

    const { encryptBinary } = require("../lib/crypto");
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const packet = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    // Try to decode with a WRONG key
    const wrongKey = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    await pipeline.receivePacket(packet, wrongKey, { address: "127.0.0.1", port: 7000 });

    expect(app.error).toHaveBeenCalled();
    const errMsg = app.error.mock.calls[0][0];
    expect(errMsg).toMatch(/auth|tampered|wrong key/i);
  });
});

// ── receivePacket – valid DATA packet ────────────────────────────────────────

describe("receivePacket – valid DATA packet", () => {
  test("calls app.handleMessage for each delta", async () => {
    const { pipeline, app } = makeServer();

    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const delta = {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 1.5 }] }]
    };
    const payload = JSON.stringify([delta]);
    const compressed = await brotliCompressAsync(Buffer.from(payload));

    const { encryptBinary } = require("../lib/crypto");
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const packet = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    await pipeline.receivePacket(packet, SECRET_KEY, { address: "127.0.0.1", port: 8000 });

    expect(app.handleMessage).toHaveBeenCalled();
  });

  test("creates a session on first packet from a new client", async () => {
    const { pipeline } = makeServer();

    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const payload = JSON.stringify([{ context: "vessels.self", updates: [{ values: [] }] }]);
    const compressed = await brotliCompressAsync(Buffer.from(payload));
    const { encryptBinary } = require("../lib/crypto");
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const packet = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    await pipeline.receivePacket(packet, SECRET_KEY, { address: "192.168.1.50", port: 4321 });

    const m = pipeline.getMetrics();
    expect(m.totalSessions).toBe(1);
    expect(m.sessions[0].address).toBe("192.168.1.50:4321");
  });

  test("increments dataPacketsReceived counter", async () => {
    const { pipeline, metricsApi } = makeServer();

    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const payload = JSON.stringify([{ context: "vessels.self", updates: [{ values: [] }] }]);
    const compressed = await brotliCompressAsync(Buffer.from(payload));
    const { encryptBinary } = require("../lib/crypto");
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const packet = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    await pipeline.receivePacket(packet, SECRET_KEY, { address: "127.0.0.1", port: 5001 });

    expect(metricsApi.metrics.dataPacketsReceived).toBeGreaterThanOrEqual(1);
  });
});

// ── receivePacket – duplicate detection ──────────────────────────────────────

describe("receivePacket – duplicate detection", () => {
  test("increments duplicatePackets counter on receiving the same seq twice", async () => {
    const { pipeline, metricsApi } = makeServer();

    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const payload = JSON.stringify([{ context: "vessels.self", updates: [{ values: [] }] }]);
    const compressed = await brotliCompressAsync(Buffer.from(payload));
    const { encryptBinary } = require("../lib/crypto");

    const rinfo = { address: "127.0.0.1", port: 5002 };

    // Send packet once
    const encrypted1 = encryptBinary(compressed, SECRET_KEY);
    const seq = builder.getCurrentSequence();
    const packet1 = builder.buildDataPacket(encrypted1, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });
    await pipeline.receivePacket(packet1, SECRET_KEY, rinfo);

    // Re-send same sequence (simulate duplicate)
    const builder2 = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    // Force same sequence by using a raw approach: just send the original packet again
    await pipeline.receivePacket(packet1, SECRET_KEY, rinfo);

    expect(metricsApi.metrics.duplicatePackets).toBeGreaterThanOrEqual(1);
  });
});

// ── receivePacket – v3 variant ────────────────────────────────────────────────

describe("v3 server pipeline", () => {
  test("creates a v3 server pipeline with the same API", () => {
    const app = makeApp();
    const state = makeState();
    state.options.protocolVersion = 3;
    const metricsApi = createMetrics();
    const pipeline = createPipeline(3, "server", app, state, metricsApi);
    expect(typeof pipeline.receivePacket).toBe("function");
    expect(typeof pipeline.getSequenceTracker).toBe("function");
    expect(typeof pipeline.getMetrics).toBe("function");
  });
});
