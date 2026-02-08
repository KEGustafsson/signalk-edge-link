"use strict";

// Delta and timing
const DEFAULT_DELTA_TIMER = 1000; // milliseconds
const PING_TIMEOUT_BUFFER = 10000; // milliseconds - extra buffer for ping timeout
const MILLISECONDS_PER_MINUTE = 60000;
const MAX_DELTAS_BUFFER_SIZE = 1000; // prevent memory leaks

// File watching
const FILE_WATCH_DEBOUNCE_DELAY = 300; // milliseconds
const CONTENT_HASH_ALGORITHM = "md5"; // Faster than SHA-256 for file change detection
const WATCHER_RECOVERY_DELAY = 5000; // milliseconds

// UDP and network
const MAX_SAFE_UDP_PAYLOAD = 1400; // Maximum safe UDP payload size (avoid fragmentation)
const BROTLI_QUALITY_HIGH = 10; // Maximum Brotli compression quality
const UDP_RETRY_MAX = 3; // Maximum UDP send retries
const UDP_RETRY_DELAY = 100; // milliseconds - base retry delay

// Smart batching - prevent UDP packets from exceeding MTU
const SMART_BATCH_SAFETY_MARGIN = 0.85; // Target 85% of MTU (leaves room for variance)
const SMART_BATCH_SMOOTHING = 0.2; // Rolling average weight (20% new, 80% old)
const SMART_BATCH_INITIAL_ESTIMATE = 200; // Initial bytes-per-delta estimate
const SMART_BATCH_MIN_DELTAS = 1; // Always allow at least 1 delta per packet
const SMART_BATCH_MAX_DELTAS = 50; // Cap to prevent excessive batching latency

// Rate limiting
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests per minute per IP

// Congestion control (AIMD algorithm)
const CONGESTION_MIN_DELTA_TIMER = 100; // Minimum delta timer (ms)
const CONGESTION_MAX_DELTA_TIMER = 5000; // Maximum delta timer (ms)
const CONGESTION_TARGET_RTT = 200; // Target RTT threshold (ms)
const CONGESTION_ADJUST_INTERVAL = 5000; // Interval between adjustments (ms)
const CONGESTION_MAX_ADJUSTMENT = 0.2; // Maximum adjustment per step (20%)
const CONGESTION_SMOOTHING_FACTOR = 0.2; // EMA smoothing factor (20% new, 80% old)
const CONGESTION_LOSS_THRESHOLD_LOW = 0.01; // Below this loss → increase rate
const CONGESTION_LOSS_THRESHOLD_HIGH = 0.05; // Above this loss → decrease rate
const CONGESTION_RTT_MULTIPLIER_HIGH = 1.5; // RTT > target * 1.5 → decrease rate
const CONGESTION_INCREASE_FACTOR = 0.95; // Additive increase: timer *= 0.95
const CONGESTION_DECREASE_FACTOR = 1.5; // Multiplicative decrease: timer *= 1.5

// Connection bonding
const BONDING_HEALTH_CHECK_INTERVAL = 1000; // Health check interval (ms)
const BONDING_RTT_THRESHOLD = 500; // RTT threshold for failover (ms)
const BONDING_LOSS_THRESHOLD = 0.10; // Packet loss threshold for failover (10%)
const BONDING_FAILBACK_DELAY = 30000; // Delay before failback (ms) - prevents oscillation
const BONDING_HEARTBEAT_TIMEOUT = 5000; // Heartbeat response timeout (ms)
const BONDING_FAILBACK_RTT_HYSTERESIS = 0.8; // Failback requires RTT < threshold * 0.8
const BONDING_FAILBACK_LOSS_HYSTERESIS = 0.5; // Failback requires loss < threshold * 0.5
const BONDING_HEALTH_WINDOW_SIZE = 10; // Number of RTT samples to keep
const BONDING_RTT_EMA_ALPHA = 0.2; // Exponential moving average alpha for RTT

// Metrics
const BANDWIDTH_HISTORY_MAX = 60; // Keep 60 data points (5 minutes at 5s intervals)

/**
 * Calculates max deltas per batch based on average bytes per delta
 * @param {number} avgBytes - Average bytes per delta
 * @returns {number} Clamped max deltas per batch
 */
function calculateMaxDeltasPerBatch(avgBytes) {
  const raw = Math.floor((MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN) / avgBytes);
  return Math.max(SMART_BATCH_MIN_DELTAS, Math.min(SMART_BATCH_MAX_DELTAS, raw));
}

module.exports = {
  DEFAULT_DELTA_TIMER,
  PING_TIMEOUT_BUFFER,
  MILLISECONDS_PER_MINUTE,
  MAX_DELTAS_BUFFER_SIZE,
  FILE_WATCH_DEBOUNCE_DELAY,
  CONTENT_HASH_ALGORITHM,
  WATCHER_RECOVERY_DELAY,
  MAX_SAFE_UDP_PAYLOAD,
  BROTLI_QUALITY_HIGH,
  UDP_RETRY_MAX,
  UDP_RETRY_DELAY,
  SMART_BATCH_SAFETY_MARGIN,
  SMART_BATCH_SMOOTHING,
  SMART_BATCH_INITIAL_ESTIMATE,
  SMART_BATCH_MIN_DELTAS,
  SMART_BATCH_MAX_DELTAS,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_REQUESTS,
  CONGESTION_MIN_DELTA_TIMER,
  CONGESTION_MAX_DELTA_TIMER,
  CONGESTION_TARGET_RTT,
  CONGESTION_ADJUST_INTERVAL,
  CONGESTION_MAX_ADJUSTMENT,
  CONGESTION_SMOOTHING_FACTOR,
  CONGESTION_LOSS_THRESHOLD_LOW,
  CONGESTION_LOSS_THRESHOLD_HIGH,
  CONGESTION_RTT_MULTIPLIER_HIGH,
  CONGESTION_INCREASE_FACTOR,
  CONGESTION_DECREASE_FACTOR,
  BONDING_HEALTH_CHECK_INTERVAL,
  BONDING_RTT_THRESHOLD,
  BONDING_LOSS_THRESHOLD,
  BONDING_FAILBACK_DELAY,
  BONDING_HEARTBEAT_TIMEOUT,
  BONDING_FAILBACK_RTT_HYSTERESIS,
  BONDING_FAILBACK_LOSS_HYSTERESIS,
  BONDING_HEALTH_WINDOW_SIZE,
  BONDING_RTT_EMA_ALPHA,
  BANDWIDTH_HISTORY_MAX,
  calculateMaxDeltasPerBatch
};
