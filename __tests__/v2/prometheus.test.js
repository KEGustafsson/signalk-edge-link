"use strict";

const {
  formatPrometheusMetrics,
  formatLabels,
  validatePrometheusFormat,
  escapeLabelValue,
  sanitizeMetricNameComponent
} = require("../../lib/prometheus");
const CircularBuffer = require("../../lib/CircularBuffer");

describe("Prometheus Metrics Exporter", () => {
  let metrics;
  let state;

  beforeEach(() => {
    metrics = {
      startTime: Date.now() - 60000, // 1 minute ago
      deltasSent: 1000,
      deltasReceived: 950,
      udpSendErrors: 5,
      udpRetries: 3,
      compressionErrors: 1,
      encryptionErrors: 0,
      subscriptionErrors: 0,
      rtt: 50,
      jitter: 10,
      retransmissions: 15,
      queueDepth: 5,
      acksSent: 900,
      naksSent: 10,
      bandwidth: {
        bytesOut: 500000,
        bytesIn: 200000,
        bytesOutRaw: 1000000,
        bytesInRaw: 400000,
        packetsOut: 1000,
        packetsIn: 950,
        rateOut: 8000,
        rateIn: 3000,
        compressionRatio: 50,
        history: new CircularBuffer(60)
      },
      smartBatching: {
        earlySends: 100,
        timerSends: 200,
        oversizedPackets: 3,
        avgBytesPerDelta: 180
      }
    };

    state = {
      isServerMode: false,
      readyToSend: true,
      deltas: [1, 2, 3]
    };
  });

  describe("formatPrometheusMetrics", () => {
    test("returns valid Prometheus text format", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);

      // Should end with newline
      expect(text.endsWith("\n")).toBe(true);
    });

    test("includes uptime metric", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_uptime_seconds");
      expect(text).toContain("# HELP signalk_edge_link_uptime_seconds");
      expect(text).toContain("# TYPE signalk_edge_link_uptime_seconds gauge");
    });

    test("includes delta counters", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_deltas_sent_total");
      expect(text).toContain("1000");
      expect(text).toContain("signalk_edge_link_deltas_received_total");
      expect(text).toContain("950");
    });

    test("includes error counters", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_udp_send_errors_total");
      expect(text).toContain("signalk_edge_link_compression_errors_total");
      expect(text).toContain("signalk_edge_link_encryption_errors_total");
    });

    test("includes bandwidth metrics", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_bytes_out_total");
      expect(text).toContain("signalk_edge_link_bandwidth_rate_out_bytes");
      expect(text).toContain("signalk_edge_link_compression_ratio_percent");
    });

    test("includes network quality metrics", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_rtt_milliseconds");
      expect(text).toContain("signalk_edge_link_jitter_milliseconds");
      expect(text).toContain("signalk_edge_link_retransmissions_total");
      expect(text).toContain("signalk_edge_link_queue_depth");
    });

    test("includes smart batching metrics in client mode", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_smart_batch_early_sends_total");
      expect(text).toContain("signalk_edge_link_smart_batch_timer_sends_total");
    });

    test("excludes smart batching in server mode", () => {
      state.isServerMode = true;
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).not.toContain("signalk_edge_link_smart_batch_early_sends_total");
    });

    test("includes mode label", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain('mode="client"');
    });

    test("includes server mode label", () => {
      state.isServerMode = true;
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain('mode="server"');
    });

    test("includes status metrics", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toContain("signalk_edge_link_ready_to_send");
      expect(text).toContain("signalk_edge_link_deltas_buffered");
    });

    test("reports ready_to_send as 1 when true", () => {
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toMatch(/signalk_edge_link_ready_to_send\{[^}]*\}\s+1/);
    });

    test("reports ready_to_send as 0 when false", () => {
      state.readyToSend = false;
      const text = formatPrometheusMetrics(metrics, state);
      expect(text).toMatch(/signalk_edge_link_ready_to_send\{[^}]*\}\s+0/);
    });
  });

  describe("Extra metrics", () => {
    test("includes packet loss when provided", () => {
      const text = formatPrometheusMetrics(metrics, state, { packetLoss: 0.05 });
      expect(text).toContain("signalk_edge_link_packet_loss_rate");
      expect(text).toContain("0.05");
    });

    test("includes link quality when provided", () => {
      const text = formatPrometheusMetrics(metrics, state, { linkQuality: 85 });
      expect(text).toContain("signalk_edge_link_link_quality_score");
      expect(text).toContain("85");
    });

    test("includes bonding metrics when provided", () => {
      const extra = {
        bonding: {
          activeLink: "primary",
          links: {
            primary: { status: "active", rtt: 50, loss: 0.01, quality: 95 },
            backup: { status: "standby", rtt: 100, loss: 0.02, quality: 90 }
          }
        }
      };
      const text = formatPrometheusMetrics(metrics, state, extra);
      expect(text).toContain("signalk_edge_link_bonding_active_link");
      expect(text).toContain('link="primary"');
      expect(text).toContain('link="backup"');
    });

    test("includes active alerts when provided", () => {
      const extra = {
        activeAlerts: {
          rtt: { level: "warning", value: 300 },
          packetLoss: { level: "critical", value: 0.15 }
        }
      };
      const text = formatPrometheusMetrics(metrics, state, extra);
      expect(text).toContain("signalk_edge_link_alert_rtt");
      expect(text).toContain("signalk_edge_link_alert_packetLoss");
    });

    test("does not duplicate HELP/TYPE for repeated metric names", () => {
      const extra = {
        bonding: {
          activeLink: "primary",
          links: {
            primary: { status: "active", rtt: 50, loss: 0.01, quality: 95 },
            backup: { status: "standby", rtt: 100, loss: 0.02, quality: 90 }
          }
        }
      };
      const text = formatPrometheusMetrics(metrics, state, extra);
      const lines = text.split("\n");
      const typeLines = lines.filter((line) => line.startsWith("# TYPE signalk_edge_link_bonding_link_status "));
      const helpLines = lines.filter((line) => line.startsWith("# HELP signalk_edge_link_bonding_link_status "));
      expect(typeLines).toHaveLength(1);
      expect(helpLines).toHaveLength(1);
    });

    test("sanitizes active alert metric names", () => {
      const extra = {
        activeAlerts: {
          "bad.metric/name": { level: "warning", value: 1 }
        }
      };
      const text = formatPrometheusMetrics(metrics, state, extra);
      expect(text).toContain("signalk_edge_link_alert_bad_metric_name");
    });
  });

  describe("formatLabels", () => {
    test("formats empty labels", () => {
      expect(formatLabels({})).toBe("");
    });

    test("formats single label", () => {
      expect(formatLabels({ mode: "client" })).toBe('{mode="client"}');
    });

    test("formats multiple labels", () => {
      const result = formatLabels({ mode: "client", link: "primary" });
      expect(result).toBe('{mode="client",link="primary"}');
    });

    test("escapes quotes, backslashes, and newlines in label values", () => {
      const result = formatLabels({ source: "a\"b\\c\nd" });
      expect(result).toBe('{source="a\\"b\\\\c\\nd"}');
    });
  });

  describe("escapeLabelValue", () => {
    test("returns escaped Prometheus-safe label value", () => {
      expect(escapeLabelValue("x\"y\\z\nq")).toBe("x\\\"y\\\\z\\nq");
    });
  });

  describe("sanitizeMetricNameComponent", () => {
    test("replaces invalid characters with underscores", () => {
      expect(sanitizeMetricNameComponent("bad.metric/name")).toBe("bad_metric_name");
    });
  });

  describe("validatePrometheusFormat", () => {
    test("validates correct format", () => {
      const text = formatPrometheusMetrics(metrics, state);
      const result = validatePrometheusFormat(text);
      expect(result.valid).toBe(true);
      expect(result.metricCount).toBeGreaterThan(0);
    });

    test("counts unique metrics", () => {
      const text = formatPrometheusMetrics(metrics, state);
      const result = validatePrometheusFormat(text);
      expect(result.uniqueMetrics).toBeGreaterThan(10);
    });

    test("validates empty string", () => {
      const result = validatePrometheusFormat("");
      expect(result.valid).toBe(true);
      expect(result.metricCount).toBe(0);
    });

    test("validates output with extra metrics", () => {
      const extra = {
        packetLoss: 0.05,
        linkQuality: 85,
        retransmitRate: 0.02,
        bonding: {
          activeLink: "primary",
          links: {
            primary: { status: "active", rtt: 50, loss: 0.01, quality: 95 },
            backup: { status: "standby", rtt: 100, loss: 0.02, quality: 90 }
          }
        }
      };
      const text = formatPrometheusMetrics(metrics, state, extra);
      const result = validatePrometheusFormat(text);
      expect(result.valid).toBe(true);
    });
  });

  describe("Metric Types", () => {
    test("counters use counter type", () => {
      const text = formatPrometheusMetrics(metrics, state);
      const lines = text.split("\n");

      // Find counter types
      const counterLines = lines.filter(l => l.includes("# TYPE") && l.includes("counter"));
      expect(counterLines.length).toBeGreaterThan(0);

      // Verify counter metrics end with _total
      for (const line of counterLines) {
        const metricName = line.split(" ")[2];
        expect(metricName.endsWith("_total")).toBe(true);
      }
    });

    test("gauges use gauge type", () => {
      const text = formatPrometheusMetrics(metrics, state);
      const lines = text.split("\n");

      const gaugeLines = lines.filter(l => l.includes("# TYPE") && l.includes("gauge"));
      expect(gaugeLines.length).toBeGreaterThan(0);
    });

    test("each metric has HELP line", () => {
      const text = formatPrometheusMetrics(metrics, state);
      const lines = text.split("\n");

      const helpLines = lines.filter(l => l.startsWith("# HELP"));
      const typeLines = lines.filter(l => l.startsWith("# TYPE"));
      expect(helpLines.length).toBe(typeLines.length);
    });
  });
});
