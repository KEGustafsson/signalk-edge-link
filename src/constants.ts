"use strict";

// Delta and timing
export const DEFAULT_DELTA_TIMER = 1000; // milliseconds
export const PING_TIMEOUT_BUFFER = 10000; // milliseconds - extra buffer for ping timeout
export const MILLISECONDS_PER_MINUTE = 60000;
export const MAX_DELTAS_BUFFER_SIZE = 1000; // prevent memory leaks
export const DELTA_BUFFER_DROP_RATIO = 0.5; // fraction of buffer dropped on overflow
export const MAX_DELTAS_PER_PACKET = 500; // max deltas to process from a single received packet

// File watching
export const FILE_WATCH_DEBOUNCE_DELAY = 300; // milliseconds
export const CONTENT_HASH_ALGORITHM = "md5"; // Faster than SHA-256 for file change detection
export const WATCHER_RECOVERY_DELAY = 5000; // milliseconds

// UDP and network
export const MAX_SAFE_UDP_PAYLOAD = 1400; // Maximum safe UDP payload size (avoid fragmentation)
export const BROTLI_QUALITY_HIGH = 6; // Balanced quality: ~90% of max compression at ~10% of the CPU cost
export const UDP_RETRY_MAX = 3; // Maximum UDP send retries
export const UDP_RETRY_DELAY = 100; // milliseconds - base retry delay

// Smart batching - prevent UDP packets from exceeding MTU
export const SMART_BATCH_SAFETY_MARGIN = 0.85; // Target 85% of MTU (leaves room for variance)
export const SMART_BATCH_SMOOTHING = 0.2; // Rolling average weight (20% new, 80% old)
export const SMART_BATCH_INITIAL_ESTIMATE = 200; // Initial bytes-per-delta estimate
export const SMART_BATCH_MIN_DELTAS = 1; // Always allow at least 1 delta per packet
export const SMART_BATCH_MAX_DELTAS = 50; // Cap to prevent excessive batching latency

// Rate limiting
export const RATE_LIMIT_WINDOW = 60000; // 1 minute
// Web UI polls multiple endpoints in v2 mode, so this must allow
// normal dashboard usage without triggering false-positive 429s.
export const RATE_LIMIT_MAX_REQUESTS = 120; // 120 requests per minute per IP

// Congestion control (AIMD algorithm)
export const CONGESTION_MIN_DELTA_TIMER = 100; // Minimum delta timer (ms)
export const CONGESTION_MAX_DELTA_TIMER = 5000; // Maximum delta timer (ms)
export const CONGESTION_TARGET_RTT = 200; // Target RTT threshold (ms)
export const CONGESTION_ADJUST_INTERVAL = 5000; // Interval between adjustments (ms)
export const CONGESTION_MAX_ADJUSTMENT = 0.2; // Maximum adjustment per step (20%)
export const CONGESTION_SMOOTHING_FACTOR = 0.2; // EMA smoothing factor (20% new, 80% old)
export const CONGESTION_LOSS_THRESHOLD_LOW = 0.01; // Below this loss → increase rate
export const CONGESTION_LOSS_THRESHOLD_HIGH = 0.05; // Above this loss → decrease rate
export const CONGESTION_RTT_MULTIPLIER_HIGH = 1.5; // RTT > target * 1.5 → decrease rate
export const CONGESTION_INCREASE_FACTOR = 0.95; // Additive increase: timer *= 0.95
export const CONGESTION_DECREASE_FACTOR = 1.5; // Multiplicative decrease: timer *= 1.5

// Connection bonding
export const BONDING_HEALTH_CHECK_INTERVAL = 1000; // Health check interval (ms)
export const BONDING_RTT_THRESHOLD = 500; // RTT threshold for failover (ms)
export const BONDING_LOSS_THRESHOLD = 0.1; // Packet loss threshold for failover (10%)
export const BONDING_FAILBACK_DELAY = 30000; // Delay before failback (ms) - prevents oscillation
export const BONDING_HEARTBEAT_TIMEOUT = 5000; // Heartbeat response timeout (ms)
export const BONDING_FAILBACK_RTT_HYSTERESIS = 0.8; // Failback requires RTT < threshold * 0.8
export const BONDING_FAILBACK_LOSS_HYSTERESIS = 0.5; // Failback requires loss < threshold * 0.5
export const BONDING_HEALTH_WINDOW_SIZE = 10; // Number of RTT samples to keep
export const BONDING_RTT_EMA_ALPHA = 0.2; // Exponential moving average alpha for RTT

// Server session limits
export const MAX_CLIENT_SESSIONS = 100; // Max concurrent client sessions per server instance
export const UDP_RATE_LIMIT_WINDOW = 1000; // Per-client UDP rate limit window (ms)
export const UDP_RATE_LIMIT_MAX_PACKETS = 200; // Max DATA packets per client per window

// Decompression safety
export const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024; // 10 MB - reject decompression bombs
// After decompression, cap the JSON/MessagePack parse size to prevent multi-second stalls
// caused by deeply-nested objects within the allowed 10 MB decompression window.
export const MAX_PARSE_PAYLOAD_SIZE = 512 * 1024; // 512 KB

// Metrics
export const METRICS_PUBLISH_INTERVAL = 1000; // Interval (ms) for publishing metrics to Signal K
export const BANDWIDTH_HISTORY_MAX = 60; // Keep 60 data points (5 minutes at 5s intervals)
export const PATH_STATS_MAX_SIZE = 500; // Max tracked paths in pathStats Map (prevent unbounded growth)

// Enhanced monitoring
export const MONITORING_HEATMAP_BUCKETS = 60; // Number of time buckets for packet loss heatmap
export const MONITORING_HEATMAP_BUCKET_DURATION = 5000; // Duration of each bucket (5 seconds)
export const MONITORING_RETRANSMIT_HISTORY_SIZE = 120; // Retransmission rate history entries (10 minutes at 5s)
export const MONITORING_PATH_LATENCY_WINDOW = 50; // Latency samples per path
export const MONITORING_ALERT_COOLDOWN = 60000; // Alert cooldown period (1 minute)
export const PACKET_CAPTURE_MAX_PACKETS = 1000; // Max packets in capture buffer
export const PACKET_INSPECTOR_MAX_CLIENTS = 5; // Max concurrent WebSocket inspector clients

/**
 * Calculates max deltas per batch based on average bytes per delta
 * @param avgBytes - Average bytes per delta
 * @returns Clamped max deltas per batch
 */
export function calculateMaxDeltasPerBatch(avgBytes: number): number {
  const raw = Math.floor((MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN) / avgBytes);
  return Math.max(SMART_BATCH_MIN_DELTAS, Math.min(SMART_BATCH_MAX_DELTAS, raw));
}
