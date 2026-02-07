"use strict";

/**
 * Signal K Edge Link v2.0 - Server Pipeline
 *
 * Handles delta reception with v2 protocol:
 * - Packet parsing and validation
 * - Sequence tracking with loss detection
 * - Decryption and decompression (reuses v1 pipeline logic)
 * - Signal K message handling
 *
 * @module lib/pipeline-v2-server
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { decryptBinary } = require("./crypto");
const { decodeDelta } = require("./pathDictionary");
const { PacketParser, PacketType } = require("./packet");
const { SequenceTracker } = require("./sequence");

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Creates the v2 server pipeline
 * @param {Object} app - SignalK app object (for logging)
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API: { receivePacket, getMetrics, getSequenceTracker }
 */
function createPipelineV2Server(app, state, metricsApi) {
  const { metrics, recordError, trackPathStats } = metricsApi;
  const packetParser = new PacketParser();

  const sequenceTracker = new SequenceTracker({
    onLossDetected: (missing) => {
      app.debug(`v2 packet loss detected: sequences ${missing.join(", ")}`);
      // Phase 2: Send NAK packet back to client
    }
  });

  /**
   * Receive and process a v2 packet.
   * Pipeline: PacketParse → SequenceTrack → Decrypt → Decompress → Parse → handleMessage
   *
   * @param {Buffer} packet - Raw received packet
   * @param {string} secretKey - 32-character decryption key
   * @returns {Promise<void>}
   */
  async function receivePacket(packet, secretKey) {
    try {
      if (!state.options) {
        app.debug("receivePacket called but plugin is stopped, ignoring");
        return;
      }

      // Track incoming bandwidth
      metrics.bandwidth.bytesIn += packet.length;
      metrics.bandwidth.packetsIn++;

      // Check if this is a v2 packet
      if (!packetParser.isV2Packet(packet)) {
        app.debug("Received non-v2 packet, ignoring");
        return;
      }

      // Parse packet header
      const parsed = packetParser.parseHeader(packet);

      // Handle by packet type
      if (parsed.type === PacketType.HEARTBEAT) {
        app.debug("v2 heartbeat received");
        return;
      }

      if (parsed.type === PacketType.HELLO) {
        const info = JSON.parse(parsed.payload.toString());
        app.debug(`v2 hello from client: ${JSON.stringify(info)}`);
        return;
      }

      if (parsed.type !== PacketType.DATA) {
        app.debug(`v2 unhandled packet type: ${parsed.typeName}`);
        return;
      }

      // Track sequence for DATA packets
      const seqResult = sequenceTracker.processSequence(parsed.sequence);

      if (seqResult.duplicate) {
        app.debug(`v2 duplicate packet: seq=${parsed.sequence}`);
        metrics.bandwidth.packetsIn--; // don't count duplicates
        return;
      }

      if (seqResult.missing.length > 0) {
        app.debug(`v2 missing sequences: ${seqResult.missing.join(", ")}`);
        // Phase 2: Send NAK for missing sequences
      }

      // Decrypt
      const decrypted = decryptBinary(parsed.payload, secretKey);

      // Decompress
      const decompressed = await brotliDecompressAsync(decrypted);

      metrics.bandwidth.bytesInRaw += decompressed.length;

      // Parse content
      let jsonContent;
      if (parsed.flags.messagepack) {
        try {
          jsonContent = msgpack.decode(decompressed);
        } catch (msgpackErr) {
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

        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`v2 skipping null delta at index ${i}`);
          continue;
        }

        deltaMessage = decodeDelta(deltaMessage);

        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`v2 skipping null delta after decoding at index ${i}`);
          continue;
        }

        trackPathStats(deltaMessage, decompressed.length / deltaCount);

        app.handleMessage("", deltaMessage);
        app.debug(JSON.stringify(deltaMessage, null, 2));
        metrics.deltasReceived++;
      }

      app.debug(`v2 received: seq=${parsed.sequence}, ${deltaCount} deltas, ${packet.length} bytes`);
    } catch (error) {
      const msg = error.message || "";
      if (msg.includes("Unsupported state") || msg.includes("auth")) {
        app.error("v2 authentication failed: packet tampered or wrong key");
        recordError("encryption", "v2 authentication failed");
      } else if (msg.includes("decrypt")) {
        app.error(`v2 decryption error: ${msg}`);
        recordError("encryption", `v2 decryption error: ${msg}`);
      } else if (msg.includes("decompress")) {
        app.error(`v2 decompression error: ${msg}`);
        recordError("compression", `v2 decompression error: ${msg}`);
      } else if (msg.includes("CRC") || msg.includes("magic") || msg.includes("Packet")) {
        app.error(`v2 packet error: ${msg}`);
        recordError("general", `v2 packet error: ${msg}`);
      } else {
        app.error(`v2 receivePacket error: ${msg}`);
        recordError("general", `v2 receivePacket error: ${msg}`);
      }
    }
  }

  /**
   * Get the sequence tracker (for testing/metrics)
   * @returns {SequenceTracker}
   */
  function getSequenceTracker() {
    return sequenceTracker;
  }

  /**
   * Get server pipeline metrics
   * @returns {Object}
   */
  function getMetrics() {
    return {
      expectedSeq: sequenceTracker.expectedSeq,
      receivedCount: sequenceTracker.receivedSeqs.size,
      pendingNAKs: sequenceTracker.nakTimers.size
    };
  }

  return { receivePacket, getSequenceTracker, getMetrics };
}

module.exports = { createPipelineV2Server };
