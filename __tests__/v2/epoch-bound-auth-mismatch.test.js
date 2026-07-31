"use strict";

/**
 * `epochBoundAuth` must be set identically on both peers. It is opt-in, so a
 * rolling upgrade goes through a window where only one side has it — and what
 * the operator sees in that window is the whole point of these tests.
 *
 * A mismatch is a CONFIGURATION problem. It used to be reported as
 * "v2 authentication failed: packet tampered or wrong key", which is wrong in
 * both halves: nothing was tampered with and the keys match. An operator
 * reading that goes looking for a key mismatch that does not exist, while the
 * link carries nothing.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { makeMetricsApi } = require("../helpers/metrics-fixture");

const KEY = "12345678901234567890123456789012";
const CLIENT_RINFO = { address: "10.0.0.9", port: 40000 };
const PORT = 9401;

function makeClient(epochBoundAuth) {
  const wire = [];
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId: "c",
    connectionEpoch: 1700000000000,
    options: {
      secretKey: KEY,
      udpPort: PORT,
      udpAddress: "127.0.0.1",
      protocolVersion: 3,
      stretchAsciiKey: false,
      epochBoundAuth,
      reliability: {},
      congestionControl: {}
    },
    socketUdp: {
      send: jest.fn((pkt, _p, _a, cb) => {
        wire.push(Buffer.from(pkt));
        if (cb) {
          cb(null);
        }
      })
    },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const metricsApi = makeMetricsApi();
  return { wire, app, metricsApi, pipeline: createPipelineV2Client(app, state, metricsApi) };
}

function makeServer(epochBoundAuth) {
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId: "s",
    options: {
      secretKey: KEY,
      udpPort: PORT,
      udpAddress: "127.0.0.1",
      protocolVersion: 3,
      stretchAsciiKey: false,
      epochBoundAuth,
      reliability: { ackInterval: 20 }
    },
    socketUdp: { send: jest.fn((_p, _q, _a, cb) => cb && cb(null)) }
  };
  const metricsApi = makeMetricsApi();
  return { app, metricsApi, pipeline: createPipelineV2Server(app, state, metricsApi) };
}

function sampleDelta(value) {
  return {
    context: "vessels.self",
    updates: [
      {
        $source: "boat.gps",
        timestamp: "2026-07-31T00:00:00.000Z",
        values: [{ path: "navigation.speedOverGround", value }]
      }
    ]
  };
}

/** HELLO (so the server learns the epoch), then one DATA packet. */
async function handshakeAndSend(client, server) {
  await client.pipeline.sendHello("127.0.0.1", PORT);
  for (const pkt of client.wire.splice(0)) {
    await server.pipeline.receivePacket(pkt, KEY, CLIENT_RINFO).catch(() => {});
  }
  await client.pipeline.sendDelta([sampleDelta(1)], KEY, "127.0.0.1", PORT);
  for (const pkt of client.wire.splice(0)) {
    await server.pipeline.receivePacket(pkt, KEY, CLIENT_RINFO).catch(() => {});
  }
  return server.app.handleMessage.mock.calls.length > 0;
}

describe("epochBoundAuth agreement between peers", () => {
  const servers = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.pipeline.stop();
    }
  });

  function pair(clientOn, serverOn) {
    const client = makeClient(clientOn);
    const server = makeServer(serverOn);
    servers.push(server);
    return { client, server };
  }

  test.each([
    ["both off", false, false],
    ["both on", true, true]
  ])("matched configuration delivers data — %s", async (_label, c, s) => {
    const { client, server } = pair(c, s);
    await expect(handshakeAndSend(client, server)).resolves.toBe(true);
    expect(server.metricsApi.metrics.epochAuthMismatches || 0).toBe(0);
  });

  // A receiver that does not require binding still verifies a sender that
  // does, so this direction of the mismatch keeps working. Worth pinning:
  // it means enabling the flag on the sender alone buys no enforcement.
  test("sender-only binding is accepted by a receiver that does not require it", async () => {
    const { client, server } = pair(true, false);
    await expect(handshakeAndSend(client, server)).resolves.toBe(true);
    expect(server.metricsApi.metrics.epochAuthMismatches || 0).toBe(0);
  });

  describe("receiver requires it, sender does not", () => {
    test("data is refused", async () => {
      const { client, server } = pair(false, true);
      await expect(handshakeAndSend(client, server)).resolves.toBe(false);
    });

    test("the refusal is counted under its own name", async () => {
      const { client, server } = pair(false, true);
      await handshakeAndSend(client, server);

      // Its own counter: without one the condition is invisible in /metrics,
      // and it must not be filed as a malformed packet or a replay, which
      // point at entirely different causes.
      expect(server.metricsApi.metrics.epochAuthMismatches).toBeGreaterThan(0);
      expect(server.metricsApi.metrics.malformedPackets || 0).toBe(0);
      expect(server.metricsApi.metrics.replayedPackets || 0).toBe(0);
    });

    test("the log names the configuration mismatch, not tampering", async () => {
      const { client, server } = pair(false, true);
      await handshakeAndSend(client, server);

      const logged = server.app.error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/epoch-bound authentication mismatch/i);
      expect(logged).toMatch(/epochBoundAuth/);
      // The message that sent operators looking for a key problem.
      expect(logged).not.toMatch(/tampered or wrong key/);
    });
  });

  /**
   * The other way the parser refuses a packet under epoch binding, and the one
   * that must NOT read as a misconfigured peer: the sender IS binding, but no
   * HELLO has established its epoch yet. A client whose first DATA overtakes
   * its own HELLO produces exactly this, and it clears itself.
   *
   * A single message covering both causes told operators "the sender is not
   * using it" while the sender was using it — a false diagnosis pointing at
   * the wrong machine.
   */
  describe("both peers require it, but the HELLO has not landed yet", () => {
    async function sendDataWithoutHello(client, server) {
      await client.pipeline.sendDelta([sampleDelta(1)], KEY, "127.0.0.1", PORT);
      for (const pkt of client.wire.splice(0)) {
        await server.pipeline.receivePacket(pkt, KEY, CLIENT_RINFO).catch(() => {});
      }
      return server.app.handleMessage.mock.calls.length > 0;
    }

    test("the packet is refused, and counted apart from a real mismatch", async () => {
      const { client, server } = pair(true, true);

      await expect(sendDataWithoutHello(client, server)).resolves.toBe(false);
      expect(server.metricsApi.metrics.epochAuthPending).toBeGreaterThan(0);
      expect(server.metricsApi.metrics.epochAuthMismatches || 0).toBe(0);
    });

    test("it is not reported as the peer being misconfigured", async () => {
      const { client, server } = pair(true, true);
      await sendDataWithoutHello(client, server);

      const errors = server.app.error.mock.calls.map((c) => String(c[0])).join("\n");
      // Both peers are configured identically. Saying otherwise sends the
      // operator to change a setting that is already correct.
      expect(errors).not.toMatch(/the sender is not using it/);
      expect(errors).not.toMatch(/tampered or wrong key/);
    });

    test("a receiver that does NOT require binding reports it the same way", async () => {
      // The asymmetry that produced the worst message in the field. The
      // requiring path checks for a missing epoch explicitly; the
      // interop path used to fall through and verify the tag against a zero
      // epoch, which can never match — and surfaced as "Control packet
      // authentication failed (possible stretchAsciiKey or key-format mismatch
      // between peers)". The keys were fine. Only the handshake was missing.
      const { client, server } = pair(true, false);

      await expect(sendDataWithoutHello(client, server)).resolves.toBe(false);
      expect(server.metricsApi.metrics.epochAuthPending).toBeGreaterThan(0);

      const errors = server.app.error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errors).not.toMatch(/stretchAsciiKey|key-format mismatch/);
      expect(errors).not.toMatch(/tampered or wrong key/);
    });

    test("delivery resumes once the HELLO completes", async () => {
      const { client, server } = pair(true, true);
      await sendDataWithoutHello(client, server);

      // The whole reason this is transient rather than a fault.
      await expect(handshakeAndSend(client, server)).resolves.toBe(true);
    });
  });
});
