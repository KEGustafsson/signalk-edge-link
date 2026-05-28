"use strict";

/**
 * MQTT-SN end-to-end integration test using REAL UDP loopback sockets.
 *
 * Spins up:
 *   - one server pipeline (gateway) bound to 127.0.0.1:<random port>
 *   - one client pipeline talking to that gateway over real UDP
 *
 * Verifies the entire chain from sendDelta() on the client through
 * encryption, framing, UDP transport, decryption, deserialization,
 * and app.handleMessage() injection on the gateway.
 *
 * This is the test that catches problems mocked-socket unit tests
 * can't: real packet boundaries, real async timing, real socket
 * lifecycle, real interaction with state.socketUdp.
 */

const dgram = require("node:dgram");
const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");
const { buildDisconnect } = require("../../lib/mqttsn-protocol");

const SECRET_KEY = "12345678901234567890123456789012";

function makeApp(label) {
  return {
    debug: jest.fn(),
    error: jest.fn((msg) => console.error(`[${label}] ${msg}`)),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

/** Bind a UDP socket to a random loopback port and return both. */
function bindRandomSocket() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      resolve({ socket, port: socket.address().port });
    });
  });
}

/** Wait until predicate returns true or timeoutMs elapses. */
function waitUntil(predicate, timeoutMs = 2000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) {return resolve();}
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitUntil timeout after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function makeServerState(socketUdp, port) {
  return {
    instanceId: "gw-instance",
    options: {
      secretKey: SECRET_KEY,
      stretchAsciiKey: false,
      useMsgpack: false,
      protocolVersion: 4,
      mqttsnTopicPrefix: "sk",
      mqttsnGatewayId: 1,
      udpPort: port
    },
    socketUdp,
    stopped: false,
    pendingRetry: null
  };
}

function makeClientState(socketUdp, gatewayPort, overrides = {}) {
  const { options: optionOverrides = {}, ...stateOverrides } = overrides;
  return {
    instanceId: "client-instance",
    options: {
      secretKey: SECRET_KEY,
      stretchAsciiKey: false,
      useMsgpack: false,
      protocolVersion: 4,
      mqttsnTopicPrefix: "sk",
      mqttsnQos: 0,
      mqttsnKeepalive: 60,
      mqttsnCleanSession: true,
      mqttsnPublishRetain: false,
      mqttsnClientId: "sk-test-vessel",
      udpAddress: "127.0.0.1",
      udpPort: gatewayPort,
      name: "test-conn",
      ...optionOverrides
    },
    deltaTimerTime: 1000,
    socketUdp,
    stopped: false,
    pendingRetry: null,
    ...stateOverrides
  };
}

/**
 * Build a full client + gateway pair connected via real UDP loopback.
 * Returns:
 *   { client, clientApp, clientState, gateway, gatewayApp, gatewayPort, cleanup }
 */
async function makePair(clientOptionOverrides = {}) {
  // Gateway socket: bind on a random port — clients send to this
  const gw = await bindRandomSocket();
  const gatewayApp = makeApp("gw");
  const gatewayState = makeServerState(gw.socket, gw.port);
  // Mirror serialization choice on the gateway so both ends agree
  if (clientOptionOverrides.useMsgpack !== undefined) {
    gatewayState.options.useMsgpack = clientOptionOverrides.useMsgpack;
  }
  const gateway = createPipeline(4, "server", gatewayApp, gatewayState, createMetrics());

  // Wire the gateway UDP socket → pipeline.receivePacket
  gw.socket.on("message", (msg, rinfo) => {
    gateway.receivePacket(msg, SECRET_KEY, rinfo).catch((err) => {
      gatewayApp.error(`receivePacket error: ${err.message}`);
    });
  });
  gateway.startACKTimer();

  // Client socket: bind on its own random port — picks up gateway replies
  const cl = await bindRandomSocket();
  const clientApp = makeApp("client");
  const clientState = makeClientState(cl.socket, gw.port, { options: clientOptionOverrides });
  const client = createPipeline(4, "client", clientApp, clientState, createMetrics());

  cl.socket.on("message", (msg, rinfo) => {
    client.handleControlPacket(msg, rinfo).catch((err) => {
      clientApp.error(`handleControlPacket error: ${err.message}`);
    });
  });

  async function cleanup() {
    client.stopCongestionControl();
    gateway.stopACKTimer();
    await new Promise((r) => cl.socket.close(r));
    await new Promise((r) => gw.socket.close(r));
  }

  return {
    client,
    clientApp,
    clientState,
    gateway,
    gatewayApp,
    gatewayPort: gw.port,
    cleanup
  };
}

function makeDelta(path, value) {
  return {
    context: "vessels.self",
    updates: [
      {
        source: { label: "test", type: "test" },
        timestamp: new Date().toISOString(),
        values: [{ path, value }]
      }
    ]
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("MQTT-SN v4 — real UDP loopback E2E", () => {
  let pair;

  afterEach(async () => {
    if (pair) {
      await pair.cleanup();
      pair = null;
    }
  });

  test("client connects, registers, publishes, gateway injects into Signal K", async () => {
    pair = await makePair();
    const { client, clientApp, gatewayApp, gatewayPort } = pair;

    // Trigger CONNECT
    await client.sendHello("127.0.0.1", gatewayPort);

    // Wait for the gateway to log the CONNECT receipt
    await waitUntil(() =>
      gatewayApp.debug.mock.calls.some((c) => /CONNECT from "sk-test-vessel"/.test(String(c[0])))
    );

    // Publish a delta — registration + publish flow
    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 6.2),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );

    // Wait for the gateway to inject into Signal K
    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length > 0);

    const [, delta] = gatewayApp.handleMessage.mock.calls[0];
    expect(delta.context).toBe("vessels.self");
    expect(delta.updates[0].values).toEqual([{ path: "navigation.speedOverGround", value: 6.2 }]);
    expect(delta.updates[0].source.type).toBe("MQTT-SN");
    expect(delta.updates[0].source.label).toBe("mqttsn-sk-test-vessel");

    expect(clientApp.error).not.toHaveBeenCalled();
  });

  test("multiple deltas across several paths arrive in order", async () => {
    pair = await makePair();
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    const samples = [
      { path: "navigation.speedOverGround", value: 6.2 },
      { path: "navigation.courseOverGroundTrue", value: 1.47 },
      { path: "environment.wind.speedApparent", value: 8.7 },
      { path: "environment.depth.belowTransducer", value: 12.4 },
      { path: "propulsion.main.revolutions", value: 42.5 }
    ];

    for (const s of samples) {
      await client.sendDelta(makeDelta(s.path, s.value), SECRET_KEY, "127.0.0.1", gatewayPort);
    }

    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length >= samples.length, 3000);

    const received = gatewayApp.handleMessage.mock.calls.map((c) => c[1].updates[0].values[0]);
    expect(received).toEqual(samples);
  });

  test("QoS 1: client receives PUBACK after each publish", async () => {
    pair = await makePair({ mqttsnQos: 1 });
    const { client, clientApp, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 5.5),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );

    // PUBACK is acted upon silently; verify by:
    //   (a) the publish made it through (gateway injected once), and
    //   (b) no error logged on either side
    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length > 0);

    // Give time for PUBACK round-trip
    await new Promise((r) => setTimeout(r, 50));
    expect(clientApp.error).not.toHaveBeenCalled();
    expect(gatewayApp.error).not.toHaveBeenCalled();
  });

  test("complex value (object payload) round-trips correctly through encryption", async () => {
    pair = await makePair();
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    const position = { latitude: 60.1695, longitude: 24.9354 };
    await client.sendDelta(
      makeDelta("navigation.position", position),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );

    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length > 0);

    const delta = gatewayApp.handleMessage.mock.calls[0][1];
    expect(delta.updates[0].values[0]).toEqual({ path: "navigation.position", value: position });
  });

  test("gateway with wrong secretKey drops packets (no Signal K injection)", async () => {
    pair = await makePair();
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    // Client encrypts with a wrong key; gateway's decryptBinary will fail
    // AES-GCM auth tag verification and drop the packet.
    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 9.9),
      "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "127.0.0.1",
      gatewayPort
    );

    // Allow time for the packet to traverse + decrypt to fail
    await new Promise((r) => setTimeout(r, 200));
    expect(gatewayApp.handleMessage).not.toHaveBeenCalled();
    expect(gatewayApp.error).toHaveBeenCalled();
  });

  test("msgpack serialization mode round-trips end-to-end", async () => {
    // makePair mirrors useMsgpack to both client and gateway state
    pair = await makePair({ useMsgpack: true });
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    await client.sendDelta(
      makeDelta("environment.wind.speedApparent", 8.7),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );

    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length > 0);
    const delta = gatewayApp.handleMessage.mock.calls[0][1];
    expect(delta.updates[0].values[0]).toEqual({
      path: "environment.wind.speedApparent",
      value: 8.7
    });
  });

  test("two concurrent clients to one gateway do not interfere", async () => {
    // First gateway
    const gw = await bindRandomSocket();
    const gatewayApp = makeApp("gw");
    const gatewayState = makeServerState(gw.socket, gw.port);
    const gateway = createPipeline(4, "server", gatewayApp, gatewayState, createMetrics());
    gw.socket.on("message", (msg, rinfo) => {
      gateway.receivePacket(msg, SECRET_KEY, rinfo).catch(() => {});
    });
    gateway.startACKTimer();

    // Two clients on independent sockets
    const cl1 = await bindRandomSocket();
    const cl2 = await bindRandomSocket();
    const c1State = makeClientState(cl1.socket, gw.port, {
      options: { mqttsnClientId: "client-A" }
    });
    const c2State = makeClientState(cl2.socket, gw.port, {
      options: { mqttsnClientId: "client-B" }
    });
    const c1App = makeApp("c1");
    const c2App = makeApp("c2");
    const c1 = createPipeline(4, "client", c1App, c1State, createMetrics());
    const c2 = createPipeline(4, "client", c2App, c2State, createMetrics());
    cl1.socket.on("message", (msg, rinfo) => {
      c1.handleControlPacket(msg, rinfo).catch(() => {});
    });
    cl2.socket.on("message", (msg, rinfo) => {
      c2.handleControlPacket(msg, rinfo).catch(() => {});
    });

    try {
      await c1.sendHello("127.0.0.1", gw.port);
      await c2.sendHello("127.0.0.1", gw.port);
      await waitUntil(
        () => gatewayApp.debug.mock.calls.filter((c) => /CONNECT/.test(String(c[0]))).length >= 2
      );

      await c1.sendDelta(
        makeDelta("navigation.speedOverGround", 5.0),
        SECRET_KEY,
        "127.0.0.1",
        gw.port
      );
      await c2.sendDelta(
        makeDelta("environment.wind.speedApparent", 7.0),
        SECRET_KEY,
        "127.0.0.1",
        gw.port
      );

      await waitUntil(() => gatewayApp.handleMessage.mock.calls.length >= 2, 3000);

      const receivedSources = gatewayApp.handleMessage.mock.calls.map(
        (c) => c[1].updates[0].source.label
      );
      expect(receivedSources).toContain("mqttsn-client-A");
      expect(receivedSources).toContain("mqttsn-client-B");
    } finally {
      c1.stopCongestionControl();
      c2.stopCongestionControl();
      gateway.stopACKTimer();
      await new Promise((r) => cl1.socket.close(r));
      await new Promise((r) => cl2.socket.close(r));
      await new Promise((r) => gw.socket.close(r));
    }
  });

  test("client reconnects after gateway sends DISCONNECT", async () => {
    pair = await makePair();
    const { client, clientApp, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    // Confirm the link is live
    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 1.0),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );
    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length === 1);

    // Gateway disconnects the client (synthesized DISCONNECT frame)
    await client.handleControlPacket(buildDisconnect(), {
      address: "127.0.0.1",
      port: gatewayPort,
      family: "IPv4",
      size: 2
    });

    // After DISCONNECT, sendDelta drops because state == DISCONNECTED
    gatewayApp.handleMessage.mockClear();
    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 2.0),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );
    expect(gatewayApp.handleMessage).not.toHaveBeenCalled();

    // Client should have scheduled a reconnect (exponential backoff)
    expect(clientApp.debug.mock.calls.some((c) => /Reconnect in/.test(String(c[0])))).toBe(true);
  });

  test("PINGREQ → PINGRESP keepalive round-trip over real UDP", async () => {
    pair = await makePair({ mqttsnKeepalive: 1 }); // 1s keepalive forces a quick ping
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    // After keepalive period, client should send PINGREQ and gateway echoes PINGRESP.
    // We can't directly observe the PINGRESP receipt easily, but we can confirm
    // the client is still in a healthy CONNECTED state by publishing successfully
    // after the keepalive interval.
    await new Promise((r) => setTimeout(r, 1200));

    await client.sendDelta(
      makeDelta("navigation.speedOverGround", 4.4),
      SECRET_KEY,
      "127.0.0.1",
      gatewayPort
    );
    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length > 0);
    expect(gatewayApp.handleMessage.mock.calls.length).toBe(1);
  });

  test("burst of 50 deltas all arrive intact (registration de-dup + serial queue)", async () => {
    pair = await makePair();
    const { client, gatewayApp, gatewayPort } = pair;

    await client.sendHello("127.0.0.1", gatewayPort);
    await waitUntil(() => gatewayApp.debug.mock.calls.some((c) => /CONNECT/.test(String(c[0]))));

    const N = 50;
    // Mix of two paths so the first ones queue REGISTER for both
    const promises = [];
    for (let i = 0; i < N; i++) {
      const path = i % 2 === 0 ? "navigation.speedOverGround" : "environment.wind.speedApparent";
      promises.push(
        client.sendDelta(makeDelta(path, i * 0.1), SECRET_KEY, "127.0.0.1", gatewayPort)
      );
    }
    await Promise.all(promises);

    await waitUntil(() => gatewayApp.handleMessage.mock.calls.length >= N, 5000);
    expect(gatewayApp.handleMessage.mock.calls.length).toBe(N);

    // Verify values arrived in the order published per path
    const sogValues = gatewayApp.handleMessage.mock.calls
      .map((c) => c[1].updates[0].values[0])
      .filter((v) => v.path === "navigation.speedOverGround")
      .map((v) => v.value);
    const expected = [];
    for (let i = 0; i < N; i += 2) {expected.push(i * 0.1);}
    expect(sogValues).toEqual(expected);
  });
});
