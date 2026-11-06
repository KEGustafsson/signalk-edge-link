"use strict";

/**
 * Fleet sharing hardening (protocol-v3-spec §15): regression tests for the
 * server fleet sender and client receiver, driven through one server context
 * with a mocked clock so rate and ordering checks do not depend on CI speed.
 */

const { createServerContext } = require("../../src/transport/pipeline/reliable-server/context");
const { getOrCreateSession } = require("../../src/transport/pipeline/reliable-server/sessions");
const {
  createSessionState,
  onFleetDelta,
  requeuePending
} = require("../../src/transport/pipeline/reliable-server/fleet");
const { fleetTick } = require("../../src/transport/pipeline/reliable-server/fleet-sender");
const {
  handleFleetAck,
  handleFleetNak
} = require("../../src/transport/pipeline/reliable-server/fleet-recovery");
const { handleFleetHello } = require("../../src/transport/pipeline/reliable-server/fleet-hello");
const { encodeFleetIdentity } = require("../../src/codec/fleet-identity");
const { FLEET_CAPABILITY, FLEET_MAX_RETRANSMITS } = require("../../src/foundation/constants");
const { PacketParser, PacketType } = require("../../src/codec/packet-codec");
const { decodeFleetPayload } = require("../../src/codec/fleet-payload");
const { makeMetricsApi } = require("../helpers/metrics-fixture");

const secretKey = "12345678901234567890123456789012";

/** A server context with one accepted fleet session and a captured socket. */
function makeServer(fleetSharing, { confirmed = true, serverMmsi = "999000000" } = {}) {
  const packets = [];
  const app = {
    debug: () => {},
    error: () => {},
    getSelfPath: (path) => (path === "mmsi" ? serverMmsi : undefined)
  };
  const state = {
    options: { secretKey, protocolVersion: 3, fleetSharing: { enabled: true, ...fleetSharing } },
    socketUdp: {
      send: (pkt, _port, _address, cb) => {
        packets.push(Buffer.from(pkt));
        cb(null);
      }
    }
  };
  const ctx = createServerContext({ app, state, metricsApi: makeMetricsApi() });
  const session = getOrCreateSession(ctx, { address: "10.0.0.1", port: 1 });
  session.fleet = createSessionState(ctx, { self: "vessels.me", nonce: "0123456789abcdef" });
  // Unless a test says otherwise, the client has already confirmed the
  // stream with a FLEET_ACK (§15.4).
  session.fleet.confirmed = confirmed;
  ctx.fleet.members.set("vessels.me", session.key);
  return { ctx, session, packets };
}

/** Decode every distinct FLEET_DATA packet into its deltas. */
async function decodeAll(packets) {
  const parser = new PacketParser({ secretKey });
  const seen = new Set();
  const deltas = [];
  for (const pkt of packets) {
    const parsed = parser.parseHeader(pkt, { epoch: 0 });
    if (parsed.type !== PacketType.FLEET_DATA || seen.has(parsed.sequence)) {
      continue;
    }
    seen.add(parsed.sequence);
    const { encrypted } = parser.parseFleetDataPayload(parsed.payload);
    deltas.push(
      ...(await decodeFleetPayload(
        encrypted,
        { messagepack: false, pathDictionary: false },
        { secretKey }
      ))
    );
  }
  return deltas;
}

describe("fleet sender ordering", () => {
  let now;
  let clock;

  beforeEach(() => {
    now = 1_000_000;
    clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  test("under a saturated budget every path is still sent, oldest-waiting first", async () => {
    const { ctx, session, packets } = makeServer({ scope: "all", maxBytesPerSec: 512 });
    const targets = 200;
    for (let tick = 0; tick < 60; tick++) {
      for (let i = 0; i < targets; i++) {
        onFleetDelta(ctx, {
          context: `vessels.t${i}`,
          updates: [
            {
              $source: "ais",
              timestamp: new Date(now).toISOString(),
              values: [{ path: "navigation.speedOverGround", value: tick + i / 1000 }]
            }
          ]
        });
      }
      session.lastPacketTime = now;
      await fleetTick(ctx);
      // A perfect link: the client acknowledges everything sent so far.
      session.fleet.retransmitQueue.acknowledge((session.fleet.nextSeq - 1) >>> 0);
      now += 1000;
    }
    const sent = new Map();
    for (const delta of await decodeAll(packets)) {
      sent.set(delta.context, (sent.get(delta.context) ?? 0) + 1);
    }
    // More updates than the budget carries, so pacing had to choose.
    expect(ctx.metrics.fleet.rateLimitedFlushes).toBeGreaterThan(0);
    const counts = Array.from({ length: targets }, (_, i) => sent.get(`vessels.t${i}`) ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });
});

/** A fleet HELLO `info` object as the client builds it. */
function fleetHelloInfo(self, timestamp) {
  return {
    capabilities: [FLEET_CAPABILITY],
    fleet: encodeFleetIdentity({ self, nonce: "fedcba9876543210" }, secretKey),
    timestamp
  };
}

/** A fleet HELLO `info` with an explicit epoch and timestamp. */
function fleetHelloInfoAt(epoch, timestamp, self = "vessels.me") {
  return { ...fleetHelloInfo(self, timestamp), epoch };
}

/** Queue one value per context for every session. */
function enqueueValues(ctx, count, at) {
  for (let i = 0; i < count; i++) {
    onFleetDelta(ctx, {
      context: `vessels.v${i}`,
      updates: [
        {
          $source: "gps",
          timestamp: new Date(at).toISOString(),
          values: [{ path: "navigation.speedOverGround", value: i, extra: "x".repeat(40) }]
        }
      ]
    });
  }
}

/** FLEET_DATA packets sent: distinct sequences, and every send including retransmits. */
function fleetDataSent(packets) {
  const parser = new PacketParser({ secretKey });
  const data = packets
    .map((pkt) => parser.parseHeader(pkt, { epoch: 0 }))
    .filter((parsed) => parsed.type === PacketType.FLEET_DATA);
  return { distinct: new Set(data.map((parsed) => parsed.sequence)).size, sends: data.length };
}

describe("fleet coalescing", () => {
  test("a value replaced while it waits is sent only in its newest form", async () => {
    const { ctx, packets } = makeServer({ scope: "all" });
    for (const value of [1, 2, 3]) {
      onFleetDelta(ctx, {
        context: "vessels.other",
        updates: [
          {
            $source: "gps",
            timestamp: new Date(Date.now() + value).toISOString(),
            values: [{ path: "navigation.speedOverGround", value }]
          }
        ]
      });
    }
    await fleetTick(ctx);
    const values = (await decodeAll(packets)).flatMap((d) => d.updates.flatMap((u) => u.values));
    expect(values.map((v) => v.value)).toEqual([3]);
  });

  test("values put back after a deferred send go to the head of the queue", () => {
    const { ctx, session } = makeServer({ scope: "all" });
    enqueueValues(ctx, 3, Date.now());
    const pending = session.fleet.pending;
    const [first, second, third] = [...pending.values()];
    // The sender took the first two, could not send them, and puts them back
    // while the third waited.
    pending.delete([...pending.keys()][0]);
    pending.delete([...pending.keys()][0]);
    requeuePending(session.fleet, [first, second]);
    expect([...session.fleet.pending.values()]).toEqual([first, second, third]);
  });
});

describe("fleet HELLO hardening", () => {
  test("a replayed HELLO without a fleet request cannot take a member out of the fleet", () => {
    const { ctx, session } = makeServer({});
    session.fleet.lastHello = { epoch: 100, ts: 5000 };
    // Captured earlier, before the client asked for fleet sharing.
    handleFleetHello(ctx, session, { epoch: 100, timestamp: 4000 }, false);
    expect(session.fleet).not.toBeNull();
    expect(ctx.fleet.members.get("vessels.me")).toBe(session.key);
    expect(ctx.metrics.fleet.replayedHellos).toBe(1);
    // A garbled identity in an old HELLO is ignored the same way.
    handleFleetHello(
      ctx,
      session,
      { capabilities: [FLEET_CAPABILITY], fleet: "not-an-identity", epoch: 100, timestamp: 4500 },
      false
    );
    expect(session.fleet).not.toBeNull();
    expect(ctx.metrics.fleet.identityRejected).toBe(0);
    // A newer HELLO without the request is the client turning sharing off.
    handleFleetHello(ctx, session, { epoch: 100, timestamp: 6000 }, false);
    expect(session.fleet).toBeNull();
    expect(ctx.fleet.members.has("vessels.me")).toBe(false);
  });

  test("a client restarted with its clock set back is accepted by its higher epoch", () => {
    const { ctx, session } = makeServer({});
    session.fleet.lastHello = { epoch: 100, ts: 5000 };
    // The epoch is persisted and raised on every restart; the clock is not.
    handleFleetHello(ctx, session, fleetHelloInfoAt(101, 1000), true);
    expect(ctx.metrics.fleet.replayedHellos).toBe(0);
    expect(session.fleet.lastHello).toEqual({ epoch: 101, ts: 1000 });
    // A HELLO captured in the previous run stays a replay.
    handleFleetHello(ctx, session, fleetHelloInfoAt(100, 9000), false);
    expect(ctx.metrics.fleet.replayedHellos).toBe(1);
    expect(session.fleet.lastHello).toEqual({ epoch: 101, ts: 1000 });
  });

  test("a restarted vessel on a new port takes over from its stale session by epoch", () => {
    const { ctx, session } = makeServer({});
    ctx.fleet.helloMarks.set("vessels.me", { epoch: 100, ts: 5000 });
    const restarted = getOrCreateSession(ctx, { address: "10.0.0.1", port: 2 });
    // A replay of the old run from the new port is refused...
    handleFleetHello(ctx, restarted, fleetHelloInfoAt(100, 4000, "vessels.me"), false);
    expect(ctx.fleet.members.get("vessels.me")).toBe(session.key);
    expect(ctx.metrics.fleet.replayedHellos).toBe(1);
    // ...the restarted run, clock behind, is not.
    handleFleetHello(ctx, restarted, fleetHelloInfoAt(101, 1000, "vessels.me"), false);
    expect(ctx.fleet.members.get("vessels.me")).toBe(restarted.key);
  });

  test("a client cannot declare the server's own vessel", () => {
    const { ctx } = makeServer({}, { serverMmsi: "999000999" });
    const other = getOrCreateSession(ctx, { address: "10.0.0.2", port: 2 });
    handleFleetHello(ctx, other, fleetHelloInfo("vessels.urn:mrn:imo:mmsi:999000999", 1000), false);
    expect(other.fleet).toBeNull();
    expect(ctx.fleet.members.has("vessels.urn:mrn:imo:mmsi:999000999")).toBe(false);
    expect(ctx.metrics.fleet.identityRejected).toBe(1);
  });

  test("refusing the server's own vessel answers, so the client reports declined", async () => {
    const { ctx, packets } = makeServer({}, { serverMmsi: "999000999" });
    const other = getOrCreateSession(ctx, { address: "10.0.0.2", port: 2 });
    handleFleetHello(ctx, other, fleetHelloInfo("vessels.urn:mrn:imo:mmsi:999000999", 1000), false);
    await new Promise((resolve) => setImmediate(resolve));
    const parser = new PacketParser({ secretKey });
    const acks = packets
      .map((pkt) => parser.parseHeader(pkt, { epoch: 0 }))
      .filter((parsed) => parsed.type === PacketType.HELLO_ACK)
      .map((parsed) => JSON.parse(parsed.payload.toString()));
    expect(acks).toHaveLength(1);
    expect(acks[0].accepted).not.toContain(FLEET_CAPABILITY);
  });
});

describe("fleet return routability", () => {
  let now;
  let clock;

  beforeEach(() => {
    now = 2_000_000;
    clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  test("a session sends one FLEET_DATA until the client confirms its stream", async () => {
    const { ctx, session, packets } = makeServer({ scope: "all" }, { confirmed: false });
    enqueueValues(ctx, 200, now);
    // Long enough for the one packet to use up its retransmits and be
    // abandoned: that must not let a second one out.
    for (let tick = 0; tick < 15; tick++) {
      session.lastPacketTime = now;
      await fleetTick(ctx);
      now += 1000;
    }
    expect(session.fleet.retransmitQueue.getSize()).toBe(0);
    // A HELLO replayed with a spoofed source gets one packet and at most its
    // retransmits, not a stream.
    const held = fleetDataSent(packets);
    expect(held.distinct).toBe(1);
    expect(held.sends).toBeLessThanOrEqual(1 + FLEET_MAX_RETRANSMITS);
    // Once a keepalive interval has passed, one more packet may go, so a
    // real client whose first packet was lost is not stalled for good.
    for (let tick = 0; tick < 7; tick++) {
      session.lastPacketTime = now;
      await fleetTick(ctx);
      now += 1000;
    }
    expect(fleetDataSent(packets).distinct).toBe(2);
    expect(session.fleet.pending.size).toBeGreaterThan(0);
    // FLEET_ACK(stream, 0xFFFFFFFF), as a client sends on adopting the stream.
    const ack = ctx.packetParser.parseHeader(
      ctx.packetBuilder.buildFleetAckPacket(session.fleet.stream, 0xffffffff),
      { epoch: 0 }
    );
    handleFleetAck(ctx, ack, { address: session.address, port: session.port });
    expect(session.fleet.confirmed).toBe(true);
    session.lastPacketTime = now;
    await fleetTick(ctx);
    expect(fleetDataSent(packets).distinct).toBeGreaterThan(1);
  });

  test("an ACK for another stream does not confirm the session", () => {
    const { ctx, session } = makeServer({}, { confirmed: false });
    const ack = ctx.packetParser.parseHeader(
      ctx.packetBuilder.buildFleetAckPacket((session.fleet.stream + 1) >>> 0, 0xffffffff),
      { epoch: 0 }
    );
    handleFleetAck(ctx, ack, { address: session.address, port: session.port });
    expect(session.fleet.confirmed).toBe(false);
    expect(ctx.metrics.fleet.staleStreamPackets).toBe(1);
  });
});

describe("fleet loss-adaptive rate", () => {
  let now;
  let clock;

  beforeEach(() => {
    now = 3_000_000;
    clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  const nakFor = (ctx, stream, sequences) =>
    ctx.packetParser.parseHeader(ctx.packetBuilder.buildFleetNakPacket(stream, sequences), {
      epoch: 0
    });

  test("downlink loss cuts the rate once per burst; repeated NAKs of the same gap do not", async () => {
    const { ctx, session } = makeServer({ scope: "all" });
    enqueueValues(ctx, 5, now);
    await fleetTick(ctx);
    expect(session.fleet.retransmitQueue.getSize()).toBeGreaterThan(0);
    const from = { address: session.address, port: session.port };
    await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [0]), from);
    expect(ctx.metrics.fleet.rateBackoffs).toBe(1);
    expect(session.fleet.rateFactor).toBeCloseTo(0.7);
    // The client re-NAKs the same gap until it is filled; a second later
    // that is still the same loss, already retransmitted once.
    now += 1500;
    await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [0]), from);
    // A sequence the server no longer holds (abandoned or never sent).
    await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [999]), from);
    expect(ctx.metrics.fleet.rateBackoffs).toBe(1);
    // Loss stops: everything is acknowledged and the rate recovers.
    session.fleet.retransmitQueue.acknowledge((session.fleet.nextSeq - 1) >>> 0);
    for (let tick = 0; tick < 12; tick++) {
      now += 1000;
      session.lastPacketTime = now;
      await fleetTick(ctx);
    }
    expect(session.fleet.rateFactor).toBe(1);
    expect(ctx.metrics.fleet.minRateFactor).toBe(1);
  });

  test("a timed-out packet the budget holds back cuts the rate once, not on every tick", async () => {
    const { ctx, session } = makeServer({ scope: "all" });
    enqueueValues(ctx, 5, now);
    await fleetTick(ctx);
    session.fleet.tokens = -1e9;
    for (let tick = 0; tick < 6; tick++) {
      now += 2500;
      session.lastPacketTime = now;
      session.fleet.tokens = -1e9;
      await fleetTick(ctx);
    }
    expect(session.fleet.retransmitQueue.get(0).attempts).toBe(0);
    expect(ctx.metrics.fleet.rateBackoffs).toBe(1);
  });

  test("a tick still running is not overlapped by the next one", async () => {
    const { ctx, session } = makeServer({ scope: "all", maxBytesPerSec: 1048576 });
    enqueueValues(ctx, 120, now);
    await fleetTick(ctx);
    expect(session.fleet.retransmitQueue.getSize()).toBeGreaterThan(1);
    now += 2500;
    session.lastPacketTime = now;
    // A slow socket: each send completes a little later.
    const socket = ctx.state.socketUdp;
    const send = socket.send;
    socket.send = (pkt, port, address, cb) =>
      send(pkt, port, address, () => setTimeout(() => cb(null), 5));
    // Two ticks started back to back, as setInterval does while one is still
    // sending. Each timed-out packet is resent once, not once per tick.
    await Promise.all([fleetTick(ctx), fleetTick(ctx)]);
    const queue = session.fleet.retransmitQueue;
    const attempts = queue.getOldestSequences(100).map((seq) => queue.get(seq).attempts);
    expect(Math.max(...attempts)).toBe(1);
  });

  test("a gap whose retransmit the budget holds back cuts the rate once, not on every NAK", async () => {
    const { ctx, session } = makeServer({ scope: "all" });
    enqueueValues(ctx, 5, now);
    await fleetTick(ctx);
    const from = { address: session.address, port: session.port };
    // An empty budget: the retransmit waits, so the packet is never resent.
    session.fleet.tokens = -1e9;
    for (let i = 0; i < 5; i++) {
      await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [0]), from);
      now += 1500;
    }
    expect(session.fleet.retransmitQueue.get(0).attempts).toBe(0);
    expect(ctx.metrics.fleet.rateBackoffs).toBe(1);
  });

  test("repeated NAKs of one gap spread its retransmits instead of spending them at once", async () => {
    const { ctx, session } = makeServer({ scope: "all" });
    enqueueValues(ctx, 1, now);
    await fleetTick(ctx);
    const from = { address: session.address, port: session.port };
    // The client NAKs every 100 ms while the round trip is 700 ms.
    for (let i = 0; i < 7; i++) {
      await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [0]), from);
      now += 100;
    }
    expect(ctx.metrics.fleet.retransmits).toBe(1);
    expect(session.fleet.retransmitQueue.get(0).attempts).toBe(1);
    // A second later the gap is still open: the next NAK is answered.
    now += 400;
    await handleFleetNak(ctx, nakFor(ctx, session.fleet.stream, [0]), from);
    expect(ctx.metrics.fleet.retransmits).toBe(2);
  });
});
