"use strict";

/**
 * Additional coverage tests for src/pipeline-v2-server.ts
 *
 * Covers: session eviction, per-IP limits, idle expiration, UDP rate limiting,
 * payload size limits, msgpack fallback, null/invalid deltas, HEARTBEAT/HELLO
 * handling, error categorization, and periodic ACK sending.
 */

const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");
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

/**
 * Build a valid encrypted, compressed v2 DATA packet.
 * @param {object|array} payload - JSON-serializable payload
 * @param {PacketBuilder} builder - PacketBuilder instance
 * @param {object} [flagOverrides] - flag overrides for buildDataPacket
 * @returns {Promise<Buffer>}
 */
async function makeEncryptedPacket(payload, builder, flagOverrides = {}) {
  const json = JSON.stringify(payload);
  const compressed = await brotliCompressAsync(Buffer.from(json));
  const encrypted = encryptBinary(compressed, SECRET_KEY);
  return builder.buildDataPacket(encrypted, {
    compressed: true,
    encrypted: true,
    messagepack: false,
    pathDictionary: false,
    ...flagOverrides
  });
}

// ── 1. Session eviction at capacity ──────────────────────────────────────────

describe("Session eviction at capacity (MAX_CLIENT_SESSIONS = 100)", () => {
  test("evicts the oldest idle session when a 101st client connects", async () => {
    const { pipeline, app } = makeServer();

    // Create 100 sessions from distinct addresses
    for (let i = 0; i < 100; i++) {
      const b = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
      const pkt = await makeEncryptedPacket(
        [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: i }] }] }],
        b
      );
      await pipeline.receivePacket(pkt, SECRET_KEY, {
        address: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        port: 5000
      });
    }

    expect(pipeline.getMetrics().totalSessions).toBe(100);

    // 101st session from a brand-new address
    const b101 = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const pkt101 = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 999 }] }] }],
      b101
    );
    await pipeline.receivePacket(pkt101, SECRET_KEY, {
      address: "192.168.99.1",
      port: 6000
    });

    // Should still be at 100 (one evicted, one added)
    expect(pipeline.getMetrics().totalSessions).toBe(100);
    // Eviction message was logged
    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining("Session evicted (at capacity 100)")
    );
  });
});

// ── 2. Per-IP session limit ──────────────────────────────────────────────────

describe("Per-IP session limit (MAX_SESSIONS_PER_IP = 5)", () => {
  test("6th session from same IP gets an ephemeral (non-stored) session", async () => {
    const { pipeline, app } = makeServer();
    const sameIP = "172.16.0.1";

    // Create 5 sessions from the same IP on different ports
    for (let port = 5000; port < 5005; port++) {
      const b = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
      const pkt = await makeEncryptedPacket(
        [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: port }] }] }],
        b
      );
      await pipeline.receivePacket(pkt, SECRET_KEY, { address: sameIP, port });
    }
    expect(pipeline.getMetrics().totalSessions).toBe(5);

    // 6th session from same IP
    const b6 = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const pkt6 = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 6 }] }] }],
      b6
    );
    await pipeline.receivePacket(pkt6, SECRET_KEY, { address: sameIP, port: 5005 });

    // Session count should still be 5 (ephemeral session not stored)
    expect(pipeline.getMetrics().totalSessions).toBe(5);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("per-IP limit"));
  });
});

// ── 3. Session idle expiration ───────────────────────────────────────────────

describe("Session idle expiration (SESSION_IDLE_TTL_MS = 300000)", () => {
  afterEach(() => jest.useRealTimers());

  test("idle sessions are evicted when ACK timer fires after TTL", async () => {
    jest.useFakeTimers();
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Create a session
    const pkt = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] }],
      builder
    );
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.1", port: 4000 });
    expect(pipeline.getMetrics().totalSessions).toBe(1);

    // Start ACK timer (which also runs _expireIdleSessions)
    pipeline.startACKTimer();

    // Advance time past SESSION_IDLE_TTL_MS (5 minutes).
    // The ACK timer fires every ~100ms, so we advance in one large step.
    // _expireIdleSessions runs synchronously inside the interval callback,
    // but we need to flush microtasks for the async _sendPeriodicACKs promise.
    jest.advanceTimersByTime(300100);

    // Flush multiple microtask ticks so the async interval callbacks settle
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    // Run any remaining pending timers triggered by async callbacks
    jest.advanceTimersByTime(0);

    expect(pipeline.getMetrics().totalSessions).toBe(0);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("session expired (idle)"));

    pipeline.stopACKTimer();
  });
});

// ── 4. UDP rate limiting ─────────────────────────────────────────────────────

describe("Duplicate DATA immediate ACK", () => {
  test("duplicate DATA sends immediate ACK and does not forward duplicate delta", async () => {
    const { pipeline, state, app, metricsApi } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new PacketParser({ secretKey: SECRET_KEY });
    const rinfo = { address: "10.0.0.2", port: 4100 };
    const packet = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] }],
      builder
    );

    await pipeline.receivePacket(packet, SECRET_KEY, rinfo);
    const sendsAfterFirst = state.socketUdp.send.mock.calls.length;
    await pipeline.receivePacket(packet, SECRET_KEY, rinfo);

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(metricsApi.metrics.duplicatePackets).toBe(1);
    expect(state.socketUdp.send).toHaveBeenCalledTimes(sendsAfterFirst + 1);

    const lastCall = state.socketUdp.send.mock.calls[state.socketUdp.send.mock.calls.length - 1];
    const ack = parser.parseHeader(lastCall[0]);
    expect(ack.type).toBe(PacketType.ACK);
    expect(parser.parseACKPayload(ack.payload)).toBe(0);
  });
});

describe("UDP rate limiting (UDP_RATE_LIMIT_MAX_PACKETS = 200)", () => {
  test("drops packets beyond the rate limit within one window", async () => {
    jest.useFakeTimers();
    const { pipeline, metricsApi, app } = makeServer();
    const rinfo = { address: "10.0.0.5", port: 7000 };

    try {
      // Send 201 packets from same client without advancing Date.now().
      // Keeping the clock pinned proves the per-window limiter, not wall-clock
      // test runtime, controls this branch.
      for (let i = 0; i < 201; i++) {
        const b = new PacketBuilder({
          protocolVersion: 2,
          secretKey: SECRET_KEY,
          initialSequence: i
        });
        const pkt = await makeEncryptedPacket(
          [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: i }] }] }],
          b
        );
        await pipeline.receivePacket(pkt, SECRET_KEY, rinfo);
      }

      // The 201st packet should be rate-limited
      expect(metricsApi.metrics.rateLimitedPackets).toBeGreaterThanOrEqual(1);
      expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── 5. Decompression / payload size limits ───────────────────────────────────

describe("Payload size limit (MAX_PARSE_PAYLOAD_SIZE = 512KB)", () => {
  test("rejects decompressed payload exceeding MAX_PARSE_PAYLOAD_SIZE", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // The server rejects before JSON parsing, so a compact repeated payload is
    // enough to exercise the decompressed-size guard without slowing the suite.
    const oversizedPayload = Buffer.alloc(512 * 1024 + 1, 0x20);
    expect(oversizedPayload.length).toBeGreaterThan(512 * 1024);

    const compressed = await brotliCompressAsync(oversizedPayload);
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const pkt = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.6", port: 8000 });

    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining("decompressed payload too large to parse")
    );
  });
});

// ── 6. MessagePack fallback on decode failure ────────────────────────────────

describe("MessagePack fallback on decode failure", () => {
  test("falls back to JSON parse when msgpack flag is set but data is JSON-encoded", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Build a packet with the messagepack flag set, but payload is actually JSON
    const delta = { context: "vessels.self", updates: [{ values: [{ path: "a", value: 42 }] }] };
    const json = JSON.stringify([delta]);
    const compressed = await brotliCompressAsync(Buffer.from(json));
    const encrypted = encryptBinary(compressed, SECRET_KEY);

    // Set messagepack flag even though data is JSON
    const pkt = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: true,
      pathDictionary: false
    });

    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.7", port: 8100 });

    // Should log msgpack decode failure and fall back to JSON
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("MessagePack decode failed"));
    // The delta should still be handled via JSON fallback
    expect(app.handleMessage).toHaveBeenCalled();
  });
});

// ── 7. Null/invalid delta handling ───────────────────────────────────────────

describe("Null and invalid delta handling", () => {
  test("skips null deltas in the array", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Payload with null entries mixed in
    const payload = [
      null,
      { context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] },
      null
    ];
    const pkt = await makeEncryptedPacket(payload, builder);
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.8", port: 8200 });

    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("skipping null delta at index 0")
    );
    // Only the non-null delta with updates should be handled
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });

  test("skips deltas with empty updates arrays", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const payload = [{ context: "vessels.self", updates: [] }];
    const pkt = await makeEncryptedPacket(payload, builder);
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.9", port: 8300 });

    // Empty updates array means handleMessage should not be called
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("skips deltas whose updates have no valid value paths", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const payload = [
      {
        context: "vessels.self",
        updates: [{ values: [null, { value: 1 }, { path: "", value: 2 }] }]
      }
    ];
    const pkt = await makeEncryptedPacket(payload, builder);
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.9", port: 8301 });

    expect(app.handleMessage).not.toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("skipping delta with no valid Signal K values")
    );
  });

  test("drops invalid value entries and forwards the remaining valid values", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const payload = [
      {
        context: "vessels.self",
        updates: [
          {
            values: [
              { value: 1 },
              { path: "navigation.speedOverGround", value: 5.1 },
              { path: null, value: 2 }
            ]
          }
        ]
      }
    ];
    const pkt = await makeEncryptedPacket(payload, builder);
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.9", port: 8302 });

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(app.handleMessage.mock.calls[0][1].updates[0].values).toEqual([
      { path: "navigation.speedOverGround", value: 5.1 }
    ]);
  });

  test("handles non-object payload gracefully", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Payload is a primitive string (not an object/array)
    const json = JSON.stringify("just a string");
    const compressed = await brotliCompressAsync(Buffer.from(json));
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const pkt = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.10", port: 8400 });

    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("non-object payload"));
  });
});

// ── 8. HEARTBEAT and HELLO packet handling ───────────────────────────────────

describe("HEARTBEAT and HELLO packet handling", () => {
  test("HEARTBEAT packet is handled without error", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const hbPacket = builder.buildHeartbeatPacket();
    await pipeline.receivePacket(hbPacket, SECRET_KEY, { address: "10.0.0.11", port: 8500 });

    expect(app.debug).toHaveBeenCalledWith("v2 heartbeat received");
    expect(app.error).not.toHaveBeenCalled();
  });

  test("HELLO packet with valid JSON is handled without error", async () => {
    const { pipeline, app } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const helloPacket = builder.buildHelloPacket({
      clientId: "test-client",
      capabilities: ["compression", "encryption"]
    });
    await pipeline.receivePacket(helloPacket, SECRET_KEY, { address: "10.0.0.12", port: 8600 });

    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("v2 hello from client"));
    expect(app.error).not.toHaveBeenCalled();
  });

  test("HELLO packet with invalid JSON payload logs error", async () => {
    const { pipeline, app } = makeServer();

    // Manually construct a HELLO packet with invalid JSON payload.
    // We build a valid header around garbage payload bytes.
    // Construct a HELLO packet with corrupted (non-JSON) payload
    const corruptBuilder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    // Use _buildPacket directly with garbage text that's not valid JSON
    // but passes CRC. The buildHelloPacket wraps JSON.stringify so we need
    // to use the lower-level API.
    const garbagePayload = Buffer.from("not{valid}json");
    const pkt = corruptBuilder._buildPacket(PacketType.HELLO, garbagePayload, {});

    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.13", port: 8700 });

    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to parse HELLO payload")
    );
  });
});

// ── 9. Error categorization in receivePacket ─────────────────────────────────

describe("Error categorization in receivePacket", () => {
  test("CRC/magic/Packet errors increment malformedPackets and recordError('general')", async () => {
    const { pipeline, metricsApi } = makeServer();

    // Build a v2-looking packet with corrupted CRC
    const header = Buffer.alloc(15);
    header[0] = 0x53; // S
    header[1] = 0x4b; // K
    header[2] = 0x02; // version 2
    header[3] = 0x01; // DATA
    header[4] = 0x03; // flags
    header.writeUInt32BE(0, 5); // sequence
    header.writeUInt32BE(0, 9); // payload length = 0
    header.writeUInt16BE(0xbeef, 13); // bad CRC

    await pipeline.receivePacket(header, SECRET_KEY, { address: "10.0.0.14", port: 8800 });

    expect(metricsApi.metrics.malformedPackets).toBeGreaterThanOrEqual(1);
  });

  test("authentication/tamper errors are categorized as encryption errors", async () => {
    const { pipeline, app } = makeServer();

    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const delta = { context: "vessels.self", updates: [{ values: [] }] };
    const json = JSON.stringify([delta]);
    const compressed = await brotliCompressAsync(Buffer.from(json));
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const pkt = builder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });

    // Use wrong key to trigger auth error
    const wrongKey = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    await pipeline.receivePacket(pkt, wrongKey, { address: "10.0.0.15", port: 8900 });

    expect(app.error).toHaveBeenCalledWith(expect.stringMatching(/auth|tampered|wrong key/i));
  });

  test("unhandled packet type is logged", async () => {
    const { pipeline, app } = makeServer();

    // Build an ACK packet (not DATA) - server logs "unhandled packet type" for ACK
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const ackPacket = builder.buildACKPacket(0);
    await pipeline.receivePacket(ackPacket, SECRET_KEY, { address: "10.0.0.16", port: 9000 });

    // ACK type is not DATA, HEARTBEAT, or HELLO, so "unhandled" is logged
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("unhandled packet type"));
  });
});

// ── 10. Periodic ACK sending ─────────────────────────────────────────────────

describe("Periodic ACK sending", () => {
  afterEach(() => jest.useRealTimers());

  test("periodic ACK is sent for sessions with received data", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Send a packet to create a session with hasReceivedData=true
    const pkt = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] }],
      builder
    );
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.20", port: 9100 });

    // Start ACK timer
    pipeline.startACKTimer();

    // Advance past the ACK interval (default 100ms)
    jest.advanceTimersByTime(150);

    // Allow the async _sendPeriodicACKs to resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(state.socketUdp.send).toHaveBeenCalled();

    // Find ACK sends specifically (to the session address)
    const ackCalls = state.socketUdp.send.mock.calls.filter(
      (call) => call[1] === 9100 && call[2] === "10.0.0.20"
    );
    expect(ackCalls.length).toBeGreaterThanOrEqual(1);

    pipeline.stopACKTimer();
  });

  test("no ACK is sent for sessions without received data", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeServer();

    // Start ACK timer without any sessions
    pipeline.startACKTimer();

    jest.advanceTimersByTime(200);
    await Promise.resolve();

    // No sessions exist, so no ACKs should be sent
    expect(state.socketUdp.send).not.toHaveBeenCalled();

    pipeline.stopACKTimer();
  });

  test("duplicate ACK within ackResendInterval is suppressed", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Send one data packet
    const pkt = await makeEncryptedPacket(
      [{ context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] }],
      builder
    );
    await pipeline.receivePacket(pkt, SECRET_KEY, { address: "10.0.0.21", port: 9200 });

    pipeline.startACKTimer();

    // First tick - should send ACK
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();

    const firstCallCount = state.socketUdp.send.mock.calls.filter(
      (call) => call[1] === 9200
    ).length;

    // Second tick soon after (no new data) - should suppress duplicate ACK
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();

    const secondCallCount = state.socketUdp.send.mock.calls.filter(
      (call) => call[1] === 9200
    ).length;

    // The count should not have increased (duplicate suppressed within resend interval)
    expect(secondCallCount).toBe(firstCallCount);

    pipeline.stopACKTimer();
  });
});
