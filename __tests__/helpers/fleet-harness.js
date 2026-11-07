"use strict";

/**
 * In-process fleet sharing harness (protocol-v3-spec §15): a hub server
 * pipeline and client pipelines whose sockets queue datagrams, so a test
 * decides when each one is delivered, dropped or delayed.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketParser } = require("../../lib/packet");
const { makeMetricsApi } = require("./metrics-fixture");

const secretKey = "12345678901234567890123456789012";
const HUB_PORT = 9300;
const HUB_ADDR = "127.0.0.1";

const urn = (mmsi) => `vessels.urn:mrn:imo:mmsi:${mmsi}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal Signal K bus: handleMessage feeds every subscriber synchronously. */
function makeBusApp(mmsi) {
  const subscribers = [];
  const received = [];
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    getSelfPath: (path) => (path === "mmsi" ? mmsi : undefined),
    handleMessage: jest.fn((_id, delta) => {
      received.push(delta);
      for (const fn of subscribers) {
        fn(delta);
      }
    }),
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes, _onError, onDelta) => {
        subscribers.push(onDelta);
        unsubscribes.push(() => {
          const i = subscribers.indexOf(onDelta);
          if (i >= 0) {
            subscribers.splice(i, 1);
          }
        });
      }
    }
  };
  return { app, received, subscribers };
}

function makeHub(fleetSharing, extraOptions = {}) {
  const bus = makeBusApp("999000999");
  const toClients = [];
  const state = {
    instanceId: "hub",
    options: {
      secretKey,
      udpPort: HUB_PORT,
      protocolVersion: 3,
      reliability: { nakTimeout: 20 },
      fleetSharing,
      ...extraOptions
    },
    socketUdp: {
      send: jest.fn((pkt, port, address, cb) => {
        toClients.push({ pkt: Buffer.from(pkt), port, address });
        if (cb) {
          cb(null);
        }
      })
    }
  };
  const metricsApi = makeMetricsApi();
  const server = createPipelineV2Server(bus.app, state, metricsApi);
  return { server, state, bus, toClients, metricsApi };
}

function makeClient(
  mmsi,
  port,
  fleetSharing = { enabled: true },
  extraOptions = {},
  appExtras = {}
) {
  const bus = makeBusApp(mmsi);
  Object.assign(bus.app, appExtras);
  const toHub = [];
  const state = {
    instanceId: `client-${port}`,
    options: {
      secretKey,
      udpPort: HUB_PORT,
      udpAddress: HUB_ADDR,
      protocolVersion: 3,
      reliability: { nakTimeout: 20 },
      fleetSharing,
      ...extraOptions
    },
    socketUdp: {
      send: jest.fn((pkt, _port, _addr, cb) => {
        toHub.push(Buffer.from(pkt));
        if (cb) {
          cb(null);
        }
      })
    },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const metricsApi = makeMetricsApi();
  const client = createPipelineV2Client(bus.app, state, metricsApi);
  return { mmsi, self: urn(mmsi), port, client, state, bus, toHub, metricsApi };
}

/**
 * Wait until the Brotli work in flight now (tracked in jest.setup.ts) has
 * finished, so a packet whose compression or decompression already started is
 * built or applied before the next step. Work that starts later, such as the
 * next fleet tick, is not waited for. Bounded, so a stuck operation fails the
 * test instead of hanging it.
 */
async function settleBrotli() {
  const inFlight = require("node:zlib").edgeLinkBrotliInFlight;
  if (!inFlight || inFlight.size === 0) {
    return;
  }
  const started = [...inFlight];
  for (let i = 0; i < 1000 && started.some((id) => inFlight.has(id)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Move every queued datagram until both directions are quiet. */
async function pump(hub, clients, rounds = 6) {
  for (let r = 0; r < rounds; r++) {
    await settleBrotli();
    for (const c of clients) {
      const batch = c.toHub.splice(0);
      for (const pkt of batch) {
        await hub.server.receivePacket(pkt, secretKey, { address: "10.0.0.1", port: c.port });
      }
    }
    const out = hub.toClients.splice(0);
    for (const { pkt, port } of out) {
      const c = clients.find((x) => x.port === port);
      if (c) {
        await c.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT });
      }
    }
    // Packets this round's decoding or encoding produced count as traffic too.
    await settleBrotli();
    if (hub.toClients.length === 0 && clients.every((c) => c.toHub.length === 0)) {
      return;
    }
  }
}

/**
 * Pump until `done()` holds or `timeoutMs` passes. Fleet packets are
 * Brotli-compressed and decoded on the libuv threadpool, so a fixed wait can
 * end before a busy machine has built or applied them.
 */
async function pumpUntil(hub, clients, done, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await pump(hub, clients);
    if (done() || Date.now() >= deadline) {
      return;
    }
    await wait(20);
  }
}

function sog(context, value, source = "n2k.115") {
  return {
    context,
    updates: [
      {
        $source: source,
        timestamp: new Date().toISOString(),
        values: [{ path: "navigation.speedOverGround", value }]
      }
    ]
  };
}

function contextsReceived(c) {
  return new Set(c.bus.received.map((d) => d.context));
}

function lastSog(c, context) {
  const values = c.bus.received
    .filter((d) => d.context === context)
    .flatMap((d) => d.updates.flatMap((u) => u.values))
    .filter((v) => v.path === "navigation.speedOverGround");
  return values.length ? values[values.length - 1].value : undefined;
}

const typesSentTo = (hub, port) => {
  const parser = new PacketParser({ secretKey });
  return hub.state.socketUdp.send.mock.calls
    .filter((call) => call[1] === port)
    .map((call) => {
      try {
        return parser.parseHeader(Buffer.from(call[0]), { epoch: 0 }).type;
      } catch {
        return -1;
      }
    });
};

/** Deliver what `c` sent to the hub. */
async function deliverToHub(hub, c) {
  for (const pkt of c.toHub.splice(0)) {
    await hub.server.receivePacket(pkt, secretKey, { address: "10.0.0.1", port: c.port });
  }
}

/** Deliver what the hub sent to `c`; datagrams for other clients are dropped. */
async function deliverToClient(hub, c) {
  for (const { pkt, port } of hub.toClients.splice(0)) {
    if (port === c.port) {
      await c.client.handleControlPacket(pkt, { address: HUB_ADDR, port: HUB_PORT });
    }
  }
}

module.exports = {
  secretKey,
  HUB_PORT,
  HUB_ADDR,
  urn,
  wait,
  makeBusApp,
  makeHub,
  makeClient,
  pump,
  pumpUntil,
  sog,
  contextsReceived,
  lastSog,
  typesSentTo,
  deliverToHub,
  deliverToClient
};
