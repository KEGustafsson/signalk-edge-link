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
