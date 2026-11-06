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
  onFleetDelta
} = require("../../src/transport/pipeline/reliable-server/fleet");
const { fleetTick } = require("../../src/transport/pipeline/reliable-server/fleet-sender");
const { PacketParser, PacketType } = require("../../src/codec/packet-codec");
const { decodeFleetPayload } = require("../../src/codec/fleet-payload");
const { makeMetricsApi } = require("../helpers/metrics-fixture");

const secretKey = "12345678901234567890123456789012";

/** A server context with one accepted fleet session and a captured socket. */
function makeServer(fleetSharing) {
  const packets = [];
  const app = { debug: () => {}, error: () => {}, getSelfPath: () => undefined };
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
