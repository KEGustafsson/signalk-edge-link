"use strict";

/**
 * Link quality must rest on a real measurement.
 *
 * `rtt` and `jitter` fall back to 0 when nothing has been measured: a server has
 * no latency of its own to report and depends on client telemetry, and a client
 * has no sample until it times its first ACK. `calculateLinkQuality` scores that
 * all-zero input at a perfect 100, so an unmeasured link ranks above every real
 * one — a link carrying no traffic at all reported "Excellent".
 *
 * These tests exercise the real getEffectiveNetworkQuality via GET /metrics
 * rather than a mocked one, because the defect was in that computation.
 */

const createRoutes = require("../lib/routes");
const createMetrics = require("../lib/metrics");
const { MetricsPublisher } = require("../lib/transport/metrics/publisher");

function makeRouterCollector() {
  const routes = [];
  const push =
    (method) =>
    (path, ...handlers) =>
      routes.push({ method, path, handlers });
  return {
    routes,
    get: push("get"),
    post: push("post"),
    put: push("put"),
    delete: push("delete")
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return route.handlers.at(-1);
}

/**
 * Build a bundle around a real metrics registry, then apply overrides. A real
 * MetricsPublisher is attached because linkQuality is only computed when one is
 * available — without it the score is absent for an unrelated reason and the
 * assertions below would pass vacuously.
 */
function makeBundle({ isServerMode, metrics: overrides = {} }) {
  const metricsApi = createMetrics();
  Object.assign(metricsApi.metrics, overrides);
  const publisher = new MetricsPublisher(
    { handleMessage: () => {}, debug: () => {} },
    { pathPrefix: "x" }
  );
  const pipeline = { getMetricsPublisher: () => publisher };
  return {
    id: "test",
    name: "test",
    state: {
      instanceStatus: "running",
      isServerMode,
      options: { protocolVersion: 3 },
      deltas: [],
      startTime: Date.now(),
      pipeline: isServerMode ? null : pipeline,
      pipelineServer: isServerMode ? pipeline : null,
      monitoring: null
    },
    metricsApi
  };
}

function callRoute(bundle, path) {
  const instanceRegistry = {
    getAll: () => [bundle],
    getFirst: () => bundle,
    getById: () => bundle
  };
  const routes = createRoutes({ debug: () => {}, error: () => {} }, instanceRegistry, {
    _currentOptions: {}
  });
  const router = makeRouterCollector();
  routes.registerWithRouter(router);
  const res = makeResponse();
  res.set = () => res;
  findHandler(router, "get", path)({ headers: {}, params: {}, query: {} }, res);
  return res.body;
}

function getMetrics(bundle) {
  return callRoute(bundle, "/metrics");
}

describe("network quality measurement basis", () => {
  test("a client that has never timed an ACK reports no link quality", () => {
    // Traffic is going out and piling up unacknowledged — the exact state in
    // which a falsely perfect score is most misleading.
    const body = getMetrics(
      makeBundle({
        isServerMode: false,
        metrics: { rtt: 0, jitter: 0, rttSamples: 0, queueDepth: 184 }
      })
    );

    expect(body.networkQuality.linkQuality).toBeUndefined();
    expect(body.networkQuality.rtt).toBeUndefined();
    expect(body.networkQuality.jitter).toBeUndefined();
    // Locally-observed counters are real and must still be reported.
    expect(body.networkQuality.queueDepth).toBe(184);
  });

  test("a client with a timed ACK reports a score", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: false,
        metrics: { rtt: 42, jitter: 5, rttSamples: 3, queueDepth: 0 }
      })
    );

    expect(typeof body.networkQuality.linkQuality).toBe("number");
    expect(body.networkQuality.rtt).toBe(42);
    expect(body.networkQuality.jitter).toBe(5);
  });

  test("a server without client telemetry reports no link quality", () => {
    const body = getMetrics(makeBundle({ isServerMode: true, metrics: { rtt: 0, jitter: 0 } }));

    expect(body.networkQuality.linkQuality).toBeUndefined();
    expect(body.networkQuality.rtt).toBeUndefined();
  });

  test("a server with fresh client telemetry reports the client's figures", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: true,
        metrics: {
          remoteNetworkQuality: {
            rtt: 80,
            jitter: 12,
            packetLoss: 0.02,
            retransmissions: 3,
            queueDepth: 7,
            retransmitRate: 0.01,
            activeLink: "primary",
            lastUpdate: Date.now()
          }
        }
      })
    );

    expect(body.networkQuality.rtt).toBe(80);
    expect(body.networkQuality.jitter).toBe(12);
    expect(typeof body.networkQuality.linkQuality).toBe("number");
    expect(body.networkQuality.dataSource).toBe("remote-client");
  });

  // The scoring function itself: an unmeasured link must never outrank a
  // measured one. This is what made the bug invisible — 100 looked like a
  // healthy reading rather than a missing one.
  test("all-zero inputs score higher than a genuinely good link", () => {
    const publisher = new MetricsPublisher(
      { handleMessage: () => {}, debug: () => {} },
      { pathPrefix: "x" }
    );

    const unmeasured = publisher.calculateLinkQuality({
      rtt: 0,
      jitter: 0,
      packetLoss: 0,
      retransmitRate: 0
    });
    const good = publisher.calculateLinkQuality({
      rtt: 40,
      jitter: 5,
      packetLoss: 0.001,
      retransmitRate: 0.001
    });

    expect(unmeasured).toBe(100);
    expect(good).toBeLessThan(unmeasured);
  });
});

/**
 * The scrape is where a false green does the most damage: dashboards and
 * alerting rules are built on it, and `rtt_milliseconds 0` is indistinguishable
 * from a genuinely instant link. Gating only `link_quality_score` would leave
 * the same lie in the latency series.
 */
describe("prometheus network quality basis", () => {
  test("omits rtt/jitter/link-quality series for an unmeasured link", () => {
    const text = callRoute(
      makeBundle({
        isServerMode: false,
        metrics: { rtt: 0, jitter: 0, rttSamples: 0, queueDepth: 184 }
      }),
      "/prometheus"
    );

    expect(text).not.toMatch(/^signalk_edge_link_rtt_milliseconds/m);
    expect(text).not.toMatch(/^signalk_edge_link_jitter_milliseconds/m);
    expect(text).not.toMatch(/^signalk_edge_link_link_quality_score/m);
    // Counters that rest on local observation are unaffected by the gate.
    expect(text).toMatch(/^signalk_edge_link_queue_depth\{[^}]*\} 184$/m);
  });

  // /prometheus used to prefer the monitoring trackers when they existed and
  // fall back to getEffectiveNetworkQuality otherwise, so a scrape and the
  // dashboard could report different loss figures for the same link at the same
  // moment — and which one you got depended on whether monitoring was enabled.
  // An alert built on the scrape then disagreed with the UI on screen.
  test("scrape reports the same loss and retransmit rate as /metrics", () => {
    const bundle = makeBundle({
      isServerMode: false,
      metrics: { rtt: 30, jitter: 4, rttSamples: 5, packetLoss: 0.02 }
    });
    // Trackers present and deliberately disagreeing with the current figures.
    bundle.state.monitoring = {
      packetLossTracker: { getSummary: () => ({ overallLossRate: 0.99 }) },
      retransmissionTracker: { getSummary: () => ({ currentRate: 0.88 }) },
      alertManager: null
    };

    const text = callRoute(bundle, "/prometheus");
    const scraped = /^signalk_edge_link_packet_loss_rate\{[^}]*\} ([0-9.]+)$/m.exec(text);
    expect(scraped).not.toBeNull();

    const json = getMetrics(bundle);
    // One number for one concept, whichever surface you read it from.
    expect(Number(scraped[1])).toBeCloseTo(json.networkQuality.packetLoss, 6);
    expect(text).not.toMatch(/^signalk_edge_link_packet_loss_rate\{[^}]*\} 0\.99$/m);
    expect(text).not.toMatch(/^signalk_edge_link_retransmit_rate\{[^}]*\} 0\.88$/m);
  });

  // The client case above still resolves packetLoss from a local value. A
  // server with no fresh telemetry resolves it to undefined, and
  // /prometheus passes that straight into `extra` — whether the series is
  // then omitted or emitted as 0 is decided by formatPrometheusMetrics, and
  // nothing else pins it. A regression there puts a confident "0% loss" back
  // on a link that has reported nothing.
  test("omits loss and retransmit-rate series for a server with no telemetry", () => {
    const text = callRoute(
      makeBundle({ isServerMode: true, metrics: { rtt: 0, jitter: 0 } }),
      "/prometheus"
    );

    expect(text).not.toMatch(/^signalk_edge_link_packet_loss_rate/m);
    expect(text).not.toMatch(/^signalk_edge_link_retransmit_rate/m);
    expect(text).not.toMatch(/^signalk_edge_link_link_quality_score/m);
  });

  test("emits rtt/jitter/link-quality series once measured", () => {
    const text = callRoute(
      makeBundle({
        isServerMode: false,
        metrics: { rtt: 42, jitter: 5, rttSamples: 3, queueDepth: 0 }
      }),
      "/prometheus"
    );

    expect(text).toMatch(/^signalk_edge_link_rtt_milliseconds\{[^}]*\} 42$/m);
    expect(text).toMatch(/^signalk_edge_link_jitter_milliseconds\{[^}]*\} 5$/m);
    expect(text).toMatch(/^signalk_edge_link_link_quality_score\{[^}]*\} \d+/m);
  });
});

// The user-reported shape: a server sees a real RTT from its client and 0 ms
// jitter beside it. Two separate defects produced that. The client suppressed
// everything but RTT from its telemetry when skipOwnData was set, and the
// receiver turned the resulting silence into a confident measurement of zero.
describe("a peer that reports RTT but not jitter", () => {
  function freshRemote(extra) {
    return {
      rtt: 42,
      packetLoss: 0,
      retransmissions: 0,
      queueDepth: 0,
      retransmitRate: 0,
      activeLink: "primary",
      lastUpdate: Date.now(),
      ...extra
    };
  }

  test("jitter reads as absent, never as a measured 0", () => {
    const body = getMetrics(
      makeBundle({ isServerMode: true, metrics: { remoteNetworkQuality: freshRemote({}) } })
    );

    expect(body.networkQuality.rtt).toBe(42);
    // The whole point: silence must not become a number.
    expect(body.networkQuality.jitter).toBeUndefined();
  });

  test("link quality is withheld when jitter never arrived", () => {
    const body = getMetrics(
      makeBundle({ isServerMode: true, metrics: { remoteNetworkQuality: freshRemote({}) } })
    );

    // Scoring with a substituted 0 ms jitter inflates the result — the same
    // false green the measurement-basis gate exists to prevent.
    expect(body.networkQuality.linkQuality).toBeUndefined();
  });

  test("a peer that does report jitter is unaffected", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: true,
        metrics: { remoteNetworkQuality: freshRemote({ jitter: 3.4 }) }
      })
    );

    expect(body.networkQuality.rtt).toBe(42);
    expect(body.networkQuality.jitter).toBe(3.4);
    expect(typeof body.networkQuality.linkQuality).toBe("number");
  });
});

/**
 * Jitter was not special. Every remote-sourced field went through the same
 * `?? 0` (and `?? "primary"` for the active link), so a peer that omitted any
 * of them had its silence rendered as a measurement — a mixed-version rollout,
 * or a single field the ingest validator rejected, is enough to produce it.
 * Each field is asserted separately: a shared default hides exactly this.
 */
describe("fields the peer never reported stay absent", () => {
  const OMITTABLE = ["packetLoss", "retransmissions", "queueDepth", "retransmitRate"];

  function remoteWithout(missing) {
    const full = {
      rtt: 42,
      jitter: 6,
      packetLoss: 0.05,
      retransmissions: 9,
      queueDepth: 4,
      retransmitRate: 0.02,
      activeLink: "backup",
      lastUpdate: Date.now()
    };
    delete full[missing];
    return full;
  }

  test.each(OMITTABLE)("%s reads as absent, never as a measured 0", (field) => {
    const body = getMetrics(
      makeBundle({ isServerMode: true, metrics: { remoteNetworkQuality: remoteWithout(field) } })
    );

    expect(body.networkQuality[field]).toBeUndefined();
    // The rest of the report still comes through — this is a per-field gap,
    // not a reason to blank the whole panel.
    expect(body.networkQuality.rtt).toBe(42);
    expect(body.networkQuality.jitter).toBe(6);
  });

  test("an unreported active link is not guessed as 'primary'", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: true,
        metrics: { remoteNetworkQuality: remoteWithout("activeLink") }
      })
    );

    // "primary" is a real link name. Substituting it tells an operator the
    // peer is on its primary uplink when the peer said nothing at all — the
    // single most misleading value this field can take.
    expect(body.networkQuality.activeLink).toBeUndefined();
  });

  test("a reported active link is passed through, not overwritten by the local one", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: true,
        metrics: { remoteNetworkQuality: remoteWithout("queueDepth") }
      })
    );

    expect(body.networkQuality.activeLink).toBe("backup");
  });

  // linkQuality scores rtt, jitter, packetLoss and retransmitRate together.
  // Two of those four were previously substituted with 0 when missing, which
  // can only push the score up — the same false green as the jitter case.
  test.each(["packetLoss", "retransmitRate"])(
    "link quality is withheld when %s never arrived",
    (field) => {
      const body = getMetrics(
        makeBundle({ isServerMode: true, metrics: { remoteNetworkQuality: remoteWithout(field) } })
      );

      expect(body.networkQuality.linkQuality).toBeUndefined();
    }
  );

  test("a complete report still scores", () => {
    const body = getMetrics(
      makeBundle({
        isServerMode: true,
        metrics: { remoteNetworkQuality: remoteWithout("__none__") }
      })
    );

    expect(typeof body.networkQuality.linkQuality).toBe("number");
    expect(body.networkQuality.packetLoss).toBe(0.05);
    expect(body.networkQuality.retransmissions).toBe(9);
    expect(body.networkQuality.queueDepth).toBe(4);
    expect(body.networkQuality.retransmitRate).toBe(0.02);
  });
});

/**
 * The same gap, one layer down: /network-metrics and /prometheus each compute
 * linkQuality from the same four inputs and must apply the same guard, or a
 * scrape re-introduces the inflated score the JSON endpoint just stopped
 * reporting.
 */
describe("the other surfaces apply the same guard", () => {
  function serverMissing(field) {
    const remote = {
      rtt: 42,
      jitter: 6,
      packetLoss: 0.05,
      retransmitRate: 0.02,
      lastUpdate: Date.now()
    };
    delete remote[field];
    return makeBundle({ isServerMode: true, metrics: { remoteNetworkQuality: remote } });
  }

  test.each(["jitter", "packetLoss", "retransmitRate"])(
    "/network-metrics withholds link quality when %s never arrived",
    (field) => {
      const body = callRoute(serverMissing(field), "/network-metrics");
      expect(body.linkQuality).toBeUndefined();
    }
  );

  test.each(["jitter", "packetLoss", "retransmitRate"])(
    "/prometheus omits the link-quality series when %s never arrived",
    (field) => {
      const text = callRoute(serverMissing(field), "/prometheus");
      expect(text).not.toMatch(/^signalk_edge_link_link_quality_score/m);
    }
  );

  test("/network-metrics reports link quality for a complete report", () => {
    const body = callRoute(serverMissing("__none__"), "/network-metrics");
    expect(typeof body.linkQuality).toBe("number");
  });
});
