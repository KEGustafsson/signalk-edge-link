"use strict";

/**
 * Signal K Edge Link - Shared Type Definitions
 *
 * JSDoc typedefs for core data structures used across the codebase.
 * Import with: const Types = require('./types');  // (not needed at runtime)
 *
 * @module lib/types
 */

// ── Signal K Types ──────────────────────────────────────────────────────────

/**
 * A Signal K delta value entry.
 * @typedef {Object} DeltaValue
 * @property {string} path - Signal K path (e.g. "navigation.position")
 * @property {*} value - The value at this path
 */

/**
 * A Signal K delta update block.
 * @typedef {Object} DeltaUpdate
 * @property {Object} [source] - Source information
 * @property {string} [source.label] - Source label identifier
 * @property {string} [source.type] - Source type (e.g. "plugin")
 * @property {string} [timestamp] - ISO 8601 timestamp
 * @property {DeltaValue[]} values - Array of path/value pairs
 */

/**
 * A Signal K delta message.
 * @typedef {Object} Delta
 * @property {string} context - Signal K context (e.g. "vessels.self", "vessels.urn:mrn:imo:mmsi:123456789")
 * @property {DeltaUpdate[]} updates - Array of update blocks
 */

// ── Protocol Types ──────────────────────────────────────────────────────────

/**
 * Parsed v2/v3 packet header.
 * @typedef {Object} PacketHeader
 * @property {number} version - Protocol version (2 or 3)
 * @property {number} type - Packet type (DATA=0x01, ACK=0x02, NAK=0x03, HEARTBEAT=0x04, HELLO=0x05)
 * @property {string} typeName - Human-readable packet type name
 * @property {PacketFlags} flags - Packet flags
 * @property {number} sequence - Sequence number (uint32)
 * @property {number} payloadLength - Length of the payload
 * @property {Buffer} payload - Packet payload
 */

/**
 * Packet flag bits.
 * @typedef {Object} PacketFlags
 * @property {boolean} compressed - Payload is Brotli-compressed
 * @property {boolean} encrypted - Payload is AES-256-GCM encrypted
 * @property {boolean} messagepack - Payload is MessagePack-encoded (vs JSON)
 * @property {boolean} pathDictionary - Payload uses path dictionary encoding
 */

// ── Configuration Types ─────────────────────────────────────────────────────

/**
 * Per-connection configuration.
 * @typedef {Object} ConnectionConfig
 * @property {string} [name] - Human-readable connection name
 * @property {string} serverType - "server" or "client"
 * @property {number} udpPort - UDP port (1024-65535)
 * @property {string} secretKey - Encryption key (32-char ASCII, 64-char hex, or 44-char base64)
 * @property {number} [protocolVersion=1] - Protocol version (1, 2, or 3)
 * @property {boolean} [useMsgpack=false] - Use MessagePack serialization
 * @property {boolean} [usePathDictionary=false] - Use path dictionary compression
 * @property {string} [udpAddress] - (client) Destination server IP/hostname
 * @property {string} [testAddress] - (client) Health check target address
 * @property {number} [testPort] - (client) Health check target port
 * @property {ReliabilityConfig} [reliability] - Reliability settings (v2+)
 * @property {CongestionControlConfig} [congestionControl] - Congestion control settings (v2+)
 * @property {BondingConfig} [bonding] - Connection bonding settings (v2+)
 * @property {AlertThresholds} [alertThresholds] - Alert threshold overrides
 * @property {string} [managementApiToken] - Optional API authentication token
 */

/**
 * Reliability configuration for v2+ protocol.
 * @typedef {Object} ReliabilityConfig
 * @property {number} [ackInterval=100] - ACK send interval (ms)
 * @property {number} [ackResendInterval=1000] - Duplicate ACK resend interval (ms)
 * @property {number} [nakTimeout=100] - NAK scheduling timeout (ms)
 * @property {number} [retransmitQueueSize=5000] - Max retransmit queue entries
 * @property {number} [maxRetransmits=3] - Max retransmit attempts per packet
 */

/**
 * Congestion control configuration.
 * @typedef {Object} CongestionControlConfig
 * @property {boolean} [enabled=false] - Enable AIMD congestion control
 * @property {number} [targetRTT=200] - Target RTT (ms)
 * @property {number} [nominalDeltaTimer] - Nominal delta timer (ms)
 * @property {number} [minDeltaTimer=100] - Minimum delta timer (ms)
 * @property {number} [maxDeltaTimer=5000] - Maximum delta timer (ms)
 */

/**
 * Connection bonding configuration.
 * @typedef {Object} BondingConfig
 * @property {boolean} [enabled=false] - Enable dual-link bonding
 * @property {string} [mode="main-backup"] - Bonding mode
 * @property {{address: string, port: number}} [primary] - Primary link
 * @property {{address: string, port: number}} [backup] - Backup link
 * @property {Object} [failover] - Failover thresholds
 * @property {number} [failover.rttThreshold=500] - RTT threshold (ms)
 * @property {number} [failover.lossThreshold=0.10] - Packet loss threshold (ratio)
 * @property {number} [failover.failbackDelay=30000] - Failback delay (ms)
 */

/**
 * Alert threshold configuration.
 * @typedef {Object} AlertThresholds
 * @property {{warning: number, critical: number}} [rtt] - RTT thresholds (ms)
 * @property {{warning: number, critical: number}} [packetLoss] - Packet loss thresholds (ratio)
 * @property {{warning: number, critical: number}} [retransmitRate] - Retransmit rate thresholds
 * @property {{warning: number, critical: number}} [jitter] - Jitter thresholds (ms)
 * @property {{warning: number, critical: number}} [queueDepth] - Queue depth thresholds
 */

// ── Metrics Types ───────────────────────────────────────────────────────────

/**
 * Runtime metrics snapshot.
 * @typedef {Object} Metrics
 * @property {number} startTime - Instance start time (epoch ms)
 * @property {number} deltasSent - Total deltas sent
 * @property {number} deltasReceived - Total deltas received
 * @property {number} udpSendErrors - UDP send error count
 * @property {BandwidthMetrics} bandwidth - Bandwidth tracking
 * @property {SmartBatchingMetrics} smartBatching - Smart batching counters
 * @property {Map<string, PathStat>} pathStats - Per-path statistics
 * @property {number} rtt - Current round-trip time (ms)
 * @property {number} jitter - Current jitter (ms)
 * @property {number} packetLoss - Current packet loss ratio (0-1)
 * @property {number} retransmissions - Total retransmissions
 * @property {number} queueDepth - Current retransmit queue depth
 */

/**
 * Bandwidth metrics.
 * @typedef {Object} BandwidthMetrics
 * @property {number} bytesOut - Total bytes sent
 * @property {number} bytesIn - Total bytes received
 * @property {number} packetsOut - Total packets sent
 * @property {number} packetsIn - Total packets received
 * @property {number} rateOut - Current outbound rate (bytes/sec)
 * @property {number} rateIn - Current inbound rate (bytes/sec)
 * @property {number} compressionRatio - Current compression ratio
 */

/**
 * Smart batching metrics.
 * @typedef {Object} SmartBatchingMetrics
 * @property {number} earlySends - Sends triggered by batch-full
 * @property {number} timerSends - Sends triggered by timer
 * @property {number} avgBytesPerDelta - Rolling average bytes per delta
 * @property {number} maxDeltasPerBatch - Current max deltas per batch
 */

/**
 * Per-path statistics entry.
 * @typedef {Object} PathStat
 * @property {number} count - Number of times this path was sent
 * @property {number} bytes - Total bytes for this path
 * @property {number} lastUpdate - Last update time (epoch ms)
 */

module.exports = {};
