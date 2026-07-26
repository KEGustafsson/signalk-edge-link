"use strict";

/**
 * End-to-end integration test for the v3 DATA path.
 *
 * Runs the REAL client pipeline (sendDelta → sanitize → dedup → compact →
 * path-dictionary → serialize → compress → encrypt → buildDataPacket) against
 * the REAL server pipeline (receivePacket → parse → decrypt → decompress →
 * decode → dispatch), piping the emitted bytes straight back in-process.
 *
 * The pre-existing "e2e" suites (`__tests__/integration/e2e-pipeline.test.js`,
 * `__tests__/full-pipeline.test.js`) define their own private
 * compress→encrypt→buildDataPacket helpers and never call the shipped sender at
 * all. Inverting the real pipeline's compress/encrypt order, changing the
 * brotli parameters, or dropping the `compressed` flag would leave those green
 * while every deployed peer stopped decoding. This test exercises the shipped
 * code path, mirroring what `meta-end-to-end.test.js` already does for METADATA.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");

const secretKey = "12345678901234567890123456789012";

function makeMetricsApi() {
  const metrics = {
    startTime: Date.now(),
    deltasSent: 0,
    deltasReceived: 0,
    udpRetries: 0,
    udpSendErrors: 0,
    duplicatePackets: 0,
    rateLimitedPackets: 0,
    malformedPackets: 0,
    rtt: 0,
    jitter: 0,
    queueDepth: 0,
    retransmissions: 0,
    smartBatching: {
      avgBytesPerDelta: 0,
      maxDeltasPerBatch: 0,
      oversizedPackets: 0,
      earlySends: 0,
      timerSends: 0
    },
    bandwidth: {
      packetsOut: 0,
      packetsIn: 0,
      bytesOut: 0,
      bytesIn: 0,
      bytesOutRaw: 0,
      bytesInRaw: 0,
      lastBytesOut: 0,
      lastBytesIn: 0,
      lastRateCalcTime: Date.now(),
      rateOut: 0,
      rateIn: 0,
      compressionRatio: 1,
      history: { toArray: () => [] }
    }
  };
  return {
    metrics,
    recordError: jest.fn(),
    trackPathStats: jest.fn(),
    updateBandwidthRates: jest.fn()
  };
}

function makeWiredPair(options = {}) {
  const wire = [];

  const sharedOptions = {
    secretKey,
    udpPort: 9200,
    udpAddress: "127.0.0.1",
    protocolVersion: 3,
    stretchAsciiKey: false,
    ...options
  };

  const clientApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const clientState = {
    instanceId: "client-1",
    options: sharedOptions,
    socketUdp: {
      send: jest.fn((pkt, _port, _addr, cb) => {
        wire.push(Buffer.from(pkt));
        if (cb) {cb(null);}
      })
    },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const client = createPipelineV2Client(clientApp, clientState, makeMetricsApi());

  const serverApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const serverState = {
    instanceId: "server-1",
    options: { ...sharedOptions, reliability: { nakTimeout: 10 } },
    socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) }
  };
  const serverMetrics = makeMetricsApi();
  const server = createPipelineV2Server(serverApp, serverState, serverMetrics);

  return { wire, client, clientState, server, serverApp, serverMetrics };
}

const rinfo = { address: "10.0.0.5", port: 33100 };

async function deliver(server, wire) {
  for (const packet of wire) {
    await server.receivePacket(packet, secretKey, rinfo);
  }
  wire.length = 0;
}

function sampleDelta(value) {
  return {
    context: "vessels.self",
    updates: [
      {
        $source: "test.source",
        timestamp: "2026-07-26T00:00:00.000Z",
        values: [
          { path: "navigation.speedOverGround", value },
          { path: "navigation.position", value: { latitude: 60.1 + value, longitude: 24.9 } }
        ]
      }
    ]
  };
}

/** Collect the delta objects the server dispatched into Signal K. */
function dispatched(serverApp) {
  return serverApp.handleMessage.mock.calls.map((call) => call[call.length - 1]);
}

describe("v3 DATA end-to-end (real client pipeline → real server pipeline)", () => {
  // Each variant flips a codec that changes the wire encoding, so a mismatch
  // between the sender's flags and the receiver's decode path fails here.
  const variants = [
    { name: "json baseline", options: {} },
    { name: "msgpack", options: { useMsgpack: true } },
    { name: "path dictionary", options: { usePathDictionary: true } },
    { name: "compact deltas", options: { useCompactDeltas: true } },
    { name: "value dedup", options: { useValueDedup: true } },
    {
      name: "all codecs enabled",
      options: {
        useMsgpack: true,
        usePathDictionary: true,
        useCompactDeltas: true,
        useValueDedup: true
      }
    }
  ];

  for (const variant of variants) {
    test(`round-trips a delta with ${variant.name}`, async () => {
      const { wire, client, server, serverApp } = makeWiredPair(variant.options);

      await client.sendDelta([sampleDelta(4.2)], secretKey, "127.0.0.1", 9200);
      expect(wire.length).toBeGreaterThan(0);

      await deliver(server, wire);

      const received = dispatched(serverApp);
      expect(received.length).toBeGreaterThan(0);

      const delta = received[0];
      expect(delta.context).toBe("vessels.self");
      const values = delta.updates.flatMap((u) => u.values);
      const sog = values.find((v) => v.path === "navigation.speedOverGround");
      expect(sog).toBeDefined();
      expect(sog.value).toBeCloseTo(4.2, 6);

      const position = values.find((v) => v.path === "navigation.position");
      expect(position).toBeDefined();
      expect(position.value.latitude).toBeCloseTo(64.3, 6);
      expect(position.value.longitude).toBeCloseTo(24.9, 6);
    });
  }

  test("round-trips a multi-delta batch preserving order and values", async () => {
    const { wire, client, server, serverApp } = makeWiredPair();

    const batch = [sampleDelta(1), sampleDelta(2), sampleDelta(3)];
    await client.sendDelta(batch, secretKey, "127.0.0.1", 9200);
    await deliver(server, wire);

    const sogValues = dispatched(serverApp)
      .flatMap((d) => d.updates.flatMap((u) => u.values))
      .filter((v) => v.path === "navigation.speedOverGround")
      .map((v) => v.value);

    expect(sogValues).toEqual([1, 2, 3]);
  });

  test("a server configured with a different key decodes nothing", async () => {
    const { wire, client } = makeWiredPair();
    await client.sendDelta([sampleDelta(9)], secretKey, "127.0.0.1", 9200);
    expect(wire.length).toBeGreaterThan(0);

    const otherKey = "abcdefghijklmnopqrstuvwxyz012345";
    const serverApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const server = createPipelineV2Server(
      serverApp,
      {
        instanceId: "server-2",
        options: { secretKey: otherKey, udpPort: 9200, protocolVersion: 3 },
        socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) }
      },
      makeMetricsApi()
    );

    for (const packet of wire) {
      await server.receivePacket(packet, otherKey, rinfo);
    }

    // Confidentiality: the payload is AEAD-protected, so a wrong key yields no
    // dispatched deltas rather than garbage.
    expect(serverApp.handleMessage).not.toHaveBeenCalled();
  });

  test("a truncated datagram is rejected without dispatching", async () => {
    const { wire, client, server, serverApp } = makeWiredPair();
    await client.sendDelta([sampleDelta(5)], secretKey, "127.0.0.1", 9200);

    const truncated = wire.map((p) => p.subarray(0, Math.max(15, p.length - 5)));
    wire.length = 0;
    for (const packet of truncated) {
      await server.receivePacket(packet, secretKey, rinfo);
    }

    expect(serverApp.handleMessage).not.toHaveBeenCalled();
  });
});
