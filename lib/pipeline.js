"use strict";

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { encryptBinary, decryptBinary } = require("./crypto");
const { encodeDelta, decodeDelta } = require("./pathDictionary");
const {
  MAX_SAFE_UDP_PAYLOAD,
  BROTLI_QUALITY_HIGH,
  UDP_RETRY_MAX,
  UDP_RETRY_DELAY,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch
} = require("./constants");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Creates the data processing pipeline (compress, encrypt, send / receive, decrypt, decompress).
 * @param {Object} app - SignalK app object (for logging)
 * @param {Object} state - Shared mutable state (options, socketUdp, batching vars, lastPacketTime)
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API: { packCrypt, unpackDecrypt }
 */
function createPipeline(app, state, metricsApi) {
  const { metrics, recordError, trackPathStats } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus;

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
   * Compresses, encrypts, and sends delta data via UDP.
   * Pipeline: Serialize -> Compress -> Encrypt (AES-256-GCM) -> Send
   * @param {Object|Array} delta - Delta data to send
   * @param {string} secretKey - 32-character encryption key
   * @param {string} udpAddress - Destination IP address
   * @param {number} udpPort - Destination UDP port
   * @returns {Promise<void>}
   */
  async function packCrypt(delta, secretKey, udpAddress, udpPort) {
    try {
      // Guard against calls after plugin stop
      if (!state.options) {
        app.debug("packCrypt called but plugin is stopped, ignoring");
        return;
      }

      // Apply path dictionary encoding if enabled
      const processedDelta = state.options.usePathDictionary
        ? (Array.isArray(delta) ? delta.map(encodeDelta) : encodeDelta(delta))
        : delta;

      // Serialize to buffer (JSON or MessagePack)
      const serialized = deltaBuffer(processedDelta, state.options.useMsgpack);

      // Track raw bytes for compression ratio calculation
      metrics.bandwidth.bytesOutRaw += serialized.length;

      // Track path stats AFTER serialization (reuse size for efficiency)
      if (Array.isArray(delta)) {
        delta.forEach((d) => trackPathStats(d, serialized.length / delta.length));
      } else {
        trackPathStats(delta, serialized.length);
      }

      // Single compression stage (before encryption)
      const compressed = await brotliCompressAsync(serialized, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: state.options.useMsgpack
            ? zlib.constants.BROTLI_MODE_GENERIC
            : zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_HIGH,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
        }
      });

      // Encrypt with AES-256-GCM (binary format with built-in authentication)
      const packet = encryptBinary(compressed, secretKey);

      // Check for MTU issues
      if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
        app.debug(
          `Warning: Packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment. ` +
            "Consider reducing delta timer interval or filtering paths."
        );
        metrics.smartBatching.oversizedPackets++;
      }

      // Track bandwidth
      metrics.bandwidth.bytesOut += packet.length;
      metrics.bandwidth.packetsOut++;

      // Send packet
      await udpSendAsync(packet, udpAddress, udpPort);
      metrics.deltasSent++;

      // Update smart batching model after successful send
      const deltaCount = Array.isArray(delta) ? delta.length : 1;
      const bytesPerDelta = packet.length / deltaCount;

      // Update rolling average using exponential smoothing
      state.avgBytesPerDelta =
        (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;

      // Recalculate max deltas for next batch based on updated average
      state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

      // Update metrics for monitoring
      metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
      metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

      app.debug(
        `Smart batch: ${deltaCount} deltas, ${packet.length} bytes (${bytesPerDelta.toFixed(0)} bytes/delta), ` +
          `avg=${state.avgBytesPerDelta.toFixed(0)}, nextMaxDeltas=${state.maxDeltasPerBatch}`
      );

      // Update last packet time for hello message suppression
      state.lastPacketTime = Date.now();
    } catch (error) {
      const msg = error.message || "";
      if (msg.includes("compress")) {
        app.error(`Compression error: ${msg}`);
        recordError("compression", `Compression error: ${msg}`);
      } else if (msg.includes("encrypt")) {
        app.error(`Encryption error: ${msg}`);
        recordError("encryption", `Encryption error: ${msg}`);
      } else {
        app.error(`packCrypt error: ${msg}`);
        recordError("general", `packCrypt error: ${msg}`);
      }
    }
  }

  /**
   * Decompresses, decrypts, and processes received UDP data.
   * Pipeline: Receive -> Decrypt (AES-256-GCM) -> Decompress -> Parse -> Process
   * @param {Buffer} packet - Binary packet with encrypted data
   * @param {string} secretKey - 32-character decryption key
   * @returns {Promise<void>}
   */
  async function unpackDecrypt(packet, secretKey) {
    try {
      // Guard against calls after plugin stop
      if (!state.options) {
        app.debug("unpackDecrypt called but plugin is stopped, ignoring");
        return;
      }

      // Track incoming bandwidth
      metrics.bandwidth.bytesIn += packet.length;
      metrics.bandwidth.packetsIn++;

      // Decrypt with AES-256-GCM (authentication is verified automatically)
      const decrypted = decryptBinary(packet, secretKey);

      // Decompress (single decompression stage)
      const decompressed = await brotliDecompressAsync(decrypted);

      // Track raw bytes
      metrics.bandwidth.bytesInRaw += decompressed.length;

      // Parse content (JSON or MessagePack)
      let jsonContent;
      if (state.options.useMsgpack) {
        try {
          jsonContent = msgpack.decode(decompressed);
        } catch (msgpackErr) {
          // Fallback to JSON if MessagePack fails
          jsonContent = JSON.parse(decompressed.toString());
        }
      } else {
        jsonContent = JSON.parse(decompressed.toString());
      }

      // Process deltas
      const deltaKeys = Object.keys(jsonContent);
      const deltaCount = deltaKeys.length;

      for (let i = 0; i < deltaCount; i++) {
        const jsonKey = deltaKeys[i];
        let deltaMessage = jsonContent[jsonKey];

        // Skip null or undefined delta messages
        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`Skipping null delta message at index ${i}`);
          continue;
        }

        // Decode path dictionary IDs and ensure source is never null/undefined
        // decodeDelta via transformDelta always applies source ?? {}, handling both cases
        deltaMessage = decodeDelta(deltaMessage);

        // Skip if decoding returned null
        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`Skipping null delta message after decoding at index ${i}`);
          continue;
        }

        // Track path stats for server-side analytics
        trackPathStats(deltaMessage, decompressed.length / deltaCount);

        app.handleMessage("", deltaMessage);
        app.debug(JSON.stringify(deltaMessage, null, 2));
        metrics.deltasReceived++;
      }
    } catch (error) {
      const msg = error.message || "";
      if (msg.includes("Unsupported state") || msg.includes("auth")) {
        app.error("Authentication failed: packet tampered or wrong key");
        recordError("encryption", "Authentication failed: packet tampered or wrong key");
      } else if (msg.includes("decrypt")) {
        app.error(`Decryption error: ${msg}`);
        recordError("encryption", `Decryption error: ${msg}`);
      } else if (msg.includes("decompress")) {
        app.error(`Decompression error: ${msg}`);
        recordError("compression", `Decompression error: ${msg}`);
      } else {
        app.error(`unpackDecrypt error: ${msg}`);
        recordError("general", `unpackDecrypt error: ${msg}`);
      }
    }
  }

  /**
   * Sends a message via UDP with retry logic
   * @param {Buffer} message - Message to send
   * @param {string} host - Destination host address
   * @param {number} port - Destination port number
   * @param {number} retryCount - Number of retries (default 0)
   * @returns {Promise<void>}
   */
  function udpSendAsync(message, host, port, retryCount = 0) {
    if (!state.socketUdp) {
      const error = new Error("UDP socket not initialized, cannot send message");
      app.error(error.message);
      setStatus("UDP socket not initialized - cannot send data");
      throw error;
    }

    return new Promise((resolve, reject) => {
      state.socketUdp.send(message, port, host, async (error) => {
        if (error) {
          metrics.udpSendErrors++;
          if (retryCount < UDP_RETRY_MAX && (error.code === "EAGAIN" || error.code === "ENOBUFS")) {
            app.debug(`UDP send error (${error.code}), retry ${retryCount + 1}/${UDP_RETRY_MAX}`);
            metrics.udpRetries++;
            await new Promise((res) => setTimeout(res, UDP_RETRY_DELAY * (retryCount + 1)));
            try {
              await udpSendAsync(message, host, port, retryCount + 1);
              resolve();
            } catch (retryError) {
              reject(retryError);
            }
          } else {
            app.error(`UDP send error to ${host}:${port} - ${error.message} (code: ${error.code})`);
            recordError("udpSend", `UDP send error: ${error.message} (${error.code})`);
            if (retryCount >= UDP_RETRY_MAX) {
              app.error("Max retries reached, packet dropped");
            }
            reject(error);
          }
        } else {
          resolve();
        }
      });
    });
  }

  return { packCrypt, unpackDecrypt };
}

module.exports = createPipeline;
