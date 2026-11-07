"use strict";

/**
 * Fleet sharing end-to-end (protocol-v3-spec §15): one hub server pipeline and
 * three real client pipelines, wired in-process. Each client must end with the
 * other two vessels and never its own; the uplink must not echo fleet data;
 * old peers must never receive fleet packets.
 */

const { PacketParser, PacketType } = require("../../lib/packet");
const { processDelta } = require("../../src/app/connection/process-delta");
const {
  secretKey,
  HUB_PORT,
  HUB_ADDR,
  urn,
  wait,
  makeHub,
  makeClient,
  pump,
  pumpUntil,
  sog,
  contextsReceived,
  lastSog,
  typesSentTo,
  deliverToHub
} = require("../helpers/fleet-harness");

describe("fleet sharing end-to-end", () => {
  let hub;
  let clients;

  afterEach(() => {
    hub?.server.stop();
    for (const c of clients || []) {
      c.client.stop();
    }
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
    for (const c of clients) {
      await c.client.sendHello(HUB_ADDR, HUB_PORT);
    }
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
    for (const c of clients) {
      c.client.stop();
    }
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

  test("a scope all join snapshot includes AIS targets but not the hub's own vessel", async () => {
    const at = new Date().toISOString();
    const sogLeaf = (value) => ({
      navigation: { speedOverGround: { value, $source: "gps.1", timestamp: at } }
    });
    hub = makeHub({ enabled: true, scope: "all", batchIntervalMs: 100 });
    hub.bus.app.signalk = {
      retrieve: () => ({
        self: "vessels.urn:mrn:imo:mmsi:999000999",
        vessels: {
          "urn:mrn:imo:mmsi:999000999": sogLeaf(0.5),
          "urn:mrn:imo:mmsi:219999999": sogLeaf(3.3)
        },
        sources: {}
      })
    };
    const a = makeClient("230000001", 40001);
    clients = [a];
    hub.server.startACKTimer();
    await a.client.sendHello(HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(lastSog(a, urn("219999999"))).toBeCloseTo(3.3);
    expect(contextsReceived(a).has(urn("999000999"))).toBe(false);
  });

  test("fleet HELLOs wait until the hub knows its own vessel, so it cannot be claimed", async () => {
    hub = makeHub({ enabled: true, scope: "all", batchIntervalMs: 100 });
    const identity = { mmsi: undefined }; // unknown at first: no mmsi, no uuid, no tree alias
    hub.bus.app.getSelfPath = (path) => (path === "mmsi" ? identity.mmsi : undefined);
    // One client claims the hub's own vessel, another is an ordinary member.
    const impostor = makeClient("999000999", 40001);
    const member = makeClient("230000002", 40002);
    clients = [impostor, member];
    hub.server.startACKTimer();
    for (const c of clients) {
      await c.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.members).toBe(0);
    expect(hub.metricsApi.metrics.fleet.helloDeferred).toBeGreaterThan(0);
    expect(hub.bus.app.error).toHaveBeenCalledWith(
      expect.stringMatching(/own vessel ID is not resolved/)
    );
    expect(member.metricsApi.metrics.fleet.state).not.toBe("active");
    // The hub learns its own vessel; the next HELLOs are answered (the
    // lookup is retried at most every 5 s).
    identity.mmsi = "999000999";
    const realNow = Date.now.bind(Date);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + 6000);
    try {
      for (const c of clients) {
        await c.client.sendHello(HUB_ADDR, HUB_PORT);
      }
      await pump(hub, clients);
    } finally {
      clock.mockRestore();
    }
    expect(member.metricsApi.metrics.fleet.state).toBe("active");
    expect(hub.metricsApi.metrics.fleet.members).toBe(1);
    expect(hub.metricsApi.metrics.fleet.identityRejected).toBe(1);
    hub.bus.app.handleMessage("local", sog(urn("999000999"), 0.5, "gps.1"));
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(member).has(urn("999000999"))).toBe(false);
  });

  test("with includeServerVessel, a claim made before the hub knows its vessel is dropped once it does", async () => {
    hub = makeHub({ enabled: true, includeServerVessel: true, batchIntervalMs: 100 });
    const identity = { mmsi: undefined };
    hub.bus.app.getSelfPath = (path) => (path === "mmsi" ? identity.mmsi : undefined);
    const impostor = makeClient("999000999", 40001);
    const member = makeClient("230000002", 40002);
    clients = [impostor, member];
    hub.server.startACKTimer();
    for (const c of clients) {
      await c.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    // Not deferred: the hub's vessel is shared anyway, so both join.
    expect(hub.metricsApi.metrics.fleet.members).toBe(2);
    identity.mmsi = "999000999";
    const realNow = Date.now.bind(Date);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + 6000);
    try {
      await impostor.client.sendDelta(
        [sog(urn("999000999"), 9.9, "gps.fake")],
        secretKey,
        HUB_ADDR,
        HUB_PORT
      );
      await pump(hub, clients);
      expect(hub.metricsApi.metrics.fleet.members).toBe(1);
      expect(hub.metricsApi.metrics.fleet.identityRejected).toBe(1);
      hub.bus.app.handleMessage("local", sog(urn("999000999"), 0.5, "gps.1"));
      await wait(250);
      await pump(hub, clients);
    } finally {
      clock.mockRestore();
    }
    // The member gets the hub's own vessel from the hub, not the impostor's copy.
    expect(lastSog(member, urn("999000999"))).toBe(0.5);
  });

  test("a claim dropped while a delta fans out does not stop the delta reaching other members", async () => {
    hub = makeHub({ enabled: true, includeServerVessel: true, batchIntervalMs: 100 });
    const identity = { mmsi: undefined };
    hub.bus.app.getSelfPath = (path) => (path === "mmsi" ? identity.mmsi : undefined);
    // The impostor joins first, so the fan-out reaches it first.
    const impostor = makeClient("999000999", 40001);
    const a = makeClient("230000002", 40002);
    const b = makeClient("230000003", 40003);
    clients = [impostor, a, b];
    hub.server.startACKTimer();
    for (const c of clients) {
      await c.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.members).toBe(3);
    identity.mmsi = "999000999";
    const realNow = Date.now.bind(Date);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + 6000);
    try {
      // The ID resolves while A's value is checked against the impostor.
      await a.client.sendDelta([sog(a.self, 7.7)], secretKey, HUB_ADDR, HUB_PORT);
      await pump(hub, clients);
      await wait(250);
      await pump(hub, clients);
    } finally {
      clock.mockRestore();
    }
    expect(hub.metricsApi.metrics.fleet.identityRejected).toBe(1);
    expect(hub.metricsApi.metrics.fleet.members).toBe(2);
    expect(lastSog(b, a.self)).toBe(7.7);
  });

  test("scope all does not share the hub's own vessel unless includeServerVessel is set", async () => {
    await connectAll({ enabled: true, scope: "all", batchIntervalMs: 100 });
    hub.bus.app.handleMessage("local", sog(urn("999000999"), 0.5, "gps.1"));
    hub.bus.app.handleMessage("local", sog(urn("219999999"), 3.3, "ais.1"));
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(clients[1]).has(urn("219999999"))).toBe(true);
    expect(contextsReceived(clients[1]).has(urn("999000999"))).toBe(false);
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
    await wait(2); // the newer claim needs a later HELLO timestamp
    await impostor.client.sendHello(HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.identityConflicts).toBe(1);
    expect(hub.metricsApi.metrics.fleet.members).toBe(3);
    // The newest session now owns the vessel: its data is accepted, the
    // previous owner's is dropped.
    const drops = hub.metricsApi.metrics.fleet.originDrops;
    await clients[0].client.sendDelta([sog(impostor.self, 1.1)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.metricsApi.metrics.fleet.originDrops).toBe(drops + 1);
    await impostor.client.sendDelta([sog(impostor.self, 2.2)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(lastSog(hub, impostor.self)).toBe(2.2);
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

  test("join snapshots stay rate-limited across repeated client restarts", async () => {
    await connectAll();
    const before = hub.metricsApi.metrics.fleet.snapshotsSent;
    const { PacketBuilder } = require("../../lib/packet");
    const { encodeFleetIdentity, newFleetNonce } = require("../../src/codec/fleet-identity");
    const replayedBefore = hub.metricsApi.metrics.fleet.replayedHellos;
    const start = Date.now();
    for (let epoch = 10; epoch < 15; epoch++) {
      // Each restarted process stamps its HELLO later than the last one, so
      // every restart is accepted rather than ignored as a replay (§15.7).
      const buildClock = jest.spyOn(Date, "now").mockReturnValue(start + epoch);
      let hello;
      try {
        hello = new PacketBuilder({ secretKey }).buildHelloPacket({
          clientId: "x",
          epoch: start + epoch * 1000,
          capabilities: ["fleet-v1"],
          fleet: encodeFleetIdentity({ self: clients[0].self, nonce: newFleetNonce() }, secretKey)
        });
      } finally {
        buildClock.mockRestore();
      }
      await hub.server.receivePacket(hello, secretKey, {
        address: "10.0.0.1",
        port: clients[0].port
      });
    }
    expect(hub.metricsApi.metrics.fleet.replayedHellos).toBe(replayedBefore);
    expect(hub.metricsApi.metrics.fleet.snapshotsSent).toBe(before);
  });

  function metaReceived(c, context) {
    return c.bus.received
      .filter((d) => d.context === context)
      .flatMap((d) => d.updates.flatMap((u) => u.meta || []));
  }

  test("metadata travels with a path the first time a vessel receives it", async () => {
    await connectAll();
    const b = clients[1];
    hub.bus.app.signalk = {
      retrieve: () => ({
        vessels: {
          "urn:mrn:imo:mmsi:230000002": {
            navigation: {
              speedOverGround: { value: 1, meta: { units: "m/s", displayName: "SOG" } }
            }
          }
        },
        sources: {}
      })
    };
    await uplinkAndDeliver([[b, 2.0]]);
    await uplinkAndDeliver([[b, 2.1]]);
    const meta = metaReceived(clients[0], b.self);
    expect(meta).toEqual([
      { path: "navigation.speedOverGround", value: { units: "m/s", displayName: "SOG" } }
    ]);
    expect(clients[0].metricsApi.metrics.fleet.metaReceived).toBe(1);
    expect(lastSog(clients[0], b.self)).toBeCloseTo(2.1);
  });

  test("live metadata changes are forwarded to the other members", async () => {
    await connectAll();
    const b = clients[1];
    hub.bus.app.handleMessage("meta", {
      context: b.self,
      updates: [{ meta: [{ path: "environment.depth.belowKeel", value: { units: "m" } }] }]
    });
    await wait(250);
    await pump(hub, clients);
    expect(metaReceived(clients[0], b.self)).toEqual([
      { path: "environment.depth.belowKeel", value: { units: "m" } }
    ]);
    expect(metaReceived(clients[1], b.self)).toEqual([]);
  });

  function streamOf(c) {
    const parser = new PacketParser({ secretKey });
    for (const call of hub.state.socketUdp.send.mock.calls) {
      if (call[1] !== c.port) {
        continue;
      }
      try {
        const parsed = parser.parseHeader(Buffer.from(call[0]));
        if (parsed.type === PacketType.HELLO_ACK) {
          return JSON.parse(parsed.payload.toString()).fleet.stream;
        }
      } catch {
        /* not a HELLO_ACK */
      }
    }
    return null;
  }

  test("a replayed FLEET_DATA is counted as a duplicate and not applied again", async () => {
    await connectAll();
    const a = clients[0];
    const b = clients[1];
    await b.client.sendDelta([sog(b.self, 3.1)], secretKey, HUB_ADDR, HUB_PORT);
    for (const pkt of b.toHub.splice(0)) {
      await hub.server.receivePacket(pkt, secretKey, { address: "10.0.0.1", port: b.port });
    }
    await wait(250);
    const parser = new PacketParser({ secretKey });
    const toA = hub.toClients.filter((x) => {
      try {
        return x.port === a.port && parser.parseHeader(x.pkt).type === PacketType.FLEET_DATA;
      } catch {
        return false;
      }
    });
    expect(toA.length).toBeGreaterThan(0);
    await pump(hub, clients);
    const applied = a.bus.received.length;
    const dupBefore = a.metricsApi.metrics.fleet.duplicatePackets;
    for (const { pkt } of toA) {
      await a.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT });
    }
    expect(a.bus.received.length).toBe(applied);
    expect(a.metricsApi.metrics.fleet.duplicatePackets).toBe(dupBefore + toA.length);
  });

  test("a client accepts at most 200 FLEET_DATA per second", async () => {
    await connectAll();
    const a = clients[0];
    const { PacketBuilder } = require("../../lib/packet");
    const { encodeFleetPayload } = require("../../src/codec/fleet-payload");
    const builder = new PacketBuilder({ secretKey });
    const stream = streamOf(a);
    const packets = [];
    // Sequences well ahead of anything the hub sent, so none is a duplicate.
    for (let seq = 1000; seq < 1261; seq++) {
      const encrypted = await encodeFleetPayload([sog(clients[1].self, seq)], { secretKey });
      packets.push(builder.buildFleetDataPacket(stream, seq, encrypted));
    }
    const before = { ...a.metricsApi.metrics.fleet };
    // All 260 inside one second of the client's clock, whatever the CI speed.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (const pkt of packets.slice(0, 260)) {
        await a.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT });
      }
      const accepted = a.metricsApi.metrics.fleet.packetsReceived - before.packetsReceived;
      const rejected = a.metricsApi.metrics.fleet.rejectedPackets - before.rejectedPackets;
      expect(accepted).toBe(200);
      expect(rejected).toBe(60);
      // The next second accepts again.
      now += 1000;
      await a.client.handleControlPacket(packets[260], { address: HUB_ADDR, port: HUB_PORT });
      expect(a.metricsApi.metrics.fleet.packetsReceived - before.packetsReceived).toBe(201);
    } finally {
      Date.now = realNow;
    }
  });

  test("a server that never answers is reported as 'not-offered' after three HELLOs", async () => {
    const lonely = makeClient("230000077", 40077);
    clients = [lonely];
    hub = makeHub({ enabled: true });
    let tick = null;
    const realSetInterval = global.setInterval;
    global.setInterval = (fn, ms) => {
      tick = fn;
      return realSetInterval(fn, ms);
    };
    try {
      lonely.client.startMetricsPublishing();
    } finally {
      global.setInterval = realSetInterval;
    }
    for (let i = 0; i < 3; i++) {
      await lonely.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    lonely.toHub.length = 0; // the old server drops everything
    expect(lonely.metricsApi.metrics.fleet.state).toBe("offered");
    tick();
    expect(lonely.metricsApi.metrics.fleet.state).toBe("not-offered");
    lonely.client.stopMetricsPublishing();
  });

  test("a replayed HELLO from another address cannot take over a vessel", async () => {
    await connectAll();
    const a = clients[0];
    const parser = new PacketParser({ secretKey });
    const hello = a.state.socketUdp.send.mock.calls
      .map((call) => Buffer.from(call[0]))
      .find((pkt) => {
        try {
          return parser.parseHeader(pkt).type === PacketType.HELLO;
        } catch {
          return false;
        }
      });
    expect(hello).toBeDefined();
    await hub.server.receivePacket(hello, secretKey, { address: "10.6.6.6", port: 50666 });
    const fleet = hub.metricsApi.metrics.fleet;
    expect(fleet.replayedHellos).toBe(1);
    expect(fleet.identityConflicts).toBe(0);
    // A still owns its vessel: its own uplink is accepted.
    hub.bus.received.length = 0;
    await a.client.sendDelta([sog(a.self, 8.8)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.bus.received.some((d) => d.context === a.self)).toBe(true);
    expect(fleet.originDrops).toBe(0);
    // The same HELLO replayed on A's own session is not newer than the one A
    // was accepted with: ignored, and A keeps its vessel.
    await hub.server.receivePacket(hello, secretKey, { address: "10.0.0.1", port: a.port });
    expect(fleet.replayedHellos).toBe(2);
    expect(fleet.members).toBe(3);
    hub.bus.received.length = 0;
    await a.client.sendDelta([sog(a.self, 9.9)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.bus.received.some((d) => d.context === a.self)).toBe(true);
    expect(fleet.originDrops).toBe(0);
  });

  test("an old HELLO replayed after many newer ones cannot take over a vessel", async () => {
    await connectAll();
    const a = clients[0];
    const parser = new PacketParser({ secretKey });
    const hellos = () =>
      a.state.socketUdp.send.mock.calls
        .map((call) => Buffer.from(call[0]))
        .filter((pkt) => {
          try {
            return parser.parseHeader(pkt).type === PacketType.HELLO;
          } catch {
            return false;
          }
        });
    const captured = hellos()[0];
    await wait(2);
    // Many newer HELLOs from the owner must not let the oldest one back in.
    for (let i = 0; i < 40; i++) {
      await a.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    const fleet = hub.metricsApi.metrics.fleet;
    const before = fleet.replayedHellos;
    await hub.server.receivePacket(captured, secretKey, { address: "10.6.6.6", port: 50666 });
    // The newest HELLO, copied exactly, is refused too.
    await hub.server.receivePacket(hellos().at(-1), secretKey, {
      address: "10.6.6.7",
      port: 50667
    });
    expect(fleet.replayedHellos).toBe(before + 2);
    expect(fleet.identityConflicts).toBe(0);
    hub.bus.received.length = 0;
    await a.client.sendDelta([sog(a.self, 9.9)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    expect(hub.bus.received.some((d) => d.context === a.self)).toBe(true);
  });

  test("a fleet HELLO without a timestamp cannot take over a vessel", async () => {
    await connectAll();
    const { PacketBuilder } = require("../../lib/packet");
    const { encodeFleetIdentity, newFleetNonce } = require("../../src/codec/fleet-identity");
    const payload = {
      protocolVersion: 3,
      clientId: "x",
      capabilities: ["fleet-v1"],
      fleet: encodeFleetIdentity({ self: clients[0].self, nonce: newFleetNonce() }, secretKey)
    };
    const hello = new PacketBuilder({ secretKey })._buildPacket(
      PacketType.HELLO,
      Buffer.from(JSON.stringify(payload)),
      {},
      {}
    );
    await hub.server.receivePacket(hello, secretKey, { address: "10.6.6.8", port: 50668 });
    expect(hub.metricsApi.metrics.fleet.replayedHellos).toBe(1);
    expect(hub.metricsApi.metrics.fleet.identityConflicts).toBe(0);
  });

  test("an earlier HELLO from the same millisecond cannot take over a vessel", async () => {
    await connectAll();
    const a = clients[0];
    const parser = new PacketParser({ secretKey });
    const isHello = (pkt) => {
      try {
        return parser.parseHeader(pkt).type === PacketType.HELLO;
      } catch {
        return false;
      }
    };
    a.state.socketUdp.send.mockClear();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5);
    try {
      await a.client.sendHello(HUB_ADDR, HUB_PORT);
      await a.client.sendHello(HUB_ADDR, HUB_PORT);
    } finally {
      nowSpy.mockRestore();
    }
    const sent = a.state.socketUdp.send.mock.calls.map((c) => Buffer.from(c[0])).filter(isHello);
    expect(sent).toHaveLength(2);
    const stamp = (pkt) => JSON.parse(parser.parseHeader(pkt).payload.toString()).timestamp;
    expect(stamp(sent[1])).toBeGreaterThan(stamp(sent[0]));
    await pump(hub, clients);
    const before = hub.metricsApi.metrics.fleet.replayedHellos;
    await hub.server.receivePacket(sent[0], secretKey, { address: "10.6.6.9", port: 50669 });
    expect(hub.metricsApi.metrics.fleet.replayedHellos).toBe(before + 1);
    expect(hub.metricsApi.metrics.fleet.identityConflicts).toBe(0);
  });

  test("a batch too large for one datagram is split and every value arrives", async () => {
    await connectAll();
    const [a, b] = clients;
    const crypto = require("crypto");
    const values = Array.from({ length: 40 }, (_, i) => ({
      path: `environment.test.v${i}`,
      value: crypto.randomBytes(48).toString("hex")
    }));
    hub.state.socketUdp.send.mockClear();
    await b.client.sendDelta(
      [
        {
          context: b.self,
          updates: [{ $source: "n2k.115", timestamp: new Date().toISOString(), values }]
        }
      ],
      secretKey,
      HUB_ADDR,
      HUB_PORT
    );
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    const fleetToA = hub.state.socketUdp.send.mock.calls
      .filter((call) => call[1] === a.port)
      .map((call) => Buffer.from(call[0]))
      .filter((pkt) => pkt[3] === PacketType.FLEET_DATA);
    expect(fleetToA.length).toBeGreaterThan(1);
    for (const pkt of fleetToA) {
      expect(pkt.length).toBeLessThanOrEqual(1400);
    }
    const got = new Map(
      a.bus.received
        .filter((d) => d.context === b.self)
        .flatMap((d) => d.updates.flatMap((u) => u.values || []))
        .map((v) => [v.path, v.value])
    );
    for (const v of values) {
      expect(got.get(v.path)).toBe(v.value);
    }
  });

  test("a value too large for any UDP datagram is dropped, not queued", async () => {
    await connectAll();
    const [a, b] = clients;
    const crypto = require("crypto");
    const { RetransmitQueue } = require("../../src/transport/reliability/retransmit-queue");
    const queued = jest.spyOn(RetransmitQueue.prototype, "add");
    hub.state.socketUdp.send.mockClear();
    const before = hub.metricsApi.metrics.fleet.packetsAbandoned;
    hub.bus.app.handleMessage("test", {
      context: b.self,
      updates: [
        {
          $source: "n2k.115",
          timestamp: new Date().toISOString(),
          values: [
            { path: "environment.test.huge", value: crypto.randomBytes(70000).toString("hex") },
            { path: "navigation.speedOverGround", value: 3.3 }
          ]
        }
      ]
    });
    await wait(250);
    await pump(hub, clients);
    const queuedSizes = queued.mock.calls.map((call) => call[1].length);
    queued.mockRestore();
    const sizes = hub.state.socketUdp.send.mock.calls
      .filter((call) => call[1] === a.port && Buffer.from(call[0])[3] === PacketType.FLEET_DATA)
      .map((call) => call[0].length);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(65507);
    expect(hub.metricsApi.metrics.fleet.packetsAbandoned).toBeGreaterThan(before);
    expect(lastSog(a, b.self)).toBeCloseTo(3.3);
    // The oversized packet never entered any retransmit queue.
    expect(queuedSizes.length).toBeGreaterThan(0);
    expect(Math.max(...queuedSizes)).toBeLessThanOrEqual(65507);
  });

  test("a batch split into several packets stays within the byte budget and loses nothing", async () => {
    const rate = 2048;
    await connectAll({ enabled: true, maxBytesPerSec: rate, batchIntervalMs: 100 });
    const [a, b] = clients;
    const crypto = require("crypto");
    const values = Array.from({ length: 40 }, (_, i) => ({
      path: `environment.test.w${i}`,
      value: crypto.randomBytes(128).toString("hex")
    }));
    const sends = [];
    const send = hub.state.socketUdp.send;
    const normal = send.getMockImplementation();
    send.mockImplementation((pkt, port, address, cb) => {
      if (port === a.port && pkt[3] === PacketType.FLEET_DATA) {
        sends.push({ at: Date.now(), bytes: pkt.length });
      }
      normal(pkt, port, address, cb);
    });
    // The bucket holds at most one full bucket at this moment, whenever it
    // last refilled, so the bound below is measured from here.
    const start = Date.now();
    await b.client.sendDelta(
      [
        {
          context: b.self,
          updates: [{ $source: "n2k.115", timestamp: new Date().toISOString(), values }]
        }
      ],
      secretKey,
      HUB_ADDR,
      HUB_PORT
    );
    const got = () =>
      new Set(
        a.bus.received
          .filter((d) => d.context === b.self)
          .flatMap((d) => d.updates.flatMap((u) => u.values || []))
          .map((v) => v.path)
      );
    for (let i = 0; i < 80 && values.some((v) => !got().has(v.path)); i++) {
      await pump(hub, clients);
      await wait(100);
    }
    const total = sends.reduce((sum, s) => sum + s.bytes, 0);
    // More than one bucket of data, so it had to be paced.
    expect(total).toBeGreaterThan(rate);
    // Token-bucket bound: by each send, at most one full bucket plus what
    // has refilled since the start.
    let sent = 0;
    for (const s of sends) {
      sent += s.bytes;
      expect(sent).toBeLessThanOrEqual(rate + (rate * (s.at - start)) / 1000 + 1);
    }
    for (const v of values) {
      expect(got().has(v.path)).toBe(true);
    }
  }, 15000);

  test("a failed send of the first half still queues the second half for recovery", async () => {
    await connectAll();
    const [a, b] = clients;
    const crypto = require("crypto");
    const values = Array.from({ length: 40 }, (_, i) => ({
      path: `environment.test.v${i}`,
      value: crypto.randomBytes(48).toString("hex")
    }));
    const send = hub.state.socketUdp.send;
    const normal = send.getMockImplementation();
    let failed = false;
    send.mockImplementation((pkt, port, address, cb) => {
      if (!failed && port === a.port && pkt[3] === PacketType.FLEET_DATA) {
        failed = true;
        cb(new Error("EHOSTUNREACH"));
        return;
      }
      normal(pkt, port, address, cb);
    });
    await b.client.sendDelta(
      [
        {
          context: b.self,
          updates: [{ $source: "n2k.115", timestamp: new Date().toISOString(), values }]
        }
      ],
      secretKey,
      HUB_ADDR,
      HUB_PORT
    );
    // Pump often: the client gives up on a gap after maxNakRounds x nakTimeout.
    for (let i = 0; i < 30; i++) {
      await pump(hub, clients);
      await wait(10);
    }
    expect(failed).toBe(true);
    const got = new Map(
      a.bus.received
        .filter((d) => d.context === b.self)
        .flatMap((d) => d.updates.flatMap((u) => u.values || []))
        .map((v) => [v.path, v.value])
    );
    for (const v of values) {
      expect(got.get(v.path)).toBe(v.value);
    }
  });

  test("a join snapshot held back by the rate limit is sent once the limit passes", async () => {
    await connectAll();
    const before = hub.metricsApi.metrics.fleet.snapshotsSent;
    const { PacketBuilder } = require("../../lib/packet");
    const { encodeFleetIdentity, newFleetNonce } = require("../../src/codec/fleet-identity");
    // A client restart (higher epoch) inside the limit: new stream, no snapshot yet.
    // The restarted process stamps its HELLO later than the old one did; on a
    // fast runtime a fresh builder could otherwise land in the same
    // millisecond and be ignored as a replay (§15.7).
    const replayedBefore = hub.metricsApi.metrics.fleet.replayedHellos;
    const builtAt = Date.now() + 1000;
    const buildClock = jest.spyOn(Date, "now").mockReturnValue(builtAt);
    let hello;
    try {
      hello = new PacketBuilder({ secretKey }).buildHelloPacket({
        clientId: "x",
        epoch: builtAt + 60000,
        capabilities: ["fleet-v1"],
        fleet: encodeFleetIdentity({ self: clients[0].self, nonce: newFleetNonce() }, secretKey)
      });
    } finally {
      buildClock.mockRestore();
    }
    await hub.server.receivePacket(hello, secretKey, {
      address: "10.0.0.1",
      port: clients[0].port
    });
    expect(hub.metricsApi.metrics.fleet.replayedHellos).toBe(replayedBefore);
    expect(hub.metricsApi.metrics.fleet.snapshotsSent).toBe(before);
    const realNow = Date.now.bind(Date);
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow() + 11000);
    try {
      await wait(300);
    } finally {
      nowSpy.mockRestore();
    }
    expect(hub.metricsApi.metrics.fleet.snapshotsSent).toBe(before + 1);
  });

  test("a delta the local server refuses does not drop the rest of the packet", async () => {
    await connectAll();
    const a = clients[0];
    const original = a.bus.app.handleMessage;
    a.bus.app.handleMessage = jest.fn((id, delta) => {
      if (delta.context === clients[1].self) {
        throw new Error("refused");
      }
      return original(id, delta);
    });
    await clients[1].client.sendDelta([sog(clients[1].self, 1)], secretKey, HUB_ADDR, HUB_PORT);
    await clients[2].client.sendDelta([sog(clients[2].self, 2)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(a).has(clients[2].self)).toBe(true);
    expect(a.metricsApi.metrics.fleet.rejectedPackets).toBeGreaterThan(0);
    expect(a.metricsApi.metrics.fleet.acksSent).toBeGreaterThan(0);
  });

  test("a client whose own vessel is unknown reports 'offered'", async () => {
    const anon = makeClient("", 40088);
    clients = [anon];
    hub = makeHub({ enabled: true });
    await anon.client.sendHello(HUB_ADDR, HUB_PORT);
    expect(anon.metricsApi.metrics.fleet.state).toBe("offered");
  });

  test("FLEET_DATA still decoding when the client stops is not applied", async () => {
    await connectAll();
    const a = clients[0];
    await clients[1].client.sendDelta([sog(clients[1].self, 3)], secretKey, HUB_ADDR, HUB_PORT);
    for (const pkt of clients[1].toHub.splice(0)) {
      await hub.server.receivePacket(pkt, secretKey, {
        address: "10.0.0.1",
        port: clients[1].port
      });
    }
    await wait(250);
    const toA = hub.toClients.filter((x) => x.port === a.port).map((x) => x.pkt);
    expect(toA.length).toBeGreaterThan(0);
    const before = a.bus.received.length;
    const pending = toA.map((pkt) =>
      a.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT })
    );
    a.client.stop();
    await Promise.all(pending);
    expect(a.bus.received.length).toBe(before);
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
  test("scope all never sends a member the contexts it relays itself", async () => {
    await connectAll({ enabled: true, scope: "all", batchIntervalMs: 100 });
    const [a, b] = clients;
    // An AIS target only A's receiver sees.
    const ais = urn("219999999");
    await a.client.sendDelta([sog(ais, 4.4, "ais.a")], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(contextsReceived(b).has(ais)).toBe(true);
    // Getting it back would make A's loop guard drop its own AIS uplink.
    expect(contextsReceived(a).has(ais)).toBe(false);
    expect(a.state.fleetLearnedContexts.has(ais)).toBe(false);
  });

  test.each(["fleet", "all"])(
    "scope %s: a vessel another member uplinked before it joined still reaches that member",
    async (scope) => {
      hub = makeHub({ enabled: true, batchIntervalMs: 50, scope });
      const a = makeClient("230000001", 40001);
      const b = makeClient("230000002", 40002);
      clients = [a, b];
      hub.server.startACKTimer();
      await b.client.sendHello(HUB_ADDR, HUB_PORT);
      await pump(hub, [b]);
      // B's AIS receiver reports A while A is not yet a member.
      await b.client.sendDelta([sog(a.self, 1.1, "ais.1")], secretKey, HUB_ADDR, HUB_PORT);
      await deliverToHub(hub, b);
      await a.client.sendHello(HUB_ADDR, HUB_PORT);
      await pump(hub, clients);
      await a.client.sendDelta([sog(a.self, 5.5)], secretKey, HUB_ADDR, HUB_PORT);
      await pumpUntil(hub, clients, () => lastSog(b, a.self) === 5.5);
      // A is a member now: its own data goes to B, whatever B uplinked before.
      expect(lastSog(b, a.self)).toBe(5.5);
    }
  );

  test("scope all never sends a member the contexts it relays as metadata first", async () => {
    await connectAll({ enabled: true, scope: "all", batchIntervalMs: 100 });
    const [a, b] = clients;
    const ais = urn("219999999");
    // A's relay reports the target's metadata before any of its values.
    await a.client.sendMetadata(
      [{ context: ais, path: "navigation.speedOverGround", meta: { units: "m/s" } }],
      "snapshot",
      secretKey,
      HUB_ADDR,
      HUB_PORT
    );
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(metaReceived(b, ais)).toEqual([
      { path: "navigation.speedOverGround", value: { units: "m/s" } }
    ]);
    expect(contextsReceived(a).has(ais)).toBe(false);
    expect(a.state.fleetLearnedContexts.has(ais)).toBe(false);
  });

  test("METADATA for another member's vessel is refused like its DATA", async () => {
    await connectAll();
    const [a, b, c] = clients;
    hub.bus.received.length = 0;
    const drops = hub.metricsApi.metrics.fleet.originDrops;
    await a.client.sendMetadata(
      [
        {
          context: b.self,
          path: "navigation.speedOverGround",
          meta: { units: "m/s", displayName: "STALE-from-A" }
        }
      ],
      "snapshot",
      secretKey,
      HUB_ADDR,
      HUB_PORT
    );
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(hub.bus.received.some((d) => d.context === b.self)).toBe(false);
    expect(hub.metricsApi.metrics.fleet.originDrops).toBe(drops + 1);
    const seenByC = c.bus.received
      .filter((d) => d.context === b.self)
      .flatMap((d) => d.updates.flatMap((u) => u.meta || []));
    expect(seenByC.some((m) => m.value?.displayName === "STALE-from-A")).toBe(false);
  });
});

describe("fleet session state", () => {
  test("retransmissions stay within the session's byte budget", async () => {
    const { createSessionState } = require("../../src/transport/pipeline/reliable-server/fleet");
    const { retransmit } = require("../../src/transport/pipeline/reliable-server/fleet-recovery");
    const sent = [];
    const ctx = {
      fleet: { config: { maxBytesPerSec: 256 } },
      metrics: { bandwidth: { bytesOut: 0, packetsOut: 0 } },
      state: {
        socketUdp: {
          send: (pkt, _port, _addr, cb) => {
            sent.push(pkt);
            cb(null);
          }
        }
      }
    };
    const fleetSession = createSessionState(ctx, {
      self: urn("230000001"),
      nonce: "0123456789abcdef"
    });
    const session = { key: "10.0.0.1:1", address: "10.0.0.1", port: 1, fleet: fleetSession };
    for (let seq = 0; seq < 10; seq++) {
      fleetSession.retransmitQueue.add(seq, Buffer.alloc(1000));
    }
    await retransmit(ctx, session, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // A full 1400-byte bucket at 256 B/s covers one 1000-byte packet; the
    // second would overspend it, so it waits.
    expect(sent.length).toBe(1);
    expect(fleetSession.tokens).toBeGreaterThanOrEqual(0);
    // The rest keep their place and go out once the budget refills.
    expect(fleetSession.retransmitQueue.get(9)).toBeDefined();
  });

  test("values put back after a deferred send never replace newer ones", () => {
    const {
      createSessionState,
      requeuePending
    } = require("../../src/transport/pipeline/reliable-server/fleet");
    const { pendingKey } = require("../../src/transport/pipeline/reliable-server/fleet-meta");
    const ctx = { fleet: { config: { maxBytesPerSec: 8192 } }, metrics: {} };
    const session = createSessionState(ctx, { self: urn("230000001"), nonce: "0123456789abcdef" });
    const value = (path, v) => ({
      kind: "value",
      context: "vessels.x",
      $source: "n2k.1",
      source: undefined,
      timestamp: undefined,
      path,
      value: v
    });
    session.pending.set(pendingKey("value", "vessels.x", "n2k.1", "a"), value("a", 2));
    requeuePending(session, [value("a", 1), value("b", 1)]);
    expect(session.pending.get(pendingKey("value", "vessels.x", "n2k.1", "a")).value).toBe(2);
    expect(session.pending.get(pendingKey("value", "vessels.x", "n2k.1", "b")).value).toBe(1);
  });

  test("a tree lookup that throws leaves metadata to be sent with a later packet", () => {
    const { createSessionState } = require("../../src/transport/pipeline/reliable-server/fleet");
    const {
      withFirstSightMeta
    } = require("../../src/transport/pipeline/reliable-server/fleet-meta");
    let fail = true;
    const tree = {
      vessels: { x: { navigation: { speedOverGround: { value: 3, meta: { units: "m/s" } } } } }
    };
    const ctx = {
      fleet: { config: { maxBytesPerSec: 8192 } },
      metrics: {},
      app: {
        signalk: {
          retrieve: () => {
            if (fail) {
              throw new Error("tree unavailable");
            }
            return tree;
          }
        }
      }
    };
    const session = createSessionState(ctx, { self: urn("230000001"), nonce: "0123456789abcdef" });
    const values = [
      {
        kind: "value",
        context: "vessels.x",
        $source: "n2k.1",
        source: undefined,
        timestamp: undefined,
        path: "navigation.speedOverGround",
        value: 3
      }
    ];
    const first = withFirstSightMeta(ctx, session, values);
    expect(first.values).toHaveLength(1);
    expect(first.added).toEqual([]);
    fail = false;
    const second = withFirstSightMeta(ctx, session, values);
    expect(second.values).toHaveLength(2);
    expect(second.values[1]).toMatchObject({ kind: "meta", value: { units: "m/s" } });
  });

  test("a dropped FLEET_DATA makes the next values carry metadata again", () => {
    const { createSessionState } = require("../../src/transport/pipeline/reliable-server/fleet");
    const { FLEET_RETRANSMIT_QUEUE_SIZE } = require("../../src/foundation/constants");
    const ctx = { fleet: { config: { maxBytesPerSec: 8192 } }, metrics: {} };
    const session = createSessionState(ctx, { self: urn("230000001"), nonce: "0123456789abcdef" });
    session.metaSent.add("vessels.x\0navigation.speedOverGround");
    // Filling the queue evicts the oldest unacknowledged packet.
    for (let seq = 0; seq <= FLEET_RETRANSMIT_QUEUE_SIZE; seq++) {
      session.retransmitQueue.add(seq, Buffer.alloc(1));
    }
    expect(ctx.metrics.fleet.packetsAbandoned).toBe(1);
    expect(session.metaSent.size).toBe(0);
  });
});
