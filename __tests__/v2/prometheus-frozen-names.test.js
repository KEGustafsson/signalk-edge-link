"use strict";

/**
 * Frozen Prometheus metric-name surface.
 *
 * This is a tripwire, not a behaviour test. The exported Prometheus metric
 * names are a public contract: dashboards, alert rules and scrapers depend on
 * them. The Phase 4 application-layer rewrite re-homes the code that produces
 * these names, so this snapshot pins the exact static name surface and fails
 * loudly if any name is renamed, added or removed without a deliberate update.
 *
 * Dynamic, label-derived names (per-alert series whose name embeds the alert
 * name) are intentionally excluded — only the static surface is frozen here.
 */

const {
  formatPrometheusMetrics,
  formatManagementAuthPrometheusMetrics
} = require("../../lib/prometheus");
const CircularBuffer = require("../../lib/CircularBuffer");

function staticMetricNames() {
  const metrics = {
    startTime: Date.now() - 60000,
    deltasSent: 1000,
    deltasReceived: 950,
    udpSendErrors: 5,
    udpRetries: 3,
    compressionErrors: 1,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    malformedPackets: 2,
    rtt: 50,
    jitter: 10,
    retransmissions: 15,
    queueDepth: 5,
    acksSent: 900,
    naksSent: 10,
    dataPacketsReceived: 875,
    rateLimitedPackets: 4,
    droppedDeltaBatches: 2,
    droppedDeltaCount: 9,
    suppressedOutboundDuplicates: 6,
    suppressedOutboundDuplicateStats: new Map(),
    errorCounts: { compression: 1, encryption: 2, subscription: 0, udpSend: 0, general: 0 },
    bandwidth: {
      bytesOut: 5e5,
      bytesIn: 2e5,
      bytesOutRaw: 1e6,
      bytesInRaw: 4e5,
      packetsOut: 1000,
      packetsIn: 950,
      rateOut: 8000,
      rateIn: 3000,
      compressionRatio: 50,
      metaBytesOut: 12345,
      metaBytesIn: 6789,
      metaPacketsOut: 12,
      metaPacketsIn: 8,
      metaSnapshotsSent: 3,
      metaDiffsSent: 6,
      metaRateLimitedPackets: 1,
      history: new CircularBuffer(60)
    },
    smartBatching: {
      earlySends: 100,
      timerSends: 200,
      oversizedPackets: 3,
      avgBytesPerDelta: 180
    }
  };
  const state = { isServerMode: false, readyToSend: true, deltas: [1, 2, 3] };
  const extra = {
    packetLoss: 0.5,
    linkQuality: 99,
    bonding: {
      activeLink: "primary",
      links: {
        primary: { status: "active", rtt: 50, loss: 0.01, quality: 95 },
        backup: { status: "standby", rtt: 100, loss: 0.02, quality: 90 }
      }
    }
    // activeAlerts intentionally omitted: per-alert series names are dynamic.
  };

  const text =
    formatPrometheusMetrics(metrics, state, extra) +
    formatManagementAuthPrometheusMetrics({ auth: { total: 5 } });

  return [
    ...new Set(
      text
        .split("\n")
        .filter((line) => line.startsWith("# TYPE "))
        .map((line) => line.split(" ")[2])
    )
  ].sort();
}

describe("Prometheus frozen metric-name surface", () => {
  test("static metric names match the frozen contract", () => {
    expect(staticMetricNames()).toEqual([
      "signalk_edge_link_acks_sent_total",
      "signalk_edge_link_bandwidth_rate_in_bytes",
      "signalk_edge_link_bandwidth_rate_out_bytes",
      "signalk_edge_link_bonding_active_link",
      "signalk_edge_link_bonding_link_loss_rate",
      "signalk_edge_link_bonding_link_quality",
      "signalk_edge_link_bonding_link_rtt_milliseconds",
      "signalk_edge_link_bonding_link_status",
      "signalk_edge_link_bytes_in_raw_total",
      "signalk_edge_link_bytes_in_total",
      "signalk_edge_link_bytes_out_raw_total",
      "signalk_edge_link_bytes_out_total",
      "signalk_edge_link_compression_errors_total",
      "signalk_edge_link_compression_ratio_percent",
      "signalk_edge_link_data_packets_received_total",
      "signalk_edge_link_deltas_buffered",
      "signalk_edge_link_deltas_received_total",
      "signalk_edge_link_deltas_sent_total",
      "signalk_edge_link_dropped_delta_batches_total",
      "signalk_edge_link_dropped_deltas_total",
      "signalk_edge_link_encryption_errors_total",
      "signalk_edge_link_errors_by_category_total",
      "signalk_edge_link_jitter_milliseconds",
      "signalk_edge_link_link_quality_score",
      "signalk_edge_link_malformed_packets_total",
      "signalk_edge_link_management_auth_requests_total",
      "signalk_edge_link_metadata_bytes_in_total",
      "signalk_edge_link_metadata_bytes_out_total",
      "signalk_edge_link_metadata_diffs_sent_total",
      "signalk_edge_link_metadata_packets_in_total",
      "signalk_edge_link_metadata_packets_out_total",
      "signalk_edge_link_metadata_rate_limited_packets_total",
      "signalk_edge_link_metadata_snapshots_sent_total",
      "signalk_edge_link_naks_sent_total",
      "signalk_edge_link_packet_loss_rate",
      "signalk_edge_link_packets_in_total",
      "signalk_edge_link_packets_out_total",
      "signalk_edge_link_queue_depth",
      "signalk_edge_link_rate_limited_packets_total",
      "signalk_edge_link_ready_to_send",
      "signalk_edge_link_retransmissions_total",
      "signalk_edge_link_rtt_milliseconds",
      "signalk_edge_link_smart_batch_avg_bytes_per_delta",
      "signalk_edge_link_smart_batch_early_sends_total",
      "signalk_edge_link_smart_batch_oversized_total",
      "signalk_edge_link_smart_batch_timer_sends_total",
      "signalk_edge_link_subscription_errors_total",
      "signalk_edge_link_suppressed_outbound_duplicates_total",
      "signalk_edge_link_udp_retries_total",
      "signalk_edge_link_udp_send_errors_total",
      "signalk_edge_link_uptime_seconds"
    ]);
  });

  test("every exported metric name is documented in docs/metrics.md", () => {
    const fs = require("fs");
    const path = require("path");
    const docs = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "metrics.md"), "utf8");
    const undocumented = staticMetricNames().filter((name) => !docs.includes(name));
    expect(undocumented).toEqual([]);
  });
});
