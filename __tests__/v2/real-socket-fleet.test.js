"use strict";

/**
 * Fleet sharing over real UDP sockets (protocol-v3-spec §15), asserted
 * through GET /metrics — the JSON the web UI renders.
 *
 * The in-process suite (fleet-sharing.test.js) hands the client a synthetic
 * `rinfo`. Here every datagram crosses the kernel: clients are configured by
 * HOSTNAME, so the client's peer check must resolve "localhost" before it
 * accepts the hub's HELLO_ACK and FLEET_DATA, and the hub replies to the
 * source port the kernel reports — the same mapping a NAT would create. Each
 * client binds an ephemeral port and runs no server: fleet data reaches it
 * only through the session it opened.
 */

const dgram = require("dgram");
const createRoutes = require("../../lib/routes");
const createMetrics = require("../../lib/metrics");
const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");

const KEY = "33333333333333333333333333333333";
const PEER_HOSTNAME = "localhost";

jest.setTimeout(45000);

const urn = (mmsi) => `vessels.urn:mrn:imo:mmsi:${mmsi}`;

function bindSocket() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
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

/** A Signal K bus: handleMessage feeds every subscriber synchronously. */
function makeBusApp(mmsi) {
  const subscribers = [];
  const received = [];
  return {
    received,
    app: {
      debug: () => {},
      error: () => {},
      getSelfPath: (path) => (path === "mmsi" ? mmsi : undefined),
      handleMessage: (_id, delta) => {
        received.push(delta);
        for (const fn of subscribers) {
          fn(delta);
        }
      },
      subscriptionmanager: {
        subscribe: (_sub, unsubscribes, _onError, onDelta) => {
          subscribers.push(onDelta);
          unsubscribes.push(() => subscribers.splice(subscribers.indexOf(onDelta), 1));
        }
      }
    }
  };
}

function getMetrics(node) {
  const bundle = {
    id: node.instanceId,
    name: node.instanceId,
    state: node.state,
    metricsApi: node.metricsApi
  };
  const routes = createRoutes(
    { debug: () => {}, error: () => {} },
    { getAll: () => [bundle], getFirst: () => bundle, getById: () => bundle },
    { _currentOptions: {} }
  );
  const collected = [];
  routes.registerWithRouter({
    get: (path, ...handlers) => collected.push({ path, handlers }),
    post: () => {},
    put: () => {},
    delete: () => {}
  });
  const res = {
    body: undefined,
    status() {
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
  collected.find((r) => r.path === "/metrics").handlers.at(-1)(
    { headers: {}, params: {}, query: {} },
    res
  );
  return res.body;
}

function sog(context, value) {
  return {
    context,
    updates: [
      {
        $source: "n2k.115",
        timestamp: new Date().toISOString(),
        values: [{ path: "navigation.speedOverGround", value }]
      }
    ]
  };
}

describe("fleet sharing over real sockets", () => {
  const sockets = [];
  const stops = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch {
        /* already stopped */
      }
    }
    await Promise.all(sockets.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function makeHub(serverOptions = {}) {
    const socket = await bindSocket();
    sockets.push(socket);
    const bus = makeBusApp("999000999");
    const metricsApi = createMetrics();
    const state = {
      instanceId: "hub",
      isServerMode: true,
      instanceStatus: "running",
      deltas: [],
      startTime: Date.now(),
      monitoring: null,
      options: {
        secretKey: KEY,
        udpPort: socket.address().port,
        protocolVersion: 3,
        reliability: { ackInterval: 25, nakTimeout: 60 },
        fleetSharing: { enabled: true, batchIntervalMs: 100 },
        ...serverOptions
      },
      socketUdp: socket
    };
    const pipeline = createPipelineV2Server(bus.app, state, metricsApi);
    state.pipelineServer = pipeline;
    socket.on("message", (msg, rinfo) => pipeline.receivePacket(msg, KEY, rinfo).catch(() => {}));
    pipeline.startACKTimer();
    stops.push(() => pipeline.stop());
    return { instanceId: "hub", bus, metricsApi, state, pipeline, port: socket.address().port };
  }

  async function makeVessel(mmsi, hubPort, clientOptions = {}) {
    const socket = await bindSocket();
    sockets.push(socket);
    const bus = makeBusApp(mmsi);
    const metricsApi = createMetrics();
    const state = {
      instanceId: `vessel-${socket.address().port}`,
      isServerMode: false,
      instanceStatus: "running",
      deltas: [],
      startTime: Date.now(),
      monitoring: null,
      connectionEpoch: Date.now(),
      options: {
        secretKey: KEY,
        udpPort: hubPort,
        udpAddress: PEER_HOSTNAME,
        protocolVersion: 3,
        reliability: {},
        congestionControl: {},
        fleetSharing: { enabled: true },
        ...clientOptions
      },
      socketUdp: socket,
      deltaTimerTime: 1000,
      avgBytesPerDelta: 100,
      maxDeltasPerBatch: 10,
      readyToSend: true,
      stopped: false
    };
    const pipeline = createPipelineV2Client(bus.app, state, metricsApi);
    state.pipeline = pipeline;
    socket.on("message", (msg, rinfo) => pipeline.handleControlPacket(msg, rinfo).catch(() => {}));
    stops.push(() => pipeline.stop());
    await pipeline.sendHello(PEER_HOSTNAME, hubPort);
    return { instanceId: state.instanceId, self: urn(mmsi), bus, metricsApi, state, pipeline };
  }

  const fleetOf = (node) => getMetrics(node).fleet;
  const contexts = (node) => new Set(node.bus.received.map((d) => d.context));

  test.each([
    ["defaults", {}],
    [
      "msgpack + path dictionary + epochBoundAuth",
      { useMsgpack: true, usePathDictionary: true, epochBoundAuth: true }
    ]
  ])("three vessels each receive the other two (%s)", async (_name, codec) => {
    const hub = await makeHub(codec);
    const vessels = [];
    for (const mmsi of ["230000001", "230000002", "230000003"]) {
      vessels.push(await makeVessel(mmsi, hub.port, codec));
    }
    await waitFor(
      () => vessels.every((v) => fleetOf(v)?.state === "active"),
      "every vessel's fleet state to be active"
    );
    expect(fleetOf(hub).members).toBe(3);

    for (const [i, v] of vessels.entries()) {
      await v.pipeline.sendDelta([sog(v.self, i + 0.5)], KEY, PEER_HOSTNAME, hub.port);
    }
    await waitFor(
      () => vessels.every((v) => vessels.every((o) => o === v || contexts(v).has(o.self))),
      "every vessel to receive the other two"
    );

    for (const v of vessels) {
      expect(contexts(v).has(v.self)).toBe(false);
      const m = fleetOf(v);
      expect(m.contextsKnown).toBe(2);
      expect(m.rejectedPackets).toBe(0);
    }
    const hubFleet = fleetOf(hub);
    expect(hubFleet.packetsSent).toBeGreaterThan(0);
    expect(hubFleet.identityConflicts).toBe(0);
    // The hub's own tree holds each vessel exactly once, from its owner.
    expect(hubFleet.originDrops).toBe(0);
  });

  test("a hub with fleet sharing off is reported as declined through GET /metrics", async () => {
    const hub = await makeHub({ fleetSharing: { enabled: false } });
    const vessel = await makeVessel("230000009", hub.port);
    await waitFor(() => fleetOf(vessel)?.state === "declined", "fleet state declined");
    expect(getMetrics(hub).fleet).toBeNull();
  });
});
