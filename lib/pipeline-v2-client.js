"use strict";

/**
 * Signal K Edge Link v2.0 - Client Pipeline
 *
 * Handles delta transmission with v2 protocol:
 * - Packet building with sequence numbers
 * - Encryption and compression (reuses v1 pipeline logic)
 * - UDP transmission
 *
 * @module lib/pipeline-v2-client
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { encryptBinary } = require("./crypto");
const { encodeDelta } = require("./pathDictionary");
const { PacketBuilder } = require("./packet");
const {
  MAX_SAFE_UDP_PAYLOAD,
  BROTLI_QUALITY_HIGH,
  UDP_RETRY_MAX,
  UDP_RETRY_DELAY,
  SMART_BATCH_SMOOTHING,
  calculateMaxDeltasPerBatch
} = require("./constants");

const brotliCompressAsync = promisify(zlib.brotliCompress);

/**
 * Creates the v2 client pipeline
 * @param {Object} app - SignalK app object (for logging)
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API: { sendDelta, getMetrics, getPacketBuilder }
 */
function createPipelineV2Client(app, state, metricsApi) {
  const { metrics, recordError, trackPathStats } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus;
  const packetBuilder = new PacketBuilder();

  /**
   * Converts delta object to buffer (JSON or MessagePack)
   * @param {Object|Array} delta - Delta object or array
   * @param {boolean} useMsgpack - Whether to use MessagePack
   * @returns {Buffer} Encoded buffer
   */
  function deltaBuffer(delta, useMsgpack = false) {
    if (useMsgpack) {
      return Buffer.from(msgpack.encode(delta));
    }
    return Buffer.from(JSON.stringify(delta), "utf8");
  }

  /**
   * Compress, encrypt, wrap in v2 packet, and send delta data via UDP.
   * Pipeline: Serialize → Compress → Encrypt → PacketBuild → Send
   *
   * @param {Object|Array} delta - Delta data to send
   * @param {string} secretKey - 32-character encryption key
   * @param {string} udpAddress - Destination IP address
   * @param {number} udpPort - Destination UDP port
   * @returns {Promise<void>}
   */
  async function sendDelta(delta, secretKey, udpAddress, udpPort) {
    try {
      if (!state.options) {
        app.debug("sendDelta called but plugin is stopped, ignoring");
        return;
      }

      // Apply path dictionary encoding if enabled
      const processedDelta = state.options.usePathDictionary
        ? (Array.isArray(delta) ? delta.map(encodeDelta) : encodeDelta(delta))
        : delta;

      // Serialize to buffer
      const serialized = deltaBuffer(processedDelta, state.options.useMsgpack);

      metrics.bandwidth.bytesOutRaw += serialized.length;

      if (Array.isArray(delta)) {
        delta.forEach((d) => trackPathStats(d, serialized.length / delta.length));
      } else {
        trackPathStats(delta, serialized.length);
      }

      // Compress
      const compressed = await brotliCompressAsync(serialized, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: state.options.useMsgpack
            ? zlib.constants.BROTLI_MODE_GENERIC
            : zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_HIGH,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
        }
      });

      // Encrypt
      const encrypted = encryptBinary(compressed, secretKey);

      // Build v2 packet with header
      const packet = packetBuilder.buildDataPacket(encrypted, {
        compressed: true,
        encrypted: true,
        messagepack: !!state.options.useMsgpack,
        pathDictionary: !!state.options.usePathDictionary
      });

      // MTU check
      if (packet.length > MAX_SAFE_UDP_PAYLOAD) {
        app.debug(
          `Warning: v2 packet size ${packet.length} bytes exceeds safe MTU (${MAX_SAFE_UDP_PAYLOAD}), may fragment.`
        );
        metrics.smartBatching.oversizedPackets++;
      }

      // Track bandwidth
      metrics.bandwidth.bytesOut += packet.length;
      metrics.bandwidth.packetsOut++;

      // Send packet
      await udpSendAsync(packet, udpAddress, udpPort);
      metrics.deltasSent++;

      // Update smart batching model
      const deltaCount = Array.isArray(delta) ? delta.length : 1;
      const bytesPerDelta = packet.length / deltaCount;

      state.avgBytesPerDelta =
        (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
      state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

      metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
      metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

      app.debug(
        `v2 sent: seq=${packetBuilder.getCurrentSequence() - 1}, ${deltaCount} deltas, ${packet.length} bytes`
      );

      state.lastPacketTime = Date.now();
    } catch (error) {
      const msg = error.message || "";
      if (msg.includes("compress")) {
        app.error(`v2 compression error: ${msg}`);
        recordError("compression", `v2 compression error: ${msg}`);
      } else if (msg.includes("encrypt")) {
        app.error(`v2 encryption error: ${msg}`);
        recordError("encryption", `v2 encryption error: ${msg}`);
      } else {
        app.error(`v2 sendDelta error: ${msg}`);
        recordError("general", `v2 sendDelta error: ${msg}`);
      }
    }
  }

  /**
   * Sends a message via UDP with retry logic
   * @param {Buffer} message - Message to send
   * @param {string} host - Destination host
   * @param {number} port - Destination port
   * @param {number} retryCount - Current retry count
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

  /**
   * Get the packet builder (for testing/metrics)
   * @returns {PacketBuilder}
   */
  function getPacketBuilder() {
    return packetBuilder;
  }

  return { sendDelta, getPacketBuilder };
}

module.exports = { createPipelineV2Client };
