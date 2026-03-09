"use strict";

/**
 * Shared pipeline utilities used by both v1 and v2 client pipelines.
 *
 * @module lib/pipeline-utils
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { BROTLI_QUALITY_HIGH, UDP_RETRY_MAX, UDP_RETRY_DELAY } = require("./constants.ts");

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

/**
 * Sends a message via UDP with retry logic for transient errors.
 *
 * @param {Object} socket - dgram UDP socket
 * @param {Buffer} message - Message to send
 * @param {string} host - Destination host address
 * @param {number} port - Destination port number
 * @param {Object} [callbacks] - Optional callbacks for metrics/logging
 * @param {Function} [callbacks.onRetry] - Called on retry with (retryCount, error)
 * @param {Function} [callbacks.onError] - Called on final failure with (error)
 * @param {number} [retryCount=0] - Current retry count (internal)
 * @returns {Promise<void>}
 */
function udpSendAsync(socket, message, host, port, callbacks = {}, retryCount = 0) {
  if (!socket) {
    throw new Error("UDP socket not initialized, cannot send message");
  }

  return new Promise((resolve, reject) => {
    socket.send(message, port, host, async (error) => {
      if (error) {
        if (retryCount < UDP_RETRY_MAX && (error.code === "EAGAIN" || error.code === "ENOBUFS")) {
          if (callbacks.onRetry) {
            callbacks.onRetry(retryCount + 1, error);
          }
          await new Promise((res) => setTimeout(res, UDP_RETRY_DELAY * (retryCount + 1)));
          try {
            await udpSendAsync(socket, message, host, port, callbacks, retryCount + 1);
            resolve();
          } catch (retryError) {
            reject(retryError);
          }
        } else {
          if (callbacks.onError) {
            callbacks.onError(error, retryCount);
          }
          reject(error);
        }
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  deltaBuffer,
  compressPayload,
  brotliCompressAsync,
  brotliDecompressAsync,
  udpSendAsync
};
