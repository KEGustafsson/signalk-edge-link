"use strict";

/**
 * L1 codec — packet wire constants, enums, CRC16 and protocol-version helpers.
 * Shared by the builder and parser; the public subset is re-exported by
 * packet-codec.ts.
 */

// --- Constants ---

/** Magic bytes identifying a v2 packet: "SK" */
export const MAGIC = Buffer.from([0x53, 0x4b]);

/** Default reliable transport protocol version */
export const PROTOCOL_VERSION = 0x02;

export const PROTOCOL_VERSION_V3 = 0x03;

export const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, PROTOCOL_VERSION_V3]);

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
  PATH_DICTIONARY: 0x08 // bit 3
});

/** Maximum sequence number before wraparound (2^32 - 1) */
export const MAX_SEQUENCE = 0xffffffff;

/** A parsed packet header as returned by PacketParser.parseHeader(). */
export interface ParsedPacket {
  version: number;
  type: number;
  typeName: string;
  flags: { compressed: boolean; encrypted: boolean; messagepack: boolean; pathDictionary: boolean };
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
    throw new Error("Packet protocol version must be 2 or 3");
  }
  return version;
}

/**
 * Whether control packets (ACK/NAK/HEARTBEAT/HELLO/META_REQUEST/
 * FULL_STATUS_REQUEST) carry an HMAC tag instead of a CRC-only trailer.
 *
 * v3 requires HMAC. v2 control packets carry only a CRC16 trailer (or no
 * trailer at all for HEARTBEAT / META_REQUEST / FULL_STATUS_REQUEST) — a
 * CRC is not a security primitive, so v2 control frames are forgeable by
 * any host that can reach the UDP port. Operators MUST deploy v3 for any
 * configuration where the UDP port is exposed to untrusted networks; the
 * server emits a loud warning at startup whenever a v2 connection is
 * configured. See src/index.ts and docs/protocol-v2-spec.md §5.
 */
export function usesAuthenticatedControl(version: number | undefined | null): boolean {
  return normalizeProtocolVersion(version) >= PROTOCOL_VERSION_V3;
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
