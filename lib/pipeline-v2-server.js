"use strict";

/**
 * Signal K Edge Link v2.0 - Server Pipeline
 *
 * Handles delta reception with v2 protocol:
 * - Packet parsing and validation
 * - Sequence tracking with loss detection
 * - Decryption and decompression (reuses v1 pipeline logic)
 * - Signal K message handling
 * - Periodic ACK generation for reliability
 * - NAK generation on packet loss detection
 *
 * @module lib/pipeline-v2-server
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { decryptBinary } = require("./crypto");
const { decodeDelta } = require("./pathDictionary");
const { PacketBuilder, PacketParser, PacketType } = require("./packet");
const { SequenceTracker } = require("./sequence");
const { MetricsPublisher } = require("./metrics-publisher");

const { MAX_DECOMPRESSED_SIZE } = require("./constants");

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Creates the v2 server pipeline
 * @param {Object} app - SignalK app object (for logging)
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API
 */
function createPipelineV2Server(app, state, metricsApi) {
  const { metrics, recordError, trackPathStats, updateBandwidthRates } = metricsApi;
  const packetParser = new PacketParser();
  const packetBuilder = new PacketBuilder();

  // Reliability: ACK/NAK state
  const reliabilityConfig = (state.options && state.options.reliability) || {};
  const ackInterval = reliabilityConfig.ackInterval || 100;
  const ackResendInterval = reliabilityConfig.ackResendInterval || 1000;
  let lastAckSeq = null;
  let lastAckSentAt = 0;
  let ackTimer = null;
  // Client address for ACK/NAK replies (updated on each received packet).
  // Supports single client or bonding client (multiple source addresses).
  let lastClientAddress = null;
  let hasReceivedData = false;

  // Reliability metrics
  metrics.acksSent = metrics.acksSent || 0;
  metrics.naksSent = metrics.naksSent || 0;
  metrics.duplicatePackets = metrics.duplicatePackets || 0;
  metrics.dataPacketsReceived = metrics.dataPacketsReceived || 0;

  // Network metrics publisher
  const metricsPublisher = new MetricsPublisher(app);

  // Metrics collection state
  let metricsInterval = null;
  let lastMetricsTime = Date.now();
  let lastBytesReceived = 0;
  let lastPacketsReceived = 0;
  let lossBaseSeq = null;
  let lossHighestSeq = null;
  let lossReceivedCount = 0;
  let lastLossExpected = 0;
  let lastLossReceived = 0;

  function isAhead(seq, reference) {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  const sequenceTracker = new SequenceTracker({
    nakTimeout: reliabilityConfig.nakTimeout || 100,
    onLossDetected: (missing) => {
      app.debug(`v2 packet loss detected: sequences ${missing.join(", ")}`);
      _sendNAK(missing);
    }
  });

  /**
   * Send NAK for missing packets back to the client
   *
   * @private
   * @param {number[]} missingSeqs - Missing sequence numbers
   */
  async function _sendNAK(missingSeqs) {
    if (missingSeqs.length === 0) {return;}
    if (!lastClientAddress) {return;}

    try {
      const nakPacket = packetBuilder.buildNAKPacket(missingSeqs);
      await _sendUDP(nakPacket, lastClientAddress);

      metrics.naksSent++;
      app.debug(`Sent NAK: missing=${missingSeqs.join(", ")}`);
    } catch (err) {
      app.error(`Failed to send NAK: ${err.message}`);
    }
  }

  /**
   * Send periodic ACK to acknowledge received packets.
   * Only sends if new data has been received since last ACK.
   *
   * @private
   */
  async function _sendPeriodicACK() {
    if (!lastClientAddress || !hasReceivedData) {return;}
    if (sequenceTracker.expectedSeq === null) {return;}

    const currentExpected = sequenceTracker.expectedSeq >>> 0;
    const ackSeq = (currentExpected - 1) >>> 0;

    // Re-send duplicate ACKs periodically so client can recover if an ACK was lost.
    const isDuplicateAck = lastAckSeq !== null && ackSeq === lastAckSeq;
    const timeSinceLastAck = Date.now() - lastAckSentAt;
    if (isDuplicateAck && timeSinceLastAck < ackResendInterval) {
      return;
    }

    try {
      const ackPacket = packetBuilder.buildACKPacket(ackSeq);
      await _sendUDP(ackPacket, lastClientAddress);

      lastAckSeq = ackSeq;
      lastAckSentAt = Date.now();
      metrics.acksSent++;
      app.debug(`Sent ACK: seq=${ackSeq}`);
    } catch (err) {
      app.error(`Failed to send ACK: ${err.message}`);
    }
  }

  /**
   * Start periodic ACK timer
   */
  function startACKTimer() {
    if (ackTimer) {return;}
    ackTimer = setInterval(() => {
      _sendPeriodicACK().catch((err) => {
        app.error(`Periodic ACK error: ${err.message}`);
      });
    }, ackInterval);
  }

  /**
   * Stop periodic ACK timer
   */
  function stopACKTimer() {
    if (ackTimer) {
      clearInterval(ackTimer);
      ackTimer = null;
    }
  }

  /**
   * Send UDP packet to a destination
   *
   * @private
   * @param {Buffer} packet - Packet to send
   * @param {Object} destination - {address, port}
   * @returns {Promise<void>}
   */
  function _sendUDP(packet, destination) {
    if (!destination) {
      throw new Error("No client address known");
    }
    if (!state.socketUdp) {
      throw new Error("UDP socket not initialized");
    }

    return new Promise((resolve, reject) => {
      state.socketUdp.send(
        packet,
        destination.port,
        destination.address,
        (err) => {
          if (err) {reject(err);}
          else {resolve();}
        }
      );
    });
  }

  /**
   * Receive and process a v2 packet.
   * Pipeline: PacketParse → SequenceTrack → Decrypt → Decompress → Parse → handleMessage
   *
   * @param {Buffer} packet - Raw received packet
   * @param {string} secretKey - 32-character decryption key
   * @param {Object} [rinfo] - Remote address info {address, port}
   * @returns {Promise<void>}
   */
  async function receivePacket(packet, secretKey, rinfo) {
    try {
      if (!state.options) {
        app.debug("receivePacket called but plugin is stopped, ignoring");
        return;
      }

      // Bonding health probes use a lightweight out-of-band heartbeat packet.
      // Echo probe payload back to sender so the client-side bonding manager
      // can measure RTT per link without involving protocol headers.
      if (packet.length >= 12 && packet.toString("ascii", 0, 7) === "HBPROBE") {
        if (rinfo) {
          await _sendUDP(packet, { address: rinfo.address, port: rinfo.port });
        }
        return;
      }

      // Store client address for ACK/NAK replies
      if (rinfo) {
        lastClientAddress = {
          address: rinfo.address,
          port: rinfo.port
        };
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
        try {
          const info = JSON.parse(parsed.payload.toString());
          app.debug(`v2 hello from client: ${JSON.stringify(info)}`);
        } catch (parseErr) {
          app.error(`v2 failed to parse HELLO payload: ${parseErr.message}`);
        }
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
        metrics.duplicatePackets++;
        return;
      }

      // Count valid DATA packets for accurate packet loss calculation
      metrics.dataPacketsReceived++;
      hasReceivedData = true;
      const dataSeq = parsed.sequence >>> 0;
      if (seqResult.resynced || lossBaseSeq === null) {
        lossBaseSeq = dataSeq;
        lossHighestSeq = dataSeq;
        lossReceivedCount = 1;
        lastLossExpected = 0;
        lastLossReceived = 0;
        app.debug(`v2 sequence resync at seq=${dataSeq}`);
      } else {
        lossReceivedCount++;
        if (isAhead(dataSeq, lossHighestSeq)) {
          lossHighestSeq = dataSeq;
        }
      }

      // Decrypt
      const decrypted = decryptBinary(parsed.payload, secretKey);

      // Decompress
      const decompressed = await brotliDecompressAsync(decrypted);

      // Guard against decompression bombs
      if (decompressed.length > MAX_DECOMPRESSED_SIZE) {
        app.error(`v2 decompressed payload exceeds size limit (${decompressed.length} > ${MAX_DECOMPRESSED_SIZE})`);
        recordError("compression", "v2 decompressed payload exceeds size limit");
        return;
      }

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

      // Validate parsed content is an object or array
      if (jsonContent === null || typeof jsonContent !== "object") {
        app.error("v2 received non-object payload, skipping");
        recordError("general", "v2 received non-object payload");
        return;
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
   * Get the packet builder (for testing/metrics)
   * @returns {PacketBuilder}
   */
  function getPacketBuilder() {
    return packetBuilder;
  }

  /**
   * Get server pipeline metrics
   * @returns {Object}
   */
  function getMetrics() {
    return {
      expectedSeq: sequenceTracker.expectedSeq,
      receivedCount: sequenceTracker.receivedSeqs.size,
      pendingNAKs: sequenceTracker.nakTimers.size,
      acksSent: metrics.acksSent,
      naksSent: metrics.naksSent,
      lastAckSeq
    };
  }

  /**
   * Get the metrics publisher (for testing/external access)
   * @returns {MetricsPublisher}
   */
  function getMetricsPublisher() {
    return metricsPublisher;
  }

  /**
   * Start periodic metrics publishing (every 1 second)
   */
  function startMetricsPublishing() {
    if (metricsInterval) {return;}
    lastMetricsTime = Date.now();
    lastBytesReceived = metrics.bandwidth.bytesIn;
    lastPacketsReceived = metrics.bandwidth.packetsIn;
    lastLossExpected = 0;
    lastLossReceived = 0;

    metricsInterval = setInterval(() => {
      _publishServerMetrics();
    }, 1000);
  }

  /**
   * Stop periodic metrics publishing
   */
  function stopMetricsPublishing() {
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }
  }

  /**
   * Collect and publish server-side metrics to Signal K
   *
   * @private
   */
  function _publishServerMetrics() {
    updateBandwidthRates(true);

    const now = Date.now();
    const elapsed = (now - lastMetricsTime) / 1000;
    if (elapsed <= 0) {return;}

    // Calculate rates
    const bytesReceived = metrics.bandwidth.bytesIn - lastBytesReceived;
    const packetsReceived = metrics.bandwidth.packetsIn - lastPacketsReceived;

    const downloadBandwidth = bytesReceived / elapsed;
    const packetsReceivedPerSec = packetsReceived / elapsed;

    // Calculate packet loss using a re-baselined data sequence window.
    const totalExpected =
      lossBaseSeq !== null && lossHighestSeq !== null
        ? (((lossHighestSeq - lossBaseSeq) >>> 0) + 1)
        : 0;
    const totalReceived = lossReceivedCount;
    const periodExpected = Math.max(0, totalExpected - lastLossExpected);
    const periodReceived = Math.max(0, totalReceived - lastLossReceived);
    const packetLoss = periodExpected > 0
      ? Math.max(0, (periodExpected - periodReceived) / periodExpected)
      : (metrics.packetLoss || 0);
    metrics.packetLoss = packetLoss;

    // Publish to Signal K
    metricsPublisher.publish({
      downloadBandwidth: downloadBandwidth,
      packetsReceivedPerSec: packetsReceivedPerSec,
      packetLoss: packetLoss,
      sequenceNumber: sequenceTracker.expectedSeq,
      compressionRatio: metrics.bandwidth.compressionRatio || 0
    });

    // Update last values
    lastMetricsTime = now;
    lastBytesReceived = metrics.bandwidth.bytesIn;
    lastPacketsReceived = metrics.bandwidth.packetsIn;
    lastLossExpected = totalExpected;
    lastLossReceived = totalReceived;
  }

  return {
    receivePacket,
    getSequenceTracker,
    getPacketBuilder,
    getMetrics,
    getMetricsPublisher,
    startACKTimer,
    stopACKTimer,
    startMetricsPublishing,
    stopMetricsPublishing
  };
}

module.exports = { createPipelineV2Server };
