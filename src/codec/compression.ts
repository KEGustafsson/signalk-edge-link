"use strict";

/**
 * L1 codec — Brotli compression + delta serialization.
 *
 * Pure, deterministic payload codec extracted from the old `pipeline-utils.ts`
 * (rewrite plan doc 02/05). The matching socket I/O helper (`udpSendAsync`)
 * stays out of the codec layer and moves to the transport layer in Phase 2.
 *
 * @module codec/compression
 */

import { promisify } from "util";
import * as zlib from "zlib";
import * as msgpack from "@msgpack/msgpack";
import { BROTLI_QUALITY_HIGH } from "../foundation/constants";

export const brotliCompressAsync = promisify(zlib.brotliCompress);
export const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Converts delta object to buffer (JSON or MessagePack)
 * @param delta - Delta object or array to convert
 * @param useMsgpack - Whether to use MessagePack serialization
 * @returns Encoded buffer
 */
export function deltaBuffer(delta: unknown, useMsgpack = false): Buffer {
  if (useMsgpack) {
    return Buffer.from(msgpack.encode(delta));
  }
  return Buffer.from(JSON.stringify(delta), "utf8");
}

/**
 * Compress data using Brotli with mode-appropriate settings.
 *
 * Brotli quality is local-only: higher values produce smaller output at
 * higher CPU cost. The decompressor reads any quality level transparently,
 * so peers are not required to match. Range 0..11, default
 * {@link BROTLI_QUALITY_HIGH} = 6.
 *
 * @param data - Data to compress
 * @param useMsgpack - Whether the data is MessagePack (generic) or JSON (text)
 * @param brotliQuality - Optional override; clamped to 0..11. Defaults to
 *                       BROTLI_QUALITY_HIGH (6) when undefined.
 * @returns Compressed data
 */
export function compressPayload(
  data: Buffer,
  useMsgpack: boolean,
  brotliQuality?: number
): Promise<Buffer> {
  const quality =
    brotliQuality === undefined
      ? BROTLI_QUALITY_HIGH
      : Math.max(0, Math.min(11, Math.trunc(brotliQuality)));
  return brotliCompressAsync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: useMsgpack
        ? zlib.constants.BROTLI_MODE_GENERIC
        : zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    }
  }) as Promise<Buffer>;
}
