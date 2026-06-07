"use strict";

/** L1 codec — packet parsing + control-payload decoders (rewrite plan doc 02 split). */

import {
  MAGIC,
  HEADER_SIZE,
  PacketType,
  PacketFlags,
  MAX_SEQUENCE,
  SUPPORTED_PROTOCOL_VERSIONS,
  VALID_PACKET_TYPES,
  normalizeProtocolVersion,
  usesAuthenticatedControl,
  crc16,
  getTypeName
} from "./constants";
import type { ParsedPacket } from "./constants";
import { verifyControlPacketAuthTag, CONTROL_AUTH_TAG_LENGTH } from "../crypto";

// --- PacketParser ---

/**
 * Parses v2 protocol packets
 */
export class PacketParser {
  _secretKey: string | null;
  _stretchAsciiKey: boolean;

  constructor(config: { secretKey?: string; stretchAsciiKey?: boolean } = {}) {
    this._secretKey = config.secretKey || null;
    this._stretchAsciiKey = !!config.stretchAsciiKey;
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
    options: { secretKey?: string; stretchAsciiKey?: boolean } = {}
  ): ParsedPacket {
    if (!Buffer.isBuffer(packet)) {
      throw new Error("Packet must be a Buffer");
    }
    if (packet.length < HEADER_SIZE) {
      throw new Error(`Packet too small: ${packet.length} bytes (minimum ${HEADER_SIZE})`);
    }

    // Validate magic bytes
    if (packet[0] !== MAGIC[0] || packet[1] !== MAGIC[1]) {
      throw new Error("Invalid magic bytes");
    }

    // Validate version
    const version = packet[2];
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }

    // Parse type
    const type = packet[3];
    if (!VALID_PACKET_TYPES.has(type as (typeof PacketType)[keyof typeof PacketType])) {
      throw new Error(`Unknown packet type: 0x${type.toString(16)}`);
    }

    // Parse flags
    const flagByte = packet[4];
    const flags = {
      compressed: !!(flagByte & PacketFlags.COMPRESSED),
      encrypted: !!(flagByte & PacketFlags.ENCRYPTED),
      messagepack: !!(flagByte & PacketFlags.MESSAGEPACK),
      pathDictionary: !!(flagByte & PacketFlags.PATH_DICTIONARY)
    };

    // Parse sequence
    const sequence = packet.readUInt32BE(5);

    // Parse payload length
    const payloadLength = packet.readUInt32BE(9);

    // Validate CRC16
    const expectedCRC = crc16(packet.subarray(0, 13));
    const actualCRC = packet.readUInt16BE(13);
    if (expectedCRC !== actualCRC) {
      throw new Error(
        `CRC mismatch: expected 0x${expectedCRC.toString(16)}, got 0x${actualCRC.toString(16)}`
      );
    }

    // Validate payload length against actual data
    const actualPayloadLength = packet.length - HEADER_SIZE;
    if (payloadLength !== actualPayloadLength) {
      throw new Error(
        `Payload length mismatch: header says ${payloadLength}, actual ${actualPayloadLength}`
      );
    }

    // Extract payload
    let payload = packet.subarray(HEADER_SIZE);

    if (type !== PacketType.DATA && type !== PacketType.METADATA) {
      if (usesAuthenticatedControl(version)) {
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
        payload = payloadData;
      } else {
        // HEARTBEAT, META_REQUEST, and FULL_STATUS_REQUEST carry a 0-byte
        // payload with no CRC — accept as-is. ACK / NAK / HELLO must include
        // a 2-byte CRC16 trailer; reject undersized payloads so forged control
        // frames cannot slip through unverified.
        if (
          type !== PacketType.HEARTBEAT &&
          type !== PacketType.META_REQUEST &&
          type !== PacketType.FULL_STATUS_REQUEST
        ) {
          if (payload.length < 2) {
            throw new Error(`Control packet payload too short for CRC: ${payload.length} byte(s)`);
          }
          const payloadData = payload.subarray(0, payload.length - 2);
          const expectedPayloadCrc = crc16(payloadData);
          const actualPayloadCrc = payload.readUInt16BE(payload.length - 2);
          if (expectedPayloadCrc !== actualPayloadCrc) {
            throw new Error(
              `Payload CRC mismatch: expected 0x${expectedPayloadCrc.toString(16)}, ` +
                `got 0x${actualPayloadCrc.toString(16)}`
            );
          }
          payload = payloadData;
        }
      }
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
   * Check if a buffer looks like a supported reliable packet (v2 or v3)
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
