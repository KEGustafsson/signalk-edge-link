"use strict";

/**
 * H3 end-to-end anti-replay tests. White-box: drives the server context
 * directly so we can simulate session idle-expiry / eviction (drop the live
 * session while the per-peer replay guard intentionally survives).
 */

const { promisify } = require("util");
const zlib = require("zlib");
const { createServerContext } = require("../../lib/transport/pipeline/reliable-server/context");
const { receivePacket } = require("../../lib/transport/pipeline/reliable-server/receive");
const { PacketBuilder } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");
const createMetrics = require("../../lib/metrics");

const SECRET = "12345678901234567890123456789012";
const brotliCompress = promisify(zlib.brotliCompress);
const client = { address: "10.0.0.5", port: 6000 };
const guardKey = `${client.address}:${client.port}`;

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeCtx(app) {
  const state = {
    instanceId: null,
    options: {
      secretKey: SECRET,
      protocolVersion: 3,
      // Legacy unauthenticated DATA frames keep these tests focused on the
      // replay window (independent of the header-HMAC path).
      authenticatedHeaders: false,
      reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
    },
    socketUdp: { send: jest.fn((d, p, a, cb) => cb && cb(null)) }
  };
  return createServerContext({ app, state, metricsApi: createMetrics() });
}

function helloPacket(epoch) {
  const info = { clientId: "c", instanceId: "c" };
  if (epoch !== undefined) {
    info.epoch = epoch;
  }
  return new PacketBuilder({ protocolVersion: 3, secretKey: SECRET }).buildHelloPacket(info, {
    secretKey: SECRET
  });
}

async function dataPacket(seq, value) {
  const delta = [
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value }] }]
    }
  ];
  const compressed = await brotliCompress(Buffer.from(JSON.stringify(delta)));
  const encrypted = encryptBinary(compressed, SECRET);
  return new PacketBuilder({
    initialSequence: seq,
    protocolVersion: 3,
    secretKey: SECRET
  }).buildDataPacket(encrypted, { compressed: true, encrypted: true });
}

describe("H3 anti-replay", () => {
  test("rejects a DATA replay after the live session is gone (idle/eviction)", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    const pkt = await dataPacket(500, 4);
    await receivePacket(ctx, pkt, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Simulate session idle-expiry / eviction: the live session disappears but
    // the replay guard persists.
    ctx.clientSessions.clear();
    expect(ctx.replayGuards.size).toBe(1);

    // Replay the captured datagram — must NOT be re-injected.
    await receivePacket(ctx, pkt, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.replayedPackets).toBe(1);
  });

  test("accepts a legitimate restart (higher epoch) with a new sequence baseline", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    await receivePacket(ctx, await dataPacket(900000, 1), SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Restart: higher epoch + a much lower random base that would otherwise look
    // like a replay / too-old. The higher epoch resets the window.
    await receivePacket(ctx, helloPacket(2000), SECRET, client);
    await receivePacket(ctx, await dataPacket(50, 2), SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    expect(ctx.replayGuards.get(guardKey).epoch).toBe(2000);
  });

  test("ignores a replayed (stale) HELLO so the window is not reset", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    const pkt = await dataPacket(500, 7);
    await receivePacket(ctx, pkt, SECRET, client);
    ctx.clientSessions.clear();

    // Attacker replays the captured HELLO (same epoch) then the captured DATA.
    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    await receivePacket(ctx, pkt, SECRET, client);

    expect(app.handleMessage).toHaveBeenCalledTimes(1); // replay still blocked
    expect(ctx.replayGuards.get(guardKey).epoch).toBe(1000);
    expect(ctx.metrics.replayedPackets).toBe(1);
  });

  test("rejects an in-session replay (window catches it before resync)", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    const pkt = await dataPacket(500, 3);
    await receivePacket(ctx, pkt, SECRET, client);
    await receivePacket(ctx, pkt, SECRET, client); // immediate replay
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.replayedPackets).toBe(1);
  });

  test("rejects a replay from a rotated source port while the session is live", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    const pkt = await dataPacket(500, 4);
    await receivePacket(ctx, pkt, SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // The guard is keyed by address:port, so an attacker replaying the captured
    // datagram from a different source port used to mint a fresh guard whose
    // empty window accepted everything — bypassing replay protection even with
    // the legitimate session still live.
    await receivePacket(ctx, pkt, SECRET, { address: client.address, port: 61234 });
    await receivePacket(ctx, pkt, SECRET, { address: client.address, port: 40000 });

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.replayedPackets).toBe(2);
  });

  test("rejects DATA from an unhandshaked port even with an unseen sequence", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    await receivePacket(ctx, await dataPacket(500, 1), SECRET, client);

    // A sequence the window has never seen still must not be accepted from a
    // port that never completed a handshake for this peer address.
    await receivePacket(ctx, await dataPacket(900, 2), SECRET, {
      address: client.address,
      port: 55555
    });

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.replayedPackets).toBe(1);
  });

  test("accepts a legitimate reconnect from a new port once it handshakes", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    await receivePacket(ctx, await dataPacket(500, 1), SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Client restarts and rebinds to a new ephemeral port: it HELLOs first with
    // a higher epoch, so its DATA must still be accepted.
    const reconnected = { address: client.address, port: 7100 };
    await receivePacket(ctx, helloPacket(2000), SECRET, reconnected);
    await receivePacket(ctx, await dataPacket(50, 2), SECRET, reconnected);

    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    expect(ctx.metrics.replayedPackets).toBe(0);
  });

  // Regression: the replay window is re-baselined on an epoch increase, but the
  // session's sequence tracker was not. A restarted peer picks a fresh random
  // initial sequence; when that landed BELOW the previous stream (but within the
  // resync threshold) every packet was classified as a late arrival — correctly
  // not re-dispatched, and therefore silently dropped.
  test("accepts a restarted peer whose new sequence base is below the old one", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    await receivePacket(ctx, helloPacket(1000), SECRET, client);
    await receivePacket(ctx, await dataPacket(500, 1), SECRET, client);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);

    // Restart: higher epoch, new base only moderately lower than 500 — far
    // inside the behind-resync threshold, so nothing else would rescue it.
    await receivePacket(ctx, helloPacket(2000), SECRET, client);
    await receivePacket(ctx, await dataPacket(50, 2), SECRET, client);
    await receivePacket(ctx, await dataPacket(51, 3), SECRET, client);

    expect(app.handleMessage).toHaveBeenCalledTimes(3);
    expect(ctx.metrics.replayedPackets).toBe(0);
  });

  // The unhandshaked-port gate is keyed by ADDRESS, so two peers behind one NAT
  // share it. Using `epoch > 0` as the handshake proxy made a pre-H3 peer — which
  // completes a real handshake but advertises no epoch — look identical to a
  // never-seen source port: once its H3 neighbour handshaked, the legacy peer's
  // data was silently dropped as a rotated-port replay.
  test("accepts a pre-H3 peer sharing a NAT address with an H3 peer", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);
    const modern = { address: "10.0.0.5", port: 6000 };
    const legacy = { address: "10.0.0.5", port: 6001 };

    await receivePacket(ctx, helloPacket(1000), SECRET, modern);
    await receivePacket(ctx, await dataPacket(500, 1), SECRET, modern);

    // Same address, different port, HELLO carries no epoch.
    await receivePacket(ctx, helloPacket(undefined), SECRET, legacy);
    await receivePacket(ctx, await dataPacket(700, 2), SECRET, legacy);

    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    expect(ctx.metrics.replayedPackets).toBe(0);

    // The gate still holds for a port that never handshaked at all.
    await receivePacket(ctx, await dataPacket(900, 3), SECRET, {
      address: "10.0.0.5",
      port: 6002
    });
    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    expect(ctx.metrics.replayedPackets).toBe(1);
  });

  test("does not strictly enforce for pre-H3 peers that send no epoch", async () => {
    const app = makeApp();
    const ctx = makeCtx(app);

    // Legacy HELLO without an epoch field.
    await receivePacket(ctx, helloPacket(undefined), SECRET, client);
    expect(ctx.replayGuards.get(guardKey)?.epoch ?? 0).toBe(0);

    const pkt = await dataPacket(500, 9);
    await receivePacket(ctx, pkt, SECRET, client);
    ctx.clientSessions.clear();

    // Backward-compat: with no negotiated epoch the strict guard is not
    // enforced, so a fresh session accepts the packet again (legacy behavior).
    await receivePacket(ctx, pkt, SECRET, client);
    expect(ctx.metrics.replayedPackets).toBe(0);
    expect(app.handleMessage).toHaveBeenCalledTimes(2);
  });
});
