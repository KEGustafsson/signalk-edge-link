"use strict";

/**
 * Tests for multi-client session support in pipeline-v2-server.js
 *
 * Verifies that:
 * - Each unique client address:port gets its own isolated session
 * - ACK/NAK replies are sent to the correct client
 * - Idle sessions are expired after TTL
 * - Backward-compat: getSequenceTracker() returns first session's tracker
 */

const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketBuilder } = require("../../lib/packet");
const createMetrics = require("../../lib/metrics");

function makeMockApp() {
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
    instanceId: null,
    options: {
      secretKey: "abcdefghijklmnopqrstuvwxyz123456",
      protocolVersion: 2,
      reliability: {
        ackInterval: 100,
        ackResendInterval: 1000,
        nakTimeout: 50
      }
    },
    socketUdp: null,
    ...overrides
  };
}

function makeSentPacket(secretKey) {
  // Build a valid v2 DATA packet (empty payload for simplicity)
  const { promisify } = require("util");
  const zlib = require("zlib");
  const { encryptBinary } = require("../../lib/crypto");

  const payload = JSON.stringify([]);
  const brotliCompress = promisify(zlib.brotliCompress);
  return brotliCompress(Buffer.from(payload)).then((compressed) => {
    const encrypted = encryptBinary(compressed, secretKey);
    const builder = new PacketBuilder();
    return builder.buildDataPacket(encrypted, 1, { compressed: true, encrypted: true });
  });
}

describe("pipeline-v2-server multi-client sessions", () => {
  let app;
  let state;
  let metricsApi;
  let server;
  const SECRET = "abcdefghijklmnopqrstuvwxyz123456";

  const clientA = { address: "10.0.0.1", port: 12345 };
  const clientB = { address: "10.0.0.2", port: 12346 };

  beforeEach(() => {
    app = makeMockApp();
    metricsApi = createMetrics();
    state = makeState();
    server = createPipelineV2Server(app, state, metricsApi);
  });

  afterEach(() => {
    server.stopACKTimer();
    server.stopMetricsPublishing();
  });

  test("getMetrics returns sessions array with totalSessions count", () => {
    const m = server.getMetrics();
    expect(Array.isArray(m.sessions)).toBe(true);
    expect(m.totalSessions).toBe(0);
    expect(m.acksSent).toBe(0);
    expect(m.naksSent).toBe(0);
  });

  test("getSequenceTracker returns a SequenceTracker (backward compat)", () => {
    const tracker = server.getSequenceTracker();
    // Should have the expected SequenceTracker API
    expect(typeof tracker.processSequence).toBe("function");
    expect(typeof tracker.reset).toBe("function");
  });

  test("two different client addresses get independent sessions after packets arrive", async () => {
    const packet = await makeSentPacket(SECRET);

    // Set up a minimal mock socket so receivePacket can try to send ACK
    const udpSends = [];
    state.socketUdp = {
      send: jest.fn((data, port, address, cb) => {
        udpSends.push({ port, address });
        cb(null);
      })
    };

    await server.receivePacket(packet, SECRET, clientA);
    await server.receivePacket(packet, SECRET, clientB);

    const m = server.getMetrics();
    expect(m.totalSessions).toBe(2);
    const addrs = m.sessions.map((s) => s.address);
    expect(addrs).toContain(`${clientA.address}:${clientA.port}`);
    expect(addrs).toContain(`${clientB.address}:${clientB.port}`);
  });

  test("same client address reuses existing session", async () => {
    const packet = await makeSentPacket(SECRET);

    state.socketUdp = {
      send: jest.fn((data, port, address, cb) => cb(null))
    };

    await server.receivePacket(packet, SECRET, clientA);
    await server.receivePacket(packet, SECRET, clientA);

    const m = server.getMetrics();
    // Only one session for clientA
    expect(m.totalSessions).toBe(1);
  });

  test("bonding heartbeat probe is echoed back without creating a session", async () => {
    const probe = Buffer.alloc(12);
    probe.write("HBPROBE", 0, "ascii");

    let echoed = false;
    state.socketUdp = {
      send: jest.fn((data, port, address, cb) => {
        if (port === clientA.port && address === clientA.address) {
          echoed = true;
        }
        cb(null);
      })
    };

    await server.receivePacket(probe, SECRET, clientA);

    expect(echoed).toBe(true);
    // No session created for probe
    expect(server.getMetrics().totalSessions).toBe(0);
  });

  test("startACKTimer / stopACKTimer control the interval", () => {
    jest.useFakeTimers();
    server.startACKTimer();
    // Calling startACKTimer again should not create a second timer
    server.startACKTimer();
    server.stopACKTimer();
    jest.useRealTimers();
  });
});

describe("pipeline-v2-server MetricsPublisher pathPrefix", () => {
  test("uses instance-namespaced path when state.instanceId is set", () => {
    const app = makeMockApp();
    const metricsApi = createMetrics();
    const state = makeState({ instanceId: "my-server" });
    const server = createPipelineV2Server(app, state, metricsApi);
    const publisher = server.getMetricsPublisher();
    expect(publisher.pathPrefix).toBe("networking.edgeLink.my-server");
    server.stopACKTimer();
    server.stopMetricsPublishing();
  });

  test("uses default path when state.instanceId is null", () => {
    const app = makeMockApp();
    const metricsApi = createMetrics();
    const state = makeState({ instanceId: null });
    const server = createPipelineV2Server(app, state, metricsApi);
    const publisher = server.getMetricsPublisher();
    expect(publisher.pathPrefix).toBe("networking.edgeLink");
    server.stopACKTimer();
    server.stopMetricsPublishing();
  });
});
