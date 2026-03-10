"use strict";

/**
 * Signal K Edge Link v2.0 - Prometheus Metrics Exporter
 *
 * Exports metrics in Prometheus text exposition format for scraping.
 * See: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * @module lib/prometheus
 */

import type { Metrics } from "./types";

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
 * Generates Prometheus-formatted metrics text from plugin state.
 */
export function formatPrometheusMetrics(
  metrics: Metrics,
  state: any,
  extra: PrometheusExtra = {},
  opts: PrometheusOpts = {}
): string {
  const lines: string[] = [];
  const prefix = "signalk_edge_link";
  const mode = state.isServerMode ? "server" : "client";
  const metricMeta = opts.sharedMeta instanceof Set ? opts.sharedMeta : new Set<string>();
  const instanceId: string | null = state.instanceId || null;

  // Base labels present on every time-series.
  const baseLabels: Record<string, string> = instanceId ? { mode, instance: instanceId } : { mode };

  function gauge(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    const fullName = `${prefix}_${name}`;
    if (!metricMeta.has(fullName)) {
      lines.push(`# HELP ${fullName} ${help}`);
      lines.push(`# TYPE ${fullName} gauge`);
      metricMeta.add(fullName);
    }
    const labelStr = formatLabels({ ...baseLabels, ...labels });
    lines.push(`${fullName}${labelStr} ${value}`);
  }

  function counter(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    const fullName = `${prefix}_${name}`;
    if (!metricMeta.has(fullName)) {
      lines.push(`# HELP ${fullName} ${help}`);
      lines.push(`# TYPE ${fullName} counter`);
      metricMeta.add(fullName);
    }
    const labelStr = formatLabels({ ...baseLabels, ...labels });
    lines.push(`${fullName}${labelStr} ${value}`);
  }

  // Uptime
  const uptimeSeconds = Math.floor((Date.now() - metrics.startTime) / 1000);
  gauge("uptime_seconds", "Plugin uptime in seconds", uptimeSeconds);

  // Delta counters
  counter("deltas_sent_total", "Total deltas sent", metrics.deltasSent);
  counter("deltas_received_total", "Total deltas received", metrics.deltasReceived);

  // Error counters
  counter("udp_send_errors_total", "Total UDP send errors", metrics.udpSendErrors);
  counter("udp_retries_total", "Total UDP send retries", metrics.udpRetries);
  counter("compression_errors_total", "Total compression errors", metrics.compressionErrors);
  counter("encryption_errors_total", "Total encryption errors", metrics.encryptionErrors);
  counter("subscription_errors_total", "Total subscription errors", metrics.subscriptionErrors);
  counter("malformed_packets_total", "Total malformed packets dropped", metrics.malformedPackets || 0);

  if (metrics.errorCounts && typeof metrics.errorCounts === "object") {
    for (const [category, value] of Object.entries(metrics.errorCounts)) {
      counter(
        "errors_by_category_total",
        "Total errors grouped by category",
        value || 0,
        { category: sanitizeMetricNameComponent(category) }
      );
    }
  }

  // Bandwidth
  counter("bytes_out_total", "Total bytes sent (compressed)", metrics.bandwidth.bytesOut);
  counter("bytes_in_total", "Total bytes received (compressed)", metrics.bandwidth.bytesIn);
  counter("bytes_out_raw_total", "Total bytes sent (raw/uncompressed)", metrics.bandwidth.bytesOutRaw);
  counter("bytes_in_raw_total", "Total bytes received (raw/uncompressed)", metrics.bandwidth.bytesInRaw);
  counter("packets_out_total", "Total packets sent", metrics.bandwidth.packetsOut);
  counter("packets_in_total", "Total packets received", metrics.bandwidth.packetsIn);
  gauge("bandwidth_rate_out_bytes", "Current outbound bandwidth (bytes/s)", metrics.bandwidth.rateOut);
  gauge("bandwidth_rate_in_bytes", "Current inbound bandwidth (bytes/s)", metrics.bandwidth.rateIn);
  gauge("compression_ratio_percent", "Current compression ratio percentage", metrics.bandwidth.compressionRatio);

  // Network quality (v2 pipeline)
  gauge("rtt_milliseconds", "Round trip time in milliseconds", metrics.rtt || 0);
  gauge("jitter_milliseconds", "Jitter in milliseconds", metrics.jitter || 0);
  counter("retransmissions_total", "Total packet retransmissions", metrics.retransmissions || 0);
  gauge("queue_depth", "Retransmit queue depth", metrics.queueDepth || 0);
  counter("acks_sent_total", "Total ACKs sent", metrics.acksSent || 0);
  counter("naks_sent_total", "Total NAKs sent", metrics.naksSent || 0);

  // Smart batching (client only)
  if (!state.isServerMode && metrics.smartBatching) {
    counter("smart_batch_early_sends_total", "Smart batch early sends", metrics.smartBatching.earlySends);
    counter("smart_batch_timer_sends_total", "Smart batch timer sends", metrics.smartBatching.timerSends);
    counter("smart_batch_oversized_total", "Smart batch oversized packets", metrics.smartBatching.oversizedPackets);
    gauge("smart_batch_avg_bytes_per_delta", "Average bytes per delta", metrics.smartBatching.avgBytesPerDelta);
  }

  // Status
  gauge("ready_to_send", "Whether plugin is ready to send (1=yes, 0=no)", state.readyToSend ? 1 : 0);
  gauge("deltas_buffered", "Number of deltas currently buffered", state.deltas ? state.deltas.length : 0);

  // Extra monitoring metrics
  if (extra.packetLoss !== undefined) {
    gauge("packet_loss_rate", "Current packet loss rate (0-1)", extra.packetLoss);
  }
  if (extra.linkQuality !== undefined) {
    gauge("link_quality_score", "Link quality score (0-100)", extra.linkQuality);
  }
  if (extra.retransmitRate !== undefined) {
    gauge("retransmit_rate", "Current retransmission rate (0-1)", extra.retransmitRate);
  }

  // Active alerts
  if (extra.activeAlerts) {
    for (const [name, alert] of Object.entries(extra.activeAlerts)) {
      const level = alert.level === "critical" ? 2 : 1;
      const safeName = sanitizeMetricNameComponent(name);
      gauge(`alert_${safeName}`, `Alert state for ${name} (0=ok, 1=warning, 2=critical)`, level);
    }
  }

  // Bonding metrics
  if (extra.bonding) {
    const { activeLink, links } = extra.bonding;
    gauge("bonding_active_link", "Active bonding link (1=primary, 2=backup)",
      activeLink === "primary" ? 1 : 2);

    if (links) {
      for (const [name, link] of Object.entries(links)) {
        const statusNum = link.status === "active" ? 1 : (link.status === "standby" ? 0 : -1);
        gauge("bonding_link_status", "Bonding link status", statusNum, { link: name });
        gauge("bonding_link_rtt_milliseconds", "Bonding link RTT", link.rtt || 0, { link: name });
        gauge("bonding_link_loss_rate", "Bonding link loss rate", link.loss || 0, { link: name });
        gauge("bonding_link_quality", "Bonding link quality score", link.quality || 0, { link: name });
      }
    }
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

/**
 * Format Prometheus label set
 * @param labels - Label key-value pairs
 * @returns Formatted label string like {key="value",key2="value2"}
 */
export function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) { return ""; }
  const parts = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

export function escapeLabelValue(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

export function sanitizeMetricNameComponent(name: unknown): string {
  const replaced = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
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
    if (line === "") { continue; }

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
      const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|[+-]Inf)$/);
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
