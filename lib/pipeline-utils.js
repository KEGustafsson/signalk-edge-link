"use strict";

/**
 * Shared pipeline utilities used by both v1 and v2 client pipelines.
 *
 * @module lib/pipeline-utils
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { BROTLI_QUALITY_HIGH } = require("./constants");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Converts delta object to buffer (JSON or MessagePack)
 * @param {Object|Array} delta - Delta object or array to convert
 * @param {boolean} useMsgpack - Whether to use MessagePack serialization
 * @returns {Buffer} Encoded buffer
 */
function deltaBuffer(delta, useMsgpack = false) {
  if (useMsgpack) {
    return Buffer.from(msgpack.encode(delta));
  }
  return Buffer.from(JSON.stringify(delta), "utf8");
}

/**
 * Compress data using Brotli with mode-appropriate settings.
 * @param {Buffer} data - Data to compress
 * @param {boolean} useMsgpack - Whether the data is MessagePack (generic) or JSON (text)
 * @returns {Promise<Buffer>} Compressed data
 */
function compressPayload(data, useMsgpack) {
  return brotliCompressAsync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: useMsgpack
        ? zlib.constants.BROTLI_MODE_GENERIC
        : zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_HIGH,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    }
  });
}

module.exports = {
  deltaBuffer,
  compressPayload,
  brotliCompressAsync,
  brotliDecompressAsync
};
