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
