"use strict";

/**
 * Signal K Edge Link v2.0 - Client Pipeline
 *
 * Handles delta transmission with v2 protocol:
 * - Packet building with sequence numbers
 * - Encryption and compression (reuses v1 pipeline logic)
 * - UDP transmission
 * - Retransmission queue for reliability
 * - ACK/NAK handling for packet delivery confirmation
 *
 * @module lib/pipeline-v2-client
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { encryptBinary } = require("./crypto");
const { encodeDelta } = require("./pathDictionary");
const { PacketBuilder, PacketParser, PacketType } = require("./packet");
const { RetransmitQueue } = require("./retransmit-queue");
const { MetricsPublisher } = require("./metrics-publisher");
const { CongestionControl } = require("./congestion");
const { BondingManager } = require("./bonding");
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
 * @returns {Object} Pipeline API
 */
function createPipelineV2Client(app, state, metricsApi) {
  const { metrics, recordError, trackPathStats, updateBandwidthRates } = metricsApi;
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});
  const packetBuilder = new PacketBuilder();
  const packetParser = new PacketParser();

  // Reliability: retransmit queue
  const retransmitQueue = new RetransmitQueue({
    maxSize: (state.options && state.options.reliability && state.options.reliability.retransmitQueueSize) || 5000,
    maxRetransmits: (state.options && state.options.reliability && state.options.reliability.maxRetransmits) || 3
  });
  const retransmitMaxAge = (state.options && state.options.reliability && state.options.reliability.retransmitMaxAge) || 30000;
  const retransmitMinAge = (state.options && state.options.reliability && state.options.reliability.retransmitMinAge) || 2000;
  const retransmitRttMultiplier = (state.options && state.options.reliability && state.options.reliability.retransmitRttMultiplier) || 6;
  const ackIdleDrainAge = (state.options && state.options.reliability && state.options.reliability.ackIdleDrainAge) || 3000;
  const forceDrainAfterAckIdle =
    state.options && state.options.reliability && state.options.reliability.forceDrainAfterAckIdle !== undefined
      ? !!state.options.reliability.forceDrainAfterAckIdle
      : true;
  const forceDrainAfterMs = (state.options && state.options.reliability && state.options.reliability.forceDrainAfterMs) || 12000;

  // Reliability metrics
  metrics.retransmissions = metrics.retransmissions || 0;
  metrics.queueDepth = metrics.queueDepth || 0;
  metrics.rtt = metrics.rtt || 0;
  metrics.jitter = metrics.jitter || 0;

  // Network metrics publisher
  const metricsPublisher = new MetricsPublisher(app);

  // Dynamic congestion control
  const congestionConfig = (state.options && state.options.congestionControl) || {};
  const congestionControl = new CongestionControl(congestionConfig);
  let congestionAdjustInterval = null;

  // Connection bonding (initialized lazily via initBonding)
  let bondingManager = null;

  // Metrics collection state
  let metricsInterval = null;
  let lastMetricsTime = Date.now();
  let lastBytesSent = 0;
  let lastPacketsSent = 0;

  // Enhanced monitoring hooks (set externally via setMonitoring)
  let monitoringHooks = null;

  // RTT tracking for jitter calculation
  const rttSamples = [];
  let lastAckedSeq = null;
  let lastAckAt = Date.now();

  // Sliding window for packet loss calculation
  const LOSS_WINDOW_SIZE = 50;
  const lossWindow = []; // recent send outcomes: true = retransmitted, false = clean

  function _effectiveRetransmitAge() {
    let maxAge = retransmitMaxAge;

    if (metrics.rtt > 0) {
      const rttBasedAge = Math.round(metrics.rtt * retransmitRttMultiplier);
      maxAge = Math.min(maxAge, Math.max(retransmitMinAge, rttBasedAge));
    }

    const ackIdleMs = Date.now() - lastAckAt;
    if (ackIdleMs >= ackIdleDrainAge) {
      maxAge = Math.min(maxAge, ackIdleDrainAge);
    }

    return Math.max(retransmitMinAge, maxAge);
  }

  function _pruneRetransmitQueue(reason) {
    const ackIdleMs = Date.now() - lastAckAt;
    if (forceDrainAfterAckIdle && ackIdleMs >= forceDrainAfterMs && retransmitQueue.getSize() > 0) {
      const dropped = retransmitQueue.getSize();
      retransmitQueue.clear();
      metrics.queueDepth = 0;
      app.debug(`Force-drained retransmit queue: dropped=${dropped} (${reason}, ackIdle=${ackIdleMs}ms)`);
      return;
    }

    const maxAge = _effectiveRetransmitAge();
    const expired = retransmitQueue.expireOld(maxAge);
    if (expired > 0) {
      metrics.queueDepth = retransmitQueue.getSize();
      app.debug(`Pruned ${expired} retransmit entries (${reason}, maxAge=${maxAge}ms, queueDepth=${metrics.queueDepth})`);
    }
  }

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
   * Pipeline: Serialize → Compress → Encrypt → PacketBuild → Send → Store in retransmit queue
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

      // Capture sequence before building (buildDataPacket advances it)
      const seq = packetBuilder.getCurrentSequence();

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

      // Enhanced monitoring: capture and inspect
      if (monitoringHooks) {
        if (monitoringHooks.packetCapture) {
          monitoringHooks.packetCapture.capture(packet, "send", { address: udpAddress, port: udpPort });
        }
        if (monitoringHooks.packetInspector) {
          monitoringHooks.packetInspector.inspect(packet, "send", { address: udpAddress, port: udpPort });
        }
        if (monitoringHooks.packetLossTracker) {
          monitoringHooks.packetLossTracker.record(false); // not lost
        }
      }

      // Store in retransmit queue for reliability
      retransmitQueue.add(seq, packet);
      metrics.queueDepth = retransmitQueue.getSize();
      _pruneRetransmitQueue("send");

      // Record clean send in loss window
      lossWindow.push(false);
      if (lossWindow.length > LOSS_WINDOW_SIZE) {lossWindow.shift();}

      // Update smart batching model
      const deltaCount = Array.isArray(delta) ? delta.length : 1;
      const bytesPerDelta = packet.length / deltaCount;

      state.avgBytesPerDelta =
        (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
      state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

      metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
      metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

      app.debug(
        `v2 sent: seq=${seq}, ${deltaCount} deltas, ${packet.length} bytes`
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
   * Handle incoming ACK packet from server.
   * Removes acknowledged packets from the retransmit queue.
   *
   * @param {Buffer} packet - Raw ACK packet
   */
  function receiveACK(packet) {
    try {
      const parsed = packetParser.parseHeader(packet);

      if (parsed.type !== PacketType.ACK) {
        app.error(`Expected ACK, got ${parsed.typeName}`);
        return;
      }

      const ackedSeq = packetParser.parseACKPayload(parsed.payload);

      // Estimate RTT from original send timestamp (not retransmit timestamp)
      const entry = retransmitQueue.get(ackedSeq);
      if (entry && (entry.originalTimestamp || entry.timestamp)) {
        const rtt = Date.now() - (entry.originalTimestamp || entry.timestamp);
        metrics.rtt = rtt;

        // Track RTT samples for jitter calculation
        rttSamples.push(rtt);
        if (rttSamples.length > 10) {
          rttSamples.shift();
        }

        // Calculate jitter as standard deviation of recent RTT samples
        if (rttSamples.length >= 2) {
          const avg = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
          const variance = rttSamples.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / rttSamples.length;
          metrics.jitter = Math.round(Math.sqrt(variance));
        }
      }

      // Remove acknowledged packets from queue
      const removed = retransmitQueue.acknowledgeRange(lastAckedSeq, ackedSeq);
      lastAckedSeq = ackedSeq >>> 0;
      lastAckAt = Date.now();

      // Update congestion control with latest network metrics
      congestionControl.updateMetrics({
        rtt: metrics.rtt,
        packetLoss: _calculatePacketLoss()
      });

      app.debug(`ACK received: seq=${ackedSeq}, removed=${removed}, queueDepth=${retransmitQueue.getSize()}, rtt=${metrics.rtt}ms`);

      // Update metrics
      metrics.queueDepth = retransmitQueue.getSize();
      _pruneRetransmitQueue("ack");
    } catch (err) {
      app.error(`Failed to process ACK: ${err.message}`);
      recordError("general", `ACK processing error: ${err.message}`);
    }
  }

  /**
   * Handle incoming NAK packet from server.
   * Retransmits the requested missing packets.
   *
   * @param {Buffer} packet - Raw NAK packet
   * @param {string} udpAddress - Address to retransmit to
   * @param {number} udpPort - Port to retransmit to
   * @returns {Promise<void>}
   */
  async function receiveNAK(packet, udpAddress, udpPort) {
    try {
      const parsed = packetParser.parseHeader(packet);

      if (parsed.type !== PacketType.NAK) {
        app.error(`Expected NAK, got ${parsed.typeName}`);
        return;
      }

      const missingSeqs = packetParser.parseNAKPayload(parsed.payload);

      app.debug(`NAK received: missing=${missingSeqs.join(", ")}`);

      // Get packets for retransmission
      const toRetransmit = retransmitQueue.retransmit(missingSeqs);

      // Retransmit each packet
      for (const { sequence, packet: retransmitPacket, attempt } of toRetransmit) {
        app.debug(`Retransmitting seq=${sequence}, attempt=${attempt}`);
        await udpSendAsync(retransmitPacket, udpAddress, udpPort);
        metrics.retransmissions++;

        // Record loss event in sliding window
        lossWindow.push(true);
        if (lossWindow.length > LOSS_WINDOW_SIZE) {lossWindow.shift();}
      }

      app.debug(`Retransmitted ${toRetransmit.length} packets`);
      metrics.queueDepth = retransmitQueue.getSize();
    } catch (err) {
      app.error(`Failed to process NAK: ${err.message}`);
      recordError("general", `NAK processing error: ${err.message}`);
    }
  }

  /**
   * Handle incoming control packets (ACK/NAK) from the server.
   * Called when data is received on the UDP socket.
   *
   * @param {Buffer} msg - Raw packet data
   * @param {Object} rinfo - Remote address info
   */
  async function handleControlPacket(msg, rinfo) {
    try {
      // Quick check: is this a v2 packet?
      if (!packetParser.isV2Packet(msg)) {
        return;
      }

      const parsed = packetParser.parseHeader(msg);

      if (parsed.type === PacketType.ACK) {
        receiveACK(msg);
      } else if (parsed.type === PacketType.NAK) {
        await receiveNAK(msg, rinfo.address, rinfo.port);
      }
      // Ignore other packet types on client side
    } catch (err) {
      // Ignore parse errors (might be corrupted packet)
      app.debug(`Failed to parse control packet: ${err.message}`);
    }
  }

  /**
   * Sends a message via UDP with retry logic.
   * When bonding is active, uses the bonding manager's active socket and address.
   *
   * @param {Buffer} message - Message to send
   * @param {string} host - Destination host (overridden by bonding if active)
   * @param {number} port - Destination port (overridden by bonding if active)
   * @param {number} retryCount - Current retry count
   * @returns {Promise<void>}
   */
  function udpSendAsync(message, host, port, retryCount = 0) {
    // Determine socket and destination based on bonding state
    let socket;
    let sendHost = host;
    let sendPort = port;

    if (bondingManager) {
      socket = bondingManager.getActiveSocket();
      const dest = bondingManager.getActiveAddress();
      sendHost = dest.address;
      sendPort = dest.port;
    } else {
      socket = state.socketUdp;
    }

    if (!socket) {
      const error = new Error("UDP socket not initialized, cannot send message");
      app.error(error.message);
      setStatus("UDP socket not initialized - cannot send data");
      throw error;
    }

    return new Promise((resolve, reject) => {
      socket.send(message, sendPort, sendHost, async (error) => {
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
            app.error(`UDP send error to ${sendHost}:${sendPort} - ${error.message} (code: ${error.code})`);
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

  /**
   * Get the retransmit queue (for testing/metrics)
   * @returns {RetransmitQueue}
   */
  function getRetransmitQueue() {
    return retransmitQueue;
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
    lastBytesSent = metrics.bandwidth.bytesOut;
    lastPacketsSent = metrics.bandwidth.packetsOut;

    metricsInterval = setInterval(() => {
      _publishMetrics();
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
   * Collect and publish metrics to Signal K
   *
   * @private
   */
  function _publishMetrics() {
    updateBandwidthRates(false);

    _pruneRetransmitQueue("metrics");

    const now = Date.now();
    const elapsed = (now - lastMetricsTime) / 1000; // seconds
    if (elapsed <= 0) {return;}

    // Calculate rates
    const bytesSent = metrics.bandwidth.bytesOut - lastBytesSent;
    const packetsSent = metrics.bandwidth.packetsOut - lastPacketsSent;

    const uploadBandwidth = bytesSent / elapsed;
    const packetsSentPerSec = packetsSent / elapsed;

    // Calculate retransmit rate
    const retransmitRate = metrics.bandwidth.packetsOut > 0 ?
      metrics.retransmissions / metrics.bandwidth.packetsOut : 0;

    // Publish to Signal K
    metricsPublisher.publish({
      rtt: metrics.rtt || 0,
      jitter: metrics.jitter || 0,
      uploadBandwidth: uploadBandwidth,
      packetsSentPerSec: packetsSentPerSec,
      retransmissions: metrics.retransmissions,
      sequenceNumber: packetBuilder.getCurrentSequence(),
      queueDepth: retransmitQueue.getSize(),
      retransmitRate: retransmitRate,
      activeLink: bondingManager ? bondingManager.getActiveLinkName() : "primary",
      compressionRatio: metrics.bandwidth.compressionRatio || 0
    });

    // Enhanced monitoring: snapshot retransmission rates and check alerts
    if (monitoringHooks) {
      if (monitoringHooks.retransmissionTracker) {
        monitoringHooks.retransmissionTracker.snapshot(
          metrics.bandwidth.packetsOut,
          metrics.retransmissions
        );
      }
      if (monitoringHooks.alertManager) {
        monitoringHooks.alertManager.checkAll({
          rtt: metrics.rtt || 0,
          jitter: metrics.jitter || 0,
          retransmitRate: retransmitRate,
          queueDepth: retransmitQueue.getSize()
        });
      }
    }

    // Update last values
    lastMetricsTime = now;
    lastBytesSent = metrics.bandwidth.bytesOut;
    lastPacketsSent = metrics.bandwidth.packetsOut;
  }

  /**
   * Calculate recent packet loss ratio using a sliding window.
   * Uses the last LOSS_WINDOW_SIZE send/retransmit events for responsiveness
   * to changing network conditions.
   *
   * @private
   * @returns {number} Loss ratio (0-1)
   */
  function _calculatePacketLoss() {
    if (lossWindow.length === 0) {return 0;}
    const losses = lossWindow.filter(Boolean).length;
    return losses / lossWindow.length;
  }

  /**
   * Get the congestion control instance (for testing/API access)
   * @returns {CongestionControl}
   */
  function getCongestionControl() {
    return congestionControl;
  }

  /**
   * Start the congestion control adjustment timer.
   * Checks every second whether an adjustment is due and applies it.
   */
  function startCongestionControl() {
    if (congestionAdjustInterval) {return;}

    congestionAdjustInterval = setInterval(() => {
      const oldTimer = congestionControl.getCurrentDeltaTimer();
      const newTimer = congestionControl.adjust();
      if (newTimer !== oldTimer) {
        app.debug(`Congestion control: delta timer ${oldTimer} -> ${newTimer}ms (avgRTT=${Math.round(congestionControl.getAvgRTT())}ms, avgLoss=${(congestionControl.getAvgLoss() * 100).toFixed(2)}%)`);
        // Update the shared state delta timer so the send loop uses the new value
        state.deltaTimerTime = newTimer;
      }
    }, 1000);
  }

  /**
   * Stop the congestion control adjustment timer.
   */
  function stopCongestionControl() {
    if (congestionAdjustInterval) {
      clearInterval(congestionAdjustInterval);
      congestionAdjustInterval = null;
    }
  }

  /**
   * Start periodic heartbeat for NAT keepalive.
   * Sends a lightweight heartbeat packet every 25 seconds to keep
   * the NAT mapping alive on cellular/CGNAT networks.
   *
   * @param {string} udpAddress - Server address
   * @param {number} udpPort - Server port
   * @returns {Object} Timer handle with stop() method
   */
  function startHeartbeat(udpAddress, udpPort) {
    const HEARTBEAT_INTERVAL = 25000; // 25 seconds (under typical 30-120s NAT timeout)
    let heartbeatTimer = null;

    heartbeatTimer = setInterval(async () => {
      try {
        const heartbeatPacket = packetBuilder.buildHeartbeatPacket();
        await udpSendAsync(heartbeatPacket, udpAddress, udpPort);
        state.lastPacketTime = Date.now();
        app.debug("v2 heartbeat sent (NAT keepalive)");
      } catch (err) {
        app.debug(`v2 heartbeat send failed: ${err.message}`);
      }
    }, HEARTBEAT_INTERVAL);

    return {
      stop() {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }
    };
  }

  /**
   * Initialize connection bonding.
   * Creates a BondingManager and sets up control packet forwarding.
   *
   * @param {Object} bondingConfig - Bonding configuration
   * @returns {Promise<BondingManager>} The initialized bonding manager
   */
  async function initBonding(bondingConfig) {
    bondingManager = new BondingManager(bondingConfig, app);
    bondingManager.setMetricsPublisher(metricsPublisher);

    // Forward control packets from bonding sockets to pipeline
    bondingManager.onControlPacket((linkName, msg) => {
      handleControlPacket(msg, {
        address: bondingManager.links[linkName].address,
        port: bondingManager.links[linkName].port
      });
    });

    await bondingManager.initialize();
    return bondingManager;
  }

  /**
   * Stop connection bonding and clean up resources.
   */
  function stopBonding() {
    if (bondingManager) {
      bondingManager.stop();
      bondingManager = null;
    }
  }

  /**
   * Get the bonding manager instance (for API/testing)
   * @returns {BondingManager|null}
   */
  function getBondingManager() {
    return bondingManager;
  }

  /**
   * Set enhanced monitoring hooks
   * @param {Object} hooks - Monitoring objects from lib/monitoring.js and lib/packet-capture.js
   */
  function setMonitoring(hooks) {
    monitoringHooks = hooks;
  }

  return {
    sendDelta,
    getPacketBuilder,
    getRetransmitQueue,
    getMetricsPublisher,
    getCongestionControl,
    getBondingManager,
    receiveACK,
    receiveNAK,
    handleControlPacket,
    startMetricsPublishing,
    stopMetricsPublishing,
    startCongestionControl,
    stopCongestionControl,
    startHeartbeat,
    initBonding,
    stopBonding,
    setMonitoring
  };
}

module.exports = { createPipelineV2Client };
