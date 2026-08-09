"use strict";

/**
 * Regression coverage for the two ways a link could go permanently deaf:
 *
 *  1. the client latched its handshake and never re-HELLOed, so a peer that
 *     lost the session (server restart, NAT rebind) could never be reached
 *     again;
 *  2. server socket recovery built a second pipeline, stranding the first with
 *     its sessions, epochs and replay guards.
 */

const { AlertManager } = require("../../lib/monitoring");
const { MONITORING_ALERT_COOLDOWN } = require("../../lib/constants");

describe("alert manager does not flap around a threshold", () => {
  function makeManager(emit) {
    return new AlertManager(
      { handleMessage: emit, debug: () => {}, error: () => {} },
      {
        thresholds: { rtt: { warning: 200 } },
        cooldown: MONITORING_ALERT_COOLDOWN
      }
    );
  }

  test("a value oscillating across the threshold raises at most once per cooldown", () => {
    const emit = jest.fn();
    const mgr = makeManager(emit);

    // checkAll runs once a second in the real pipeline. Marginal RTT used to
    // produce raise/clear/raise/clear — one operator notification every second.
    let raised = 0;
    for (let i = 0; i < 20; i++) {
      const alert = mgr.check("rtt", i % 2 === 0 ? 205 : 195);
      if (alert) {
        raised++;
      }
    }

    expect(raised).toBe(1);
  });

  test("an escalation to critical is still reported immediately", () => {
    const emit = jest.fn();
    const mgr = new AlertManager(
      { handleMessage: emit, debug: () => {}, error: () => {} },
      {
        thresholds: { rtt: { warning: 200, critical: 500 } },
        cooldown: MONITORING_ALERT_COOLDOWN
      }
    );

    expect(mgr.check("rtt", 205)).toMatchObject({ level: "warning" });
    // Worse news must not wait out the cooldown.
    expect(mgr.check("rtt", 900)).toMatchObject({ level: "critical" });
  });

  test("the first alert for a metric is never delayed", () => {
    const mgr = makeManager(jest.fn());
    expect(mgr.check("rtt", 205)).toMatchObject({ level: "warning" });
  });
});

describe("per-IP session cap evicts rather than locking a client out", () => {
  const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
  const { PacketBuilder } = require("../../lib/packet");
  const { makeMetricsApi } = require("../helpers/metrics-fixture");

  const SECRET_KEY = "0123456789abcdef0123456789abcdef";

  function makeState() {
    return {
      instanceId: "test",
      options: { protocolVersion: 3, secretKey: SECRET_KEY, serverType: "server" },
      isServerMode: true,
      stopped: false,
      socketUdp: { send: jest.fn((m, p, a, cb) => cb && cb(null)) },
      sourceRegistry: null,
      deltas: []
    };
  }

  test("a client rotating source ports can still handshake after hitting the cap", async () => {
    const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const state = makeState();
    const server = createPipelineV2Server(app, state, makeMetricsApi());
    const address = "203.0.113.9";

    // Six distinct source ports from one NAT address, as a client that has
    // recovered its socket several times inside the idle TTL would produce.
    for (let port = 6000; port <= 6005; port++) {
      const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET_KEY });
      const hello = builder.buildHelloPacket({
        protocolVersion: 3,
        clientId: "c",
        instanceId: "c",
        epoch: 1000 + port
      });
      await server.receivePacket(hello, SECRET_KEY, { address, port });
    }

    const keys = server.getMetrics().sessions.map((s) => s.address);
    // The cap still holds…
    expect(keys.length).toBeLessThanOrEqual(5);
    // …but the newest port is present rather than refused.
    expect(keys).toContain(`${address}:6005`);
  });
});

describe("session capacity: per-IP eviction runs before global eviction", () => {
  const { getOrCreateSession } = require("../../lib/transport/pipeline/reliable-server/sessions");
  const { MAX_CLIENT_SESSIONS } = require("../../lib/constants");

  function makeCtx() {
    return {
      app: { debug: jest.fn(), error: jest.fn() },
      metrics: {},
      clientSessions: new Map(),
      nakTimeout: 1000,
      maxNakRounds: 3,
      MAX_SESSIONS_PER_IP: 5
    };
  }

  test("a full table plus an address at its per-IP cap evicts only that address's session", () => {
    const ctx = makeCtx();
    const busy = "203.0.113.50";

    // 95 unrelated peers, deliberately the oldest entries in the table, plus 5
    // ports from one address — exactly MAX_CLIENT_SESSIONS in total.
    const unrelated = [];
    for (let i = 0; i < MAX_CLIENT_SESSIONS - 5; i++) {
      const session = getOrCreateSession(ctx, { address: `10.0.0.${i}`, port: 5000 });
      session.lastPacketTime = 1000 + i; // oldest globally
      unrelated.push(session.key);
    }
    for (let port = 6000; port < 6005; port++) {
      const session = getOrCreateSession(ctx, { address: busy, port });
      session.lastPacketTime = 900000 + port; // newest globally
    }
    expect(ctx.clientSessions.size).toBe(MAX_CLIENT_SESSIONS);

    // A sixth port from the busy address. Freeing its own LRU slot is enough,
    // so no unrelated peer should be touched. Evicting globally first would
    // throw out the oldest unrelated peer *and* the busy address's LRU — two
    // sessions destroyed to admit one.
    const created = getOrCreateSession(ctx, { address: busy, port: 6005 });

    expect(created).not.toBeNull();
    expect(ctx.clientSessions.size).toBeLessThanOrEqual(MAX_CLIENT_SESSIONS);

    const surviving = new Set(ctx.clientSessions.keys());
    for (const key of unrelated) {
      expect(surviving.has(key)).toBe(true);
    }
    expect(surviving.has(`${busy}:6005`)).toBe(true);
    expect(surviving.has(`${busy}:6000`)).toBe(false);
  });
});
