"use strict";

/** L1 codec — packet parsing + control-payload decoders. */

import {
  MAGIC,
  HEADER_SIZE,
  PacketType,
  PacketFlags,
  SUPPORTED_PROTOCOL_VERSIONS,
  VALID_PACKET_TYPES,
  crc16,
  getTypeName
} from "./constants";
import type { ParsedPacket } from "./constants";
import { verifyControlPacketAuthTag, CONTROL_AUTH_TAG_LENGTH } from "../crypto";

// --- Header field parsing / validation ---

/**
 * Parse and validate the fixed header fields (magic, version, type, flags,
 * sequence, payload length). Throws on any malformed/unsupported field.
 */
function parseHeaderFields(packet: Buffer): {
  version: number;
  type: number;
  flags: ParsedPacket["flags"];
  sequence: number;
  payloadLength: number;
} {
  if (packet[0] !== MAGIC[0] || packet[1] !== MAGIC[1]) {
    throw new Error("Invalid magic bytes");
  }

  const version = packet[2];
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const type = packet[3];
  if (!VALID_PACKET_TYPES.has(type as (typeof PacketType)[keyof typeof PacketType])) {
    throw new Error(`Unknown packet type: 0x${type.toString(16)}`);
  }

  const flagByte = packet[4];
  const flags = {
    compressed: !!(flagByte & PacketFlags.COMPRESSED),
    encrypted: !!(flagByte & PacketFlags.ENCRYPTED),
    messagepack: !!(flagByte & PacketFlags.MESSAGEPACK),
    pathDictionary: !!(flagByte & PacketFlags.PATH_DICTIONARY),
    authenticatedHeader: !!(flagByte & PacketFlags.AUTHENTICATED_HEADER)
  };

  return {
    version,
    type,
    flags,
    sequence: packet.readUInt32BE(5),
    payloadLength: packet.readUInt32BE(9)
  };
}

/**
 * Validate the header CRC16 and that the declared payload length matches the
 * actual payload bytes present. Throws on mismatch.
 */
function validateHeaderIntegrity(packet: Buffer, payloadLength: number): void {
  const expectedCRC = crc16(packet.subarray(0, 13));
  const actualCRC = packet.readUInt16BE(13);
  if (expectedCRC !== actualCRC) {
    throw new Error(
      `CRC mismatch: expected 0x${expectedCRC.toString(16)}, got 0x${actualCRC.toString(16)}`
    );
  }

  const actualPayloadLength = packet.length - HEADER_SIZE;
  if (payloadLength !== actualPayloadLength) {
    throw new Error(
      `Payload length mismatch: header says ${payloadLength}, actual ${actualPayloadLength}`
    );
  }
}

// --- PacketParser ---

/**
 * Parses reliable-transport (v3) protocol packets
 */
export class PacketParser {
  _secretKey: string | null;
  _stretchAsciiKey: boolean;
  _authenticatedHeaders: boolean;

  constructor(
    config: { secretKey?: string; stretchAsciiKey?: boolean; authenticatedHeaders?: boolean } = {}
  ) {
    this._secretKey = config.secretKey || null;
    this._stretchAsciiKey = !!config.stretchAsciiKey;
    this._authenticatedHeaders = !!config.authenticatedHeaders;
  }

  /**
   * Parse a packet header
   * @param {Buffer} packet - Raw packet data
   * @param {Object} [options]
   * @param {string} [options.secretKey] - Required for v3 control packets
   * @param {boolean} [options.stretchAsciiKey] - Override the parser's
   *   constructor-time setting; both ends must agree
   * @returns {Object} Parsed packet information
   * @throws {Error} If packet is invalid
   */
  parseHeader(
    packet: Buffer,
    options: { secretKey?: string; stretchAsciiKey?: boolean; authenticatedHeaders?: boolean } = {}
  ): ParsedPacket {
    if (!Buffer.isBuffer(packet)) {
      throw new Error("Packet must be a Buffer");
    }
    if (packet.length < HEADER_SIZE) {
      throw new Error(`Packet too small: ${packet.length} bytes (minimum ${HEADER_SIZE})`);
    }

    const { version, type, flags, sequence, payloadLength } = parseHeaderFields(packet);
    validateHeaderIntegrity(packet, payloadLength);

    let payload = packet.subarray(HEADER_SIZE);

    const isDataOrMeta = type === PacketType.DATA || type === PacketType.METADATA;
    if (isDataOrMeta) {
      const requireAuthHeader = options.authenticatedHeaders ?? this._authenticatedHeaders;
      if (requireAuthHeader) {
        payload = this._stripDataMetaAuthTag(packet, payload, flags, options);
      }
    } else {
      payload = this._stripControlAuthTag(packet, payload, options);
    }

    return {
      version,
      type,
      typeName: getTypeName(type),
      flags,
      sequence,
      payloadLength,
      payload
    };
  }

  /**
   * Opt-in DATA/METADATA header authentication. When this parser is configured
   * to require it (both peers must agree, like stretchAsciiKey), every
   * DATA/METADATA packet must carry the AUTHENTICATED_HEADER flag and a valid
   * trailing HMAC tag over header[0..13)+ciphertext. A missing flag is treated
   * as a downgrade attempt and rejected; a bad tag fails authentication.
   */
  _stripDataMetaAuthTag(
    packet: Buffer,
    payload: Buffer,
    flags: ParsedPacket["flags"],
    options: { secretKey?: string; stretchAsciiKey?: boolean }
  ): Buffer {
    if (!flags.authenticatedHeader) {
      throw new Error("Authenticated header required but AUTHENTICATED_HEADER flag not set");
    }
    if (payload.length < CONTROL_AUTH_TAG_LENGTH) {
      throw new Error("DATA/METADATA authentication tag missing");
    }
    const ciphertext = payload.subarray(0, payload.length - CONTROL_AUTH_TAG_LENGTH);
    const authTag = payload.subarray(payload.length - CONTROL_AUTH_TAG_LENGTH);
    const secretKey = options.secretKey || this._secretKey;
    if (!secretKey) {
      throw new Error("DATA/METADATA authentication requires secretKey");
    }
    const stretchAsciiKey = options.stretchAsciiKey ?? this._stretchAsciiKey;
    verifyControlPacketAuthTag(packet.subarray(0, 13), ciphertext, authTag, secretKey, {
      stretchAsciiKey
    });
    return ciphertext;
  }

  /**
   * Control packets (ACK/NAK/HEARTBEAT/HELLO/META_REQUEST/FULL_STATUS_REQUEST)
   * are HMAC-authenticated: verify the trailing auth tag and strip it so the
   * caller sees only the logical payload. DATA/METADATA are AEAD ciphertext.
   */
  _stripControlAuthTag(
    packet: Buffer,
    payload: Buffer,
    options: { secretKey?: string; stretchAsciiKey?: boolean }
  ): Buffer {
    if (payload.length < CONTROL_AUTH_TAG_LENGTH) {
      throw new Error("Control packet authentication tag missing");
    }
    const payloadData = payload.subarray(0, payload.length - CONTROL_AUTH_TAG_LENGTH);
    const authTag = payload.subarray(payload.length - CONTROL_AUTH_TAG_LENGTH);
    const secretKey = options.secretKey || this._secretKey;
    if (!secretKey) {
      throw new Error("Control packet authentication requires secretKey");
    }
    const stretchAsciiKey = options.stretchAsciiKey ?? this._stretchAsciiKey;
    verifyControlPacketAuthTag(packet.subarray(0, 13), payloadData, authTag, secretKey, {
      stretchAsciiKey
    });
    return payloadData;
  }

  /**
   * Check if a buffer looks like a supported reliable packet (v3)
   * @param {Buffer} data - Data to check
   * @returns {boolean} True if data starts with a supported packet header
   */
  isV2Packet(data: Buffer): boolean {
    return (
      Buffer.isBuffer(data) &&
      data.length >= HEADER_SIZE &&
      data[0] === MAGIC[0] &&
      data[1] === MAGIC[1] &&
      SUPPORTED_PROTOCOL_VERSIONS.has(data[2])
    );
  }

  /**
   * Parse ACK payload (returns just the acknowledged sequence number)
   * @param {Buffer} payload - ACK packet payload
   * @returns {number} Acknowledged sequence number
   */
  parseACKPayload(payload: Buffer): number {
    if (payload.length < 4) {
      throw new Error("ACK payload too small");
    }
    return payload.readUInt32BE(0);
  }

  /**
   * Parse extended ACK payload (sequence + optional receive window)
   * @param {Buffer} payload - ACK packet payload
   * @returns {Object} Parsed ACK with sequence and optional receiveWindow
   */
  parseACKPayloadFull(payload: Buffer): { sequence: number; receiveWindow?: number } {
    if (payload.length < 4) {
      throw new Error("ACK payload too small");
    }
    const result: { sequence: number; receiveWindow?: number } = {
      sequence: payload.readUInt32BE(0)
    };
    if (payload.length >= 8) {
      result.receiveWindow = payload.readUInt32BE(4);
    }
    return result;
  }

  /**
   * Parse NAK payload
   * @param {Buffer} payload - NAK packet payload
   * @returns {number[]} Array of missing sequence numbers
   */
  parseNAKPayload(payload: Buffer): number[] {
    if (payload.length % 4 !== 0) {
      throw new Error("NAK payload length must be a multiple of 4");
    }
    const missing: number[] = [];
    for (let i = 0; i < payload.length; i += 4) {
      missing.push(payload.readUInt32BE(i));
    }
    return missing;
  }
}
