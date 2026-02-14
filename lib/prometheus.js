"use strict";

/**
 * Signal K Edge Link v2.0 - Prometheus Metrics Exporter
 *
 * Exports metrics in Prometheus text exposition format for scraping.
 * See: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * @module lib/prometheus
 */

/**
 * Generates Prometheus-formatted metrics text from plugin state.
 *
 * @param {Object} metrics - The metrics object from lib/metrics.js
 * @param {Object} state - Plugin shared state
 * @param {Object} [extra] - Extra metrics from monitoring modules
 * @returns {string} Prometheus text exposition format
 */
function formatPrometheusMetrics(metrics, state, extra = {}) {
  const lines = [];
  const prefix = "signalk_edge_link";
  const mode = state.isServerMode ? "server" : "client";

  // Helper to add a metric with HELP and TYPE
  function gauge(name, help, value, labels = {}) {
    const fullName = `${prefix}_${name}`;
    lines.push(`# HELP ${fullName} ${help}`);
    lines.push(`# TYPE ${fullName} gauge`);
    const labelStr = formatLabels({ mode, ...labels });
    lines.push(`${fullName}${labelStr} ${value}`);
  }

  function counter(name, help, value, labels = {}) {
    const fullName = `${prefix}_${name}`;
    lines.push(`# HELP ${fullName} ${help}`);
    lines.push(`# TYPE ${fullName} counter`);
    const labelStr = formatLabels({ mode, ...labels });
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
      gauge(`alert_${name}`, `Alert state for ${name} (0=ok, 1=warning, 2=critical)`, level);
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
 * @param {Object} labels - Label key-value pairs
 * @returns {string} Formatted label string like {key="value",key2="value2"}
 */
function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) {return "";}
  const parts = entries.map(([k, v]) => `${k}="${v}"`);
  return `{${parts.join(",")}}`;
}

/**
 * Validate that Prometheus metrics output is well-formed
 * @param {string} metricsText - Prometheus text output
 * @returns {Object} Validation result { valid, errors, metricCount }
 */
function validatePrometheusFormat(metricsText) {
  const lines = metricsText.split("\n");
  const errors = [];
  let metricCount = 0;
  const seenMetrics = new Set();
  let lastType = null;
  let lastHelp = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {continue;}

    if (line.startsWith("# HELP ")) {
      const parts = line.substring(7).split(" ");
      lastHelp = parts[0];
    } else if (line.startsWith("# TYPE ")) {
      const parts = line.substring(7).split(" ");
      lastType = parts[0];
      const typeValue = parts.slice(1).join(" ");
      if (!["counter", "gauge", "histogram", "summary", "untyped"].includes(typeValue)) {
        errors.push(`Line ${i + 1}: Invalid type "${typeValue}" for ${lastType}`);
      }
    } else if (line.startsWith("#")) {
      // Other comment - ok
    } else {
      // Metric line
      const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\\{[^}]*\\})?\s+(-?[0-9.eE+-]+|NaN|[+-]Inf)$/);
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

module.exports = { formatPrometheusMetrics, formatLabels, validatePrometheusFormat };
