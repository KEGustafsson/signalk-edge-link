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
  const CLIENT_TELEMETRY_SOURCE = "signalk-edge-link-client-telemetry";
  const CLIENT_TELEMETRY_PATHS = new Set([
    "networking.edgeLink.rtt",
    "networking.edgeLink.jitter",
    "networking.edgeLink.packetLoss",
    "networking.edgeLink.retransmissions",
    "networking.edgeLink.queueDepth",
    "networking.edgeLink.retransmitRate",
    "networking.edgeLink.activeLink"
  ]);
  const REMOTE_TELEMETRY_TTL_MS = 15000;

  // Reliability: ACK/NAK state
  const reliabilityConfig = (state.options && state.options.reliability) || {};
  const ackInterval = reliabilityConfig.ackInterval ?? 100;
  const ackResendInterval = reliabilityConfig.ackResendInterval ?? 1000;
  // Session idle timeout: expire sessions that have not sent a packet for this long (ms)
  const SESSION_IDLE_TTL_MS = 300000; // 5 minutes
  let ackTimer = null;

  /**
   * Per-client session map, keyed by "address:port".
   * Each entry tracks independent sequence state and ACK/NAK state for one
   * remote client so that multiple clients can connect to the same server
   * port simultaneously.
   */
  const clientSessions = new Map();

  /**
   * Get or create a session object for the given rinfo.
   * @private
   * @param {Object} rinfo - { address, port }
   * @returns {Object} Session object
   */
  function _getOrCreateSession(rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    if (!clientSessions.has(key)) {
      clientSessions.set(key, {
        key,
        address: rinfo.address,
        port: rinfo.port,
        sequenceTracker: new SequenceTracker({
          nakTimeout: reliabilityConfig.nakTimeout || 100,
          onLossDetected: (missing) => {
            app.debug(`[v2-server] packet loss from ${key}: seqs ${missing.join(", ")}`);
            _sendNAK(missing, { address: rinfo.address, port: rinfo.port });
          }
        }),
        lastAckSeq: null,
        lastAckSentAt: 0,
        hasReceivedData: false,
        lastPacketTime: Date.now(),
        // per-session loss window counters
        lossBaseSeq: null,
        lossHighestSeq: null,
        lossReceivedCount: 0,
        lastLossExpected: 0,
        lastLossReceived: 0
      });
      app.debug(`[v2-server] new client session: ${key}`);
    }
    const session = clientSessions.get(key);
    session.lastPacketTime = Date.now();
    return session;
  }

  /**
   * Remove sessions that have been idle longer than SESSION_IDLE_TTL_MS.
   * @private
   */
  function _expireIdleSessions() {
    const now = Date.now();
    for (const [key, session] of clientSessions) {
      if (now - session.lastPacketTime > SESSION_IDLE_TTL_MS) {
        session.sequenceTracker.reset();
        clientSessions.delete(key);
        app.debug(`[v2-server] session expired (idle): ${key}`);
      }
    }
  }

  // Reliability metrics
  metrics.acksSent = metrics.acksSent || 0;
  metrics.naksSent = metrics.naksSent || 0;
  metrics.duplicatePackets = metrics.duplicatePackets || 0;
  metrics.dataPacketsReceived = metrics.dataPacketsReceived || 0;

  // Network metrics publisher (namespaced per instance when instanceId is set)
  const metricsPublisher = new MetricsPublisher(app, {
    pathPrefix: state.instanceId
      ? `networking.edgeLink.${state.instanceId}`
      : "networking.edgeLink"
  });

  // Metrics collection state (bandwidth rates; loss is tracked per-session)
  let metricsInterval = null;
  let lastMetricsTime = Date.now();
  let lastBytesReceived = 0;
  let lastPacketsReceived = 0;

  function _toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function _isFreshRemoteTelemetry(now = Date.now()) {
    const last = metrics.remoteNetworkQuality && metrics.remoteNetworkQuality.lastUpdate;
    return Number.isFinite(last) && last > 0 && (now - last) <= REMOTE_TELEMETRY_TTL_MS;
  }

  function _ingestRemoteTelemetry(deltaMessage) {
    if (!deltaMessage || !Array.isArray(deltaMessage.updates)) {
      return;
    }

    let changed = false;
    const remote = metrics.remoteNetworkQuality || {};
    const filteredUpdates = [];

    for (const update of deltaMessage.updates) {
      if (!update || !Array.isArray(update.values)) {
        filteredUpdates.push(update);
        continue;
      }

      const sourceLabel = update.source && update.source.label;
      if (sourceLabel !== CLIENT_TELEMETRY_SOURCE) {
        filteredUpdates.push(update);
        continue;
      }

      const remainingValues = [];
      for (const entry of update.values) {
        if (!entry || typeof entry.path !== "string" || !CLIENT_TELEMETRY_PATHS.has(entry.path)) {
          remainingValues.push(entry);
          continue;
        }

        switch (entry.path) {
          case "networking.edgeLink.rtt": {
            const rtt = _toFiniteNumber(entry.value);
            if (rtt !== null && rtt >= 0) {
              remote.rtt = rtt;
              metrics.rtt = rtt;
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.jitter": {
            const jitter = _toFiniteNumber(entry.value);
            if (jitter !== null && jitter >= 0) {
              remote.jitter = jitter;
              metrics.jitter = jitter;
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.packetLoss": {
            const loss = _toFiniteNumber(entry.value);
            if (loss !== null) {
              remote.packetLoss = Math.max(0, Math.min(1, loss));
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.retransmissions": {
            const retransmissions = _toFiniteNumber(entry.value);
            if (retransmissions !== null && retransmissions >= 0) {
              const rounded = Math.round(retransmissions);
              remote.retransmissions = rounded;
              metrics.retransmissions = rounded;
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.queueDepth": {
            const queueDepth = _toFiniteNumber(entry.value);
            if (queueDepth !== null && queueDepth >= 0) {
              const rounded = Math.round(queueDepth);
              remote.queueDepth = rounded;
              metrics.queueDepth = rounded;
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.retransmitRate": {
            const retransmitRate = _toFiniteNumber(entry.value);
            if (retransmitRate !== null) {
              remote.retransmitRate = Math.max(0, Math.min(1, retransmitRate));
              changed = true;
            }
            break;
          }
          case "networking.edgeLink.activeLink":
            if (typeof entry.value === "string" && entry.value.length > 0) {
              remote.activeLink = entry.value;
              changed = true;
            }
            break;
          default:
            remainingValues.push(entry);
            break;
        }
      }

      if (remainingValues.length > 0) {
        filteredUpdates.push({ ...update, values: remainingValues });
      }
    }

    if (changed) {
      remote.lastUpdate = Date.now();
      metrics.remoteNetworkQuality = remote;
    }

    deltaMessage.updates = filteredUpdates;
  }

  function isAhead(seq, reference) {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  // sequenceTracker is now per-session; kept for backward-compat test access
  // (returns tracker from first active session, or a fresh one if none exist)
  function _getFirstSessionTracker() {
    const first = clientSessions.values().next().value;
    return first ? first.sequenceTracker : new SequenceTracker({ nakTimeout: reliabilityConfig.nakTimeout || 100 });
  }

  /**
   * Send NAK for missing packets back to a specific client.
   *
   * @private
   * @param {number[]} missingSeqs - Missing sequence numbers
   * @param {Object} destination   - { address, port }
   */
  async function _sendNAK(missingSeqs, destination) {
    if (missingSeqs.length === 0) {return;}
    if (!destination) {return;}

    try {
      const nakPacket = packetBuilder.buildNAKPacket(missingSeqs);
      await _sendUDP(nakPacket, destination);

      metrics.naksSent++;
      app.debug(`Sent NAK to ${destination.address}:${destination.port}: missing=${missingSeqs.join(", ")}`);
    } catch (err) {
      app.error(`Failed to send NAK: ${err.message}`);
    }
  }

  /**
   * Send periodic ACK to all active client sessions.
   * Each session tracks its own ACK state independently.
   *
   * @private
   */
  async function _sendPeriodicACKs() {
    for (const session of clientSessions.values()) {
      if (!session.hasReceivedData) {continue;}
      if (session.sequenceTracker.expectedSeq === null) {continue;}

      const currentExpected = session.sequenceTracker.expectedSeq >>> 0;
      const ackSeq = (currentExpected - 1) >>> 0;

      // Re-send duplicate ACKs periodically so client can recover if an ACK was lost.
      const isDuplicateAck = session.lastAckSeq !== null && ackSeq === session.lastAckSeq;
      const timeSinceLastAck = Date.now() - session.lastAckSentAt;
      if (isDuplicateAck && timeSinceLastAck < ackResendInterval) {
        continue;
      }

      try {
        const ackPacket = packetBuilder.buildACKPacket(ackSeq);
        await _sendUDP(ackPacket, { address: session.address, port: session.port });

        session.lastAckSeq = ackSeq;
        session.lastAckSentAt = Date.now();
        metrics.acksSent++;
        app.debug(`Sent ACK to ${session.key}: seq=${ackSeq}`);
      } catch (err) {
        app.error(`Failed to send ACK to ${session.key}: ${err.message}`);
      }
    }
  }

  /**
   * Start periodic ACK timer.
   * Also runs session expiry on each tick (every ackInterval ms).
   */
  function startACKTimer() {
    if (ackTimer) {return;}
    ackTimer = setInterval(() => {
      _expireIdleSessions();
      _sendPeriodicACKs().catch((err) => {
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

      // Resolve per-client session (creates one on first contact from this addr:port)
      const session = rinfo ? _getOrCreateSession(rinfo) : null;

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

      // Use the per-client sequence tracker
      const seqResult = session
        ? session.sequenceTracker.processSequence(parsed.sequence)
        : { duplicate: false, resynced: false };

      if (seqResult.duplicate) {
        app.debug(`v2 duplicate packet: seq=${parsed.sequence}`);
        metrics.duplicatePackets++;
        return;
      }

      // Count valid DATA packets for accurate packet loss calculation
      metrics.dataPacketsReceived++;
      if (session) {
        session.hasReceivedData = true;
      }
      const dataSeq = parsed.sequence >>> 0;
      if (session) {
        if (seqResult.resynced || session.lossBaseSeq === null) {
          session.lossBaseSeq = dataSeq;
          session.lossHighestSeq = dataSeq;
          session.lossReceivedCount = 1;
          session.lastLossExpected = 0;
          session.lastLossReceived = 0;
          app.debug(`v2 sequence resync at seq=${dataSeq} for ${session.key}`);
        } else {
          session.lossReceivedCount++;
          if (isAhead(dataSeq, session.lossHighestSeq)) {
            session.lossHighestSeq = dataSeq;
          }
        }
      }

      // Decrypt
      const decrypted = decryptBinary(parsed.payload, secretKey);

      // Decompress (capped to prevent decompression bombs)
      const decompressed = await brotliDecompressAsync(decrypted, {
        maxOutputLength: MAX_DECOMPRESSED_SIZE
      });

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

      // Process deltas: payload may be an Array of deltas or an indexed
      // object ({0: delta, 1: delta, ...}).  Normalise to an array so
      // iteration is safe for both shapes.
      const deltas = Array.isArray(jsonContent)
        ? jsonContent
        : Object.values(jsonContent);
      const deltaCount = deltas.length;

      for (let i = 0; i < deltaCount; i++) {
        let deltaMessage = deltas[i];

        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`v2 skipping null delta at index ${i}`);
          continue;
        }

        deltaMessage = decodeDelta(deltaMessage);

        if (deltaMessage === null || deltaMessage === undefined) {
          app.debug(`v2 skipping null delta after decoding at index ${i}`);
          continue;
        }

        _ingestRemoteTelemetry(deltaMessage);
        if (!Array.isArray(deltaMessage.updates) || deltaMessage.updates.length === 0) {
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
   * Get the sequence tracker for the first active session (backward-compat for tests).
   * @returns {SequenceTracker}
   */
  function getSequenceTracker() {
    return _getFirstSessionTracker();
  }

  /**
   * Get the packet builder (for testing/metrics)
   * @returns {PacketBuilder}
   */
  function getPacketBuilder() {
    return packetBuilder;
  }

  /**
   * Get server pipeline metrics including per-session state.
   * @returns {Object}
   */
  function getMetrics() {
    const sessions = [...clientSessions.values()].map((s) => ({
      address: s.key,
      expectedSeq: s.sequenceTracker.expectedSeq,
      receivedCount: s.sequenceTracker.receivedSeqs.size,
      pendingNAKs: s.sequenceTracker.nakTimers.size,
      lastAckSeq: s.lastAckSeq,
      hasReceivedData: s.hasReceivedData,
      lastPacketTime: s.lastPacketTime
    }));
    return {
      sessions,
      totalSessions: clientSessions.size,
      acksSent: metrics.acksSent,
      naksSent: metrics.naksSent
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

    // Aggregate packet loss across all active client sessions.
    let aggExpected = 0;
    let aggReceived = 0;
    let aggPeriodExpected = 0;
    let aggPeriodReceived = 0;
    for (const session of clientSessions.values()) {
      if (session.lossBaseSeq === null || session.lossHighestSeq === null) {continue;}
      const totalExpected = ((((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0);
      const totalReceived = session.lossReceivedCount;
      aggExpected += totalExpected;
      aggReceived += totalReceived;
      aggPeriodExpected += Math.max(0, totalExpected - session.lastLossExpected);
      aggPeriodReceived += Math.max(0, totalReceived - session.lastLossReceived);
    }
    const packetLoss = aggPeriodExpected > 0
      ? Math.max(0, (aggPeriodExpected - aggPeriodReceived) / aggPeriodExpected)
      : (metrics.packetLoss || 0);
    metrics.packetLoss = packetLoss;
    // Advance per-session baselines for the next period
    for (const session of clientSessions.values()) {
      if (session.lossBaseSeq === null) {continue;}
      session.lastLossExpected = session.lossBaseSeq !== null && session.lossHighestSeq !== null
        ? ((((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0)
        : 0;
      session.lastLossReceived = session.lossReceivedCount;
    }
    const totalExpected = aggExpected;
    const totalReceived = aggReceived;

    const hasRemoteTelemetry = _isFreshRemoteTelemetry(now);
    const remote = metrics.remoteNetworkQuality || {};
    const effectiveRtt = hasRemoteTelemetry ? (remote.rtt || 0) : 0;
    const effectiveJitter = hasRemoteTelemetry ? (remote.jitter || 0) : 0;
    const effectivePacketLoss = hasRemoteTelemetry ? (remote.packetLoss || 0) : packetLoss;
    const effectiveRetransmissions = hasRemoteTelemetry ? (remote.retransmissions || 0) : 0;
    const effectiveQueueDepth = hasRemoteTelemetry ? (remote.queueDepth || 0) : 0;
    const effectiveRetransmitRate = hasRemoteTelemetry ? (remote.retransmitRate || 0) : 0;
    const effectiveActiveLink = hasRemoteTelemetry ? (remote.activeLink || "primary") : "primary";

    // Publish to Signal K
    metricsPublisher.publish({
      rtt: effectiveRtt,
      jitter: effectiveJitter,
      downloadBandwidth: downloadBandwidth,
      packetsReceivedPerSec: packetsReceivedPerSec,
      packetLoss: effectivePacketLoss,
      retransmissions: effectiveRetransmissions,
      queueDepth: effectiveQueueDepth,
      retransmitRate: effectiveRetransmitRate,
      activeLink: effectiveActiveLink,
      sequenceNumber: _getFirstSessionTracker().expectedSeq,
      compressionRatio: metrics.bandwidth.compressionRatio || 0
    });

    // Update last values
    lastMetricsTime = now;
    lastBytesReceived = metrics.bandwidth.bytesIn;
    lastPacketsReceived = metrics.bandwidth.packetsIn;
    // Per-session loss baselines are updated inside the loop above
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
