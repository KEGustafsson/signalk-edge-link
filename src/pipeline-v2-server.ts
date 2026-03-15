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

import { promisify } from "util";
import zlib from "node:zlib";
import * as msgpack from "@msgpack/msgpack";
import { decryptBinary } from "./crypto";
import { decodeDelta } from "./pathDictionary";
import { PacketBuilder, PacketParser, PacketType, ParsedPacket } from "./packet";
import * as dgram from "dgram";
import { SequenceTracker } from "./sequence";
import { MetricsPublisher } from "./metrics-publisher";
import type { SignalKApp, MetricsApi, InstanceState, Delta, DeltaValue } from "./types";

import {
  MAX_DECOMPRESSED_SIZE,
  MAX_DELTAS_PER_PACKET,
  MAX_CLIENT_SESSIONS,
  METRICS_PUBLISH_INTERVAL,
  UDP_RATE_LIMIT_WINDOW,
  UDP_RATE_LIMIT_MAX_PACKETS
} from "./constants";

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Creates the v2 server pipeline
 * @param app       - SignalK app object (for logging)
 * @param state     - Shared mutable state
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API
 */
interface ClientSession {
  key: string;
  address: string;
  port: number;
  sequenceTracker: SequenceTracker;
  lastAckSeq: number | null;
  lastAckSentAt: number;
  hasReceivedData: boolean;
  lastPacketTime: number;
  lossBaseSeq: number | null;
  lossHighestSeq: number | null;
  lossReceivedCount: number;
  lastLossExpected: number;
  lastLossReceived: number;
  rateLimitCount: number;
  rateLimitWindowStart: number;
}

function createPipelineV2Server(app: SignalKApp, state: InstanceState, metricsApi: MetricsApi) {
  const { metrics, recordError, trackPathStats, updateBandwidthRates } = metricsApi;
  const protocolVersion = state.options && state.options.protocolVersion === 3 ? 3 : 2;
  const packetParser = new PacketParser({
    secretKey: state.options?.secretKey ?? undefined
  });
  const packetBuilder = new PacketBuilder({
    protocolVersion,
    secretKey: state.options?.secretKey ?? undefined
  });
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
  const ackInterval: number = reliabilityConfig.ackInterval ?? 100;
  const ackResendInterval: number = reliabilityConfig.ackResendInterval ?? 1000;
  // Session idle timeout: expire sessions that have not sent a packet for this long (ms)
  const SESSION_IDLE_TTL_MS = 300000; // 5 minutes
  let ackTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Per-client session map, keyed by "address:port".
   */
  const clientSessions = new Map<string, ClientSession>();

  /**
   * Get or create a session object for the given rinfo.
   * @private
   */
  function _getOrCreateSession(rinfo: { address: string; port: number }): ClientSession {
    const key = `${rinfo.address}:${rinfo.port}`;

    // Fast path: session already exists (most common case).
    const existing = clientSessions.get(key);
    if (existing) {
      existing.lastPacketTime = Date.now();
      return existing;
    }

    // Evict the oldest idle session if we are at capacity.
    if (clientSessions.size >= MAX_CLIENT_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, s] of clientSessions) {
        if (s.lastPacketTime < oldestTime) {
          oldestTime = s.lastPacketTime;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const evicted = clientSessions.get(oldestKey);
        if (evicted) {
          evicted.sequenceTracker.reset();
        }
        clientSessions.delete(oldestKey);
        app.error(`[v2-server] Session evicted (at capacity ${MAX_CLIENT_SESSIONS}): ${oldestKey}`);
      }
    }

    // Create new session. Guard against a re-entrant creation that may have
    // already added the session during the eviction scan above.
    if (clientSessions.has(key)) {
      const session = clientSessions.get(key)!;
      session.lastPacketTime = Date.now();
      return session;
    }

    const session = {
      key,
      address: rinfo.address,
      port: rinfo.port,
      sequenceTracker: new SequenceTracker({
        nakTimeout: reliabilityConfig.nakTimeout || 100,
        onLossDetected: (missing: number[]) => {
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
      lastLossReceived: 0,
      // per-session UDP rate limiting
      rateLimitCount: 0,
      rateLimitWindowStart: Date.now()
    };
    clientSessions.set(key, session);
    app.debug(`[v2-server] new client session: ${key}`);
    return session;
  }

  /**
   * Remove sessions that have been idle longer than SESSION_IDLE_TTL_MS.
   * @private
   */
  function _expireIdleSessions(): void {
    const now = Date.now();
    // Collect keys to evict first, then delete — avoids modifying the Map
    // during iteration, which can cause entries to be silently skipped in V8.
    const toEvict: string[] = [];
    for (const [key, session] of clientSessions) {
      if (now - session.lastPacketTime > SESSION_IDLE_TTL_MS) {
        toEvict.push(key);
      }
    }
    for (const key of toEvict) {
      const session = clientSessions.get(key);
      if (session) {
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
      : "networking.edgeLink",
    sourceLabel: state.instanceId ? `signalk-edge-link:${state.instanceId}` : "signalk-edge-link"
  });

  // Metrics collection state (bandwidth rates; loss is tracked per-session)
  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  let lastMetricsTime = Date.now();
  let lastBytesReceived = 0;
  let lastPacketsReceived = 0;

  function _toFiniteNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function _isFreshRemoteTelemetry(now: number = Date.now()): boolean {
    const last = metrics.remoteNetworkQuality && metrics.remoteNetworkQuality.lastUpdate;
    return Number.isFinite(last) && last > 0 && now - last <= REMOTE_TELEMETRY_TTL_MS;
  }

  function _ingestRemoteTelemetry(deltaMessage: Delta): void {
    if (!deltaMessage || !Array.isArray(deltaMessage.updates)) {
      return;
    }

    let changed = false;
    const remote = metrics.remoteNetworkQuality || {};
    const filteredUpdates: Delta["updates"] = [];

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

      const remainingValues: DeltaValue[] = [];
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

  function isAhead(seq: number, reference: number): boolean {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  // sequenceTracker is now per-session; kept for backward-compat test access
  function _getFirstSessionTracker(): SequenceTracker {
    const first = clientSessions.values().next().value;
    return first
      ? first.sequenceTracker
      : new SequenceTracker({ nakTimeout: reliabilityConfig.nakTimeout || 100 });
  }

  /**
   * Send NAK for missing packets back to a specific client.
   * @private
   */
  async function _sendNAK(
    missingSeqs: number[],
    destination: { address: string; port: number }
  ): Promise<void> {
    if (missingSeqs.length === 0) {
      return;
    }
    if (!destination) {
      return;
    }

    try {
      const nakPacket = packetBuilder.buildNAKPacket(missingSeqs);
      await _sendUDP(nakPacket, destination);

      metrics.naksSent = (metrics.naksSent ?? 0) + 1;
      app.debug(
        `Sent NAK to ${destination.address}:${destination.port}: missing=${missingSeqs.join(", ")}`
      );
    } catch (err: any) {
      app.error(`Failed to send NAK: ${err.message}`);
    }
  }

  /**
   * Send periodic ACK to all active client sessions.
   * @private
   */
  async function _sendPeriodicACKs(): Promise<void> {
    for (const session of clientSessions.values()) {
      if (!session.hasReceivedData) {
        continue;
      }
      if (session.sequenceTracker.expectedSeq === null) {
        continue;
      }

      const currentExpected = session.sequenceTracker.expectedSeq >>> 0;
      const ackSeq = (currentExpected - 1) >>> 0;

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
        metrics.acksSent = (metrics.acksSent ?? 0) + 1;
        app.debug(`Sent ACK to ${session.key}: seq=${ackSeq}`);
      } catch (err: any) {
        app.error(`Failed to send ACK to ${session.key}: ${err.message}`);
      }
    }
  }

  /**
   * Start periodic ACK timer.
   */
  function startACKTimer(): void {
    if (ackTimer) {
      return;
    }
    ackTimer = setInterval(() => {
      _expireIdleSessions();
      _sendPeriodicACKs().catch((err: any) => {
        app.error(`Periodic ACK error: ${err.message}`);
      });
    }, ackInterval);
  }

  /**
   * Stop periodic ACK timer
   */
  function stopACKTimer(): void {
    if (ackTimer) {
      clearInterval(ackTimer);
      ackTimer = null;
    }
  }

  /**
   * Send UDP packet to a destination
   * @private
   */
  function _sendUDP(packet: Buffer, destination: { address: string; port: number }): Promise<void> {
    if (!destination) {
      throw new Error("No client address known");
    }
    if (!state.socketUdp) {
      throw new Error("UDP socket not initialized");
    }

    return new Promise<void>((resolve, reject) => {
      state.socketUdp!.send(packet, destination.port, destination.address, (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receive and process a v2 packet.
   * Pipeline: PacketParse → SequenceTrack → Decrypt → Decompress → Parse → handleMessage
   *
   * @param packet    - Raw received packet
   * @param secretKey - 32-character decryption key
   * @param rinfo     - Remote address info {address, port}
   */
  async function receivePacket(
    packet: Buffer,
    secretKey: string,
    rinfo?: { address: string; port: number }
  ): Promise<void> {
    try {
      if (!state.options) {
        app.debug("receivePacket called but plugin is stopped, ignoring");
        return;
      }

      // Bonding health probes use a lightweight out-of-band heartbeat packet.
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
        metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
        app.debug("Received non-v2 packet, ignoring");
        return;
      }

      // Parse packet header
      const parsed = packetParser.parseHeader(packet, { secretKey });

      // Handle by packet type
      if (parsed.type === PacketType.HEARTBEAT) {
        app.debug("v2 heartbeat received");
        return;
      }

      if (parsed.type === PacketType.HELLO) {
        try {
          const info = JSON.parse(parsed.payload.toString());
          app.debug(`v2 hello from client: ${JSON.stringify(info)}`);
        } catch (parseErr: any) {
          app.error(`v2 failed to parse HELLO payload: ${parseErr.message}`);
        }
        return;
      }

      if (parsed.type !== PacketType.DATA) {
        app.debug(`v2 unhandled packet type: ${parsed.typeName}`);
        return;
      }

      // Per-client UDP rate limiting for DATA packets
      if (session) {
        const now = Date.now();
        if (now - session.rateLimitWindowStart >= UDP_RATE_LIMIT_WINDOW) {
          session.rateLimitCount = 0;
          session.rateLimitWindowStart = now;
        }
        session.rateLimitCount++;
        if (session.rateLimitCount > UDP_RATE_LIMIT_MAX_PACKETS) {
          metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
          app.debug(
            `[v2-server] rate limited ${session.key}: ${session.rateLimitCount} packets in window`
          );
          return;
        }
      }

      // Use the per-client sequence tracker
      const seqResult = session
        ? session.sequenceTracker.processSequence(parsed.sequence)
        : { duplicate: false, resynced: false };

      if (seqResult.duplicate) {
        app.debug(`v2 duplicate packet: seq=${parsed.sequence}`);
        metrics.duplicatePackets = (metrics.duplicatePackets ?? 0) + 1;
        return;
      }

      // Count valid DATA packets for accurate packet loss calculation
      metrics.dataPacketsReceived = (metrics.dataPacketsReceived ?? 0) + 1;
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
          if (isAhead(dataSeq, session.lossHighestSeq ?? 0)) {
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
      let jsonContent: unknown;
      if (parsed.flags.messagepack) {
        try {
          jsonContent = msgpack.decode(decompressed);
        } catch (msgpackErr: any) {
          app.debug(`MessagePack decode failed (${msgpackErr.message}), falling back to JSON`);
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

      // Process deltas: payload may be an Array of deltas or an indexed object
      const deltas: Delta[] = Array.isArray(jsonContent)
        ? (jsonContent as Delta[])
        : Object.values(jsonContent as Record<string, Delta>);
      const deltaCount = Math.min(deltas.length, MAX_DELTAS_PER_PACKET);

      if (deltas.length > MAX_DELTAS_PER_PACKET) {
        app.error(
          `v2 received ${deltas.length} deltas in one packet (limit ${MAX_DELTAS_PER_PACKET}), truncating`
        );
      }

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
        metrics.deltasReceived++;
      }

      app.debug(
        `v2 received: seq=${parsed.sequence}, ${deltaCount} deltas, ${packet.length} bytes`
      );
    } catch (error: any) {
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
        metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
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
   */
  function getSequenceTracker(): SequenceTracker {
    return _getFirstSessionTracker();
  }

  /**
   * Get the packet builder (for testing/metrics)
   */
  function getPacketBuilder(): PacketBuilder {
    return packetBuilder;
  }

  /**
   * Get server pipeline metrics including per-session state.
   */
  function getMetrics(): Record<string, unknown> {
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
   */
  function getMetricsPublisher(): MetricsPublisher {
    return metricsPublisher;
  }

  /**
   * Start periodic metrics publishing (every 1 second)
   */
  function startMetricsPublishing(): void {
    if (metricsInterval) {
      return;
    }
    lastMetricsTime = Date.now();
    lastBytesReceived = metrics.bandwidth.bytesIn;
    lastPacketsReceived = metrics.bandwidth.packetsIn;

    metricsInterval = setInterval(() => {
      _publishServerMetrics();
    }, METRICS_PUBLISH_INTERVAL);
  }

  /**
   * Stop periodic metrics publishing
   */
  function stopMetricsPublishing(): void {
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }
  }

  /**
   * Collect and publish server-side metrics to Signal K
   * @private
   */
  function _publishServerMetrics(): void {
    updateBandwidthRates(true);

    const now = Date.now();
    const elapsed = (now - lastMetricsTime) / 1000;
    if (elapsed <= 0) {
      return;
    }

    // Calculate rates
    const bytesReceived = metrics.bandwidth.bytesIn - lastBytesReceived;
    const packetsReceived = metrics.bandwidth.packetsIn - lastPacketsReceived;

    const downloadBandwidth = bytesReceived / elapsed;
    const packetsReceivedPerSec = packetsReceived / elapsed;

    // Aggregate packet loss across all active client sessions.
    let aggPeriodExpected = 0;
    let aggPeriodReceived = 0;
    for (const session of clientSessions.values()) {
      if (session.lossBaseSeq === null || session.lossHighestSeq === null) {
        continue;
      }
      const totalExpected = (((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0;
      const totalReceived = session.lossReceivedCount;
      aggPeriodExpected += Math.max(0, totalExpected - session.lastLossExpected);
      aggPeriodReceived += Math.max(0, totalReceived - session.lastLossReceived);
    }
    const packetLoss =
      aggPeriodExpected > 0
        ? Math.max(0, (aggPeriodExpected - aggPeriodReceived) / aggPeriodExpected)
        : metrics.packetLoss || 0;
    metrics.packetLoss = packetLoss;
    // Advance per-session baselines for the next period
    for (const session of clientSessions.values()) {
      if (session.lossBaseSeq === null) {
        continue;
      }
      session.lastLossExpected =
        session.lossBaseSeq !== null && session.lossHighestSeq !== null
          ? (((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0
          : 0;
      session.lastLossReceived = session.lossReceivedCount;
    }

    const hasRemoteTelemetry = _isFreshRemoteTelemetry(now);
    const remote = metrics.remoteNetworkQuality || {};
    const effectiveRtt = hasRemoteTelemetry ? remote.rtt || 0 : 0;
    const effectiveJitter = hasRemoteTelemetry ? remote.jitter || 0 : 0;
    const effectivePacketLoss = hasRemoteTelemetry ? remote.packetLoss || 0 : packetLoss;
    const effectiveRetransmissions = hasRemoteTelemetry ? remote.retransmissions || 0 : 0;
    const effectiveQueueDepth = hasRemoteTelemetry ? remote.queueDepth || 0 : 0;
    const effectiveRetransmitRate = hasRemoteTelemetry ? remote.retransmitRate || 0 : 0;
    const effectiveActiveLink = hasRemoteTelemetry ? remote.activeLink || "primary" : "primary";

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
      sequenceNumber: _getFirstSessionTracker().expectedSeq ?? undefined,
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

export { createPipelineV2Server };
