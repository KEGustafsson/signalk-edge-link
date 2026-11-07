"use strict";

/** Fleet sharing metrics in Prometheus output (protocol-v3-spec §15). */

const {
  formatPrometheusMetrics,
  validatePrometheusFormat
} = require("../src/domain/metrics/prometheus");
const { makeMetricsApi } = require("./helpers/metrics-fixture");
const { ensureFleetMetrics } = require("../src/transport/fleet/common");

function render(metrics) {
  return formatPrometheusMetrics(metrics, {
    isServerMode: true,
    instanceId: "hub",
    readyToSend: true,
    deltas: []
  });
}

describe("fleet Prometheus metrics", () => {
  test("absent until fleet sharing runs", () => {
    const { metrics } = makeMetricsApi();
    expect(render(metrics)).not.toContain("fleet_");
  });

  test("emits valid, label-free fleet series", () => {
    const { metrics } = makeMetricsApi();
    const fleet = ensureFleetMetrics(metrics);
    fleet.members = 3;
    fleet.packetsSent = 12;
    fleet.originDrops = 2;
    fleet.helloDeferred = 7;
    fleet.minRateFactor = 0.5;
    fleet.state = "active";
    const text = render(metrics);
    expect(validatePrometheusFormat(text).valid).toBe(true);
    expect(text).toMatch(/signalk_edge_link_fleet_members\{mode="server",instance="hub"\} 3/);
    expect(text).toMatch(/signalk_edge_link_fleet_packets_sent_total\{[^}]*\} 12/);
    expect(text).toMatch(/signalk_edge_link_fleet_origin_drops_total\{[^}]*\} 2/);
    expect(text).toContain("# TYPE signalk_edge_link_fleet_hello_deferred_total counter");
    expect(text).toMatch(
      /signalk_edge_link_fleet_hello_deferred_total\{mode="server",instance="hub"\} 7(?:\n|$)/
    );
    expect(text).toMatch(/signalk_edge_link_fleet_active\{[^}]*\} 1/);
    expect(text).toMatch(/signalk_edge_link_fleet_min_rate_factor\{[^}]*\} 0\.5(?:\n|$)/);
    for (const line of text
      .split("\n")
      .filter((l) => l.includes("_fleet_") && !l.startsWith("#"))) {
      expect(line).toMatch(/^\S+\{mode="server",instance="hub"\} \d+(?:\.\d+)?$/);
    }
  });
});
