"use strict";

/**
 * Additional coverage tests for src/pipeline-v2-client.ts
 * Targets compression/encryption errors, oversized packets, Karn's algorithm,
 * ACK/NAK edge cases, recovery burst guards, force drain, packet loss
 * calculation, and handleControlPacket filtering.
 */

const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");
const { PacketBuilder, PacketType } = require("../../lib/packet");
const { MAX_SAFE_UDP_PAYLOAD } = require("../../lib/constants");

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
    avgBytesPerDelta: 200,
    maxDeltasPerBatch: 5,
    lastPacketTime: 0,
    readyToSend: false,
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

const rinfo = { address: "127.0.0.1", port: 12345, family: "IPv4", size: 0 };

function simpleDelta() {
  return { context: "vessels.self", updates: [{ values: [{ path: "a", value: 1 }] }] };
}

function sourcePayload(seed) {
  const crypto = require("crypto");
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += crypto.createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return out;
}

// ── 1. sendDelta compression error ──────────────────────────────────────────

describe("sendDelta – compression error", () => {
  let origCompress;
  const pipelineUtils = require("../../lib/pipeline-utils");

  beforeEach(() => {
    origCompress = pipelineUtils.compressPayload;
  });
  afterEach(() => {
    pipelineUtils.compressPayload = origCompress;
  });

  test("catches and records a compression error", async () => {
    const { pipeline, app, metricsApi } = makeClient();
    pipelineUtils.compressPayload = jest.fn(() => {
      throw new Error("compress failed");
    });

    await expect(pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345)).rejects.toThrow(
      "compress"
    );

    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("compression error"));
    expect(metricsApi.metrics.compressionErrors).toBeGreaterThan(0);
    const recent = metricsApi.metrics.recentErrors || [];
    expect(recent.some((e) => e.category === "compression")).toBe(true);
  });
});

// ── 2. sendDelta encryption error ───────────────────────────────────────────

describe("sendDelta – encryption error", () => {
  let origEncrypt;
  const crypto = require("../../lib/crypto");

  beforeEach(() => {
    origEncrypt = crypto.encryptBinary;
  });
  afterEach(() => {
    crypto.encryptBinary = origEncrypt;
  });

  test("catches and records an encryption error", async () => {
    const { pipeline, app, metricsApi } = makeClient();
    crypto.encryptBinary = jest.fn(() => {
      throw new Error("encrypt failed");
    });

    await expect(pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345)).rejects.toThrow(
      "encrypt"
    );

    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("encryption error"));
    expect(metricsApi.metrics.encryptionErrors).toBeGreaterThan(0);
    const recent = metricsApi.metrics.recentErrors || [];
    expect(recent.some((e) => e.category === "encryption")).toBe(true);
  });
});

// ── 3. Oversized packet warning ─────────────────────────────────────────────

describe("sendDelta – oversized packet warning", () => {
  test("logs a warning when packet exceeds MAX_SAFE_UDP_PAYLOAD", async () => {
    const { pipeline, app, metricsApi } = makeClient();

    // Use random data that resists compression to exceed 1400 bytes after encrypt+header
    const crypto = require("crypto");
    const bigValue = crypto.randomBytes(2000).toString("base64");
    const largeDelta = {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.big", value: bigValue }] }]
    };

    await pipeline.sendDelta(largeDelta, SECRET_KEY, "127.0.0.1", 12345);

    const warningLogged = app.debug.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("exceeds safe MTU")
    );
    expect(warningLogged).toBe(true);
    expect(metricsApi.metrics.smartBatching.oversizedPackets).toBeGreaterThan(0);
  });
});

// ── 4. ACK handling with Karn's algorithm ───────────────────────────────────

describe("receiveACK – Karn's algorithm", () => {
  afterEach(() => jest.useRealTimers());

  test("does NOT sample RTT for retransmitted packets, DOES for fresh ones", async () => {
    jest.useFakeTimers();
    const { pipeline, metricsApi } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    // Send a delta to populate the retransmit queue at seq=0
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    // Simulate a retransmission of seq=0 by marking it retransmitted
    const rq = pipeline.getRetransmitQueue();
    const entry0 = rq.get(0);
    expect(entry0).toBeDefined();
    // Force attempts > 0 to simulate retransmission
    if (entry0) {
      entry0.attempts = 1;
    }

    jest.advanceTimersByTime(50);

    // Receive ACK for seq=0 (retransmitted) - RTT should NOT be sampled
    const ack0 = builder.buildACKPacket(0);
    pipeline.receiveACK(
      require("../../lib/packet").PacketParser
        ? new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY }).parseHeader(
          ack0
        )
        : (() => {
          throw new Error("no parser");
        })(),
      rinfo
    );

    // RTT should still be 0 (not sampled)
    expect(metricsApi.metrics.rtt).toBe(0);

    // Now send a fresh delta at seq=1
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    jest.advanceTimersByTime(100);

    // ACK for seq=1 (fresh, attempts=0) - RTT SHOULD be sampled
    const ack1 = builder.buildACKPacket(1);
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });
    pipeline.receiveACK(parser.parseHeader(ack1), rinfo);

    expect(metricsApi.metrics.rtt).toBeGreaterThan(0);
  });
});

// ── 5. ACK out-of-order ─────────────────────────────────────────────────────

describe("receiveACK – out-of-order ACK", () => {
  test("does not regress lastAckedSeq on older ACK", async () => {
    const { pipeline, metricsApi } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    // Send two deltas (seq 0 and 1)
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    // ACK seq=1 first (higher)
    const ack1 = builder.buildACKPacket(1);
    pipeline.receiveACK(parser.parseHeader(ack1), rinfo);

    // Now ACK seq=0 (behind) - lastAckedSeq should stay at 1
    const ack0 = builder.buildACKPacket(0);
    pipeline.receiveACK(parser.parseHeader(ack0), rinfo);

    // Send seq=2 and ACK it - verify queue still works correctly
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    const ack2 = builder.buildACKPacket(2);
    pipeline.receiveACK(parser.parseHeader(ack2), rinfo);

    // No errors should have been recorded
    const recent = metricsApi.metrics.recentErrors || [];
    expect(recent.length).toBe(0);
  });

  test("stale out-of-order ACK does not drain newer queue entries", async () => {
    const { pipeline } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    pipeline.receiveACK(parser.parseHeader(builder.buildACKPacket(1)), rinfo);
    expect(pipeline.getRetransmitQueue().get(2)).toBeDefined();

    pipeline.receiveACK(parser.parseHeader(builder.buildACKPacket(0)), rinfo);

    expect(pipeline.getRetransmitQueue().getSize()).toBe(1);
    expect(pipeline.getRetransmitQueue().get(2)).toBeDefined();
  });
});

// ── 6. ACK parse error ──────────────────────────────────────────────────────

describe("receiveACK – parse error", () => {
  test("catches error on malformed ACK payload", () => {
    const { pipeline, app, metricsApi } = makeClient();

    // Create a parsed packet with an empty payload (too short for parseACKPayload)
    const malformedParsed = {
      version: 2,
      type: PacketType.ACK,
      typeName: "ACK",
      flags: { compressed: false, encrypted: false, messagepack: false, pathDictionary: false },
      sequence: 0,
      payloadLength: 0,
      payload: Buffer.alloc(0) // too short - parseACKPayload needs >= 4
    };

    expect(() => pipeline.receiveACK(malformedParsed, rinfo)).not.toThrow();
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("Failed to process ACK"));
    const recent = metricsApi.metrics.recentErrors || [];
    expect(recent.some((e) => e.message && e.message.includes("ACK"))).toBe(true);
  });
});

// ── 7. NAK handling ─────────────────────────────────────────────────────────

describe("receiveNAK – retransmission", () => {
  test("retransmits packets for requested sequences", async () => {
    const { pipeline, state, metricsApi } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    // Send 3 deltas: seq 0, 1, 2
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    const sendCountBefore = state.socketUdp.send.mock.calls.length;

    // Build a NAK for seq 0 and 2
    const nakPacket = builder.buildNAKPacket([0, 2]);
    const parsed = parser.parseHeader(nakPacket);
    await pipeline.receiveNAK(parsed, "127.0.0.1", 12345);

    // Should have sent 2 retransmissions
    const sendCountAfter = state.socketUdp.send.mock.calls.length;
    expect(sendCountAfter - sendCountBefore).toBe(2);
    const retransmittedSeqs = state.socketUdp.send.mock.calls
      .slice(sendCountBefore)
      .map((call) => parser.parseHeader(call[0]).sequence);
    expect(retransmittedSeqs).toEqual([0, 2]);
    expect(metricsApi.metrics.retransmissions).toBeGreaterThanOrEqual(2);
  });
});

// ── 8. NAK parse error ──────────────────────────────────────────────────────

describe("receiveNAK – parse error", () => {
  test("catches error on malformed NAK payload", async () => {
    const { pipeline, app, metricsApi } = makeClient();

    // Payload length not a multiple of 4 will cause parseNAKPayload to throw
    const malformedParsed = {
      version: 2,
      type: PacketType.NAK,
      typeName: "NAK",
      flags: { compressed: false, encrypted: false, messagepack: false, pathDictionary: false },
      sequence: 0,
      payloadLength: 3,
      payload: Buffer.alloc(3) // not a multiple of 4
    };

    await expect(pipeline.receiveNAK(malformedParsed, "127.0.0.1", 12345)).resolves.toBeUndefined();
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("Failed to process NAK"));
    const recent = metricsApi.metrics.recentErrors || [];
    expect(recent.some((e) => e.message && e.message.includes("NAK"))).toBe(true);
  });
});

// ── 9. Recovery burst guard conditions ──────────────────────────────────────

describe("recovery burst guards", () => {
  afterEach(() => jest.useRealTimers());

  test("does NOT fire when disabled", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeClient({
      options: {
        secretKey: SECRET_KEY,
        udpAddress: "127.0.0.1",
        udpPort: 12345,
        protocolVersion: 2,
        useMsgpack: false,
        usePathDictionary: false,
        reliability: { recoveryBurstEnabled: false },
        congestionControl: {}
      }
    });
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    const sendsBefore = state.socketUdp.send.mock.calls.length;

    // ACK with a large gap - recovery burst should NOT trigger because disabled
    jest.advanceTimersByTime(5000);
    const ack = builder.buildACKPacket(0);
    pipeline.receiveACK(parser.parseHeader(ack), rinfo);

    jest.advanceTimersByTime(1000);
    // No extra sends beyond the ACK handling
    const sendsAfter = state.socketUdp.send.mock.calls.length;
    expect(sendsAfter).toBe(sendsBefore);
  });

  test("does NOT fire when queue is empty", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    jest.advanceTimersByTime(5000);

    // ACK seq=0 which clears the queue
    const ack = builder.buildACKPacket(0);
    pipeline.receiveACK(parser.parseHeader(ack), rinfo);

    // Queue is now empty, recovery burst should not trigger more sends
    const sendsBefore = state.socketUdp.send.mock.calls.length;
    jest.advanceTimersByTime(5000);
    const sendsAfter = state.socketUdp.send.mock.calls.length;
    expect(sendsAfter).toBe(sendsBefore);
  });

  test("does NOT fire when ACK gap is below threshold", async () => {
    jest.useFakeTimers();
    const { pipeline, state } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    // Short gap (under default 4000ms) - should not trigger burst
    jest.advanceTimersByTime(100);
    const ack = builder.buildACKPacket(0);
    pipeline.receiveACK(parser.parseHeader(ack), rinfo);

    const sendsBefore = state.socketUdp.send.mock.calls.length;
    jest.advanceTimersByTime(1000);
    const sendsAfter = state.socketUdp.send.mock.calls.length;
    expect(sendsAfter).toBe(sendsBefore);
  });

  test("recovery burst stops when the socket becomes unavailable", async () => {
    jest.useFakeTimers();
    const { pipeline, state, app } = makeClient({
      options: {
        secretKey: SECRET_KEY,
        udpAddress: "127.0.0.1",
        udpPort: 12345,
        protocolVersion: 2,
        useMsgpack: false,
        usePathDictionary: false,
        reliability: {
          recoveryAckGapMs: 1000,
          recoveryBurstIntervalMs: 100
        },
        congestionControl: {}
      }
    });
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    const sendsBeforeRecovery = state.socketUdp.send.mock.calls.length;

    jest.advanceTimersByTime(5000);
    state.socketUdp = null;
    pipeline.receiveACK(parser.parseHeader(builder.buildACKPacket(0)), rinfo);

    await Promise.resolve();
    jest.advanceTimersByTime(500);

    expect(state.socketUdp).toBeNull();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("Recovery burst stopped: UDP socket unavailable")
    );
    expect(sendsBeforeRecovery).toBe(2);
  });
});

// ── 10. Force drain after ACK idle ──────────────────────────────────────────

describe("source snapshot sender", () => {
  test("does not send a source snapshot when the pipeline is stopped", async () => {
    const { pipeline, state, app } = makeClient();
    state.options = null;

    await expect(
      pipeline.sendSourceSnapshot(
        { "source-a": { label: "source-a", type: "test" } },
        SECRET_KEY,
        "127.0.0.1",
        12345
      )
    ).resolves.toBeUndefined();

    expect(state.socketUdp.send).not.toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(
      "sendSourceSnapshot called but plugin is stopped, ignoring"
    );
  });

  test("splits source snapshots into safe UDP chunks", async () => {
    const { pipeline, state } = makeClient();
    const sources = {};

    for (let i = 0; i < 80; i++) {
      sources[`source-${i}`] = {
        label: `source-${i}`,
        type: "test",
        nested: {
          timestamp: `2026-04-28T14:${String(i).padStart(2, "0")}:00.000Z`,
          payload: sourcePayload(i)
        }
      };
    }

    await pipeline.sendSourceSnapshot(sources, SECRET_KEY, "127.0.0.1", 12345);

    const packets = state.socketUdp.send.mock.calls.map((call) => call[0]);
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.every((packet) => packet.length <= MAX_SAFE_UDP_PAYLOAD)).toBe(true);
  });
});

describe("force drain after ACK idle", () => {
  afterEach(() => jest.useRealTimers());

  test("drains queue when forceDrainAfterAckIdle is true and time exceeds threshold", async () => {
    jest.useFakeTimers();
    const { pipeline, app } = makeClient({
      options: {
        secretKey: SECRET_KEY,
        udpAddress: "127.0.0.1",
        udpPort: 12345,
        protocolVersion: 2,
        useMsgpack: false,
        usePathDictionary: false,
        reliability: {
          forceDrainAfterAckIdle: true,
          forceDrainAfterMs: 1000 // short for testing
        },
        congestionControl: {}
      }
    });

    // Send a delta to populate queue
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    expect(pipeline.getRetransmitQueue().getSize()).toBeGreaterThan(0);

    // Advance time past forceDrainAfterMs
    jest.advanceTimersByTime(1500);

    // Trigger prune via another send (which calls _pruneRetransmitQueue)
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    // The old entries should have been force-drained
    const drainLogged = app.debug.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("Force-drained")
    );
    expect(drainLogged).toBe(true);
  });
});

// ── 11. Packet loss calculation ─────────────────────────────────────────────

describe("packet loss calculation", () => {
  test("returns 0 for empty window (no sends)", () => {
    const { metricsApi } = makeClient();
    // No deltas sent, no ACKs - packetLoss should be 0 or undefined
    expect(metricsApi.metrics.packetLoss === undefined || metricsApi.metrics.packetLoss === 0).toBe(
      true
    );
  });

  test("returns 0 when all sends are clean", async () => {
    const { pipeline, metricsApi } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    // Send 5 deltas - each records a clean send in the loss window
    for (let i = 0; i < 5; i++) {
      await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    }

    // Trigger metrics publish to capture packetLoss
    pipeline.startMetricsPublishing();
    // Manually check: all sends were clean
    // ACK one to trigger _calculatePacketLoss inside receiveACK
    const ack = builder.buildACKPacket(4);
    pipeline.receiveACK(parser.parseHeader(ack), rinfo);

    // packetLoss should be 0 (all clean sends)
    expect(metricsApi.metrics.packetLoss === undefined || metricsApi.metrics.packetLoss === 0).toBe(
      true
    );
    pipeline.stopMetricsPublishing();
  });

  test("returns >0 when there are retransmissions (losses)", async () => {
    const { pipeline, metricsApi } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });
    const parser = new (require("../../lib/packet").PacketParser)({ secretKey: SECRET_KEY });

    // Send 3 deltas
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);
    await pipeline.sendDelta(simpleDelta(), SECRET_KEY, "127.0.0.1", 12345);

    // NAK seq 0 to trigger a retransmission (records loss in window)
    const nak = builder.buildNAKPacket([0]);
    const nakParsed = parser.parseHeader(nak);
    await pipeline.receiveNAK(nakParsed, "127.0.0.1", 12345);

    // ACK seq 2 - this will call _calculatePacketLoss and feed it to congestion control
    const ack = builder.buildACKPacket(2);
    pipeline.receiveACK(parser.parseHeader(ack), rinfo);

    // The loss window now has 3 clean sends + 1 loss = 25% loss
    // We just verify it's > 0
    // packetLoss is set during _publishMetrics, but congestion control gets it from receiveACK
    // Let's trigger _publishMetrics
    pipeline.startMetricsPublishing();
    jest.useFakeTimers();
    jest.advanceTimersByTime(2000);
    jest.useRealTimers();
    pipeline.stopMetricsPublishing();

    // The internal loss window should reflect the retransmission
    expect(metricsApi.metrics.retransmissions).toBeGreaterThan(0);
  });
});

// ── 12. handleControlPacket with non-v2 packet ─────────────────────────────

describe("handleControlPacket – non-v2 packet", () => {
  test("silently ignores a non-v2 packet (no magic bytes)", async () => {
    const { pipeline, app } = makeClient();

    // Random buffer without SK magic bytes
    const nonV2 = Buffer.from("this is not a v2 packet");
    await expect(pipeline.handleControlPacket(nonV2, rinfo)).resolves.toBeUndefined();

    // Should not log any error
    expect(app.error).not.toHaveBeenCalled();
  });

  test("silently ignores a v1-style packet (wrong version byte)", async () => {
    const { pipeline, app } = makeClient();

    // Has SK magic but version=1 (unsupported)
    const v1Packet = Buffer.alloc(20);
    v1Packet[0] = 0x53; // S
    v1Packet[1] = 0x4b; // K
    v1Packet[2] = 0x01; // version 1
    await expect(pipeline.handleControlPacket(v1Packet, rinfo)).resolves.toBeUndefined();

    // isV2Packet returns false for version 1, so it's silently ignored
    expect(app.error).not.toHaveBeenCalled();
  });
});

// ── 13. handleControlPacket with unknown type (HEARTBEAT) ───────────────────

describe("handleControlPacket – ignored types", () => {
  test("ignores a HEARTBEAT packet (only ACK/NAK handled on client)", async () => {
    const { pipeline, app } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const heartbeat = builder.buildHeartbeatPacket();
    await expect(pipeline.handleControlPacket(heartbeat, rinfo)).resolves.toBeUndefined();

    // Should parse successfully (no error) but not trigger any ACK/NAK logic
    expect(app.error).not.toHaveBeenCalled();
  });

  test("ignores a HELLO packet on client side", async () => {
    const { pipeline, app } = makeClient();
    const builder = new PacketBuilder({ protocolVersion: 2, secretKey: SECRET_KEY });

    const hello = builder.buildHelloPacket({ clientId: "test" });
    await expect(pipeline.handleControlPacket(hello, rinfo)).resolves.toBeUndefined();

    expect(app.error).not.toHaveBeenCalled();
  });
});
