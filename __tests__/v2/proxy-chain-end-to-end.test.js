"use strict";

/**
 * End-to-end DATA flow across a proxy chain: Boat → Proxy → Cloud.
 *
 * The two-hop topology was untested. `full-status-cascade.test.js` covers the
 * FULL_STATUS_REQUEST wiring with mocked pipelines, and
 * `data-end-to-end.test.js` covers one real hop — but nothing carried an actual
 * delta across two, so everything that only breaks on the second hop was
 * invisible: per-hop codec renegotiation, per-hop keys, per-hop sequence and
 * epoch state, `$source` survival, and path-dictionary encode/decode running
 * twice over the same payload.
 *
 * A proxy is two independent instances in one process, joined by the Signal K
 * tree rather than by a direct pipe: its server dispatches received deltas via
 * `handleMessage`, and its client picks them up and sends them onward. This
 * test models exactly that — the proxy's client forwards what the proxy's
 * server actually dispatched, not the original object — so a mutation applied
 * on the way in is carried forward the way it would be in production.
 *
 * Each hop uses its own secret key, as real deployments do; a hop that leaked
 * the other's key or reused sequence state would fail to decode here.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { makeMetricsApi } = require("../helpers/metrics-fixture");

const BOAT_TO_PROXY_KEY = "11111111111111111111111111111111";
const PROXY_TO_CLOUD_KEY = "22222222222222222222222222222222";

function makeClient(instanceId, key, port, options) {
  const wire = [];
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId,
    options: {
      secretKey: key,
      udpPort: port,
      udpAddress: "127.0.0.1",
      protocolVersion: 3,
      stretchAsciiKey: false,
      ...options
    },
    socketUdp: {
      send: jest.fn((pkt, _port, _addr, cb) => {
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
  return { wire, app, pipeline: createPipelineV2Client(app, state, makeMetricsApi()) };
}

// Every server pipeline this file creates, so none is left holding a timer.
// `nakTimeout: 10` means receivePacket can arm a NAK (and its coalescing
// flush) that outlives the test: jest then reports a worker that failed to
// exit, and a late callback touches state belonging to a finished test.
const activePipelines = [];

afterEach(() => {
  for (const pipeline of activePipelines.splice(0)) {
    pipeline.stop();
  }
});

function makeServer(instanceId, key, port, options) {
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId,
    options: {
      secretKey: key,
      udpPort: port,
      udpAddress: "127.0.0.1",
      protocolVersion: 3,
      stretchAsciiKey: false,
      reliability: { nakTimeout: 10 },
      ...options
    },
    socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) }
  };
  const pipeline = createPipelineV2Server(app, state, makeMetricsApi());
  activePipelines.push(pipeline);
  return { app, pipeline };
}

/** Deltas the node dispatched into its Signal K tree. */
function dispatched(app) {
  return app.handleMessage.mock.calls.map((call) => call[call.length - 1]);
}

async function drain(server, wire, key, rinfo) {
  for (const packet of wire) {
    await server.receivePacket(packet, key, rinfo);
  }
  wire.length = 0;
}

function sampleDelta(value) {
  return {
    context: "vessels.self",
    updates: [
      {
        $source: "boat.gps",
        timestamp: "2026-07-30T00:00:00.000Z",
        values: [
          { path: "navigation.speedOverGround", value },
          { path: "navigation.position", value: { latitude: 60.1 + value, longitude: 24.9 } }
        ]
      }
    ]
  };
}

const BOAT_RINFO = { address: "10.1.0.2", port: 41000 };
const PROXY_RINFO = { address: "10.2.0.2", port: 42000 };

/**
 * Build Boat(client) → Proxy(server+client) → Cloud(server) and carry `delta`
 * the whole way, returning what each node dispatched into its own SK tree.
 */
async function runChain(delta, { boatHop = {}, cloudHop = {} } = {}) {
  const boat = makeClient("boat", BOAT_TO_PROXY_KEY, 9301, boatHop);
  const proxyServer = makeServer("proxy-in", BOAT_TO_PROXY_KEY, 9301, boatHop);
  const proxyClient = makeClient("proxy-out", PROXY_TO_CLOUD_KEY, 9302, cloudHop);
  const cloud = makeServer("cloud-in", PROXY_TO_CLOUD_KEY, 9302, cloudHop);

  // Hop 1: boat → proxy
  await boat.pipeline.sendDelta([delta], BOAT_TO_PROXY_KEY, "127.0.0.1", 9301);
  expect(boat.wire.length).toBeGreaterThan(0);
  await drain(proxyServer.pipeline, boat.wire, BOAT_TO_PROXY_KEY, BOAT_RINFO);

  const atProxy = dispatched(proxyServer.app);
  expect(atProxy.length).toBeGreaterThan(0);

  // Hop 2: proxy forwards what its own tree received — not the original object.
  for (const forwarded of atProxy) {
    await proxyClient.pipeline.sendDelta([forwarded], PROXY_TO_CLOUD_KEY, "127.0.0.1", 9302);
  }
  expect(proxyClient.wire.length).toBeGreaterThan(0);
  await drain(cloud.pipeline, proxyClient.wire, PROXY_TO_CLOUD_KEY, PROXY_RINFO);

  return { atProxy, atCloud: dispatched(cloud.app) };
}

function valuesOf(delta) {
  return delta.updates.flatMap((u) => u.values);
}

describe("DATA across a Boat → Proxy → Cloud chain", () => {
  // Codecs are negotiated per hop, so the interesting cases are the asymmetric
  // ones: a payload decoded under one encoding and re-encoded under another.
  const variants = [
    { name: "plain on both hops", boatHop: {}, cloudHop: {} },
    {
      name: "path dictionary on both hops",
      boatHop: { usePathDictionary: true },
      cloudHop: { usePathDictionary: true }
    },
    {
      name: "path dictionary inbound, plain outbound",
      boatHop: { usePathDictionary: true },
      cloudHop: {}
    },
    {
      name: "plain inbound, msgpack + dictionary outbound",
      boatHop: {},
      cloudHop: { useMsgpack: true, usePathDictionary: true }
    },
    {
      name: "all codecs on both hops",
      boatHop: {
        useMsgpack: true,
        usePathDictionary: true,
        useCompactDeltas: true,
        useValueDedup: true
      },
      cloudHop: {
        useMsgpack: true,
        usePathDictionary: true,
        useCompactDeltas: true,
        useValueDedup: true
      }
    }
  ];

  for (const variant of variants) {
    test(`payload survives both hops — ${variant.name}`, async () => {
      const { atCloud } = await runChain(sampleDelta(4.2), variant);

      expect(atCloud.length).toBeGreaterThan(0);
      const delta = atCloud[0];
      expect(delta.context).toBe("vessels.self");

      const values = valuesOf(delta);
      const sog = values.find((v) => v.path === "navigation.speedOverGround");
      const pos = values.find((v) => v.path === "navigation.position");

      // The whole point: the numbers that left the boat are the numbers that
      // reach the cloud, after two independent encode/decode cycles.
      expect(sog).toBeDefined();
      expect(sog.value).toBeCloseTo(4.2, 6);
      expect(pos).toBeDefined();
      expect(pos.value.latitude).toBeCloseTo(64.3, 6);
      expect(pos.value.longitude).toBeCloseTo(24.9, 6);
    });
  }

  test("the originating source label survives both hops", async () => {
    const { atCloud } = await runChain(sampleDelta(1.5));

    // Attribution is the reason a proxy chain is useful at all: the cloud must
    // still be able to tell which sensor produced the value, not merely which
    // hop handed it over.
    const sources = atCloud.flatMap((d) => d.updates.map((u) => u.$source || u.source?.label));
    expect(sources.some((s) => typeof s === "string" && s.includes("boat.gps"))).toBe(true);
  });

  test("each hop keys its own crypto — the far key cannot decode the near hop", async () => {
    const boat = makeClient("boat", BOAT_TO_PROXY_KEY, 9301, {});
    const wrongKeyServer = makeServer("proxy-in", PROXY_TO_CLOUD_KEY, 9301, {});

    await boat.pipeline.sendDelta([sampleDelta(3)], BOAT_TO_PROXY_KEY, "127.0.0.1", 9301);
    await drain(wrongKeyServer.pipeline, boat.wire, PROXY_TO_CLOUD_KEY, BOAT_RINFO);

    // A hop that silently accepted the neighbouring hop's key would mean the
    // chain is not actually two independent security domains.
    expect(dispatched(wrongKeyServer.app)).toHaveLength(0);
  });

  // Units and descriptions travel on their own packet type, so DATA arriving
  // intact says nothing about META. A chain that forwards values but loses
  // their metadata renders every gauge on the far end unitless.
  test("metadata survives both hops", async () => {
    const boat = makeClient("boat", BOAT_TO_PROXY_KEY, 9301, {});
    const proxyServer = makeServer("proxy-in", BOAT_TO_PROXY_KEY, 9301, {});
    const proxyClient = makeClient("proxy-out", PROXY_TO_CLOUD_KEY, 9302, {});
    const cloud = makeServer("cloud-in", PROXY_TO_CLOUD_KEY, 9302, {});

    const entries = [
      {
        context: "vessels.self",
        path: "navigation.speedOverGround",
        meta: { units: "m/s", description: "Speed over ground" }
      }
    ];

    await boat.pipeline.sendMetadata(entries, "snapshot", BOAT_TO_PROXY_KEY, "127.0.0.1", 9301);
    await drain(proxyServer.pipeline, boat.wire, BOAT_TO_PROXY_KEY, BOAT_RINFO);

    // Re-derive the onward entries from what the proxy actually received,
    // mirroring how its metadata streamer republishes from the local tree.
    const atProxy = dispatched(proxyServer.app);
    expect(atProxy.length).toBeGreaterThan(0);
    const forwarded = atProxy.flatMap((d) =>
      (d.updates || []).flatMap((u) =>
        (u.meta || []).map((m) => ({ context: d.context, path: m.path, meta: m.value }))
      )
    );
    expect(forwarded.length).toBeGreaterThan(0);

    await proxyClient.pipeline.sendMetadata(
      forwarded,
      "snapshot",
      PROXY_TO_CLOUD_KEY,
      "127.0.0.1",
      9302
    );
    await drain(cloud.pipeline, proxyClient.wire, PROXY_TO_CLOUD_KEY, PROXY_RINFO);

    const atCloud = dispatched(cloud.app);
    expect(atCloud.length).toBeGreaterThan(0);
    const meta = atCloud.flatMap((d) => d.updates.flatMap((u) => u.meta || []));
    expect(meta).toEqual(
      expect.arrayContaining([
        {
          path: "navigation.speedOverGround",
          value: { units: "m/s", description: "Speed over ground" }
        }
      ])
    );
  });

  test("hops keep independent sequence state under sustained flow", async () => {
    const boat = makeClient("boat", BOAT_TO_PROXY_KEY, 9301, {});
    const proxyServer = makeServer("proxy-in", BOAT_TO_PROXY_KEY, 9301, {});
    const proxyClient = makeClient("proxy-out", PROXY_TO_CLOUD_KEY, 9302, {});
    const cloud = makeServer("cloud-in", PROXY_TO_CLOUD_KEY, 9302, {});

    const sent = [];
    for (let i = 0; i < 25; i++) {
      const value = 1 + i * 0.25;
      sent.push(value);
      await boat.pipeline.sendDelta([sampleDelta(value)], BOAT_TO_PROXY_KEY, "127.0.0.1", 9301);
      await drain(proxyServer.pipeline, boat.wire, BOAT_TO_PROXY_KEY, BOAT_RINFO);

      for (const forwarded of dispatched(proxyServer.app)) {
        await proxyClient.pipeline.sendDelta([forwarded], PROXY_TO_CLOUD_KEY, "127.0.0.1", 9302);
      }
      proxyServer.app.handleMessage.mockClear();
      await drain(cloud.pipeline, proxyClient.wire, PROXY_TO_CLOUD_KEY, PROXY_RINFO);
    }

    // Nothing may be dropped as a duplicate or replay because the two hops
    // number their packets independently and each receiver tracks its own.
    const arrived = dispatched(cloud.app)
      .flatMap(valuesOf)
      .filter((v) => v.path === "navigation.speedOverGround")
      .map((v) => v.value);

    expect(arrived).toHaveLength(sent.length);
    for (let i = 0; i < sent.length; i++) {
      expect(arrived[i]).toBeCloseTo(sent[i], 6);
    }
  });
});
