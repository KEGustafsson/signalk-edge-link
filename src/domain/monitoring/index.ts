"use strict";

/**
 * Signal K Edge Link v2.0 - Enhanced Monitoring
 *
 * Provides advanced monitoring data structures for:
 * - Packet loss heatmap visualization (time-bucketed loss tracking)
 * - Per-path latency tracking (latency per Signal K path)
 * - Retransmission rate chart data (time-series retransmission rates)
 * - Alert thresholds with Signal K notifications
 *
 * Each tracker lives in its own module; this barrel preserves the legacy
 * `lib/monitoring` entrypoint that aggregates them.
 *
 * @module lib/monitoring
 */

export { PacketLossTracker } from "./packet-loss-tracker";
export { PathLatencyTracker } from "./path-latency-tracker";
export { RetransmissionTracker } from "./retransmission-tracker";
export { AlertManager } from "./alert-manager";
