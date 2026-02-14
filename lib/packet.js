"use strict";

/**
 * Signal K Edge Link v2.0 - Packet Protocol Layer
 *
 * Binary packet format for reliable UDP communication.
 * Adds headers with sequence numbers, packet types, flags, and CRC16 checksums.
 *
 * Wire format (big-endian):
 * ┌──────────┬─────────┬───────┬───────────┬───────────┬──────────┬─────────┐
 * │ Magic(2) │ Ver.(1) │ Type  │ Flags(1)  │ Seq.(4)   │ Len.(4)  │ CRC16   │
 * │  0xSK    │  0x02   │ (1)   │           │           │          │  (2)    │
 * ├──────────┴─────────┴───────┴───────────┴───────────┴──────────┴─────────┤
 * │ Payload (variable length)                                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Header: 15 bytes total
 * - Magic:    2 bytes (0x53, 0x4B = "SK")
 * - Version:  1 byte  (0x02 for v2)
 * - Type:     1 byte  (DATA, ACK, NAK, HEARTBEAT, HELLO)
 * - Flags:    1 byte  (compressed, encrypted, msgpack, pathdict)
 * - Sequence: 4 bytes (uint32, big-endian)
 * - Length:   4 bytes (payload length, uint32, big-endian)
 * - CRC16:    2 bytes (CRC-CCITT of header bytes 0..12)
 *
 * @module lib/packet
 */

// --- Constants ---

/** Magic bytes identifying a v2 packet: "SK" */
const MAGIC = Buffer.from([0x53, 0x4b]);

/** Protocol version */
const PROTOCOL_VERSION = 0x02;

/** Total header size in bytes */
const HEADER_SIZE = 15;

/**
 * Packet types
 * @enum {number}
 */
const PacketType = Object.freeze({
  DATA: 0x01,
  ACK: 0x02,
  NAK: 0x03,
  HEARTBEAT: 0x04,
  HELLO: 0x05
});

/**
 * Packet flag bit positions
 * @enum {number}
 */
const PacketFlags = Object.freeze({
  COMPRESSED: 0x01,      // bit 0
  ENCRYPTED: 0x02,       // bit 1
  MESSAGEPACK: 0x04,     // bit 2
  PATH_DICTIONARY: 0x08  // bit 3
});

/** Maximum sequence number before wraparound (2^32 - 1) */
const MAX_SEQUENCE = 0xffffffff;

// --- CRC16-CCITT ---

/**
 * Precomputed CRC16-CCITT lookup table (polynomial 0x1021)
 * @type {Uint16Array}
 */
const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
    table[i] = crc & 0xffff;
  }
  return table;
})();

/**
 * Calculate CRC16-CCITT checksum
 * @param {Buffer} data - Data to checksum
 * @returns {number} 16-bit CRC value
 */
function crc16(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// --- PacketBuilder ---

/**
 * Builds v2 protocol packets with headers
 */
class PacketBuilder {
  /**
   * @param {Object} [config]
   * @param {number} [config.initialSequence=0] - Starting sequence number
   */
  constructor(config = {}) {
    this._sequence = config.initialSequence || 0;
  }

  /**
   * Build a DATA packet
   * @param {Buffer} payload - Payload data
   * @param {Object} [flags] - Packet flags
   * @param {boolean} [flags.compressed=false]
   * @param {boolean} [flags.encrypted=false]
   * @param {boolean} [flags.messagepack=false]
   * @param {boolean} [flags.pathDictionary=false]
   * @returns {Buffer} Complete packet with header and payload
   */
  buildDataPacket(payload, flags = {}) {
    const packet = this._buildPacket(PacketType.DATA, payload, flags);
    this._advanceSequence();
    return packet;
  }

  /**
   * Build an ACK packet
   * @param {number} ackedSequence - Sequence number being acknowledged
   * @returns {Buffer} ACK packet
   */
  buildACKPacket(ackedSequence) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(ackedSequence, 0);
    return this._buildPacket(PacketType.ACK, payload, {});
  }

  /**
   * Build a NAK packet
   * @param {number[]} missingSequences - Array of missing sequence numbers
   * @returns {Buffer} NAK packet
   */
  buildNAKPacket(missingSequences) {
    const payload = Buffer.alloc(missingSequences.length * 4);
    for (let i = 0; i < missingSequences.length; i++) {
      payload.writeUInt32BE(missingSequences[i], i * 4);
    }
    return this._buildPacket(PacketType.NAK, payload, {});
  }

  /**
   * Build a HEARTBEAT packet
   * @returns {Buffer} Heartbeat packet (no payload)
   */
  buildHeartbeatPacket() {
    return this._buildPacket(PacketType.HEARTBEAT, Buffer.alloc(0), {});
  }

  /**
   * Build a HELLO packet
   * @param {Object} info - Hello information
   * @param {number} [info.protocolVersion] - Protocol version
   * @param {string} [info.clientId] - Client identifier
   * @returns {Buffer} Hello packet
   */
  buildHelloPacket(info = {}) {
    const payload = Buffer.from(JSON.stringify({
      protocolVersion: info.protocolVersion || PROTOCOL_VERSION,
      clientId: info.clientId || "",
      timestamp: Date.now()
    }));
    return this._buildPacket(PacketType.HELLO, payload, {});
  }

  /**
   * Get current sequence number
   * @returns {number}
   */
  getCurrentSequence() {
    return this._sequence;
  }

  /**
   * Manually set the sequence number (for testing/retransmission)
   * @param {number} seq
   */
  setSequence(seq) {
    this._sequence = seq >>> 0; // ensure uint32
  }

  /**
   * Build a packet with header
   * @private
   * @param {number} type - Packet type
   * @param {Buffer} payload - Payload data
   * @param {Object} flags - Flag options
   * @returns {Buffer} Complete packet
   */
  _buildPacket(type, payload, flags) {
    const header = Buffer.alloc(HEADER_SIZE);

    // Magic bytes
    header[0] = MAGIC[0];
    header[1] = MAGIC[1];

    // Version
    header[2] = PROTOCOL_VERSION;

    // Type
    header[3] = type;

    // Flags
    let flagByte = 0;
    if (flags.compressed) {flagByte |= PacketFlags.COMPRESSED;}
    if (flags.encrypted) {flagByte |= PacketFlags.ENCRYPTED;}
    if (flags.messagepack) {flagByte |= PacketFlags.MESSAGEPACK;}
    if (flags.pathDictionary) {flagByte |= PacketFlags.PATH_DICTIONARY;}
    header[4] = flagByte;

    // Sequence number (uint32 big-endian)
    header.writeUInt32BE(this._sequence, 5);

    // Payload length (uint32 big-endian)
    header.writeUInt32BE(payload.length, 9);

    // CRC16 over header bytes 0..12 (everything except the CRC field itself)
    const crcValue = crc16(header.subarray(0, 13));
    header.writeUInt16BE(crcValue, 13);

    return Buffer.concat([header, payload]);
  }

  /**
   * Advance sequence number with wraparound
   * @private
   */
  _advanceSequence() {
    this._sequence = (this._sequence + 1) >>> 0;
  }
}

// --- PacketParser ---

/**
 * Parses v2 protocol packets
 */
class PacketParser {
  /**
   * Parse a packet header
   * @param {Buffer} packet - Raw packet data
   * @returns {Object} Parsed packet information
   * @throws {Error} If packet is invalid
   */
  parseHeader(packet) {
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
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }

    // Parse type
    const type = packet[3];
    if (!Object.values(PacketType).includes(type)) {
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
      throw new Error(`CRC mismatch: expected 0x${expectedCRC.toString(16)}, got 0x${actualCRC.toString(16)}`);
    }

    // Validate payload length against actual data
    const actualPayloadLength = packet.length - HEADER_SIZE;
    if (payloadLength !== actualPayloadLength) {
      throw new Error(`Payload length mismatch: header says ${payloadLength}, actual ${actualPayloadLength}`);
    }

    // Extract payload
    const payload = packet.subarray(HEADER_SIZE);

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
   * Check if a buffer looks like a v2 packet (quick check without full parse)
   * @param {Buffer} data - Data to check
   * @returns {boolean} True if data starts with v2 magic bytes
   */
  isV2Packet(data) {
    return Buffer.isBuffer(data) &&
      data.length >= HEADER_SIZE &&
      data[0] === MAGIC[0] &&
      data[1] === MAGIC[1] &&
      data[2] === PROTOCOL_VERSION;
  }

  /**
   * Parse ACK payload
   * @param {Buffer} payload - ACK packet payload
   * @returns {number} Acknowledged sequence number
   */
  parseACKPayload(payload) {
    if (payload.length < 4) {
      throw new Error("ACK payload too small");
    }
    return payload.readUInt32BE(0);
  }

  /**
   * Parse NAK payload
   * @param {Buffer} payload - NAK packet payload
   * @returns {number[]} Array of missing sequence numbers
   */
  parseNAKPayload(payload) {
    if (payload.length % 4 !== 0) {
      throw new Error("NAK payload length must be a multiple of 4");
    }
    const missing = [];
    for (let i = 0; i < payload.length; i += 4) {
      missing.push(payload.readUInt32BE(i));
    }
    return missing;
  }
}

// --- Helpers ---

/**
 * Get human-readable name for a packet type
 * @param {number} type - Packet type value
 * @returns {string} Type name
 */
function getTypeName(type) {
  const names = {
    [PacketType.DATA]: "DATA",
    [PacketType.ACK]: "ACK",
    [PacketType.NAK]: "NAK",
    [PacketType.HEARTBEAT]: "HEARTBEAT",
    [PacketType.HELLO]: "HELLO"
  };
  return names[type] || "UNKNOWN";
}

module.exports = {
  PacketBuilder,
  PacketParser,
  PacketType,
  PacketFlags,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  MAGIC,
  MAX_SEQUENCE,
  crc16,
  getTypeName
};
