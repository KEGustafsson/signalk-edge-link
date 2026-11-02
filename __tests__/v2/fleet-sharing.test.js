"use strict";

/**
 * Fleet sharing end-to-end (protocol-v3-spec §15): one hub server pipeline and
 * three real client pipelines, wired in-process. Each client must end with the
 * other two vessels and never its own; the uplink must not echo fleet data;
 * old peers must never receive fleet packets.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketParser, PacketType } = require("../../lib/packet");
const { processDelta } = require("../../src/app/connection/process-delta");

const secretKey = "12345678901234567890123456789012";
const HUB_PORT = 9300;
const HUB_ADDR = "127.0.0.1";

const urn = (mmsi) => `vessels.urn:mrn:imo:mmsi:${mmsi}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    errorCounts: {},
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

/** A minimal Signal K bus: handleMessage feeds every subscriber synchronously. */
function makeBusApp(mmsi) {
  const subscribers = [];
  const received = [];
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    getSelfPath: (path) => (path === "mmsi" ? mmsi : undefined),
    handleMessage: jest.fn((_id, delta) => {
      received.push(delta);
      for (const fn of subscribers) {fn(delta);}
    }),
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes, _onError, onDelta) => {
        subscribers.push(onDelta);
        unsubscribes.push(() => {
          const i = subscribers.indexOf(onDelta);
          if (i >= 0) {subscribers.splice(i, 1);}
        });
      }
    }
  };
  return { app, received, subscribers };
}

function makeHub(fleetSharing, extraOptions = {}) {
  const bus = makeBusApp("999000999");
  const toClients = [];
  const state = {
    instanceId: "hub",
    options: {
      secretKey,
      udpPort: HUB_PORT,
      protocolVersion: 3,
      reliability: { nakTimeout: 20 },
      fleetSharing,
      ...extraOptions
    },
    socketUdp: {
      send: jest.fn((pkt, port, address, cb) => {
        toClients.push({ pkt: Buffer.from(pkt), port, address });
        if (cb) {cb(null);}
      })
    }
  };
  const metricsApi = makeMetricsApi();
  const server = createPipelineV2Server(bus.app, state, metricsApi);
  return { server, state, bus, toClients, metricsApi };
}

function makeClient(mmsi, port, fleetSharing = { enabled: true }, extraOptions = {}) {
  const bus = makeBusApp(mmsi);
  const toHub = [];
  const state = {
    instanceId: `client-${port}`,
    options: {
      secretKey,
      udpPort: HUB_PORT,
      udpAddress: HUB_ADDR,
      protocolVersion: 3,
      reliability: { nakTimeout: 20 },
      fleetSharing,
      ...extraOptions
    },
    socketUdp: {
      send: jest.fn((pkt, _port, _addr, cb) => {
        toHub.push(Buffer.from(pkt));
        if (cb) {cb(null);}
      })
    },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const metricsApi = makeMetricsApi();
  const client = createPipelineV2Client(bus.app, state, metricsApi);
  return { mmsi, self: urn(mmsi), port, client, state, bus, toHub, metricsApi };
}

/** Move every queued datagram until both directions are quiet. */
async function pump(hub, clients, rounds = 6) {
  for (let r = 0; r < rounds; r++) {
    let moved = 0;
    for (const c of clients) {
      const batch = c.toHub.splice(0);
      moved += batch.length;
      for (const pkt of batch) {
        await hub.server.receivePacket(pkt, secretKey, { address: "10.0.0.1", port: c.port });
      }
    }
    const out = hub.toClients.splice(0);
    moved += out.length;
    for (const { pkt, port } of out) {
      const c = clients.find((x) => x.port === port);
      if (c) {await c.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT });}
    }
    if (moved === 0) {return;}
  }
}

function sog(context, value, source = "n2k.115") {
  return {
    context,
    updates: [
      {
        $source: source,
        timestamp: new Date().toISOString(),
        values: [{ path: "navigation.speedOverGround", value }]
      }
    ]
  };
}

function contextsReceived(c) {
  return new Set(c.bus.received.map((d) => d.context));
}

function lastSog(c, context) {
  const values = c.bus.received
    .filter((d) => d.context === context)
    .flatMap((d) => d.updates.flatMap((u) => u.values))
    .filter((v) => v.path === "navigation.speedOverGround");
  return values.length ? values[values.length - 1].value : undefined;
}

const typesSentTo = (hub, port) => {
  const parser = new PacketParser({ secretKey });
  return hub.state.socketUdp.send.mock.calls
    .filter((call) => call[1] === port)
    .map((call) => {
      try {
        return parser.parseHeader(Buffer.from(call[0]), { epoch: 0 }).type;
      } catch {
        return -1;
      }
    });
};

describe("fleet sharing end-to-end", () => {
  let hub;
  let clients;

  afterEach(() => {
    hub?.server.stop();
    for (const c of clients || []) {c.client.stop();}
  });

  async function connectAll(
    fleetConfig = { enabled: true, batchIntervalMs: 100 },
    clientCfgs = []
  ) {
    hub = makeHub(fleetConfig);
    clients = [
      makeClient("230000001", 40001, clientCfgs[0]),
      makeClient("230000002", 40002, clientCfgs[1]),
      makeClient("230000003", 40003, clientCfgs[2])
    ];
    hub.server.startACKTimer();
    for (const c of clients) {await c.client.sendHello(HUB_ADDR, HUB_PORT);}
    await pump(hub, clients);
  }

  async function uplinkAndDeliver(values) {
    for (const [c, value] of values) {
      await c.client.sendDelta([sog(c.self, value)], secretKey, HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
  }

  test("each vessel receives the other two and never itself", async () => {
    await connectAll();
    for (const c of clients) {
      expect(c.metricsApi.metrics.fleet.state).toBe("active");
    }
    expect(hub.metricsApi.metrics.fleet.members).toBe(3);

    await uplinkAndDeliver([
      [clients[0], 1.1],
      [clients[1], 2.2],
      [clients[2], 3.3]
    ]);

    for (const c of clients) {
      const others = clients.filter((o) => o !== c);
      const seen = contextsReceived(c);
      expect(seen.has(c.self)).toBe(false);
      for (const o of others) {
        expect(seen.has(o.self)).toBe(true);
      }
      expect(c.state.fleetLearnedContexts.has(c.self)).toBe(false);
      expect(c.state.fleetLearnedContexts.size).toBe(2);
    }
    expect(lastSog(clients[0], clients[1].self)).toBeCloseTo(2.2);
    expect(lastSog(clients[2], clients[0].self)).toBeCloseTo(1.1);
  });

  test("the vessel identity never appears in plaintext on the wire", async () => {
    await connectAll();
    for (const c of clients) {
      for (const call of c.state.socketUdp.send.mock.calls) {
        expect(Buffer.from(call[0]).toString("latin1")).not.toContain(c.mmsi);
      }
    }
  });

  test("scope 'fleet' excludes AIS targets; scope 'all' includes them", async () => {
    await connectAll();
    const ais = urn("219999999");
    hub.bus.app.handleMessage("ais", sog(ais, 7.7, "ais.1"));
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(clients[0]).has(ais)).toBe(false);

    hub.server.stop();
    for (const c of clients) {c.client.stop();}
    await connectAll({ enabled: true, scope: "all", batchIntervalMs: 100 });
    hub.bus.app.handleMessage("ais", sog(ais, 7.7, "ais.1"));
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(clients[0]).has(ais)).toBe(true);
    expect(contextsReceived(clients[0]).has(clients[0].self)).toBe(false);
  });

  test("includeServerVessel shares the hub's own vessel", async () => {
    await connectAll({ enabled: true, includeServerVessel: true, batchIntervalMs: 100 });
    hub.bus.app.handleMessage("local", sog(urn("999000999"), 0.5, "gps.1"));
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(clients[1]).has(urn("999000999"))).toBe(true);
  });

  test("the client uplink drops contexts learned from the fleet (no echo)", async () => {
    await connectAll();
    await uplinkAndDeliver([[clients[1], 2.2]]);
    const a = clients[0];
    expect(a.state.fleetLearnedContexts.has(clients[1].self)).toBe(true);

    // Feed B's delta (as A's local bus would re-emit it) through A's real
    // uplink entry point.
    const ctx = {
      state: { ...a.state, readyToSend: true, subscribing: false, deltas: [] },
      metrics: a.metricsApi.metrics,
      options: a.state.options,
      appProxy: a.bus.app,
      app: a.bus.app,
      instanceId: a.state.instanceId,
      services: { enqueueMetaDiff: jest.fn(), flushDeltaBatch: jest.fn(() => Promise.resolve()) },
      recordError: jest.fn()
    };
    const before = a.metricsApi.metrics.fleet.loopDrops;
    processDelta(ctx, sog(clients[1].self, 9.9));
    expect(a.metricsApi.metrics.fleet.loopDrops).toBe(before + 1);
    expect(ctx.state.deltas).toHaveLength(0);
  });

  test("origin authority: another member's vessel is accepted only from its owner", async () => {
    await connectAll();
    const a = clients[0];
    const b = clients[1];
    hub.bus.received.length = 0;
    // A relays a copy of B (e.g. from AIS) over its own uplink.
    await a.client.sendDelta([sog(b.self, 5.5, "ais.relay")], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.bus.received.some((d) => d.context === b.self)).toBe(false);
    expect(hub.metricsApi.metrics.fleet.originDrops).toBeGreaterThan(0);
  });

  test("a duplicate vessel claim moves ownership to the newest session", async () => {
    await connectAll();
    const impostor = makeClient("230000001", 40009);
    clients.push(impostor);
    await impostor.client.sendHello(HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.identityConflicts).toBe(1);
    expect(hub.metricsApi.metrics.fleet.members).toBe(3);
  });

  test("a client without fleet sharing never receives fleet packet types", async () => {
    await connectAll(undefined, [{ enabled: false }, undefined, undefined]);
    expect(clients[0].metricsApi.metrics.fleet?.state ?? "disabled").toBe("disabled");
    await uplinkAndDeliver([
      [clients[1], 2.2],
      [clients[2], 3.3]
    ]);
    const types = typesSentTo(hub, clients[0].port);
    for (const t of [PacketType.HELLO_ACK, PacketType.FLEET_DATA]) {
      expect(types).not.toContain(t);
    }
    expect(contextsReceived(clients[0]).size).toBe(0);
  });

  test("a server with fleet sharing off answers 'declined' and sends no data", async () => {
    await connectAll({ enabled: false });
    for (const c of clients) {
      expect(c.metricsApi.metrics.fleet.state).toBe("declined");
    }
    await uplinkAndDeliver([[clients[1], 2.2]]);
    expect(typesSentTo(hub, clients[0].port)).not.toContain(PacketType.FLEET_DATA);
  });

  test("lost FLEET_DATA is recovered by NAK and retransmit; older values never win", async () => {
    await connectAll();
    const a = clients[0];
    const b = clients[1];
    const lost = sog(b.self, 4.4);
    lost.updates[0].values.push({ path: "navigation.headingTrue", value: 1.25 });
    await b.client.sendDelta([lost], secretKey, HUB_ADDR, HUB_PORT);
    for (const pkt of b.toHub.splice(0)) {
      await hub.server.receivePacket(pkt, secretKey, { address: "10.0.0.1", port: b.port });
    }
    await wait(250);
    // Drop every datagram the hub sent to A in this round.
    const kept = hub.toClients.splice(0).filter((x) => x.port !== a.port);
    hub.toClients.push(...kept);
    await wait(5);
    await b.client.sendDelta([sog(b.self, 4.5)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    await wait(100);
    await pump(hub, clients);

    const values = a.bus.received
      .filter((d) => d.context === b.self)
      .flatMap((d) => d.updates.flatMap((u) => u.values));
    // The path only the lost packet carried arrived by retransmission...
    expect(values.find((v) => v.path === "navigation.headingTrue")?.value).toBeCloseTo(1.25);
    // ...and its older speed did not overwrite the newer one.
    expect(lastSog(a, b.self)).toBeCloseTo(4.5);
    expect(a.metricsApi.metrics.fleet.staleValues).toBeGreaterThan(0);
    expect(a.metricsApi.metrics.fleet.naksSent).toBeGreaterThan(0);
    expect(hub.metricsApi.metrics.fleet.retransmits).toBeGreaterThan(0);
  });

  test("tampered FLEET_DATA is rejected", async () => {
    await connectAll();
    const a = clients[0];
    await clients[1].client.sendDelta([sog(clients[1].self, 2.2)], secretKey, HUB_ADDR, HUB_PORT);
    for (const pkt of clients[1].toHub.splice(0)) {
      await hub.server.receivePacket(pkt, secretKey, {
        address: "10.0.0.1",
        port: clients[1].port
      });
    }
    await wait(250);
    const parser = new PacketParser({ secretKey });
    const fleetPackets = hub.toClients.filter((x) => {
      try {
        return x.port === a.port && parser.parseHeader(x.pkt).type === PacketType.FLEET_DATA;
      } catch {
        return false;
      }
    });
    expect(fleetPackets.length).toBeGreaterThan(0);
    const tampered = Buffer.from(fleetPackets[0].pkt);
    tampered[25] ^= 0xff;
    const before = a.bus.received.length;
    await a.client.handleControlPacket(tampered, { address: HUB_ADDR, port: HUB_PORT });
    expect(a.bus.received.length).toBe(before);
    expect(a.metricsApi.metrics.malformedPackets).toBeGreaterThan(0);
  });

  test("a client requested pathFilter limits what it receives", async () => {
    await connectAll(undefined, [
      { enabled: true, pathFilter: { allow: ["environment.*"], deny: [] } },
      undefined,
      undefined
    ]);
    await uplinkAndDeliver([[clients[1], 2.2]]);
    expect(contextsReceived(clients[0]).has(clients[1].self)).toBe(false);
    expect(contextsReceived(clients[2]).has(clients[1].self)).toBe(true);
  });

  test("the per-session byte budget defers values and keeps only the newest", async () => {
    await connectAll({ enabled: true, maxBytesPerSec: 256, batchIntervalMs: 100 });
    const b = clients[1];
    const many = {
      context: b.self,
      updates: [
        {
          $source: "n2k.115",
          timestamp: new Date().toISOString(),
          values: Array.from({ length: 200 }, (_, i) => ({
            path: `environment.test.p${i}`,
            value: Math.random()
          }))
        }
      ]
    };
    await b.client.sendDelta([many], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(350);
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.rateLimitedFlushes).toBeGreaterThan(0);
    const delivered = clients[0].bus.received
      .filter((d) => d.context === b.self)
      .flatMap((d) => d.updates.flatMap((u) => u.values)).length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(200);
  });

  test("a late-joining vessel gets a snapshot of the fleet", async () => {
    hub = makeHub({ enabled: true, batchIntervalMs: 100 });
    const b = makeClient("230000002", 40002);
    clients = [b];
    hub.server.startACKTimer();
    await b.client.sendHello(HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await b.client.sendDelta([sog(b.self, 6.6)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    // The hub tree: give the snapshot something to read.
    hub.bus.app.signalk = {
      retrieve: () => ({
        vessels: {
          "urn:mrn:imo:mmsi:230000002": {
            navigation: {
              speedOverGround: {
                value: 6.6,
                $source: "n2k.115",
                timestamp: new Date().toISOString()
              }
            }
          }
        },
        sources: {}
      })
    };
    const late = makeClient("230000001", 40001);
    clients.push(late);
    await late.client.sendHello(HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(lastSog(late, b.self)).toBeCloseTo(6.6);
    expect(hub.metricsApi.metrics.fleet.snapshotsSent).toBeGreaterThan(0);
  });
});
