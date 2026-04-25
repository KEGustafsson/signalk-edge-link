"use strict";

/**
 * End-to-end integration test for v2 metadata streaming.
 *
 * Runs the real client pipeline (sendMetadata → encryption → packet build)
 * against the real server pipeline (receivePacket → decryption → emit) by
 * piping the bytes the client emits straight back into the server in-process.
 * No real UDP socket is opened — the dgram surface is faked just enough to
 * capture whatever the client sends and feed it to the server.
 *
 * This catches integration regressions that the per-layer unit tests miss:
 * the envelope shape, packet flag bits, MTU thresholds, and per-session
 * dedup all have to agree across the wire boundary or the test fails.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");

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

describe("v2 metadata end-to-end (client → server)", () => {
  const secretKey = "12345678901234567890123456789012";

  function makeWiredPair({ useMsgpack = false, usePathDictionary = false } = {}) {
    // The "wire": every packet the client tries to send is captured here so
    // the test can hand-feed it to the server pipeline. We don't care about
    // ordering for correctness tests; tests reorder/duplicate explicitly.
    const wire = [];

    const clientApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const clientState = {
      instanceId: "client-1",
      options: {
        secretKey,
        udpPort: 9100,
        udpAddress: "127.0.0.1",
        useMsgpack,
        usePathDictionary,
        protocolVersion: 2,
        stretchAsciiKey: false
      },
      socketUdp: {
        send: jest.fn((pkt, port, addr, cb) => {
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
    const clientMetrics = makeMetricsApi();
    const client = createPipelineV2Client(clientApp, clientState, clientMetrics);

    const serverApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const serverState = {
      instanceId: "server-1",
      options: {
        secretKey,
        udpPort: 9100,
        protocolVersion: 2,
        useMsgpack,
        usePathDictionary,
        stretchAsciiKey: false,
        reliability: { nakTimeout: 10 }
      },
      socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) }
    };
    const serverMetrics = makeMetricsApi();
    const server = createPipelineV2Server(serverApp, serverState, serverMetrics);

    return { wire, client, clientApp, clientMetrics, server, serverApp, serverMetrics };
  }

  async function deliverWire(server, wire, rinfo = { address: "10.0.0.5", port: 33000 }) {
    for (const packet of wire) {
      await server.receivePacket(packet, secretKey, rinfo);
    }
  }

  test("snapshot entries arrive intact at app.handleMessage", async () => {
    const { wire, client, server, serverApp } = makeWiredPair();

    const entries = [
      {
        context: "vessels.urn:mrn:imo:mmsi:12345",
        path: "navigation.speedOverGround",
        meta: { units: "m/s", description: "Speed over ground" }
      },
      {
        context: "vessels.urn:mrn:imo:mmsi:12345",
        path: "environment.wind.speedApparent",
        meta: { units: "m/s" }
      }
    ];

    await client.sendMetadata(entries, "snapshot", secretKey, "127.0.0.1", 9100);
    expect(wire.length).toBeGreaterThan(0);
    await deliverWire(server, wire);

    // One handleMessage per context. Same context for both entries above ⇒ 1.
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(1);
    const delta = serverApp.handleMessage.mock.calls[0][1];
    expect(delta.context).toBe("vessels.urn:mrn:imo:mmsi:12345");
    expect(delta.updates[0].meta).toHaveLength(2);
    expect(delta.updates[0].meta).toEqual(
      expect.arrayContaining([
        {
          path: "navigation.speedOverGround",
          value: { units: "m/s", description: "Speed over ground" }
        },
        { path: "environment.wind.speedApparent", value: { units: "m/s" } }
      ])
    );
  });

  test("survives MessagePack serialization end-to-end", async () => {
    const { wire, client, server, serverApp } = makeWiredPair({ useMsgpack: true });
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    await deliverWire(server, wire);
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(1);
    expect(serverApp.handleMessage.mock.calls[0][1].updates[0].meta[0].value).toEqual({
      units: "m"
    });
  });

  test("survives path-dictionary encoding end-to-end", async () => {
    const { wire, client, server, serverApp } = makeWiredPair({ usePathDictionary: true });
    await client.sendMetadata(
      [
        {
          context: "vessels.self",
          path: "navigation.speedOverGround",
          meta: { units: "m/s" }
        }
      ],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    await deliverWire(server, wire);
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(1);
    expect(serverApp.handleMessage.mock.calls[0][1].updates[0].meta[0].path).toBe(
      "navigation.speedOverGround"
    );
  });

  test("server dedupes duplicate envelopes (same envSeq replayed)", async () => {
    const { wire, client, server, serverApp, serverMetrics } = makeWiredPair();
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    // Replay the same wire bytes twice — the second copy must be rejected.
    await deliverWire(server, [...wire, ...wire]);
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(1);
    expect(serverMetrics.metrics.duplicatePackets).toBeGreaterThan(0);
  });

  test("two snapshots in order both apply (envSeq advances)", async () => {
    const { wire, client, server, serverApp } = makeWiredPair();
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    await client.sendMetadata(
      [{ context: "vessels.self", path: "b", meta: { units: "rad" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    expect(wire.length).toBe(2);
    await deliverWire(server, wire);
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(2);
  });

  test("server drops a stale envelope arriving after a newer one", async () => {
    const { wire, client, server, serverApp, serverMetrics } = makeWiredPair();
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    await client.sendMetadata(
      [{ context: "vessels.self", path: "b", meta: { units: "rad" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    // Deliver newer (#1) before older (#0).
    await deliverWire(server, [wire[1], wire[0]]);
    expect(serverApp.handleMessage).toHaveBeenCalledTimes(1);
    expect(serverMetrics.metrics.duplicatePackets).toBeGreaterThan(0);
  });

  test("client metaSnapshotsSent / metaDiffsSent counters track sends", async () => {
    const { wire, client, clientMetrics } = makeWiredPair();
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
      "snapshot",
      secretKey,
      "127.0.0.1",
      9100
    );
    await client.sendMetadata(
      [{ context: "vessels.self", path: "a", meta: { units: "ft" } }],
      "diff",
      secretKey,
      "127.0.0.1",
      9100
    );
    expect(clientMetrics.metrics.bandwidth.metaSnapshotsSent).toBe(1);
    expect(clientMetrics.metrics.bandwidth.metaDiffsSent).toBe(1);
    expect(wire.length).toBe(2);
  });

  test("client throws (rather than swallows) when UDP send rejects", async () => {
    const { clientApp, clientMetrics } = makeWiredPair();
    // Override the socket to fail every send.
    clientMetrics.recordError = jest.fn();
    const failingState = {
      instanceId: "client-fail",
      options: {
        secretKey,
        udpPort: 9100,
        udpAddress: "127.0.0.1",
        useMsgpack: false,
        usePathDictionary: false,
        protocolVersion: 2,
        stretchAsciiKey: false
      },
      socketUdp: {
        send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(new Error("EHOSTUNREACH")))
      },
      deltaTimerTime: 1000,
      avgBytesPerDelta: 100,
      maxDeltasPerBatch: 10,
      stopped: false
    };
    const failingClient = createPipelineV2Client(clientApp, failingState, clientMetrics);
    await expect(
      failingClient.sendMetadata(
        [{ context: "vessels.self", path: "a", meta: { units: "m" } }],
        "snapshot",
        secretKey,
        "127.0.0.1",
        9100
      )
    ).rejects.toBeDefined();
  });
});
