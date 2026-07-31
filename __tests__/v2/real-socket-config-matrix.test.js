"use strict";

/**
 * Real sockets, real configuration combinations, asserted through the endpoint
 * an operator actually reads.
 *
 * Every bug reported from a running link so far shared one of two shapes, and
 * both are invisible to a test built from the author's mental model:
 *
 *   1. The harness erased the thing that broke. In-process suites pipe bytes
 *      between pipelines and hand the receiver a synthetic `rinfo`, which
 *      removes DNS, the kernel's idea of a datagram's source, and the
 *      IPv4-mapped form an IPv6-capable socket reports. The hostname peer
 *      check lived exactly there and no test could see it.
 *
 *   2. The assertion checked shape, not justification. "linkQuality is a
 *      number" passed while the number was invented from values no peer ever
 *      sent.
 *
 * So this suite binds real UDP sockets, configures peers by HOSTNAME (which is
 * what real deployments use), varies the configuration options that ship, and
 * asserts GET /metrics — the same JSON the web UI renders — rather than
 * pipeline internals. A value that is absent must read as absent all the way
 * out to the endpoint.
 */

const dgram = require("dgram");
const createRoutes = require("../../lib/routes");
const createMetrics = require("../../lib/metrics");
const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");

const KEY_HOP_A = "11111111111111111111111111111111";
const KEY_HOP_B = "22222222222222222222222222222222";

// Resolves to a loopback literal, so `rinfo.address` never equals the
// configured string and the resolution path has to do the work.
const PEER_HOSTNAME = "localhost";

jest.setTimeout(45000);

function bindSocket() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const onBindError = (err) => reject(err);
    socket.once("error", onBindError);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", onBindError);
      socket.socketErrors = [];
      socket.on("error", (err) => socket.socketErrors.push(err));
      resolve(socket);
    });
  });
}

function waitFor(predicate, description, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (err) {
        return reject(err);
      }
      if (ok) {
        return resolve();
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for: ${description}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function sampleDelta(value) {
  return {
    context: "vessels.self",
    updates: [
      {
        $source: "boat.gps",
        timestamp: "2026-07-31T00:00:00.000Z",
        values: [
          { path: "navigation.speedOverGround", value },
          { path: "navigation.position", value: { latitude: 60.1 + value, longitude: 24.9 } }
        ]
      }
    ]
  };
}

/**
 * Drive one client metrics-publish tick without waiting out
 * METRICS_PUBLISH_INTERVAL. Real timers are in use (the sockets need them), so
 * the interval callback is captured at registration and invoked directly.
 */
async function publishTelemetryOnce(pipeline) {
  let cb = null;
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    cb = fn;
    return realSetInterval(fn, ms);
  };
  pipeline.startMetricsPublishing();
  global.setInterval = realSetInterval;
  pipeline.stopMetricsPublishing();
  // publishMetrics returns early when no time has passed since
  // startMetricsPublishing recorded lastMetricsTime, so the period rates would
  // divide by zero. Let the clock move before driving the tick.
  await new Promise((r) => setTimeout(r, 15));
  if (cb) {
    cb();
  }
  // Let the async sendDelta chain reach the socket.
  await new Promise((r) => setTimeout(r, 30));
}

/** GET /metrics for a node, through the real router — the operator's view. */
function getMetrics(node) {
  const bundle = {
    id: node.instanceId,
    name: node.instanceId,
    state: node.state,
    metricsApi: node.metricsApi
  };
  const instanceRegistry = {
    getAll: () => [bundle],
    getFirst: () => bundle,
    getById: () => bundle
  };
  const routes = createRoutes({ debug: () => {}, error: () => {} }, instanceRegistry, {
    _currentOptions: {}
  });
  const collected = [];
  const router = {
    get: (path, ...handlers) => collected.push({ path, handlers }),
    post: () => {},
    put: () => {},
    delete: () => {}
  };
  routes.registerWithRouter(router);
  const route = collected.find((r) => r.path === "/metrics");
  const res = {
    body: undefined,
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(p) {
      this.body = p;
      return this;
    },
    send(p) {
      this.body = p;
      return this;
    },
    set() {
      return this;
    }
  };
  route.handlers.at(-1)({ headers: {}, params: {}, query: {} }, res);
  return res.body;
}

describe("real sockets, real configurations, asserted through GET /metrics", () => {
  const open = [];
  const stops = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch {
        /* already stopped */
      }
    }
    await Promise.all(
      open.splice(0).map(
        (s) =>
          new Promise((resolve) => {
            try {
              s.close(resolve);
            } catch {
              resolve();
            }
          })
      )
    );
  });

  async function makeServerNode(instanceId, key, options = {}) {
    const socket = await bindSocket();
    open.push(socket);
    const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const metricsApi = createMetrics();
    const state = {
      instanceId,
      isServerMode: true,
      instanceStatus: "running",
      deltas: [],
      startTime: Date.now(),
      monitoring: null,
      options: {
        secretKey: key,
        udpPort: socket.address().port,
        udpAddress: PEER_HOSTNAME,
        protocolVersion: 3,
        stretchAsciiKey: false,
        reliability: { ackInterval: 25, nakTimeout: 60 },
        ...options
      },
      socketUdp: socket
    };
    const pipeline = createPipelineV2Server(app, state, metricsApi);
    state.pipelineServer = pipeline;
    state.pipeline = null;
    socket.on("message", (msg, rinfo) => {
      pipeline.receivePacket(msg, key, rinfo).catch(() => {});
    });
    pipeline.startACKTimer();
    stops.push(() => pipeline.stop());
    return { instanceId, socket, app, metricsApi, state, pipeline, port: socket.address().port };
  }

  async function makeClientNode(instanceId, key, peerPort, options = {}, extra = {}) {
    const socket = await bindSocket();
    open.push(socket);
    const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const metricsApi = createMetrics();
    const state = {
      // Only set when the case is exercising instance-scoped paths, since a
      // bare instanceId is what switches the publisher to the scoped prefix.
      instanceId: extra.useInstanceScopedPaths === false ? null : instanceId,
      isServerMode: false,
      instanceStatus: "running",
      deltas: [],
      startTime: Date.now(),
      monitoring: null,
      connectionEpoch: Date.now(),
      options: {
        secretKey: key,
        udpPort: peerPort,
        udpAddress: PEER_HOSTNAME,
        protocolVersion: 3,
        stretchAsciiKey: false,
        reliability: {},
        congestionControl: {},
        ...options
      },
      socketUdp: socket,
      deltaTimerTime: 1000,
      avgBytesPerDelta: 100,
      maxDeltasPerBatch: 10,
      readyToSend: true,
      stopped: false
    };
    const pipeline = createPipelineV2Client(app, state, metricsApi);
    state.pipeline = pipeline;
    state.pipelineServer = null;
    // Mirrors start-client.ts: every inbound datagram is a control packet.
    socket.on("message", (msg, rinfo) => {
      pipeline.handleControlPacket(msg, rinfo).catch(() => {});
    });
    stops.push(() => pipeline.stopMetricsPublishing());
    return { instanceId, socket, app, metricsApi, state, pipeline };
  }

  /**
   * The configurations that actually ship. Each varies one axis that has
   * historically broken, rather than exploring the full cartesian product —
   * these run over real sockets and every case costs a handshake.
   */
  const CONFIGS = [
    { name: "defaults", client: {}, server: {} },
    {
      name: "msgpack + path dictionary",
      client: { useMsgpack: true, usePathDictionary: true },
      server: { useMsgpack: true, usePathDictionary: true }
    },
    {
      name: "all codecs",
      client: {
        useMsgpack: true,
        usePathDictionary: true,
        useCompactDeltas: true,
        useValueDedup: true
      },
      server: { useMsgpack: true, usePathDictionary: true }
    },
    {
      name: "skipOwnData enabled",
      client: { skipOwnData: true },
      server: {}
    },
    {
      name: "epochBoundAuth on both ends",
      client: { epochBoundAuth: true },
      server: { epochBoundAuth: true }
    },
    {
      name: "authenticatedHeaders disabled on both ends",
      client: { authenticatedHeaders: false },
      server: { authenticatedHeaders: false }
    },
    {
      name: "stretchAsciiKey on both ends",
      client: { stretchAsciiKey: true },
      server: { stretchAsciiKey: true }
    }
  ];

  describe.each(CONFIGS)("single hop — $name", ({ client: cOpts, server: sOpts }) => {
    test("data arrives intact and both ends report a measured link", async () => {
      const server = await makeServerNode("cloud-in", KEY_HOP_A, sOpts);
      const client = await makeClientNode("boat", KEY_HOP_A, server.port, cOpts);

      await client.pipeline.sendHello(PEER_HOSTNAME, server.port);
      for (let i = 0; i < 5; i++) {
        await client.pipeline.sendDelta(
          [sampleDelta(1 + i)],
          KEY_HOP_A,
          PEER_HOSTNAME,
          server.port
        );
      }

      await waitFor(
        () => server.app.handleMessage.mock.calls.length > 0,
        "the server to dispatch received deltas"
      );

      // Payload integrity through whichever codec chain this case configured.
      const delivered = server.app.handleMessage.mock.calls.map((c) => c[c.length - 1]);
      const values = delivered.flatMap((d) => d.updates.flatMap((u) => u.values));
      const sog = values.find((v) => v.path === "navigation.speedOverGround");
      expect(sog).toBeDefined();
      expect(typeof sog.value).toBe("number");

      // A real ACK, over a real socket, from a literal address, accepted
      // against a peer configured by name.
      await waitFor(
        () => (client.metricsApi.metrics.rttSamples ?? 0) > 0,
        "the client to time at least one ACK"
      );
      // One rejection here is the whole silent-stall failure mode.
      expect(client.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);

      const clientView = getMetrics(client);
      expect(clientView.networkQuality.rtt).toBeDefined();
      expect(typeof clientView.networkQuality.linkQuality).toBe("number");
    });
  });

  /**
   * The telemetry round trip, end to end and over the wire: a server has no
   * latency of its own, so everything the Network Quality card shows for it
   * arrives as client telemetry. Every field that reached the UI as a
   * fabricated zero passed through here.
   */
  describe("client telemetry reaches the server's /metrics", () => {
    test("the server reports the client's figures, and invents nothing", async () => {
      const server = await makeServerNode("cloud-in", KEY_HOP_A);
      const client = await makeClientNode(
        "boat",
        KEY_HOP_A,
        server.port,
        {},
        {
          useInstanceScopedPaths: false
        }
      );

      // Before any telemetry: absent must read as absent all the way out.
      const cold = getMetrics(server);
      expect(cold.networkQuality.rtt).toBeUndefined();
      expect(cold.networkQuality.jitter).toBeUndefined();
      expect(cold.networkQuality.linkQuality).toBeUndefined();
      // These sit behind a DIFFERENT gate from rtt/jitter, so they need their
      // own assertions: a server with no client telemetry has not observed
      // them either, and rendering a substituted 0 here is what put "0.0%
      // packet loss" beside three N/As on a link that had reported nothing.
      expect(cold.networkQuality.packetLoss).toBeUndefined();
      expect(cold.networkQuality.retransmitRate).toBeUndefined();
      // activeLink is deliberately NOT asserted absent: with no remote report
      // it falls back to this node's own active link, which is a real local
      // observation rather than an invented one.

      await client.pipeline.sendHello(PEER_HOSTNAME, server.port);
      for (let i = 0; i < 6; i++) {
        await client.pipeline.sendDelta([sampleDelta(i)], KEY_HOP_A, PEER_HOSTNAME, server.port);
      }
      await waitFor(
        () => (client.metricsApi.metrics.rttSamples ?? 0) > 0,
        "the client to time an ACK so it has something to report"
      );

      await publishTelemetryOnce(client.pipeline);
      await waitFor(
        () => getMetrics(server).networkQuality.rtt !== undefined,
        "the server to ingest the client's telemetry"
      );

      const warm = getMetrics(server);
      expect(warm.networkQuality.dataSource).toBe("remote-client");
      expect(typeof warm.networkQuality.rtt).toBe("number");
      // Jitter is the field that read 0 ms on a real link for two separate
      // reasons; it must arrive as a real value, not be substituted.
      expect(typeof warm.networkQuality.jitter).toBe("number");
      expect(typeof warm.networkQuality.packetLoss).toBe("number");
      expect(typeof warm.networkQuality.linkQuality).toBe("number");
    });
  });

  /**
   * Instance-scoped telemetry paths, as an INTEROP contract.
   *
   * A receiver must understand a peer that publishes its link telemetry under
   * `networking.edgeLink.<instanceId>.*` rather than the bare prefix — the
   * shape a multi-connection or proxy deployment produces. Getting this wrong
   * is what made a proxy's server show N/A for every network-quality field
   * while its client looked healthy.
   *
   * The delta is constructed here rather than taken from a local publisher on
   * purpose: this is a contract with a peer whose build we do not control, so
   * the wire shape is the thing under test. It still travels over a real
   * socket, through the real parser, codec and ingest path.
   */
  describe("instance-scoped telemetry paths from a peer", () => {
    const TELEMETRY_SOURCE = "signalk-edge-link-client-telemetry";

    function scopedTelemetryDelta(instanceId) {
      const p = `networking.edgeLink.${instanceId}`;
      return {
        context: "vessels.self",
        updates: [
          {
            source: { label: TELEMETRY_SOURCE, type: "plugin" },
            timestamp: new Date().toISOString(),
            values: [
              { path: `${p}.rtt`, value: 42 },
              { path: `${p}.jitter`, value: 3.4 },
              { path: `${p}.packetLoss`, value: 0.01 },
              { path: `${p}.retransmitRate`, value: 0.02 }
            ]
          }
        ]
      };
    }

    test("a scoped telemetry report is ingested, not discarded", async () => {
      const server = await makeServerNode("cloud-in", KEY_HOP_A);
      const client = await makeClientNode("boat-1", KEY_HOP_A, server.port);

      expect(getMetrics(server).networkQuality.rtt).toBeUndefined();

      await client.pipeline.sendHello(PEER_HOSTNAME, server.port);
      await client.pipeline.sendDelta(
        [scopedTelemetryDelta("boat-1")],
        KEY_HOP_A,
        PEER_HOSTNAME,
        server.port
      );

      await waitFor(
        () => getMetrics(server).networkQuality.rtt !== undefined,
        "the server to ingest scoped telemetry paths"
      );

      const view = getMetrics(server);
      expect(view.networkQuality.rtt).toBe(42);
      expect(view.networkQuality.jitter).toBe(3.4);
      expect(view.networkQuality.dataSource).toBe("remote-client");
    });

    test("the unscoped form still works, so the fix did not trade one for the other", async () => {
      const server = await makeServerNode("cloud-in", KEY_HOP_A);
      const client = await makeClientNode(
        "boat",
        KEY_HOP_A,
        server.port,
        {},
        {
          useInstanceScopedPaths: false
        }
      );

      await client.pipeline.sendHello(PEER_HOSTNAME, server.port);
      const unscoped = scopedTelemetryDelta("PLACEHOLDER");
      unscoped.updates[0].values = unscoped.updates[0].values.map((v) => ({
        ...v,
        path: v.path.replace("networking.edgeLink.PLACEHOLDER.", "networking.edgeLink.")
      }));
      await client.pipeline.sendDelta([unscoped], KEY_HOP_A, PEER_HOSTNAME, server.port);

      await waitFor(
        () => getMetrics(server).networkQuality.rtt !== undefined,
        "the server to ingest unscoped telemetry paths"
      );
      expect(getMetrics(server).networkQuality.rtt).toBe(42);
    });
  });

  /**
   * Two hops with distinct keys and distinct instance IDs — the deployment the
   * proxy bugs were reported from, over real sockets.
   */
  describe("client → proxy → server over real sockets", () => {
    test("payload survives both hops and no hop rejects a control packet", async () => {
      const cloud = await makeServerNode("cloud-in", KEY_HOP_B);
      const proxyClient = await makeClientNode("proxy-out", KEY_HOP_B, cloud.port);
      const proxyServer = await makeServerNode("proxy-in", KEY_HOP_A);
      const boat = await makeClientNode("boat", KEY_HOP_A, proxyServer.port);

      // A proxy forwards what its own Signal K tree received, not the original
      // object — so any mutation applied inbound is carried onward, as in
      // production.
      proxyServer.app.handleMessage.mockImplementation((_id, delta) => {
        proxyClient.pipeline
          .sendDelta([delta], KEY_HOP_B, PEER_HOSTNAME, cloud.port)
          .catch(() => {});
      });

      await boat.pipeline.sendHello(PEER_HOSTNAME, proxyServer.port);
      await proxyClient.pipeline.sendHello(PEER_HOSTNAME, cloud.port);
      for (let i = 0; i < 5; i++) {
        await boat.pipeline.sendDelta(
          [sampleDelta(10 + i)],
          KEY_HOP_A,
          PEER_HOSTNAME,
          proxyServer.port
        );
      }

      await waitFor(
        () => cloud.app.handleMessage.mock.calls.length > 0,
        "the boat's data to reach the cloud through the proxy"
      );

      const atCloud = cloud.app.handleMessage.mock.calls.map((c) => c[c.length - 1]);
      const values = atCloud.flatMap((d) => d.updates.flatMap((u) => u.values));
      const pos = values.find((v) => v.path === "navigation.position");
      expect(pos).toBeDefined();
      expect(pos.value.longitude).toBeCloseTo(24.9, 6);

      // Both hops must keep their reliability layer alive. A single rejected
      // control packet on either is the silent stall.
      await waitFor(
        () => (boat.metricsApi.metrics.rttSamples ?? 0) > 0,
        "the boat to time an ACK from the proxy"
      );
      expect(boat.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
      expect(proxyClient.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
    });
  });

  /**
   * epochBoundAuth over real sockets. The matched case must carry data; the
   * mismatched case must fail with the reason NAMED, since a wrong diagnosis
   * here sent an operator to change a setting that was already correct.
   */
  describe("epochBoundAuth agreement, over real sockets", () => {
    test("receiver requires it, sender does not: refused and named", async () => {
      const server = await makeServerNode("cloud-in", KEY_HOP_A, { epochBoundAuth: true });
      const client = await makeClientNode("boat", KEY_HOP_A, server.port, {
        epochBoundAuth: false
      });

      await client.pipeline.sendHello(PEER_HOSTNAME, server.port);
      for (let i = 0; i < 3; i++) {
        await client.pipeline.sendDelta([sampleDelta(i)], KEY_HOP_A, PEER_HOSTNAME, server.port);
      }

      await waitFor(
        () => (server.metricsApi.metrics.epochAuthMismatches ?? 0) > 0,
        "the server to record an epoch-bound auth mismatch"
      );

      const logged = server.app.error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/epochBoundAuth/);
      // The two messages that pointed at the wrong machine.
      expect(logged).not.toMatch(/stretchAsciiKey|key-format mismatch/);
      expect(logged).not.toMatch(/tampered or wrong key/);
    });
  });
});
