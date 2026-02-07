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
  BANDWIDTH_HISTORY_MAX,
  calculateMaxDeltasPerBatch
};
