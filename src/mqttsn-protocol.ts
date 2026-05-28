"use strict";

/**
 * MQTT-SN v1.2 protocol — pure encode/decode, no I/O, no state.
 *
 * Frame format:
 *   1-byte header (total len ≤ 255): [Length(1)] [MsgType(1)] [Body...]
 *   3-byte header (total len > 255): [0x01] [Length(2 BE)] [MsgType(1)] [Body...]
 *   Length always includes the header bytes themselves.
 *
 * All multi-byte integers are big-endian per the MQTT-SN spec.
 */

// ── Message type constants ────────────────────────────────────────────────────

export const MQTTSN = {
  ADVERTISE: 0x00,
  SEARCHGW: 0x01,
  GWINFO: 0x02,
  CONNECT: 0x04,
  CONNACK: 0x05,
  REGISTER: 0x0a,
  REGACK: 0x0b,
  PUBLISH: 0x0c,
  PUBACK: 0x0d,
  PINGREQ: 0x16,
  PINGRESP: 0x17,
  DISCONNECT: 0x18
} as const;

// ── Return code constants ─────────────────────────────────────────────────────

export const RC = {
  ACCEPTED: 0x00,
  REJECTED_CONGESTION: 0x01,
  REJECTED_INVALID_TOPIC: 0x02,
  REJECTED_NOT_SUPPORTED: 0x03
} as const;

// ── Decoded message union ─────────────────────────────────────────────────────

export type MqttSnMessage =
  | { type: "CONNACK"; returnCode: number }
  | { type: "REGACK"; topicId: number; msgId: number; returnCode: number }
  | { type: "PUBACK"; topicId: number; msgId: number; returnCode: number }
  | { type: "PINGRESP" }
  | { type: "DISCONNECT"; sleepDuration?: number }
  | { type: "CONNECT"; clientId: string; cleanSession: boolean; duration: number; will: boolean }
  | { type: "REGISTER"; topicName: string; msgId: number }
  | {
      type: "PUBLISH";
      topicId: number;
      msgId: number;
      payload: Buffer;
      qos: number;
      retain: boolean;
      dup: boolean;
      topicIdType: number;
    }
  | { type: "PINGREQ"; clientId?: string }
  | { type: "SEARCHGW"; radius: number }
  | { type: "ADVERTISE"; gatewayId: number; duration: number }
  | { type: "GWINFO"; gatewayId: number }
  | { type: "UNKNOWN"; msgType: number };

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Prepend the correct MQTT-SN length header to a message body.
 *
 * 1-byte form: total = 1(len) + 1(type) + N(body). Valid when total ≤ 255.
 * 3-byte form: total = 3(hdr) + 1(type) + N(body). Used when 1-byte total > 255.
 */
function frame(msgType: number, body: Buffer): Buffer {
  const oneByteTotal = 2 + body.length; // 1(len byte) + 1(type byte) + N
  if (oneByteTotal <= 255) {
    return Buffer.concat([Buffer.from([oneByteTotal, msgType]), body]);
  }
  // 3-byte header: the Length field value = 3(hdr) + 1(type) + N = 4 + N
  const threeByteTotal = 4 + body.length;
  const hdr = Buffer.alloc(4);
  hdr[0] = 0x01;
  hdr.writeUInt16BE(threeByteTotal, 1);
  hdr[3] = msgType;
  return Buffer.concat([hdr, body]);
}

// ── Encode functions (client → gateway) ──────────────────────────────────────

/**
 * Build a CONNECT frame.
 * Flags: bit 3 = Will, bit 2 = CleanSession.
 * ProtocolId is always 0x01 per MQTT-SN v1.2.
 */
export function buildConnect(
  clientId: string,
  cleanSession: boolean,
  duration: number,
  will = false
): Buffer {
  const flags = (will ? 0x08 : 0x00) | (cleanSession ? 0x04 : 0x00);
  const clientIdBuf = Buffer.from(clientId, "utf8");
  const body = Buffer.alloc(1 + 1 + 2 + clientIdBuf.length);
  body[0] = flags;
  body[1] = 0x01; // ProtocolId
  body.writeUInt16BE(Math.min(65535, Math.max(1, duration)), 2);
  clientIdBuf.copy(body, 4);
  return frame(MQTTSN.CONNECT, body);
}

/**
 * Build a REGISTER frame (sent by client; TopicId field is 0x0000,
 * gateway assigns the real ID and returns it in REGACK).
 */
export function buildRegister(topicName: string, msgId: number): Buffer {
  const topicBuf = Buffer.from(topicName, "utf8");
  const body = Buffer.alloc(4 + topicBuf.length);
  body.writeUInt16BE(0x0000, 0); // placeholder TopicId
  body.writeUInt16BE(msgId & 0xffff, 2);
  topicBuf.copy(body, 4);
  return frame(MQTTSN.REGISTER, body);
}

/**
 * Build a PUBLISH frame.
 * PUBLISH Flags byte:
 *   bit 7: DUP, bits 5-6: QoS (0b00=0, 0b01=1), bit 4: Retain,
 *   bits 3-2: unused in PUBLISH, bits 1-0: TopicIdType (0=normal).
 * For QoS 0, msgId should be 0x0000.
 */
export function buildPublish(
  topicId: number,
  msgId: number,
  payload: Buffer,
  qos: 0 | 1,
  retain = false,
  dup = false,
  topicIdType: 0 | 1 | 2 = 0
): Buffer {
  const qosBits = (qos & 0x03) << 5;
  const flags = (dup ? 0x80 : 0x00) | qosBits | (retain ? 0x10 : 0x00) | (topicIdType & 0x03);
  const body = Buffer.alloc(5 + payload.length);
  body[0] = flags;
  body.writeUInt16BE(topicId & 0xffff, 1);
  body.writeUInt16BE(msgId & 0xffff, 3);
  payload.copy(body, 5);
  return frame(MQTTSN.PUBLISH, body);
}

/** Build a PINGREQ frame (no payload for connected client). */
export function buildPingReq(): Buffer {
  return Buffer.from([0x02, MQTTSN.PINGREQ]);
}

/** Build a DISCONNECT frame (no sleep duration). */
export function buildDisconnect(): Buffer {
  return Buffer.from([0x02, MQTTSN.DISCONNECT]);
}

// ── Encode functions (gateway → client) ──────────────────────────────────────

/** Build a CONNACK frame. */
export function buildConnack(returnCode: number): Buffer {
  return frame(MQTTSN.CONNACK, Buffer.from([returnCode & 0xff]));
}

/**
 * Build a REGACK frame (gateway assigns topicId and returns it to client).
 */
export function buildRegack(topicId: number, msgId: number, returnCode: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(topicId & 0xffff, 0);
  body.writeUInt16BE(msgId & 0xffff, 2);
  body[4] = returnCode & 0xff;
  return frame(MQTTSN.REGACK, body);
}

/** Build a PUBACK frame (QoS 1 acknowledgment). */
export function buildPubAck(topicId: number, msgId: number, returnCode: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(topicId & 0xffff, 0);
  body.writeUInt16BE(msgId & 0xffff, 2);
  body[4] = returnCode & 0xff;
  return frame(MQTTSN.PUBACK, body);
}

/** Build a PINGRESP frame. */
export function buildPingResp(): Buffer {
  return Buffer.from([0x02, MQTTSN.PINGRESP]);
}

/**
 * Build a GWINFO frame (gateway's response to SEARCHGW).
 * GatewayAddress is omitted; client already knows our address.
 */
export function buildGwInfo(gatewayId: number): Buffer {
  return frame(MQTTSN.GWINFO, Buffer.from([gatewayId & 0xff]));
}

// ── Decode function ───────────────────────────────────────────────────────────

/**
 * Parse one MQTT-SN frame from a UDP datagram buffer.
 *
 * Returns { type: "UNKNOWN" } for unrecognised or malformed frames rather
 * than throwing, so the caller can safely ignore bad packets.
 */
export function parseMessage(buf: Buffer): MqttSnMessage {
  if (buf.length < 2) return { type: "UNKNOWN", msgType: -1 };

  let msgType: number;
  let totalLen: number;
  let offset: number;

  if (buf[0] === 0x01) {
    // 3-byte length header
    if (buf.length < 4) return { type: "UNKNOWN", msgType: -1 };
    totalLen = buf.readUInt16BE(1); // includes all 3 header bytes
    msgType = buf[3];
    offset = 4;
  } else {
    totalLen = buf[0];
    msgType = buf[1];
    offset = 2;
  }

  if (totalLen < offset || buf.length < totalLen) return { type: "UNKNOWN", msgType };

  // Body is everything after the length+type prefix, up to totalLen
  const body = buf.slice(offset, totalLen);

  switch (msgType) {
    case MQTTSN.CONNACK:
      if (body.length < 1) return { type: "UNKNOWN", msgType };
      return { type: "CONNACK", returnCode: body[0] };

    case MQTTSN.REGACK:
      if (body.length < 5) return { type: "UNKNOWN", msgType };
      return {
        type: "REGACK",
        topicId: body.readUInt16BE(0),
        msgId: body.readUInt16BE(2),
        returnCode: body[4]
      };

    case MQTTSN.PUBACK:
      if (body.length < 5) return { type: "UNKNOWN", msgType };
      return {
        type: "PUBACK",
        topicId: body.readUInt16BE(0),
        msgId: body.readUInt16BE(2),
        returnCode: body[4]
      };

    case MQTTSN.PINGRESP:
      return { type: "PINGRESP" };

    case MQTTSN.PINGREQ:
      return {
        type: "PINGREQ",
        clientId: body.length > 0 ? body.toString("utf8") : undefined
      };

    case MQTTSN.DISCONNECT: {
      const sleepDuration = body.length >= 2 ? body.readUInt16BE(0) : undefined;
      return { type: "DISCONNECT", sleepDuration };
    }

    case MQTTSN.CONNECT: {
      if (body.length < 4) return { type: "UNKNOWN", msgType };
      const flags = body[0];
      if (body[1] !== 0x01) return { type: "UNKNOWN", msgType }; // ProtocolId must be MQTT-SN v1.2
      const duration = body.readUInt16BE(2);
      const clientId = body.slice(4).toString("utf8");
      return {
        type: "CONNECT",
        clientId,
        cleanSession: !!(flags & 0x04),
        will: !!(flags & 0x08),
        duration
      };
    }

    case MQTTSN.REGISTER: {
      if (body.length < 4) return { type: "UNKNOWN", msgType };
      const msgId = body.readUInt16BE(2);
      const topicName = body.slice(4).toString("utf8");
      return { type: "REGISTER", topicName, msgId };
    }

    case MQTTSN.PUBLISH: {
      if (body.length < 5) return { type: "UNKNOWN", msgType };
      const flags = body[0];
      const topicId = body.readUInt16BE(1);
      const msgId = body.readUInt16BE(3);
      const payload = body.slice(5);
      const rawQos = (flags >>> 5) & 0x03;
      // QoS -1 is encoded as 0b11 in the flags; treat as 0 for our purposes
      const qos = rawQos === 3 ? 0 : rawQos;
      return {
        type: "PUBLISH",
        topicId,
        msgId,
        payload,
        qos,
        retain: !!(flags & 0x10),
        dup: !!(flags & 0x80),
        topicIdType: flags & 0x03
      };
    }

    case MQTTSN.SEARCHGW:
      return { type: "SEARCHGW", radius: body.length > 0 ? body[0] : 0 };

    case MQTTSN.ADVERTISE:
      if (body.length < 3) return { type: "UNKNOWN", msgType };
      return { type: "ADVERTISE", gatewayId: body[0], duration: body.readUInt16BE(1) };

    case MQTTSN.GWINFO:
      if (body.length < 1) return { type: "UNKNOWN", msgType };
      return { type: "GWINFO", gatewayId: body[0] };

    default:
      return { type: "UNKNOWN", msgType };
  }
}
