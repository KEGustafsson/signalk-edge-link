"use strict";

/**
 * Security regression tests for pre-authentication hardening in the reliable
 * (v3) server pipeline:
 *
 *  - Non-v3 / malformed datagrams are stateless drops (no session allocated).
 *  - Forged-but-CRC-valid DATA packets must not allocate a session or mutate
 *    sequence/NAK state (payload is authenticated by AES-GCM BEFORE any
 *    session/sequence mutation).
 *  - The per-source-IP session cap drops over-cap new sessions rather than
 *    processing them via an unstored "dummy" session.
 */

const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketBuilder } = require("../../lib/packet");
const createMetrics = require("../../lib/metrics");

const SECRET = "6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536";

function makeMockApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeState() {
  return {
    instanceId: null,
    options: {
      secretKey: SECRET,
      protocolVersion: 3,
      reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
    },
    socketUdp: { send: jest.fn((data, port, address, cb) => cb && cb(null)) }
  };
}

describe("reliable server pre-auth hardening", () => {
  let app;
  let state;
  let metricsApi;
  let server;

  beforeEach(() => {
    app = makeMockApp();
    metricsApi = createMetrics();
    state = makeState();
    server = createPipelineV2Server(app, state, metricsApi);
  });

  test("non-v3 / junk datagram is a stateless drop (no session)", async () => {
    await server.receivePacket(Buffer.from("not a real packet at all"), SECRET, {
      address: "10.0.0.9",
      port: 5555
    });
    expect(server.getMetrics().totalSessions).toBe(0);
  });

  test("forged CRC-valid DATA packet does not allocate a session or advance sequence", async () => {
    // Valid header + CRC (PacketBuilder computes the CRC), but the payload is
    // random bytes that will fail AES-GCM authentication on decrypt.
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET });
    const garbage = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeef", "hex");
    const forged = builder.buildDataPacket(garbage, 42, { compressed: true, encrypted: true });

    await server.receivePacket(forged, SECRET, { address: "10.0.0.10", port: 6666 });

    const m = server.getMetrics();
    // No long-lived session created from an unauthenticated DATA packet.
    expect(m.totalSessions).toBe(0);
    // Sequence/NAK state was never touched (no data counted).
    expect(metricsApi.metrics.dataPacketsReceived).toBe(0);
  });

  test("per-IP session cap drops over-cap new sessions (no dummy processing)", async () => {
    // HELLO is HMAC-authenticated, so it allocates sessions. Send HELLOs from
    // more than MAX_SESSIONS_PER_IP (5) distinct ports on one IP.
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET });
    const hello = builder.buildHelloPacket({ clientId: "c1" }, { secretKey: SECRET });

    for (let port = 7000; port < 7010; port++) {
      await server.receivePacket(hello, SECRET, { address: "10.0.0.11", port });
    }

    // Never more than the per-IP cap of 5 sessions for one source IP.
    expect(server.getMetrics().totalSessions).toBeLessThanOrEqual(5);
  });
});
