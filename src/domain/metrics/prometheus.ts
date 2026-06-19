"use strict";

/**
 * Signal K Edge Link v2.0 - Prometheus Metrics Exporter
 *
 * Exports metrics in Prometheus text exposition format for scraping.
 * See: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * @module domain/metrics/prometheus
 */

import type { Metrics, InstanceState } from "../../foundation/types";
import type { ManagementAuthSnapshot } from "../../routes/types";

interface PrometheusOpts {
  sharedMeta?: Set<string>;
}

interface PrometheusExtra {
  packetLoss?: number;
  linkQuality?: number;
  retransmitRate?: number;
  activeAlerts?: Record<string, { level: string }>;
  bonding?: {
    activeLink: string;
    links?: Record<string, { status: string; rtt?: number; loss?: number; quality?: number }>;
  };
}

/**
 * Emits Prometheus time-series lines into a shared buffer, deduplicating
 * HELP/TYPE metadata via the supplied `metricMeta` set. Section helpers below
 * receive one of these so the emitted text stays byte-identical regardless of
 * how the work is split across functions.
 */
class MetricEmitter {
  readonly lines: string[] = [];
  private readonly prefix = "signalk_edge_link";
  private readonly baseLabels: Record<string, string>;
  private readonly metricMeta: Set<string>;

  constructor(baseLabels: Record<string, string>, metricMeta: Set<string>) {
    this.baseLabels = baseLabels;
    this.metricMeta = metricMeta;
  }

  // Render a numeric value in Prometheus exposition format. Non-finite values
  // must use the spec tokens (`+Inf`/`-Inf`/`NaN`); a raw `String(Infinity)`
  // ("Infinity") is invalid and makes Prometheus reject the entire scrape.
  private formatValue(value: number): string {
    if (Number.isFinite(value)) return String(value);
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "+Inf" : "-Inf";
  }

  private emit(
    type: "gauge" | "counter",
    name: string,
    help: string,
    value: number,
    labels: Record<string, string>
  ): void {
    const fullName = `${this.prefix}_${name}`;
    if (!this.metricMeta.has(fullName)) {
      this.lines.push(`# HELP ${fullName} ${help}`);
      this.lines.push(`# TYPE ${fullName} ${type}`);
      this.metricMeta.add(fullName);
    }
    const labelStr = formatLabels({ ...this.baseLabels, ...labels });
    this.lines.push(`${fullName}${labelStr} ${this.formatValue(value)}`);
  }

  gauge(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    this.emit("gauge", name, help, value, labels);
  }

  counter(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    this.emit("counter", name, help, value, labels);
  }
}

function emitDeltaCounters(e: MetricEmitter, metrics: Metrics): void {
  const uptimeSeconds = Math.floor((Date.now() - metrics.startTime) / 1000);
  e.gauge("uptime_seconds", "Plugin uptime in seconds", uptimeSeconds);

  e.counter("deltas_sent_total", "Total deltas sent", metrics.deltasSent);
  e.counter("deltas_received_total", "Total deltas received", metrics.deltasReceived);
  e.counter(
    "data_packets_received_total",
    "Total v2 data packets received",
    metrics.dataPacketsReceived || 0
  );
  e.counter(
    "rate_limited_packets_total",
    "Total packets dropped by rate limiting",
    metrics.rateLimitedPackets || 0
  );
  e.counter(
    "dropped_delta_batches_total",
    "Total delta batches dropped before send",
    metrics.droppedDeltaBatches || 0
  );
  e.counter(
    "dropped_deltas_total",
    "Total deltas dropped before send",
    metrics.droppedDeltaCount || 0
  );
  e.counter(
    "suppressed_outbound_duplicates_total",
    "Total exact duplicate outbound deltas suppressed before send",
    metrics.suppressedOutboundDuplicates || 0
  );
  // The per-(context, path, source) duplicate breakdown is intentionally NOT
  // exported to Prometheus. Those labels are arbitrary, identifying, and churn
  // over time (high cardinality), which both blows up Prometheus series counts
  // and leaks source/path identity to any scraper. The detailed breakdown
  // remains available via the JSON /metrics and /network-metrics endpoints
  // (metrics.suppressedOutboundDuplicateStats).
}

function emitErrorCounters(e: MetricEmitter, metrics: Metrics): void {
  e.counter("udp_send_errors_total", "Total UDP send errors", metrics.udpSendErrors);
  e.counter("udp_retries_total", "Total UDP send retries", metrics.udpRetries);
  e.counter("compression_errors_total", "Total compression errors", metrics.compressionErrors);
  e.counter("encryption_errors_total", "Total encryption errors", metrics.encryptionErrors);
  e.counter("subscription_errors_total", "Total subscription errors", metrics.subscriptionErrors);
  e.counter(
    "malformed_packets_total",
    "Total malformed packets dropped",
    metrics.malformedPackets || 0
  );

  if (metrics.errorCounts && typeof metrics.errorCounts === "object") {
    for (const [category, value] of Object.entries(metrics.errorCounts)) {
      e.counter("errors_by_category_total", "Total errors grouped by category", value || 0, {
        category: sanitizeMetricNameComponent(category)
      });
    }
  }
}

function emitBandwidth(e: MetricEmitter, metrics: Metrics): void {
  const bw = metrics.bandwidth;
  e.counter("bytes_out_total", "Total bytes sent (compressed)", bw.bytesOut);
  e.counter("bytes_in_total", "Total bytes received (compressed)", bw.bytesIn);
  e.counter("bytes_out_raw_total", "Total bytes sent (raw/uncompressed)", bw.bytesOutRaw);
  e.counter("bytes_in_raw_total", "Total bytes received (raw/uncompressed)", bw.bytesInRaw);
  e.counter("packets_out_total", "Total packets sent", bw.packetsOut);
  e.counter("packets_in_total", "Total packets received", bw.packetsIn);
  e.counter(
    "metadata_bytes_out_total",
    "Total bytes sent as metadata packets",
    bw.metaBytesOut || 0
  );
  e.counter(
    "metadata_bytes_in_total",
    "Total bytes received as metadata packets",
    bw.metaBytesIn || 0
  );
  e.counter("metadata_packets_out_total", "Total metadata packets sent", bw.metaPacketsOut || 0);
  e.counter("metadata_packets_in_total", "Total metadata packets received", bw.metaPacketsIn || 0);
  e.counter(
    "metadata_snapshots_sent_total",
    "Total metadata snapshot envelopes sent",
    bw.metaSnapshotsSent || 0
  );
  e.counter(
    "metadata_diffs_sent_total",
    "Total metadata diff envelopes sent",
    bw.metaDiffsSent || 0
  );
  e.counter(
    "metadata_rate_limited_packets_total",
    "Total metadata packets dropped by rate limiting",
    bw.metaRateLimitedPackets || 0
  );
  e.gauge("bandwidth_rate_out_bytes", "Current outbound bandwidth (bytes/s)", bw.rateOut);
  e.gauge("bandwidth_rate_in_bytes", "Current inbound bandwidth (bytes/s)", bw.rateIn);
  e.gauge("compression_ratio_percent", "Current compression ratio percentage", bw.compressionRatio);
}

function emitNetworkQuality(e: MetricEmitter, metrics: Metrics): void {
  e.gauge("rtt_milliseconds", "Round trip time in milliseconds", metrics.rtt || 0);
  e.gauge("jitter_milliseconds", "Jitter in milliseconds", metrics.jitter || 0);
  e.counter("retransmissions_total", "Total packet retransmissions", metrics.retransmissions || 0);
  e.gauge("queue_depth", "Retransmit queue depth", metrics.queueDepth || 0);
  e.counter("acks_sent_total", "Total ACKs sent", metrics.acksSent || 0);
  e.counter("naks_sent_total", "Total NAKs sent", metrics.naksSent || 0);
}

function emitSmartBatching(e: MetricEmitter, metrics: Metrics, state: InstanceState): void {
  if (state.isServerMode || !metrics.smartBatching) {
    return;
  }
  const sb = metrics.smartBatching;
  e.counter("smart_batch_early_sends_total", "Smart batch early sends", sb.earlySends);
  e.counter("smart_batch_timer_sends_total", "Smart batch timer sends", sb.timerSends);
  e.counter("smart_batch_oversized_total", "Smart batch oversized packets", sb.oversizedPackets);
  e.gauge("smart_batch_avg_bytes_per_delta", "Average bytes per delta", sb.avgBytesPerDelta);
}

function emitStatus(e: MetricEmitter, state: InstanceState): void {
  e.gauge(
    "ready_to_send",
    "Whether plugin is ready to send (1=yes, 0=no)",
    state.readyToSend ? 1 : 0
  );
  e.gauge(
    "deltas_buffered",
    "Number of deltas currently buffered",
    state.deltas ? state.deltas.length : 0
  );
}

function emitExtra(e: MetricEmitter, extra: PrometheusExtra): void {
  if (extra.packetLoss !== undefined) {
    e.gauge("packet_loss_rate", "Current packet loss rate (0-1)", extra.packetLoss);
  }
  if (extra.linkQuality !== undefined) {
    e.gauge("link_quality_score", "Link quality score (0-100)", extra.linkQuality);
  }
  if (extra.retransmitRate !== undefined) {
    e.gauge("retransmit_rate", "Current retransmission rate (0-1)", extra.retransmitRate);
  }

  if (extra.activeAlerts) {
    for (const [name, alert] of Object.entries(extra.activeAlerts)) {
      const level = alert.level === "critical" ? 2 : 1;
      const safeName = sanitizeMetricNameComponent(name);
      e.gauge(`alert_${safeName}`, `Alert state for ${name} (0=ok, 1=warning, 2=critical)`, level);
    }
  }
}

function emitBonding(e: MetricEmitter, extra: PrometheusExtra): void {
  if (!extra.bonding) {
    return;
  }
  const { activeLink, links } = extra.bonding;
  e.gauge(
    "bonding_active_link",
    "Active bonding link (1=primary, 2=backup)",
    activeLink === "primary" ? 1 : 2
  );

  if (links) {
    for (const [name, link] of Object.entries(links)) {
      const statusNum = link.status === "active" ? 1 : link.status === "standby" ? 0 : -1;
      e.gauge("bonding_link_status", "Bonding link status", statusNum, { link: name });
      e.gauge("bonding_link_rtt_milliseconds", "Bonding link RTT", link.rtt || 0, { link: name });
      e.gauge("bonding_link_loss_rate", "Bonding link loss rate", link.loss || 0, { link: name });
      e.gauge("bonding_link_quality", "Bonding link quality score", link.quality || 0, {
        link: name
      });
    }
  }
}

/**
 * Generates Prometheus-formatted metrics text from plugin state.
 */
export function formatPrometheusMetrics(
  metrics: Metrics,
  state: InstanceState,
  extra: PrometheusExtra = {},
  opts: PrometheusOpts = {}
): string {
  const mode = state.isServerMode ? "server" : "client";
  const metricMeta = opts.sharedMeta instanceof Set ? opts.sharedMeta : new Set<string>();
  const instanceId: string | null = state.instanceId || null;

  // Base labels present on every time-series.
  const baseLabels: Record<string, string> = instanceId ? { mode, instance: instanceId } : { mode };

  const e = new MetricEmitter(baseLabels, metricMeta);

  emitDeltaCounters(e, metrics);
  emitErrorCounters(e, metrics);
  emitBandwidth(e, metrics);
  emitNetworkQuality(e, metrics);
  emitSmartBatching(e, metrics, state);
  emitStatus(e, state);
  emitExtra(e, extra);
  emitBonding(e, extra);

  e.lines.push(""); // trailing newline
  return e.lines.join("\n");
}

/** Formats management-auth counters as a separate Prometheus block; kept isolated from formatPrometheusMetrics so routes that don't expose the management API can omit it from scrape output without mutating the shared metricMeta set. */
export function formatManagementAuthPrometheusMetrics(
  snapshot: ManagementAuthSnapshot,
  opts: PrometheusOpts = {}
): string {
  const lines: string[] = [];
  const fullName = "signalk_edge_link_management_auth_requests_total";
  const metricMeta = opts.sharedMeta instanceof Set ? opts.sharedMeta : new Set<string>();

  if (!metricMeta.has(fullName)) {
    lines.push(`# HELP ${fullName} Total management API auth decisions`);
    lines.push(`# TYPE ${fullName} counter`);
    metricMeta.add(fullName);
  }

  for (const [action, counters] of Object.entries(snapshot.byAction || {})) {
    for (const [decision, reasonCounts] of Object.entries(counters.byDecision || {})) {
      for (const [reason, value] of Object.entries(reasonCounts)) {
        const labels = {
          decision,
          reason: sanitizeManagementAuthLabel(reason),
          action: sanitizeManagementAuthLabel(action)
        };
        lines.push(`${fullName}${formatLabels(labels)} ${value || 0}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format Prometheus label set
 * @param labels - Label key-value pairs
 * @returns Formatted label string like {key="value",key2="value2"}
 */
export function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const parts = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

/** Escape a Prometheus label value per the exposition format spec (backslash, newline, double-quote). */
export function escapeLabelValue(value: unknown): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Replace non-alphanumeric/underscore characters in a metric name segment with underscores. */
export function sanitizeMetricNameComponent(name: unknown): string {
  const replaced = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
  return replaced.length > 0 ? replaced : "unknown";
}

function sanitizeManagementAuthLabel(value: unknown): string {
  const replaced = String(value)
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 64);
  return replaced.length > 0 ? replaced : "unknown";
}

interface PrometheusValidationResult {
  valid: boolean;
  errors: string[];
  metricCount: number;
  uniqueMetrics: number;
}

/**
 * Validate that Prometheus metrics output is well-formed
 * @param metricsText - Prometheus text output
 * @returns Validation result
 */
export function validatePrometheusFormat(metricsText: string): PrometheusValidationResult {
  const lines = metricsText.split("\n");
  const errors: string[] = [];
  let metricCount = 0;
  const seenMetrics = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {
      continue;
    }

    if (line.startsWith("# HELP ")) {
      // HELP line - validated by presence check
    } else if (line.startsWith("# TYPE ")) {
      const parts = line.substring(7).split(" ");
      const typeValue = parts.slice(1).join(" ");
      if (!["counter", "gauge", "histogram", "summary", "untyped"].includes(typeValue)) {
        errors.push(`Line ${i + 1}: Invalid type "${typeValue}" for ${parts[0]}`);
      }
    } else if (line.startsWith("#")) {
      // Other comment - ok
    } else {
      // Metric line
      const match = line.match(
        /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|[+-]Inf)$/
      );
      if (!match) {
        // Try simpler match
        const simpleMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (simpleMatch) {
          metricCount++;
          seenMetrics.add(simpleMatch[1]);
        } else {
          errors.push(`Line ${i + 1}: Invalid metric line "${line.substring(0, 60)}"`);
        }
      } else {
        metricCount++;
        seenMetrics.add(match[1]);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    metricCount,
    uniqueMetrics: seenMetrics.size
  };
}
