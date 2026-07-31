"use strict";

/**
 * Boat → Proxy → Cloud over REAL UDP sockets, with peers configured by
 * hostname rather than IP address.
 *
 * Every other end-to-end test in this repo pipes bytes in-process and hands the
 * receiver a synthetic `rinfo`. That skips the entire address layer: DNS
 * resolution, what the kernel actually reports as a datagram's source, and the
 * IPv4-mapped (`::ffff:`) form an IPv6-capable socket produces. `isExpectedPeer`
 * lives precisely there — it compares the configured peer against `rinfo.address`
 * and silently drops every ACK and NAK when they disagree.
 *
 * That is not hypothetical. A string comparison of a configured hostname against
 * a literal `rinfo.address` never matches, which stalled RTT measurement, froze
 * the cumulative ACK and let the retransmit queue grow without bound — and no
 * test in the suite could see it, because none of them used a socket.
 *
 * Hostnames are used deliberately: real deployments configure a name, not an
 * address, so this is the resolution path that actually runs in production and
 * the one that took the most correcting.
 */

const dgram = require("dgram");
const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { makeMetricsApi } = require("../helpers/metrics-fixture");

const BOAT_TO_PROXY_KEY = "11111111111111111111111111111111";
const PROXY_TO_CLOUD_KEY = "22222222222222222222222222222222";

// Resolves to a loopback literal, so rinfo.address never equals the configured
// string and the resolution path must do the work.
const PEER_HOSTNAME = "localhost";

jest.setTimeout(30000);

function bindSocket() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const onBindError = (err) => reject(err);
    socket.once("error", onBindError);
    socket.bind(0, "127.0.0.1", () => {
      // Hand the socket a permanent error listener. Without one, a socket
      // error after bind is an unhandled 'error' event, which throws out of
      // the event loop and fails the run with a stack that names neither the
      // test nor the socket. Recording it lets a test assert on it instead.
      socket.off("error", onBindError);
      socket.socketErrors = [];
      socket.on("error", (err) => socket.socketErrors.push(err));
      resolve(socket);
    });
  });
}

function waitFor(predicate, description, timeoutMs = 10000) {
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
        values: [{ path: "navigation.speedOverGround", value }]
      }
    ]
  };
}

describe("real UDP sockets, hostname-configured peers, Boat → Proxy → Cloud", () => {
  const open = [];
  const timers = [];

  afterEach(async () => {
    for (const stop of timers.splice(0)) {
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

  /** A receiving node: real bound socket, real server pipeline, real ACKs. */
  async function makeServerNode(instanceId, key) {
    const socket = await bindSocket();
    open.push(socket);
    const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const state = {
      instanceId,
      options: {
        secretKey: key,
        udpPort: socket.address().port,
        udpAddress: PEER_HOSTNAME,
        protocolVersion: 3,
        stretchAsciiKey: false,
        reliability: { ackInterval: 25, nakTimeout: 50 }
      },
      socketUdp: socket
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);
    socket.on("message", (msg, rinfo) => {
      pipeline.receivePacket(msg, key, rinfo).catch(() => {});
    });
    pipeline.startACKTimer();
    timers.push(() => pipeline.stopACKTimer());
    return { socket, app, metricsApi, pipeline, port: socket.address().port };
  }

  /**
   * A sending node. `udpAddress` is a HOSTNAME, so both dgram.send and
   * isExpectedPeer have to resolve it; the kernel reports the peer's literal
   * address on the way back.
   */
  async function makeClientNode(instanceId, key, peerPort) {
    const socket = await bindSocket();
    open.push(socket);
    const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const state = {
      instanceId,
      options: {
        secretKey: key,
        udpPort: peerPort,
        udpAddress: PEER_HOSTNAME,
        protocolVersion: 3,
        stretchAsciiKey: false,
        reliability: {},
        congestionControl: {}
      },
      socketUdp: socket,
      deltaTimerTime: 1000,
      avgBytesPerDelta: 100,
      maxDeltasPerBatch: 10,
      stopped: false
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Client(app, state, metricsApi);
    // Mirrors start-client.ts: every inbound datagram on the client socket is a
    // control packet, dispatched with the kernel's rinfo.
    socket.on("message", (msg, rinfo) => {
      pipeline.handleControlPacket(msg, rinfo).catch(() => {});
    });
    return { socket, app, metricsApi, pipeline };
  }

  test("a hostname-configured client measures RTT from real ACKs", async () => {
    const server = await makeServerNode("cloud-in", BOAT_TO_PROXY_KEY);
    const client = await makeClientNode("boat", BOAT_TO_PROXY_KEY, server.port);

    for (let i = 0; i < 5; i++) {
      await client.pipeline.sendDelta(
        [sampleDelta(1 + i)],
        BOAT_TO_PROXY_KEY,
        PEER_HOSTNAME,
        server.port
      );
    }

    await waitFor(
      () => server.app.handleMessage.mock.calls.length > 0,
      "the server to dispatch received deltas"
    );

    // The assertion the in-process suites cannot make: ACKs came back over a
    // real socket, from a literal address, and were accepted against a peer
    // configured by name.
    await waitFor(
      () => (client.metricsApi.metrics.rttSamples ?? 0) > 0,
      "the client to time at least one ACK"
    );

    expect(client.metricsApi.metrics.rtt).toBeGreaterThanOrEqual(0);
    // Zero is the whole point: a single rejection here means the peer check
    // refused a legitimate ACK, which is how the link stalls silently.
    expect(client.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
  });

  test("the retransmit queue drains instead of growing without bound", async () => {
    const server = await makeServerNode("cloud-in", BOAT_TO_PROXY_KEY);
    const client = await makeClientNode("boat", BOAT_TO_PROXY_KEY, server.port);

    for (let i = 0; i < 20; i++) {
      await client.pipeline.sendDelta(
        [sampleDelta(i)],
        BOAT_TO_PROXY_KEY,
        PEER_HOSTNAME,
        server.port
      );
    }

    // A queue that only grows is the visible symptom of dropped ACKs — the
    // "Queue Depth 184" state reported from a real link.
    await waitFor(
      () => client.pipeline.getRetransmitQueue().getSize() === 0,
      "the retransmit queue to drain once ACKs are honoured"
    );

    expect(client.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
  });

  test("data crosses the full chain and both hops keep measuring", async () => {
    const cloud = await makeServerNode("cloud-in", PROXY_TO_CLOUD_KEY);
    const proxyClient = await makeClientNode("proxy-out", PROXY_TO_CLOUD_KEY, cloud.port);
    const proxyServer = await makeServerNode("proxy-in", BOAT_TO_PROXY_KEY);
    const boat = await makeClientNode("boat", BOAT_TO_PROXY_KEY, proxyServer.port);

    // The proxy forwards what its own Signal K tree received, as in production.
    proxyServer.app.handleMessage.mockImplementation((_id, delta) => {
      proxyClient.pipeline
        .sendDelta([delta], PROXY_TO_CLOUD_KEY, PEER_HOSTNAME, cloud.port)
        .catch(() => {});
    });

    for (let i = 0; i < 5; i++) {
      await boat.pipeline.sendDelta(
        [sampleDelta(10 + i)],
        BOAT_TO_PROXY_KEY,
        PEER_HOSTNAME,
        proxyServer.port
      );
    }

    await waitFor(
      () => cloud.app.handleMessage.mock.calls.length > 0,
      "the boat's data to reach the cloud through the proxy"
    );

    const atCloud = cloud.app.handleMessage.mock.calls.map((c) => c[c.length - 1]);
    const values = atCloud.flatMap((d) => (d.updates || []).flatMap((u) => u.values || []));
    expect(values.some((v) => v.path === "navigation.speedOverGround")).toBe(true);

    // Both hops are independent client→server links; each must time its own
    // ACKs. A proxy whose upstream hop never measures is the "RTT N/A" report.
    await waitFor(
      () => (boat.metricsApi.metrics.rttSamples ?? 0) > 0,
      "the boat→proxy hop to measure RTT"
    );
    await waitFor(
      () => (proxyClient.metricsApi.metrics.rttSamples ?? 0) > 0,
      "the proxy→cloud hop to measure RTT"
    );

    expect(boat.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
    expect(proxyClient.metricsApi.metrics.rejectedControlPackets || 0).toBe(0);
  });
});
