"use strict";

/**
 * L1 codec — packet wire format public surface (rewrite plan doc 02/05).
 * Barrels the split constants / builder / parser. Public exports match the
 * pre-split module exactly.
 *
 * @module codec/packet-codec
 */

export { PacketBuilder } from "./packet/builder";
export { PacketParser } from "./packet/parser";
export type { ParsedPacket } from "./packet/constants";
export {
  PacketType,
  PacketFlags,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_V3,
  SUPPORTED_PROTOCOL_VERSIONS,
  MAGIC,
  MAX_SEQUENCE,
  usesAuthenticatedControl,
  crc16,
  getTypeName
} from "./packet/constants";
