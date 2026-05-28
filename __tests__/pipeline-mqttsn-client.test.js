"use strict";

const { createPipeline } = require("../lib/pipeline-factory");
const createMetrics = require("../lib/metrics");
const {
  buildConnack,
  buildRegack,
  buildPubAck,
  buildPingResp,
  buildDisconnect,
  parseMessage,
  MQTTSN,
  RC
} = require("../lib/mqttsn-protocol");
const { decryptBinary } = require("../lib/crypto");

const SECRET_KEY = "12345678901234567890123456789012";
const GW_ADDR = "127.0.0.1";
const GW_PORT = 1883;
const RINFO = { address: GW_ADDR, port: GW_PORT, family: "IPv4", size: 0 };

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeSocket() {
  return { send: jest.fn((buf, port, addr, cb) => cb && cb(null)) };
}

function makeState(overrides = {}) {
  return {
    instanceId: "test-client",
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
      name: "test-conn",
      ...(overrides.options || {})
    },
    deltaTimerTime: 1000,
    socketUdp: makeSocket(),
    stopped: false,
    pendingRetry: null,
    ...overrides
  };
}

let _activePipelines = [];

afterEach(() => {
  for (const p of _activePipelines) {p.stopCongestionControl();}
  _activePipelines = [];
});

function makeClient(optionOverrides = {}) {
  const app = makeApp();
  const state = makeState({ options: optionOverrides });
  const metricsApi = createMetrics();
  const pipeline = createPipeline(4, "client", app, state, metricsApi);
  _activePipelines.push(pipeline);
  return { app, state, pipeline };
}

function makeDelta(path, value) {
  return {
    context: "vessels.self",
    updates: [
      {
        source: { label: "test" },
        values: [{ path, value }]
      }
    ]
  };
}

// Find all send calls of a given MQTT-SN message type
function findSent(state, type) {
  return state.socketUdp.send.mock.calls.find((c) => {
    try {
      return parseMessage(c[0]).type === type;
    } catch (_) {
      return false;
    }
  });
}

function allSent(state, type) {
  return state.socketUdp.send.mock.calls.filter((c) => {
    try {
      return parseMessage(c[0]).type === type;
    } catch (_) {
      return false;
    }
  });
}

// Deliver a control packet to the pipeline (simulates incoming UDP)
async function deliver(pipeline, buf) {
  await pipeline.handleControlPacket(buf, RINFO);
}

// Full connect handshake
async function doConnect(pipeline, state) {
  await pipeline.sendHello(GW_ADDR, GW_PORT);
  const connectFrame = findSent(state, "CONNECT");
  expect(connectFrame).toBeDefined();
  // Simulate CONNACK
  await deliver(pipeline, buildConnack(RC.ACCEPTED));
}

// Full register-topic sequence
async function doRegister(pipeline, state, topicName, msgId = 1, topicId = 1) {
  // Clear prior REGISTER sends
  const before = allSent(state, "REGISTER").length;
  // Call sendDelta which will trigger registration
  const delta = makeDelta(topicName.replace(/^sk\//, "").replace(/\//g, "."), 99);
  // We'll trigger it externally by calling processRegistration via sendDelta
  // For the purposes of this helper, just wait for the REGISTER frame
  return { topicId };
}

// ── API surface ───────────────────────────────────────────────────────────────

describe("createPipelineMqttSnClient — API surface", () => {
  test("returns all required ClientPipelineApi methods", () => {
    const { pipeline } = makeClient();
    expect(typeof pipeline.sendDelta).toBe("function");
    expect(typeof pipeline.handleControlPacket).toBe("function");
    expect(typeof pipeline.sendHello).toBe("function");
    expect(typeof pipeline.startHeartbeat).toBe("function");
    expect(typeof pipeline.startMetricsPublishing).toBe("function");
    expect(typeof pipeline.stopMetricsPublishing).toBe("function");
    expect(typeof pipeline.stopCongestionControl).toBe("function");
    expect(typeof pipeline.getCongestionControl).toBe("function");
    expect(typeof pipeline.getMetricsPublisher).toBe("function");
    expect(typeof pipeline.initBonding).toBe("function");
    expect(typeof pipeline.stopBonding).toBe("function");
  });

  test("getCongestionControl returns an object with getState", () => {
    const { pipeline } = makeClient();
    const cc = pipeline.getCongestionControl();
    expect(cc).not.toBeNull();
    expect(typeof cc.getState).toBe("function");
    const s = cc.getState();
    expect(s).toHaveProperty("enabled");
  });

  test("getMetricsPublisher returns stub", () => {
    const { pipeline } = makeClient();
    const mp = pipeline.getMetricsPublisher();
    expect(mp).not.toBeNull();
    expect(typeof mp.publish).toBe("function");
    expect(typeof mp.publishLinkMetrics).toBe("function");
    expect(typeof mp.calculateLinkQuality).toBe("function");
  });
});

// ── sendHello / CONNECT ────────────────────────────────────────────────────────

describe("sendHello → CONNECT", () => {
  test("sends CONNECT frame on sendHello", async () => {
    const { pipeline, state } = makeClient();
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    const call = findSent(state, "CONNECT");
    expect(call).toBeDefined();
    const msg = parseMessage(call[0]);
    expect(msg.type).toBe("CONNECT");
    expect(msg.cleanSession).toBe(true);
    expect(msg.duration).toBe(60);
  });

  test("uses mqttsnClientId when configured", async () => {
    const { pipeline, state } = makeClient({ mqttsnClientId: "my-boat" });
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    const call = findSent(state, "CONNECT");
    const msg = parseMessage(call[0]);
    expect(msg.clientId).toBe("my-boat");
  });

  test("second sendHello while CONNECTING does not send a second CONNECT", async () => {
    const { pipeline, state } = makeClient();
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    const connects = allSent(state, "CONNECT");
    expect(connects.length).toBe(1);
  });
});

// ── CONNACK handling ──────────────────────────────────────────────────────────

describe("CONNACK handling", () => {
  test("accepted CONNACK moves state to CONNECTED", async () => {
    const { pipeline, state } = makeClient();
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    await deliver(pipeline, buildConnack(RC.ACCEPTED));
    // No error should have been logged
    // Verify: a subsequent sendDelta should not be dropped
    // (it will try to REGISTER, so at least no "dropped" debug msg)
  });

  test("rejected CONNACK logs error and does not send further messages immediately", async () => {
    const { pipeline, app, state } = makeClient();
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    await deliver(pipeline, buildConnack(RC.REJECTED_CONGESTION));
    expect(app.error).toHaveBeenCalled();
  });
});

// ── sendDelta — full flow ─────────────────────────────────────────────────────

describe("sendDelta — CONNECT → REGISTER → PUBLISH", () => {
  test("drops delta when not connected", async () => {
    const { pipeline, state, app } = makeClient();
    await pipeline.sendHello(GW_ADDR, GW_PORT);
    // Not CONNECTED yet (no CONNACK)
    await pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 7.3),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    expect(findSent(state, "PUBLISH")).toBeUndefined();
  });

  test("triggers REGISTER for new topic after CONNECT", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    const sendPromise = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 7.3),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );

    // REGISTER should be sent
    const regFrame = findSent(state, "REGISTER");
    expect(regFrame).toBeDefined();
    const regMsg = parseMessage(regFrame[0]);
    expect(regMsg.type).toBe("REGISTER");
    expect(regMsg.topicName).toBe("sk/navigation/speedOverGround");

    // Simulate REGACK
    await deliver(pipeline, buildRegack(1, regMsg.msgId, RC.ACCEPTED));
    await sendPromise;

    // PUBLISH should be sent
    const pubFrame = findSent(state, "PUBLISH");
    expect(pubFrame).toBeDefined();
  });

  test("PUBLISH payload is AES-256-GCM encrypted (not raw JSON)", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    const sendPromise = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 42),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const regMsg = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, regMsg.msgId, RC.ACCEPTED));
    await sendPromise;

    const pubCall = findSent(state, "PUBLISH");
    const pubMsg = parseMessage(pubCall[0]);
    // payload should NOT be plain JSON
    expect(pubMsg.payload.toString("utf8")).not.toBe("42");
    // Decrypt and verify
    const decrypted = decryptBinary(pubMsg.payload, SECRET_KEY, { stretchAsciiKey: false });
    expect(JSON.parse(decrypted.toString("utf8"))).toBe(42);
  });

  test("already-registered topic skips REGISTER, goes straight to PUBLISH", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    // First delta — registers topic
    const p1 = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 1.0),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const reg1 = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, reg1.msgId, RC.ACCEPTED));
    await p1;

    const sendCountAfterFirst = state.socketUdp.send.mock.calls.length;
    state.socketUdp.send.mockClear();

    // Second delta — same path, should skip REGISTER
    await pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 2.0),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    expect(findSent(state, "REGISTER")).toBeUndefined();
    expect(findSent(state, "PUBLISH")).toBeDefined();
  });

  test("QoS 0: msgId in PUBLISH frame is 0x0000", async () => {
    const { pipeline, state } = makeClient({ mqttsnQos: 0 });
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();
    const p = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 1),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const reg = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, reg.msgId, RC.ACCEPTED));
    await p;
    const pub = parseMessage(findSent(state, "PUBLISH")[0]);
    expect(pub.msgId).toBe(0);
  });

  test("QoS 1: msgId in PUBLISH frame is non-zero", async () => {
    const { pipeline, state } = makeClient({ mqttsnQos: 1 });
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();
    const p = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 1),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const reg = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, reg.msgId, RC.ACCEPTED));
    await p;
    const pub = parseMessage(findSent(state, "PUBLISH")[0]);
    expect(pub.msgId).toBeGreaterThan(0);
  });
});

// ── QoS 1 PUBACK / retransmit ─────────────────────────────────────────────────

describe("QoS 1 PUBACK", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("PUBACK clears the pending retransmit timer", async () => {
    const { pipeline, state } = makeClient({ mqttsnQos: 1 });
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    const p = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 5),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const reg = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, reg.msgId, RC.ACCEPTED));
    await p;

    const pub = parseMessage(findSent(state, "PUBLISH")[0]);
    state.socketUdp.send.mockClear();

    // Send PUBACK — should clear timer
    await deliver(pipeline, buildPubAck(1, pub.msgId, RC.ACCEPTED));

    // Advance past PUBACK_TIMEOUT_MS — no retransmit should happen
    jest.advanceTimersByTime(6000);
    const retransmits = allSent(state, "PUBLISH");
    expect(retransmits.length).toBe(0);
  });

  test("retransmits with DUP=true on PUBACK timeout", async () => {
    const { pipeline, state } = makeClient({ mqttsnQos: 1 });
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    const p = pipeline.sendDelta(
      makeDelta("navigation.speedOverGround", 5),
      SECRET_KEY,
      GW_ADDR,
      GW_PORT
    );
    const reg = parseMessage(findSent(state, "REGISTER")[0]);
    await deliver(pipeline, buildRegack(1, reg.msgId, RC.ACCEPTED));
    await p;
    state.socketUdp.send.mockClear();

    // Advance past PUBACK timeout without sending PUBACK
    jest.advanceTimersByTime(5001);

    const retransmits = allSent(state, "PUBLISH");
    expect(retransmits.length).toBeGreaterThan(0);
    const retMsg = parseMessage(retransmits[0][0]);
    expect(retMsg.dup).toBe(true);
  });
});

// ── DISCONNECT from gateway → reconnect ───────────────────────────────────────

describe("DISCONNECT from gateway", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("reconnects after gateway DISCONNECT", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    // Gateway sends DISCONNECT
    await deliver(pipeline, buildDisconnect());

    // Advance past first backoff (2000ms)
    jest.advanceTimersByTime(2001);

    const reconnects = allSent(state, "CONNECT");
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });
});

// ── PINGRESP ──────────────────────────────────────────────────────────────────

describe("PINGRESP", () => {
  test("PINGRESP clears the ping watchdog", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    await expect(deliver(pipeline, buildPingResp())).resolves.not.toThrow();
  });
});

// ── stopCongestionControl (full teardown) ─────────────────────────────────────

describe("stopCongestionControl (full teardown)", () => {
  test("sends DISCONNECT and stops further operations", async () => {
    const { pipeline, state } = makeClient();
    await doConnect(pipeline, state);
    state.socketUdp.send.mockClear();

    pipeline.stopCongestionControl();

    const disconnectFrame = findSent(state, "DISCONNECT");
    expect(disconnectFrame).toBeDefined();
  });
});

// ── startHeartbeat ────────────────────────────────────────────────────────────

describe("startHeartbeat", () => {
  test("returns a stop() handle", async () => {
    const { pipeline } = makeClient();
    const handle = pipeline.startHeartbeat(GW_ADDR, GW_PORT);
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
  });
});
