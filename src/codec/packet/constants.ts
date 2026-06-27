"use strict";

/**
 * L1 codec — packet wire constants, enums, CRC16 and protocol-version helpers.
 * Shared by the builder and parser; the public subset is re-exported by
 * packet-codec.ts.
 */

// --- Constants ---

/** Magic bytes identifying a reliable-transport packet: "SK" */
export const MAGIC = Buffer.from([0x53, 0x4b]);

/**
 * Reliable transport protocol version. Protocol v2 (the unauthenticated
 * CRC-only control plane) was removed; on the wire the node speaks v3 only —
 * the reliable binary stack with HMAC-authenticated control packets.
 */
export const PROTOCOL_VERSION = 0x03;

/** Alias kept for back-compat with existing imports; identical to PROTOCOL_VERSION. */
export const PROTOCOL_VERSION_V3 = 0x03;

export const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION_V3]);

/** Total header size in bytes */
export const HEADER_SIZE = 15;

/**
 * Packet types
 * @enum {number}
 */
export const PacketType = Object.freeze({
  DATA: 0x01,
  ACK: 0x02,
  NAK: 0x03,
  HEARTBEAT: 0x04,
  HELLO: 0x05,
  METADATA: 0x06,
  META_REQUEST: 0x07,
  /** Server → client: request a full values snapshot replay. */
  FULL_STATUS_REQUEST: 0x08
});

/**
 * Packet flag bit positions
 * @enum {number}
 */
export const PacketFlags = Object.freeze({
  COMPRESSED: 0x01, // bit 0
  ENCRYPTED: 0x02, // bit 1
  MESSAGEPACK: 0x04, // bit 2
  PATH_DICTIONARY: 0x08, // bit 3
  // bit 4: DATA/METADATA carry a trailing HMAC tag binding the header
  // (type/flags/sequence/length) to the AEAD ciphertext. Opt-in; both peers
  // must enable `authenticatedHeaders`. When clear, the packet uses the legacy
  // CRC-only header (still AEAD-protected payload).
  AUTHENTICATED_HEADER: 0x10 // bit 4
});

/** Maximum sequence number before wraparound (2^32 - 1) */
export const MAX_SEQUENCE = 0xffffffff;

/** A parsed packet header as returned by PacketParser.parseHeader(). */
export interface ParsedPacket {
  version: number;
  type: number;
  typeName: string;
  flags: {
    compressed: boolean;
    encrypted: boolean;
    messagepack: boolean;
    pathDictionary: boolean;
    authenticatedHeader: boolean;
  };
  sequence: number;
  payloadLength: number;
  payload: Buffer;
}

/** Pre-computed Set of valid packet type values for O(1) validation */
export const VALID_PACKET_TYPES = new Set(Object.values(PacketType));

export function normalizeProtocolVersion(version: number | undefined | null): number {
  if (version === undefined || version === null) {
    return PROTOCOL_VERSION;
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
    throw new Error("Packet protocol version must be 3");
  }
  return version;
}

// --- CRC16-CCITT ---

/**
 * Precomputed CRC16-CCITT lookup table (polynomial 0x1021)
 * @type {Uint16Array}
 */
const CRC16_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
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
export function crc16(data: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// --- Helpers ---

/**
 * Get human-readable name for a packet type
 * @param {number} type - Packet type value
 * @returns {string} Type name
 */
const TYPE_NAMES: Record<number, string> = {
  [PacketType.DATA]: "DATA",
  [PacketType.ACK]: "ACK",
  [PacketType.NAK]: "NAK",
  [PacketType.HEARTBEAT]: "HEARTBEAT",
  [PacketType.HELLO]: "HELLO",
  [PacketType.METADATA]: "METADATA",
  [PacketType.META_REQUEST]: "META_REQUEST",
  [PacketType.FULL_STATUS_REQUEST]: "FULL_STATUS_REQUEST"
};

export function getTypeName(type: number): string {
  return TYPE_NAMES[type] || "UNKNOWN";
}
