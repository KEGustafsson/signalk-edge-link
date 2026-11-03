"use strict";

/**
 * Signal K Edge Link — FLEET_DATA payload encoding.
 *
 * Same encoding as DATA (protocol-v3-spec §15.4): delta array → JSON or
 * MessagePack → optional path dictionary → Brotli → AES-256-GCM. No compact
 * deltas and no value-dedup sentinels, so a receiver needs no per-sender
 * cache to decode a packet.
 *
 * @module codec/fleet-payload
 */

import * as msgpack from "@msgpack/msgpack";
import { encryptBinary, decryptBinary } from "./crypto";
import { encodeDelta, decodeDelta } from "./path-dictionary";
import { compressPayload, deltaBuffer, brotliDecompressAsync } from "./compression";
import {
  MAX_DECOMPRESSED_SIZE,
  MAX_PARSE_PAYLOAD_SIZE,
  MAX_DELTAS_PER_PACKET
} from "../foundation/constants";
import type { Delta } from "../foundation/types";

export interface FleetEncodingOptions {
  secretKey: string;
  stretchAsciiKey?: boolean;
  useMsgpack?: boolean;
  usePathDictionary?: boolean;
  brotliQuality?: number;
}

/** Encode and encrypt a batch of deltas for FLEET_DATA. */
export async function encodeFleetPayload(
  deltas: Delta[],
  options: FleetEncodingOptions
): Promise<Buffer> {
  const items = options.usePathDictionary ? deltas.map(encodeDelta) : deltas;
  const serialized = deltaBuffer(items, !!options.useMsgpack);
  const compressed = await compressPayload(serialized, !!options.useMsgpack, options.brotliQuality);
  return encryptBinary(compressed, options.secretKey, {
    stretchAsciiKey: options.stretchAsciiKey
  });
}

/**
 * Decrypt and decode a FLEET_DATA payload. `flags` come from the packet
 * header, so a receiver decodes whatever encoding the sender chose. Throws on
 * authentication failure, oversize or a non-array payload.
 */
export async function decodeFleetPayload(
  encrypted: Buffer,
  flags: { messagepack: boolean; pathDictionary: boolean },
  options: { secretKey: string; stretchAsciiKey?: boolean }
): Promise<Delta[]> {
  const decrypted = decryptBinary(encrypted, options.secretKey, {
    stretchAsciiKey: options.stretchAsciiKey
  });
  const decompressed = await brotliDecompressAsync(decrypted, {
    maxOutputLength: MAX_DECOMPRESSED_SIZE
  });
  if (decompressed.length > MAX_PARSE_PAYLOAD_SIZE) {
    throw new Error(
      `FLEET_DATA payload too large to parse: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
  }
  const content: unknown = flags.messagepack
    ? msgpack.decode(decompressed)
    : JSON.parse(decompressed.toString("utf8"));
  if (!Array.isArray(content)) {
    throw new Error("FLEET_DATA payload is not a delta array");
  }
  const deltas = content.slice(0, MAX_DELTAS_PER_PACKET) as Delta[];
  return flags.pathDictionary
    ? deltas.filter((d) => d && typeof d === "object").map(decodeDelta)
    : deltas.filter((d) => d && typeof d === "object");
}
