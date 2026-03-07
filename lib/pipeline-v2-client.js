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

const CircularBuffer = require("./CircularBuffer");
const { encryptBinary } = require("./crypto");
const { encodeDelta } = require("./pathDictionary");
const {
  deltaBuffer, compressPayload,
  udpSendAsync: _udpSendAsyncShared
} = require("./pipeline-utils");
const { PacketBuilder, PacketParser, PacketType } = require("./packet");
const { RetransmitQueue } = require("./retransmit-queue");
const { MetricsPublisher } = require("./metrics-publisher");
const { CongestionControl } = require("./congestion");
const { BondingManager } = require("./bonding");
const {
  MAX_SAFE_UDP_PAYLOAD,
  SMART_BATCH_SMOOTHING,
  METRICS_PUBLISH_INTERVAL,
  calculateMaxDeltasPerBatch
} = require("./constants");

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
  const clientTelemetrySource = "signalk-edge-link-client-telemetry";

  // Reliability: extract config once to avoid repetitive deep-access chains
  const reliabilityConfig = (state.options && state.options.reliability) || {};
  const retransmitQueue = new RetransmitQueue({
    maxSize: reliabilityConfig.retransmitQueueSize ?? 5000,
    maxRetransmits: reliabilityConfig.maxRetransmits ?? 3
  });
  const retransmitMaxAge = reliabilityConfig.retransmitMaxAge ?? 120000;
  const retransmitMinAge = reliabilityConfig.retransmitMinAge ?? 10000;
  const retransmitRttMultiplier = reliabilityConfig.retransmitRttMultiplier ?? 12;
  const ackIdleDrainAge = reliabilityConfig.ackIdleDrainAge ?? 20000;
  const forceDrainAfterAckIdle = reliabilityConfig.forceDrainAfterAckIdle !== undefined
    ? !!reliabilityConfig.forceDrainAfterAckIdle
    : false;
  const forceDrainAfterMs = reliabilityConfig.forceDrainAfterMs ?? 45000;
  const recoveryBurstEnabled = reliabilityConfig.recoveryBurstEnabled !== undefined
    ? !!reliabilityConfig.recoveryBurstEnabled
    : true;
  const recoveryBurstSize = reliabilityConfig.recoveryBurstSize ?? 100;
  const recoveryBurstIntervalMs = reliabilityConfig.recoveryBurstIntervalMs ?? 200;
  const recoveryAckGapMs = reliabilityConfig.recoveryAckGapMs ?? 4000;

  // Reliability metrics
  metrics.retransmissions = metrics.retransmissions || 0;
  metrics.queueDepth = metrics.queueDepth || 0;
  metrics.rtt = metrics.rtt || 0;
  metrics.jitter = metrics.jitter || 0;

  // Network metrics publisher (namespaced per instance when instanceId is set)
  const metricsPublisher = new MetricsPublisher(app, {
    pathPrefix: state.instanceId
      ? `networking.edgeLink.${state.instanceId}`
      : "networking.edgeLink",
    sourceLabel: state.instanceId
      ? `signalk-edge-link:${state.instanceId}`
      : "signalk-edge-link"
  });

  // Dynamic congestion control
  const rawCongestionConfig = (state.options && state.options.congestionControl) || {};
  const congestionConfig = {
    ...rawCongestionConfig,
    initialDeltaTimer: rawCongestionConfig.initialDeltaTimer !== undefined
      ? rawCongestionConfig.initialDeltaTimer
      : state.deltaTimerTime
  };
  const congestionControl = new CongestionControl(congestionConfig);
  let congestionAdjustInterval = null;

  // Connection bonding (initialized lazily via initBonding)
  let bondingManager = null;

  // Metrics collection state
  let metricsInterval = null;
  let lastMetricsTime = Date.now();
  let lastBytesSent = 0;
  let lastPacketsSent = 0;
  let lastRetransmissions = 0;

  // Enhanced monitoring hooks (set externally via setMonitoring)
  let monitoringHooks = null;

  // RTT tracking for jitter calculation (CircularBuffer gives O(1) push with auto-eviction)
  const rttSamples = new CircularBuffer(10);
  let lastAckedSeq = null;
  let lastAckAt = Date.now();
  let lastAckRinfo = null;
  let recoveryDrainTimer = null;
  let recoveryDrainInFlight = false;
  let telemetrySendInFlight = false;

  // Sliding window for packet loss calculation (CircularBuffer gives O(1) push with auto-eviction)
  const LOSS_WINDOW_SIZE = 50;
  const lossWindow = new CircularBuffer(LOSS_WINDOW_SIZE);

  /** Returns true when seq is strictly ahead of reference in uint32 sequence space. */
  function _isSeqAhead(seq, reference) {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  function recordPathLatencies(deltaPayload) {
    if (!monitoringHooks || !monitoringHooks.pathLatencyTracker) {
      return;
    }

    const now = Date.now();
    const deltas = Array.isArray(deltaPayload) ? deltaPayload : [deltaPayload];

    for (const delta of deltas) {
      if (!delta || !Array.isArray(delta.updates)) {
        continue;
      }

      for (const update of delta.updates) {
        const timestampMs = update && update.timestamp ? Date.parse(update.timestamp) : NaN;
        if (!Number.isFinite(timestampMs)) {
          continue;
        }

        const latencyMs = Math.max(0, now - timestampMs);
        const values = Array.isArray(update.values) ? update.values : [];
        for (const value of values) {
          if (value && typeof value.path === "string" && value.path.length > 0) {
            monitoringHooks.pathLatencyTracker.record(value.path, latencyMs);
          }
        }
      }
    }
  }

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

  async function _runRecoveryBurst() {
    if (recoveryDrainInFlight || !lastAckRinfo) {
      return;
    }
    recoveryDrainInFlight = true;
    try {
      const pendingSeqs = retransmitQueue.getOldestSequences(recoveryBurstSize);
      if (pendingSeqs.length === 0) {
        if (recoveryDrainTimer) {
          clearInterval(recoveryDrainTimer);
          recoveryDrainTimer = null;
        }
        return;
      }

      const toRetransmit = retransmitQueue.retransmit(pendingSeqs);
      for (const { packet: retransmitPacket } of toRetransmit) {
        await udpSendAsync(retransmitPacket, lastAckRinfo.address, lastAckRinfo.port);
        metrics.retransmissions++;
        if (monitoringHooks && monitoringHooks.packetLossTracker) {
          monitoringHooks.packetLossTracker.record(true);
        }
        lossWindow.push(true);
      }
      metrics.queueDepth = retransmitQueue.getSize();
      app.debug(`Recovery burst: retransmitted ${toRetransmit.length}, queueDepth=${metrics.queueDepth}`);
    } catch (err) {
      app.debug(`Recovery burst error: ${err.message}`);
    } finally {
      recoveryDrainInFlight = false;
    }
  }

  function _startRecoveryBurstIfNeeded(ackGapMs, rinfo) {
    if (!recoveryBurstEnabled || !rinfo) {
      return;
    }
    if (ackGapMs < recoveryAckGapMs) {
      return;
    }
    if (retransmitQueue.getSize() === 0) {
      return;
    }

    lastAckRinfo = { address: rinfo.address, port: rinfo.port };
    if (!recoveryDrainTimer) {
      recoveryDrainTimer = setInterval(() => {
        _runRecoveryBurst();
      }, recoveryBurstIntervalMs);
    }
    _runRecoveryBurst();
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
      recordPathLatencies(delta);

      // Compress
      const compressed = await compressPayload(serialized, state.options.useMsgpack);

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
      const sentAt = Date.now();

      // Enhanced monitoring: capture and inspect
      if (monitoringHooks) {
        const rinfo = { address: udpAddress, port: udpPort };
        if (monitoringHooks.packetCapture) {
          monitoringHooks.packetCapture.capture(packet, "send", rinfo);
        }
        if (monitoringHooks.packetInspector) {
          monitoringHooks.packetInspector.inspect(packet, "send", rinfo);
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

      // Update smart batching model
      // Guard against empty array: treat 0 as 1 to avoid Infinity in bytesPerDelta.
      const deltaCount = Array.isArray(delta) && delta.length > 0 ? delta.length : 1;
      const bytesPerDelta = packet.length / deltaCount;

      state.avgBytesPerDelta =
        (1 - SMART_BATCH_SMOOTHING) * state.avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
      state.maxDeltasPerBatch = calculateMaxDeltasPerBatch(state.avgBytesPerDelta);

      metrics.smartBatching.avgBytesPerDelta = Math.round(state.avgBytesPerDelta);
      metrics.smartBatching.maxDeltasPerBatch = state.maxDeltasPerBatch;

      app.debug(
        `v2 sent: seq=${seq}, ${deltaCount} deltas, ${packet.length} bytes`
      );

      state.lastPacketTime = sentAt;
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
   * @param {Object} parsed - Pre-parsed packet header (from handleControlPacket)
   * @param {Object} rinfo - Remote address info
   */
  function receiveACK(parsed, rinfo) {
    try {
      const ackedSeq = packetParser.parseACKPayload(parsed.payload);

      const now = Date.now();
      let rttSample = null;

      // Estimate RTT from original send timestamp (not retransmit timestamp).
      // If the entry has already been evicted from the queue (queue pruned before
      // ACK arrived, or restart/recovery), skip RTT estimation entirely.
      // A stale RTT is far less harmful to congestion control than a systematically
      // underestimated one derived from the wrong send event.
      const entry = retransmitQueue.get(ackedSeq);
      if (entry && (entry.originalTimestamp || entry.timestamp)) {
        // Clamp to 0: a negative value would mean the clock ran backwards (NTP jump).
        rttSample = Math.max(0, now - (entry.originalTimestamp || entry.timestamp));
      }

      if (rttSample !== null) {
        metrics.rtt = rttSample;

        // Track RTT samples for jitter calculation
        rttSamples.push(rttSample);

        // Calculate jitter as standard deviation of recent RTT samples
        if (rttSamples.length >= 2) {
          const samples = rttSamples.toArray();
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          const variance = samples.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / samples.length;
          metrics.jitter = Math.round(Math.sqrt(variance));
        }
      }

      // Remove acknowledged packets from queue
      // Only advance lastAckedSeq forward to prevent out-of-order ACKs from
      // corrupting the acknowledgment watermark
      const removed = retransmitQueue.acknowledgeRange(lastAckedSeq, ackedSeq);
      if (lastAckedSeq === null || _isSeqAhead(ackedSeq, lastAckedSeq)) {
        lastAckedSeq = ackedSeq >>> 0;
      }
      const ackGapMs = now - lastAckAt;
      lastAckAt = now;
      lastAckRinfo = rinfo ? { address: rinfo.address, port: rinfo.port } : lastAckRinfo;

      // Update congestion control with latest network metrics
      congestionControl.updateMetrics({
        rtt: metrics.rtt,
        packetLoss: _calculatePacketLoss()
      });

      app.debug(`ACK received: seq=${ackedSeq}, removed=${removed}, queueDepth=${retransmitQueue.getSize()}, rtt=${metrics.rtt}ms`);

      // Update metrics
      metrics.queueDepth = retransmitQueue.getSize();
      _pruneRetransmitQueue("ack");
      _startRecoveryBurstIfNeeded(ackGapMs, rinfo);
    } catch (err) {
      app.error(`Failed to process ACK: ${err.message}`);
      recordError("general", `ACK processing error: ${err.message}`);
    }
  }

  /**
   * Handle incoming NAK packet from server.
   * Retransmits the requested missing packets.
   *
   * @param {Object} parsed - Pre-parsed packet header (from handleControlPacket)
   * @param {string} udpAddress - Address to retransmit to
   * @param {number} udpPort - Port to retransmit to
   * @returns {Promise<void>}
   */
  async function receiveNAK(parsed, udpAddress, udpPort) {
    try {
      const missingSeqs = packetParser.parseNAKPayload(parsed.payload);

      app.debug(`NAK received: missing=${missingSeqs.join(", ")}`);

      // Get packets for retransmission
      const toRetransmit = retransmitQueue.retransmit(missingSeqs);

      // Retransmit each packet
      for (const { sequence, packet: retransmitPacket, attempt } of toRetransmit) {
        app.debug(`Retransmitting seq=${sequence}, attempt=${attempt}`);
        await udpSendAsync(retransmitPacket, udpAddress, udpPort);
        metrics.retransmissions++;
        if (monitoringHooks && monitoringHooks.packetLossTracker) {
          monitoringHooks.packetLossTracker.record(true);
        }

        // Record loss event in sliding window
        lossWindow.push(true);
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
        receiveACK(parsed, rinfo);
      } else if (parsed.type === PacketType.NAK) {
        await receiveNAK(parsed, rinfo.address, rinfo.port);
      }
      // Ignore other packet types on client side
    } catch (err) {
      // Ignore parse errors (might be corrupted packet)
      metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
      app.debug(`Failed to parse control packet: ${err.message}`);
    }
  }

  /**
   * Sends a message via UDP with retry logic (delegates to shared utility).
   * When bonding is active, uses the bonding manager's active socket and address.
   *
   * @param {Buffer} message - Message to send
   * @param {string} host - Destination host (overridden by bonding if active)
   * @param {number} port - Destination port (overridden by bonding if active)
   * @returns {Promise<void>}
   */
  function udpSendAsync(message, host, port) {
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

    return _udpSendAsyncShared(socket, message, sendHost, sendPort, {
      onRetry(retryCount, err) {
        metrics.udpRetries++;
        app.debug(`UDP send error (${err.code}), retry ${retryCount}/${3}`);
      },
      onError(err, retryCount) {
        metrics.udpSendErrors++;
        app.error(`UDP send error to ${sendHost}:${sendPort} - ${err.message} (code: ${err.code})`);
        recordError("udpSend", `UDP send error: ${err.message} (${err.code})`);
        if (retryCount >= 3) {
          app.error("Max retries reached, packet dropped");
        }
      }
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
    lastRetransmissions = metrics.retransmissions;

    metricsInterval = setInterval(() => {
      _publishMetrics();
    }, METRICS_PUBLISH_INTERVAL);
  }

  /**
   * Stop periodic metrics publishing
   */
  function stopMetricsPublishing() {
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }
    if (recoveryDrainTimer) {
      clearInterval(recoveryDrainTimer);
      recoveryDrainTimer = null;
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

    // Calculate retransmit rate for this period (not cumulative lifetime)
    const periodRetransmissions = metrics.retransmissions - lastRetransmissions;
    const retransmitRate = packetsSent > 0 ?
      periodRetransmissions / packetsSent : 0;
    const packetLoss = _calculatePacketLoss();
    metrics.packetLoss = packetLoss;

    // Publish to Signal K
    metricsPublisher.publish({
      rtt: metrics.rtt || 0,
      jitter: metrics.jitter || 0,
      packetLoss: packetLoss,
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
          packetLoss: packetLoss,
          retransmitRate: retransmitRate,
          queueDepth: retransmitQueue.getSize()
        });
      }
    }

    // Send client-side telemetry to the server so server UI/API can display
    // measured RTT/jitter and related sender-side quality metrics.
    if (
      !telemetrySendInFlight &&
      state.readyToSend &&
      state.options &&
      state.options.protocolVersion === 2 &&
      state.options.secretKey &&
      state.options.udpAddress &&
      state.options.udpPort
    ) {
      const telemetryDelta = {
        context: "vessels.self",
        updates: [{
          source: {
            label: clientTelemetrySource,
            type: "plugin"
          },
          timestamp: new Date().toISOString(),
          values: [
            { path: "networking.edgeLink.rtt", value: metrics.rtt || 0 },
            { path: "networking.edgeLink.jitter", value: metrics.jitter || 0 },
            { path: "networking.edgeLink.packetLoss", value: packetLoss },
            { path: "networking.edgeLink.retransmissions", value: metrics.retransmissions || 0 },
            { path: "networking.edgeLink.queueDepth", value: retransmitQueue.getSize() },
            { path: "networking.edgeLink.retransmitRate", value: retransmitRate },
            { path: "networking.edgeLink.activeLink", value: bondingManager ? bondingManager.getActiveLinkName() : "primary" }
          ]
        }]
      };

      telemetrySendInFlight = true;
      sendDelta([telemetryDelta], state.options.secretKey, state.options.udpAddress, state.options.udpPort)
        .catch((err) => {
          app.debug(`Failed to send client telemetry: ${err.message}`);
        })
        .finally(() => {
          telemetrySendInFlight = false;
        });
    }

    // Update last values
    lastMetricsTime = now;
    lastBytesSent = metrics.bandwidth.bytesOut;
    lastPacketsSent = metrics.bandwidth.packetsOut;
    lastRetransmissions = metrics.retransmissions;
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
    const samples = lossWindow.toArray();
    const losses = samples.filter(Boolean).length;
    return losses / samples.length;
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
