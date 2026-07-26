"use strict";

/**
 * Epoch-bound packet authentication.
 *
 * Anti-replay enforcement arms only once a peer completes an epoch handshake.
 * That left one residual: a packet replayed from a source address the receiver
 * has NEVER seen lands on a freshly-created guard with epoch 0, which has
 * nothing to enforce against. Keying guards per address closes port rotation
 * (see replay-protection.test.js) but cannot close source-IP spoofing.
 *
 * Binding the connection epoch into the auth tag closes it: a captured packet
 * only authenticates inside the epoch it was sent in, and a receiver with no
 * established epoch for the source has no valid value to verify against.
 *
 * Opt-in (`epochBoundAuth`), because a peer that does not know the flag
 * computes the tag without the epoch — so both ends must agree.
 */

const { promisify } = require("util");
const zlib = require("zlib");
const { createServerContext } = require("../../lib/transport/pipeline/reliable-server/context");
const { receivePacket } = require("../../lib/transport/pipeline/reliable-server/receive");
const { PacketBuilder, PacketParser, PacketFlags } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");
const createMetrics = require("../../lib/metrics");

const SECRET = "12345678901234567890123456789012";
const brotliCompress = promisify(zlib.brotliCompress);
const client = { address: "10.0.0.5", port: 6000 };
const EPOCH = 1000;

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeCtx(app, { epochBoundAuth }) {
  const state = {
    instanceId: null,
    options: {
      secretKey: SECRET,
      protocolVersion: 3,
      authenticatedHeaders: true,
      epochBoundAuth,
      reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
    },
    socketUdp: { send: jest.fn((d, p, a, cb) => cb && cb(null)) }
  };
  return createServerContext({ app, state, metricsApi: createMetrics() });
}

function makeBuilder({ epochBoundAuth, connectionEpoch, initialSequence = 500 }) {
  return new PacketBuilder({
    initialSequence,
    protocolVersion: 3,
    secretKey: SECRET,
    authenticatedHeaders: true,
    epochBoundAuth,
    connectionEpoch
  });
}

function helloPacket(builder, epoch) {
  return builder.buildHelloPacket({ clientId: "c", instanceId: "c", epoch }, { secretKey: SECRET });
}

async function dataPacket(builder, value) {
  const delta = [
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value }] }]
    }
  ];
  const compressed = await brotliCompress(Buffer.from(JSON.stringify(delta)));
  const encrypted = encryptBinary(compressed, SECRET);
  return builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
}

describe("epoch-bound authentication", () => {
  test("sets the EPOCH_BOUND_AUTH flag on DATA but never on HELLO", async () => {
    const builder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });

    const data = await dataPacket(builder, 1);
    expect(data[4] & PacketFlags.EPOCH_BOUND_AUTH).toBeTruthy();

    // HELLO is what ESTABLISHES the epoch — binding it would make the
    // handshake unverifiable and the connection could never start.
    const hello = helloPacket(builder, EPOCH);
    expect(hello[4] & PacketFlags.EPOCH_BOUND_AUTH).toBeFalsy();
  });

  test("a bound builder's HELLO is byte-identical to an unbound one", () => {
    // The HELLO payload embeds Date.now(), so compare with the timestamp
    // normalised: everything else — header, flags and auth tag — must match,
    // proving the epoch is genuinely excluded rather than merely unflagged.
    // (This is also why HELLO is not frozen in the conformance vectors.)
    const info = { clientId: "c", instanceId: "c", epoch: EPOCH, timestamp: 1700000000000 };
    const bound = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH }).buildHelloPacket(
      info,
      { secretKey: SECRET }
    );
    const unbound = makeBuilder({ epochBoundAuth: false }).buildHelloPacket(info, {
      secretKey: SECRET
    });
    expect(bound.equals(unbound)).toBe(true);
  });

  test("a bound tag differs from an unbound one for identical content", async () => {
    const bound = await dataPacket(
      makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH }),
      1
    );
    const unbound = await dataPacket(makeBuilder({ epochBoundAuth: false }), 1);
    // Same header length, different trailing tag.
    expect(bound.subarray(bound.length - 16)).not.toEqual(unbound.subarray(unbound.length - 16));
  });

  test("closes the spoofed-source replay: a captured packet fails on an unknown source", async () => {
    const app = makeApp();
    const ctx = makeCtx(app, { epochBoundAuth: true });
    const builder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });

    await receivePacket(ctx, helloPacket(builder, EPOCH), SECRET, client);
    const captured = await dataPacket(builder, 4);
    await receivePacket(ctx, captured, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Replay from a source address the server has never seen. Its guard is
    // fresh (epoch 0), so there is no epoch to verify against and the tag —
    // computed under epoch 1000 — cannot authenticate.
    await receivePacket(ctx, captured, SECRET, { address: "203.0.113.9", port: 40000 });
    await receivePacket(ctx, captured, SECRET, { address: "198.51.100.7", port: 51000 });

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });

  test("a packet bound to a stale epoch is rejected after the peer restarts", async () => {
    const app = makeApp();
    const ctx = makeCtx(app, { epochBoundAuth: true });

    const oldBuilder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });
    await receivePacket(ctx, helloPacket(oldBuilder, EPOCH), SECRET, client);
    const captured = await dataPacket(oldBuilder, 1);
    await receivePacket(ctx, captured, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Peer restarts with a higher epoch; the server re-baselines to it.
    const newBuilder = makeBuilder({
      epochBoundAuth: true,
      connectionEpoch: 2000,
      initialSequence: 50
    });
    await receivePacket(ctx, helloPacket(newBuilder, 2000), SECRET, client);
    await receivePacket(ctx, await dataPacket(newBuilder, 2), SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(2);

    // The pre-restart capture is now bound to a dead epoch.
    await receivePacket(ctx, captured, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(2);
  });

  test("normal traffic still flows end to end with binding enabled", async () => {
    const app = makeApp();
    const ctx = makeCtx(app, { epochBoundAuth: true });
    const builder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });

    await receivePacket(ctx, helloPacket(builder, EPOCH), SECRET, client);
    for (let i = 0; i < 5; i++) {
      await receivePacket(ctx, await dataPacket(builder, i), SECRET, client);
    }

    expect(app.handleMessage).toHaveBeenCalledTimes(5);
  });

  test("rejects a downgrade: an unbound packet is refused when binding is required", async () => {
    const app = makeApp();
    const ctx = makeCtx(app, { epochBoundAuth: true });

    // Handshake with a bound builder so the server has an epoch...
    const boundBuilder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });
    await receivePacket(ctx, helloPacket(boundBuilder, EPOCH), SECRET, client);

    // ...then send DATA with the flag cleared, as an attacker stripping the
    // binding would. Clearing the bit also changes the HMAC-covered header, so
    // this fails regardless — but the explicit check makes the intent testable.
    const legacy = await dataPacket(makeBuilder({ epochBoundAuth: false }), 7);
    await receivePacket(ctx, legacy, SECRET, client);

    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("a receiver without binding still accepts a bound sender's packets", async () => {
    // Interop direction that must keep working: the sender binds, the receiver
    // is not configured to require it, and honours the sender's flag.
    const parser = new PacketParser({ secretKey: SECRET, authenticatedHeaders: true });
    const builder = makeBuilder({ epochBoundAuth: true, connectionEpoch: EPOCH });
    const packet = await dataPacket(builder, 3);

    const parsed = parser.parseHeader(packet, { epoch: EPOCH });
    expect(parsed.flags.epochBoundAuth).toBe(true);
  });

  test("legacy peers are unaffected when binding is disabled", async () => {
    const app = makeApp();
    const ctx = makeCtx(app, { epochBoundAuth: false });
    const builder = makeBuilder({ epochBoundAuth: false });

    await receivePacket(ctx, helloPacket(builder, EPOCH), SECRET, client);
    await receivePacket(ctx, await dataPacket(builder, 1), SECRET, client);

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });
});
