"use strict";

const {
  buildConnect,
  buildConnack,
  buildRegister,
  buildRegack,
  buildPublish,
  buildPubAck,
  buildPingReq,
  buildPingResp,
  buildDisconnect,
  buildGwInfo,
  parseMessage,
  MQTTSN,
  RC
} = require("../lib/mqttsn-protocol");

// ── buildConnect / CONNECT ────────────────────────────────────────────────────

describe("buildConnect / parseMessage(CONNECT)", () => {
  test("encodes clientId, cleanSession=true, duration", () => {
    const buf = buildConnect("vessel1", true, 60);
    const msg = parseMessage(buf);
    expect(msg.type).toBe("CONNECT");
    expect(msg.clientId).toBe("vessel1");
    expect(msg.cleanSession).toBe(true);
    expect(msg.duration).toBe(60);
    expect(msg.will).toBe(false);
  });

  test("cleanSession=false", () => {
    const msg = parseMessage(buildConnect("v1", false, 30));
    expect(msg.cleanSession).toBe(false);
  });

  test("will=true flag", () => {
    const msg = parseMessage(buildConnect("v1", true, 30, true));
    expect(msg.will).toBe(true);
  });

  test("empty clientId", () => {
    const msg = parseMessage(buildConnect("", true, 120));
    expect(msg.type).toBe("CONNECT");
    expect(msg.clientId).toBe("");
  });
});

// ── buildConnack / CONNACK ────────────────────────────────────────────────────

describe("buildConnack / parseMessage(CONNACK)", () => {
  test("accepted", () => {
    const msg = parseMessage(buildConnack(RC.ACCEPTED));
    expect(msg.type).toBe("CONNACK");
    expect(msg.returnCode).toBe(0x00);
  });

  test("rejected congestion", () => {
    const msg = parseMessage(buildConnack(RC.REJECTED_CONGESTION));
    expect(msg.type).toBe("CONNACK");
    expect(msg.returnCode).toBe(0x01);
  });

  test("rejected not supported", () => {
    const msg = parseMessage(buildConnack(RC.REJECTED_NOT_SUPPORTED));
    expect(msg.returnCode).toBe(0x03);
  });
});

// ── buildRegister / REGISTER ──────────────────────────────────────────────────

describe("buildRegister / parseMessage(REGISTER)", () => {
  test("encodes topicName and msgId", () => {
    const buf = buildRegister("sk/navigation/speedOverGround", 42);
    const msg = parseMessage(buf);
    expect(msg.type).toBe("REGISTER");
    expect(msg.topicName).toBe("sk/navigation/speedOverGround");
    expect(msg.msgId).toBe(42);
  });

  test("msgId max value", () => {
    const msg = parseMessage(buildRegister("sk/test", 0xfffe));
    expect(msg.msgId).toBe(0xfffe);
  });
});

// ── buildRegack / REGACK ──────────────────────────────────────────────────────

describe("buildRegack / parseMessage(REGACK)", () => {
  test("round-trip accepted", () => {
    const msg = parseMessage(buildRegack(7, 42, RC.ACCEPTED));
    expect(msg.type).toBe("REGACK");
    expect(msg.topicId).toBe(7);
    expect(msg.msgId).toBe(42);
    expect(msg.returnCode).toBe(RC.ACCEPTED);
  });

  test("rejected invalid topic", () => {
    const msg = parseMessage(buildRegack(0, 1, RC.REJECTED_INVALID_TOPIC));
    expect(msg.returnCode).toBe(RC.REJECTED_INVALID_TOPIC);
  });
});

// ── buildPublish / PUBLISH ────────────────────────────────────────────────────

describe("buildPublish / parseMessage(PUBLISH)", () => {
  test("QoS 0, payload preserved", () => {
    const data = Buffer.from("hello");
    const msg = parseMessage(buildPublish(3, 1, data, 0, false));
    expect(msg.type).toBe("PUBLISH");
    expect(msg.topicId).toBe(3);
    expect(msg.msgId).toBe(1);
    expect(msg.qos).toBe(0);
    expect(msg.retain).toBe(false);
    expect(msg.dup).toBe(false);
    expect(msg.payload).toEqual(data);
  });

  test("QoS 1, retain flag", () => {
    const msg = parseMessage(buildPublish(5, 2, Buffer.from("x"), 1, true));
    expect(msg.qos).toBe(1);
    expect(msg.retain).toBe(true);
  });

  test("DUP flag", () => {
    const msg = parseMessage(buildPublish(1, 5, Buffer.from("y"), 1, false, true));
    expect(msg.dup).toBe(true);
  });

  test("empty payload", () => {
    const msg = parseMessage(buildPublish(1, 0, Buffer.alloc(0), 0));
    expect(msg.type).toBe("PUBLISH");
    expect(msg.payload.length).toBe(0);
  });
});

// ── buildPubAck / PUBACK ──────────────────────────────────────────────────────

describe("buildPubAck / parseMessage(PUBACK)", () => {
  test("round-trip accepted", () => {
    const msg = parseMessage(buildPubAck(3, 10, RC.ACCEPTED));
    expect(msg.type).toBe("PUBACK");
    expect(msg.topicId).toBe(3);
    expect(msg.msgId).toBe(10);
    expect(msg.returnCode).toBe(RC.ACCEPTED);
  });
});

// ── PINGREQ / PINGRESP ────────────────────────────────────────────────────────

describe("PINGREQ / PINGRESP", () => {
  test("PINGREQ parses correctly, no clientId", () => {
    const msg = parseMessage(buildPingReq());
    expect(msg.type).toBe("PINGREQ");
    expect(msg.clientId).toBeUndefined();
  });

  test("PINGRESP parses correctly", () => {
    expect(parseMessage(buildPingResp()).type).toBe("PINGRESP");
  });
});

// ── DISCONNECT ────────────────────────────────────────────────────────────────

describe("buildDisconnect / parseMessage(DISCONNECT)", () => {
  test("basic disconnect, no sleep duration", () => {
    const msg = parseMessage(buildDisconnect());
    expect(msg.type).toBe("DISCONNECT");
    expect(msg.sleepDuration).toBeUndefined();
  });
});

// ── buildGwInfo / GWINFO ──────────────────────────────────────────────────────

describe("buildGwInfo / parseMessage(GWINFO)", () => {
  test("gateway id encoded", () => {
    const msg = parseMessage(buildGwInfo(5));
    expect(msg.type).toBe("GWINFO");
    expect(msg.gatewayId).toBe(5);
  });
});

// ── 3-byte length header ──────────────────────────────────────────────────────

describe("3-byte length frame (body > 253 bytes)", () => {
  test("frame > 255 bytes uses 3-byte header", () => {
    const bigPayload = Buffer.alloc(260, 0xab);
    const buf = buildPublish(1, 1, bigPayload, 0);
    expect(buf[0]).toBe(0x01);
    const msg = parseMessage(buf);
    expect(msg.type).toBe("PUBLISH");
    expect(msg.payload.length).toBe(260);
    expect(msg.payload.every((b) => b === 0xab)).toBe(true);
  });

  test("frame exactly 254 bytes body uses 3-byte header", () => {
    const payload = Buffer.alloc(254, 0x01);
    const buf = buildPublish(1, 1, payload, 0);
    expect(buf[0]).toBe(0x01);
    const msg = parseMessage(buf);
    expect(msg.payload.length).toBe(254);
  });

  test("frame exactly at 1-byte limit uses 1-byte header (PUBLISH 248-byte payload = 253-byte body)", () => {
    // PUBLISH body = 5 header bytes + payload; total = 2+5+248 = 255 → 1-byte header
    const payload = Buffer.alloc(248, 0x02);
    const buf = buildPublish(1, 1, payload, 0);
    expect(buf[0]).not.toBe(0x01);
    const msg = parseMessage(buf);
    expect(msg.payload.length).toBe(248);
  });
});

// ── malformed / edge-case frames ─────────────────────────────────────────────

describe("malformed frames", () => {
  test("empty buffer returns UNKNOWN", () => {
    expect(parseMessage(Buffer.alloc(0)).type).toBe("UNKNOWN");
  });

  test("single byte returns UNKNOWN", () => {
    expect(parseMessage(Buffer.from([0x02])).type).toBe("UNKNOWN");
  });

  test("truncated REGACK returns UNKNOWN", () => {
    const buf = Buffer.from([0x04, MQTTSN.REGACK, 0x00]);
    expect(parseMessage(buf).type).toBe("UNKNOWN");
  });

  test("truncated CONNECT returns UNKNOWN", () => {
    const buf = Buffer.from([0x04, MQTTSN.CONNECT, 0x04, 0x01]);
    expect(parseMessage(buf).type).toBe("UNKNOWN");
  });

  test("truncated 3-byte header returns UNKNOWN", () => {
    const buf = Buffer.from([0x01, 0x01]);
    expect(parseMessage(buf).type).toBe("UNKNOWN");
  });

  test("unknown msgType returns UNKNOWN", () => {
    const buf = Buffer.from([0x02, 0xff]);
    expect(parseMessage(buf).type).toBe("UNKNOWN");
  });
});

// ── SEARCHGW ──────────────────────────────────────────────────────────────────

describe("SEARCHGW", () => {
  test("parses radius", () => {
    const buf = Buffer.from([0x03, MQTTSN.SEARCHGW, 0x02]);
    const msg = parseMessage(buf);
    expect(msg.type).toBe("SEARCHGW");
    expect(msg.radius).toBe(2);
  });
});

// ── ADVERTISE ─────────────────────────────────────────────────────────────────

describe("ADVERTISE", () => {
  test("parses gatewayId and duration", () => {
    const body = Buffer.alloc(3);
    body[0] = 3;
    body.writeUInt16BE(120, 1);
    const buf = Buffer.concat([Buffer.from([0x05, MQTTSN.ADVERTISE]), body]);
    const msg = parseMessage(buf);
    expect(msg.type).toBe("ADVERTISE");
    expect(msg.gatewayId).toBe(3);
    expect(msg.duration).toBe(120);
  });
});
