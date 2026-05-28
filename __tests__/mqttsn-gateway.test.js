"use strict";

const { createMqttSnGateway } = require("../lib/mqttsn-gateway");
const {
  buildConnect,
  buildRegister,
  buildPublish,
  buildPingReq,
  buildDisconnect,
  buildPubAck,
  parseMessage,
  MQTTSN,
  RC
} = require("../lib/mqttsn-protocol");
const { encryptBinary } = require("../lib/crypto");

const SECRET_KEY = "12345678901234567890123456789012";
const RINFO = { address: "10.0.0.1", port: 5555 };

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
  const socket = {
    send: jest.fn((buf, port, addr, cb) => cb && cb(null)),
    on: jest.fn()
  };
  return socket;
}

function makeState(overrides = {}) {
  return {
    instanceId: "test-instance",
    options: {
      secretKey: SECRET_KEY,
      stretchAsciiKey: false,
      useMsgpack: false,
      mqttsnTopicPrefix: "sk",
      mqttsnGatewayId: 1
    },
    socketUdp: makeSocket(),
    ...overrides
  };
}

let _activeGateways = [];

afterEach(() => {
  for (const gw of _activeGateways) {
    gw.stop();
  }
  _activeGateways = [];
});

function makeGateway(stateOverrides = {}) {
  const app = makeApp();
  const state = makeState(stateOverrides);
  const gw = createMqttSnGateway(app, state, {});
  gw.start();
  _activeGateways.push(gw);
  return { gw, app, state, socket: state.socketUdp };
}

function encryptPayload(value, useMsgpack = false) {
  const serialized = useMsgpack
    ? require("@msgpack/msgpack").encode(value)
    : Buffer.from(JSON.stringify(value), "utf8");
  return encryptBinary(serialized, SECRET_KEY, { stretchAsciiKey: false });
}

function findSent(socket, type) {
  return socket.send.mock.calls.find((c) => {
    try {
      return parseMessage(c[0]).type === type;
    } catch (_) {
      return false;
    }
  });
}

function allSent(socket, type) {
  return socket.send.mock.calls.filter((c) => {
    try {
      return parseMessage(c[0]).type === type;
    } catch (_) {
      return false;
    }
  });
}

// ── CONNECT ────────────────────────────────────────────────────────────────────

describe("CONNECT", () => {
  test("sends CONNACK(ACCEPTED) on valid CONNECT", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("sensor1", true, 30), RINFO);
    const call = findSent(socket, "CONNACK");
    expect(call).toBeDefined();
    expect(parseMessage(call[0]).returnCode).toBe(RC.ACCEPTED);
    expect(call[1]).toBe(RINFO.port);
    expect(call[2]).toBe(RINFO.address);
  });

  test("replacing an existing session sends a new CONNACK", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    const connacks = allSent(socket, "CONNACK");
    expect(connacks.length).toBe(2);
  });

  test("REGISTER without an active session is ignored (no REGACK)", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildRegister("sk/nav/speed", 1), RINFO);
    const regack = findSent(socket, "REGACK");
    expect(regack).toBeUndefined();
  });
});

// ── REGISTER ──────────────────────────────────────────────────────────────────

describe("REGISTER", () => {
  test("sends REGACK with assigned topicId > 0", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    gw.handleMessage(buildRegister("sk/navigation/speedOverGround", 5), RINFO);
    const call = findSent(socket, "REGACK");
    expect(call).toBeDefined();
    const msg = parseMessage(call[0]);
    expect(msg.returnCode).toBe(RC.ACCEPTED);
    expect(msg.msgId).toBe(5);
    expect(msg.topicId).toBeGreaterThan(0);
  });

  test("same topic name always gets same topicId", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    gw.handleMessage(buildRegister("sk/nav/speed", 1), RINFO);
    gw.handleMessage(buildRegister("sk/nav/speed", 2), RINFO);
    const regacks = allSent(socket, "REGACK");
    const id1 = parseMessage(regacks[0][0]).topicId;
    const id2 = parseMessage(regacks[1][0]).topicId;
    expect(id1).toBe(id2);
  });

  test("different topics get different IDs", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    gw.handleMessage(buildRegister("sk/nav/speed", 1), RINFO);
    gw.handleMessage(buildRegister("sk/nav/heading", 2), RINFO);
    const regacks = allSent(socket, "REGACK");
    const id1 = parseMessage(regacks[0][0]).topicId;
    const id2 = parseMessage(regacks[1][0]).topicId;
    expect(id1).not.toBe(id2);
  });
});

// ── PUBLISH ───────────────────────────────────────────────────────────────────

describe("PUBLISH", () => {
  function setupSession(gw, socket) {
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    gw.handleMessage(buildRegister("sk/navigation/speedOverGround", 1), RINFO);
    const regack = parseMessage(findSent(socket, "REGACK")[0]);
    return regack.topicId;
  }

  test("QoS 0: injects value into Signal K via app.handleMessage", () => {
    const { gw, socket, app } = makeGateway();
    const topicId = setupSession(gw, socket);
    const encrypted = encryptPayload(7.3);
    gw.handleMessage(buildPublish(topicId, 1, encrypted, 0), RINFO);
    expect(app.handleMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        context: "vessels.self",
        updates: expect.arrayContaining([
          expect.objectContaining({
            values: [{ path: "navigation.speedOverGround", value: 7.3 }]
          })
        ])
      })
    );
  });

  test("QoS 1: sends PUBACK(ACCEPTED) after successful PUBLISH", () => {
    const { gw, socket } = makeGateway();
    const topicId = setupSession(gw, socket);
    const encrypted = encryptPayload(7.3);
    socket.send.mockClear();
    gw.handleMessage(buildPublish(topicId, 99, encrypted, 1), RINFO);
    const puback = findSent(socket, "PUBACK");
    expect(puback).toBeDefined();
    const msg = parseMessage(puback[0]);
    expect(msg.returnCode).toBe(RC.ACCEPTED);
    expect(msg.msgId).toBe(99);
  });

  test("QoS 0: no PUBACK sent", () => {
    const { gw, socket } = makeGateway();
    const topicId = setupSession(gw, socket);
    socket.send.mockClear();
    gw.handleMessage(buildPublish(topicId, 0, encryptPayload(1.0), 0), RINFO);
    const puback = findSent(socket, "PUBACK");
    expect(puback).toBeUndefined();
  });

  test("unknown topicId: QoS 1 sends PUBACK(REJECTED_INVALID_TOPIC)", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    socket.send.mockClear();
    gw.handleMessage(buildPublish(9999, 1, encryptPayload(1.0), 1), RINFO);
    const puback = findSent(socket, "PUBACK");
    expect(puback).toBeDefined();
    expect(parseMessage(puback[0]).returnCode).toBe(RC.REJECTED_INVALID_TOPIC);
  });

  test("unknown topicId: QoS 0 no PUBACK, app.handleMessage not called", () => {
    const { gw, socket, app } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    app.handleMessage.mockClear();
    socket.send.mockClear();
    gw.handleMessage(buildPublish(9999, 0, encryptPayload(1.0), 0), RINFO);
    expect(findSent(socket, "PUBACK")).toBeUndefined();
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("bad decryption key: drops packet, logs error", () => {
    const { gw, socket, app } = makeGateway();
    const topicId = setupSession(gw, socket);
    // Encrypt with wrong key
    const wrongKey = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const badEncrypted = encryptBinary(Buffer.from("7.3"), wrongKey, { stretchAsciiKey: false });
    app.handleMessage.mockClear();
    gw.handleMessage(buildPublish(topicId, 1, badEncrypted, 0), RINFO);
    expect(app.handleMessage).not.toHaveBeenCalled();
    expect(app.error).toHaveBeenCalled();
  });

  test("publish from unknown session is silently ignored", () => {
    const { gw, app } = makeGateway();
    // No CONNECT
    gw.handleMessage(buildPublish(1, 1, encryptPayload(1.0), 0), RINFO);
    expect(app.handleMessage).not.toHaveBeenCalled();
  });
});

// ── PINGREQ ───────────────────────────────────────────────────────────────────

describe("PINGREQ", () => {
  test("responds with PINGRESP", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 60), RINFO);
    socket.send.mockClear();
    gw.handleMessage(buildPingReq(), RINFO);
    const pingresp = findSent(socket, "PINGRESP");
    expect(pingresp).toBeDefined();
    expect(pingresp[1]).toBe(RINFO.port);
    expect(pingresp[2]).toBe(RINFO.address);
  });

  test("PINGRESP sent even without a session", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildPingReq(), RINFO);
    expect(findSent(socket, "PINGRESP")).toBeDefined();
  });
});

// ── DISCONNECT ────────────────────────────────────────────────────────────────

describe("DISCONNECT", () => {
  test("session removed after DISCONNECT — REGISTER is ignored", () => {
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 60), RINFO);
    gw.handleMessage(buildDisconnect(), RINFO);
    socket.send.mockClear();
    gw.handleMessage(buildRegister("sk/nav/speed", 1), RINFO);
    expect(findSent(socket, "REGACK")).toBeUndefined();
  });

  test("session removed after DISCONNECT — PUBLISH is ignored", () => {
    const { gw, socket, app } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 60), RINFO);
    gw.handleMessage(buildDisconnect(), RINFO);
    app.handleMessage.mockClear();
    gw.handleMessage(buildPublish(1, 1, encryptPayload(1.0), 0), RINFO);
    expect(app.handleMessage).not.toHaveBeenCalled();
  });
});

// ── SEARCHGW ──────────────────────────────────────────────────────────────────

describe("SEARCHGW", () => {
  test("sends GWINFO with configured gatewayId", () => {
    const { gw, socket } = makeGateway({
      options: {
        secretKey: SECRET_KEY,
        stretchAsciiKey: false,
        useMsgpack: false,
        mqttsnTopicPrefix: "sk",
        mqttsnGatewayId: 5
      }
    });
    gw.handleMessage(Buffer.from([0x03, MQTTSN.SEARCHGW, 0x00]), RINFO);
    const gwinfo = findSent(socket, "GWINFO");
    expect(gwinfo).toBeDefined();
    expect(parseMessage(gwinfo[0]).gatewayId).toBe(5);
  });

  test("defaults gatewayId to 1 if not configured", () => {
    const { gw, socket } = makeGateway({
      options: {
        secretKey: SECRET_KEY,
        stretchAsciiKey: false,
        useMsgpack: false,
        mqttsnTopicPrefix: "sk"
      }
    });
    gw.handleMessage(Buffer.from([0x03, MQTTSN.SEARCHGW, 0x00]), RINFO);
    const gwinfo = findSent(socket, "GWINFO");
    expect(parseMessage(gwinfo[0]).gatewayId).toBe(1);
  });
});

// ── Keepalive watchdog ────────────────────────────────────────────────────────

describe("keepalive watchdog", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("session removed after 1.5× keepalive period with no messages", () => {
    const { gw, socket, app } = makeGateway();
    // 2s keepalive → watchdog fires at 3s
    gw.handleMessage(buildConnect("s1", true, 2), RINFO);
    jest.advanceTimersByTime(3001);
    // Subsequent PUBLISH should be ignored (session gone)
    app.handleMessage.mockClear();
    gw.handleMessage(buildPublish(1, 1, encryptPayload(1.0), 0), RINFO);
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("PINGREQ resets watchdog — session survives past original timeout", () => {
    // keepalive=2s, watchdog=3s. PINGREQ at t=2s resets watchdog to t=5s.
    // At t=4.5s the session must still be alive — REGISTER → REGACK proves it.
    const { gw, socket } = makeGateway();
    gw.handleMessage(buildConnect("s1", true, 2), RINFO);
    jest.advanceTimersByTime(2000);
    gw.handleMessage(buildPingReq(), RINFO);
    jest.advanceTimersByTime(2500);
    gw.handleMessage(buildRegister("sk/nav/speed", 1), RINFO);
    expect(findSent(socket, "REGACK")).toBeDefined();
  });
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe("stop()", () => {
  test("gateway stops handling messages after stop()", () => {
    const { gw, socket } = makeGateway();
    gw.stop();
    socket.send.mockClear();
    gw.handleMessage(buildConnect("s1", true, 30), RINFO);
    expect(socket.send).not.toHaveBeenCalled();
  });
});

// ── Multiple devices ──────────────────────────────────────────────────────────

describe("multiple concurrent devices", () => {
  test("sessions keyed by address:port are independent", () => {
    const { gw, socket, app } = makeGateway();
    const rinfo1 = { address: "10.0.0.1", port: 1111 };
    const rinfo2 = { address: "10.0.0.2", port: 2222 };

    gw.handleMessage(buildConnect("device1", true, 60), rinfo1);
    gw.handleMessage(buildConnect("device2", true, 60), rinfo2);
    gw.handleMessage(buildRegister("sk/nav/speed", 1), rinfo1);
    gw.handleMessage(buildRegister("sk/nav/speed", 1), rinfo2);

    const regacks = allSent(socket, "REGACK");
    expect(regacks.length).toBe(2);
    // Both get the same topicId (1) since they each have independent registries and the
    // same topic name assigned first gets id=1
    const id1 = parseMessage(regacks[0][0]).topicId;
    const id2 = parseMessage(regacks[1][0]).topicId;
    expect(id1).toBe(1);
    expect(id2).toBe(1);

    // DISCONNECT device1 — device2 should still be reachable
    gw.handleMessage(buildDisconnect(), rinfo1);
    socket.send.mockClear();
    gw.handleMessage(buildRegister("sk/nav/heading", 2), rinfo2);
    expect(findSent(socket, "REGACK")).toBeDefined();
  });
});
