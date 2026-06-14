"use strict";

/** L0 foundation types — config. */

// ── Configuration Types ─────────────────────────────────────────────────────

/** Reliability configuration for v2+ protocol. */
export interface ReliabilityConfig {
  /** How often the server sends ACK packets to the client (ms). Default 100. */
  ackInterval?: number;
  /** Minimum gap between identical ACKs (duplicate suppression window, ms). Default 1000. */
  ackResendInterval?: number;
  /** Idle time after the last received sequence before a NAK is emitted (ms). Default 100. */
  nakTimeout?: number;
  /** Maximum number of entries held in the retransmit queue. Default 5000. */
  retransmitQueueSize?: number;
  /** Maximum retransmit attempts per packet before it is dropped. Default 3. */
  maxRetransmits?: number;
  /** Hard upper bound on retransmit queue entry age (ms). Default 120000. */
  retransmitMaxAge?: number;
  /** Lower bound on retransmit entry age; entries newer than this are never expired (ms). Default 10000. */
  retransmitMinAge?: number;
  /** Scale factor applied to the current RTT to compute the dynamic retransmit timeout. Default 12. */
  retransmitRttMultiplier?: number;
  /** Time without an ACK after which the retransmit queue is capped to this age (ms). Default 20000. */
  ackIdleDrainAge?: number;
  /** When true, force-clears the retransmit queue after `forceDrainAfterMs` of ACK silence. Default false. */
  forceDrainAfterAckIdle?: boolean;
  /** ACK-idle duration that triggers a force drain when `forceDrainAfterAckIdle` is enabled (ms). Default 45000. */
  forceDrainAfterMs?: number;
  /** Enable burst retransmission of the oldest queued packets after a long ACK gap. Default true. */
  recoveryBurstEnabled?: boolean;
  /** Maximum number of packets sent in a single recovery burst. Default 100. */
  recoveryBurstSize?: number;
  /** Interval between successive recovery burst rounds (ms). Default 200. */
  recoveryBurstIntervalMs?: number;
  /** ACK-gap threshold that triggers a recovery burst (ms). Default 4000. */
  recoveryAckGapMs?: number;
}

/** Congestion control configuration. */
export interface CongestionControlConfig {
  /** Enable automatic congestion-based delta timer adjustment. Default true. */
  enabled?: boolean;
  /** RTT target that the algorithm aims for (ms). Default 150. */
  targetRTT?: number;
  /** Normal delta send interval used as the starting point for adjustment (ms). Default 1000. */
  nominalDeltaTimer?: number;
  /** Minimum delta send interval the algorithm will set (ms). Default 100. */
  minDeltaTimer?: number;
  /** Maximum delta send interval the algorithm will set (ms). Default 10000. */
  maxDeltaTimer?: number;
}

/** Link configuration (address + port). */
export interface LinkConfig {
  address: string;
  port: number;
  interface?: string;
}

/** Failover threshold configuration. */
export interface FailoverConfig {
  /** RTT (ms) above which the primary link is considered degraded and failover is triggered. */
  rttThreshold?: number;
  /** Packet-loss ratio (0–1) above which failover is triggered. E.g. 0.05 = 5 %. */
  lossThreshold?: number;
  /** Interval between bonding health-check probes (ms). */
  healthCheckInterval?: number;
  /** Minimum time the backup link must remain healthy before failing back to primary (ms). */
  failbackDelay?: number;
  /** Duration without a heartbeat response before a link is declared dead (ms). */
  heartbeatTimeout?: number;
}

/** Connection bonding configuration. */
export interface BondingConfig {
  /** Enable dual-link bonding with automatic failover. Default false. */
  enabled?: boolean;
  /** Bonding mode. Currently only "main-backup" is supported. */
  mode?: string;
  /** Primary link address and port. */
  primary?: LinkConfig;
  /** Backup link address and port, used when primary is degraded. */
  backup?: LinkConfig;
  /** Thresholds and timing that control when failover and failback occur. */
  failover?: FailoverConfig;
}

/** Alert threshold pair. */
export interface AlertThresholdPair {
  warning?: number;
  critical?: number;
}

/** Alert threshold configuration. */
export interface AlertThresholds {
  rtt?: AlertThresholdPair;
  packetLoss?: AlertThresholdPair;
  retransmitRate?: AlertThresholdPair;
  jitter?: AlertThresholdPair;
  queueDepth?: AlertThresholdPair;
}

/**
 * Path filter configuration.
 *
 * `allow`: paths matching at least one pattern are forwarded.
 * `deny`:  paths matching any pattern are dropped (evaluated after allow).
 *
 * Glob syntax: `"navigation.*"` matches any path whose first segment is
 * `navigation`; `"*"` matches all paths; exact strings are matched literally.
 */
export interface PathFilterConfig {
  allow?: string[];
  deny?: string[];
}

/** Per-connection configuration. */
export interface ConnectionConfig {
  /** Stable per-connection identity used for config editing and secret restoration. */
  connectionId?: string;
  /** Human-readable label shown in the UI and logs. */
  name?: string;
  /** Role of this end of the connection: "client" or "server". */
  serverType: string;
  /** UDP port to send/receive data on. */
  udpPort: number;
  /** AES-256 encryption key: 64-char hex, 44-char base64, or 32-char ASCII string. */
  secretKey: string;
  /**
   * When true, 32-char ASCII keys are stretched via PBKDF2-SHA256
   * (600,000 iterations, salt "signalk-edge-link-v1") before being used as
   * the AES-256-GCM key. Hex/base64 keys are unaffected. **Both peers must
   * use the same setting** — mismatched values will fail authentication and
   * drop every packet. Default false (raw bytes used as-is).
   */
  stretchAsciiKey?: boolean;
  /**
   * Opt-in (v3) DATA/METADATA header authentication. When true, each
   * DATA/METADATA packet carries a trailing HMAC tag binding the header
   * (type/flags/sequence/length) to the AEAD ciphertext, closing the
   * unauthenticated-header gap (an on-path attacker can otherwise flip header
   * bits such as the sequence number and recompute only the CRC). **Both peers
   * must use the same setting** — a mismatch fails authentication and drops
   * every DATA packet. Default false (legacy CRC-only header). Adds 16 bytes
   * per DATA/METADATA packet.
   */
  authenticatedHeaders?: boolean;
  /** Wire protocol version (1, 2, or 3). Default 2. */
  protocolVersion?: number;
  /** Serialize deltas with MessagePack instead of JSON (smaller, faster). Default false. */
  useMsgpack?: boolean;
  /**
   * Brotli compression quality (0..11). Higher = smaller payload, more CPU.
   * Local-only setting; peers do not need to match. Default 6 (balanced).
   */
  brotliQuality?: number;
  /**
   * Per-path numeric precision (decimal places). Round outbound numeric
   * values to N decimals at the configured path. Reduces bandwidth at the
   * cost of precision. Nested object values use dotted paths
   * (e.g. `"navigation.position.latitude": 5`).
   *
   * **Lossy by design** — the receiver gets the rounded value. Only use
   * precision settings that match each sensor's actual reportable precision.
   * Paths not in the map are sent at full precision.
   */
  pathPrecision?: Record<string, number>;
  /**
   * Per-path throttle / deadband. Drops outbound values that arrive too
   * quickly (`minIntervalMs`) or whose absolute change vs the last sent
   * value is below a threshold (`deadband`). Both rules apply independently.
   *
   * Example:
   *   "pathThrottle": {
   *     "propulsion.main.revolutions":         { "minIntervalMs": 500 },
   *     "electrical.batteries.house.voltage":  { "minIntervalMs": 5000, "deadband": 0.05 }
   *   }
   *
   * Paths not in the map are not throttled.
   */
  pathThrottle?: Record<string, { minIntervalMs?: number; deadband?: number }>;
  /**
   * Allowlist and/or blocklist of Signal K paths to forward over the link.
   * Applied before quantize/throttle, so filtered paths incur zero per-packet
   * overhead.
   *
   * `allow`: only paths matching at least one pattern are forwarded.
   * `deny`:  paths matching any pattern are dropped (evaluated after allow).
   *
   * Glob syntax: `"navigation.*"` matches any path whose first segment is
   * `navigation`; `"*"` matches all paths; exact strings are matched literally.
   * Local-only setting — does not affect the receiver.
   */
  pathFilter?: PathFilterConfig;
  /**
   * Replace outbound values that are identical to the previously sent
   * value for the same (context, path) with a small sentinel object. The
   * receiver maintains the same per-(context, path) cache and restores
   * the value before injecting into Signal K.
   *
   * **Peer-matching setting** — both ends must enable this. If only the
   * client enables it, the receiver sees the sentinel as the value and
   * downstream Signal K consumers will see broken data. The receiver
   * applies expansion transparently when sentinels are seen in the
   * incoming stream, so it is safe to enable on the receiver first.
   *
   * Effective only on protocolVersion 2/3 (the reliable transport).
   */
  useValueDedup?: boolean;
  /**
   * Encode outbound delta arrays as positional msgpack arrays instead of
   * field-name JSON objects. Drops ~70-100 bytes per delta in repeated field
   * names. Requires `useMsgpack: true`. MUST MATCH on both ends.
   *
   * Effective only on protocolVersion 2/3.
   */
  useCompactDeltas?: boolean;
  /** Compress Signal K path strings with a shared dictionary to reduce packet size. Default false. */
  usePathDictionary?: boolean;
  /** Forward Signal K notification deltas over the link. Default false. */
  enableNotifications?: boolean;
  /**
   * When true, drop value entries this plugin publishes locally before they
   * are forwarded over the link. Targets paths under `networking.edgeLink.*`
   * and the v1 RTT publisher's `networking.modem.rtt` /
   * `networking.modem.<instanceId>.rtt` paths. Other paths under
   * `networking.modem.*` (signalStrength, txBytes, ...) come from external
   * providers and are left intact. Also suppresses the v2/v3 client-side
   * telemetry packet that mirrors the client's own link metrics to the
   * receiver. Default false (current behaviour: own data is forwarded along
   * with all other subscribed deltas).
   *
   * Client mode only. Ignored on server-mode connections.
   */
  skipOwnData?: boolean;
  /** Destination IP address for client mode. Not used in server mode. */
  udpAddress?: string;
  /**
   * Interval in seconds between HELLO keepalive packets sent while idle.
   * The HELLO is suppressed if real data was sent within the same window,
   * so this acts as a NAT/firewall keepalive ceiling rather than a fixed
   * retry count. Default 60.
   */
  helloMessageSender?: number;
  /** Override destination address used in automated tests. */
  testAddress?: string;
  /** Override destination port used in automated tests. */
  testPort?: number;
  /** Interval between PING keepalive packets (ms). Default 25000. */
  pingIntervalTime?: number;
  /** Interval between heartbeat packets (ms). */
  heartbeatInterval?: number;
  /** ARQ reliability layer configuration (ACK/NAK/retransmit). */
  reliability?: ReliabilityConfig;
  /** Automatic congestion-control configuration. */
  congestionControl?: CongestionControlConfig;
  /** Dual-link bonding and failover configuration. */
  bonding?: BondingConfig;
  /** Alert threshold overrides for the monitoring subsystem. */
  alertThresholds?: AlertThresholds;
  /**
   * When true (server mode, v2/v3 only), the server sends a FULL_STATUS_REQUEST
   * control packet to the client on first contact from each new session. The
   * client responds by replaying its complete current values snapshot, so the
   * server rebuilds state immediately after a restart instead of waiting for
   * individual value changes to trickle in. Default false.
   */
  requestFullStatusOnRestart?: boolean;
}
