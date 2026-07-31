"use strict";

/**
 * Every counter the metrics registry defines must be readable from somewhere.
 *
 * Three counters in this release were found defined, incremented, and exposed
 * by nothing: `abandonedSequences`, `packetsAbandoned` and
 * `rejectedControlPackets`. The last one is the counter that explains a client
 * dropping every ACK — traffic leaving, queue depth climbing, RTT never
 * measured — so its absence turned a diagnosable fault into an invisible one,
 * and the fault went unnoticed until it was hit on real hardware.
 *
 * A counter nothing reads is not telemetry, it is a comment that costs CPU.
 * This test seeds every numeric counter with a distinct sentinel, collects what
 * the read endpoints actually return, and requires each sentinel to appear —
 * or the counter to be named below as deliberately internal.
 *
 * Sentinels rather than a fixed value so one counter's number cannot be
 * mistaken for another's.
 */

const createRoutes = require("../lib/routes");
const createMetrics = require("../lib/metrics");
const { MetricsPublisher } = require("../lib/transport/metrics/publisher");

/**
 * Counters that legitimately have no endpoint of their own.
 *
 * Each needs a reason, because "no reader" is exactly the defect this test
 * exists to catch — an entry added here without one is the bug wearing a
 * disguise.
 */
const INTERNAL_ONLY = new Map([
  // Derived scalars: reported through getEffectiveNetworkQuality, which
  // substitutes remote telemetry or omits them entirely when unmeasured, so the
  // raw seeded value deliberately does not survive to the response.
  ["rtt", "reported via networkQuality, gated on a measurement basis"],
  ["jitter", "reported via networkQuality, gated on a measurement basis"],
  ["packetLoss", "reported via networkQuality/monitoring, remote may override"],
  ["queueDepth", "reported via networkQuality, remote may override"],
  ["retransmissions", "reported via networkQuality, remote may override"],
  ["rttSamples", "measurement-basis input for the gates above, not a figure"]
]);

function makeRouterCollector() {
  const routes = [];
  const push =
    (method) =>
      (path, ...handlers) =>
        routes.push({ method, path, handlers });
  return { routes, get: push("get"), post: push("post"), put: push("put"), delete: push("delete") };
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
    },
    set() {
      return this;
    }
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
  const route = router.routes.find((r) => r.method === "get" && r.path === path);
  if (!route) {
    throw new Error(`Route GET ${path} not found`);
  }
  const res = makeResponse();
  route.handlers.at(-1)({ headers: {}, params: {}, query: {} }, res);
  return res.body;
}

function makeBundle(isServerMode) {
  const metricsApi = createMetrics();
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

describe("metrics counter reachability", () => {
  // Both modes: several counters are surfaced on one side only, so a
  // client-only sweep would report false gaps for the server's counters.
  for (const isServerMode of [false, true]) {
    const mode = isServerMode ? "server" : "client";

    test(`every ${mode} counter is readable from some endpoint`, () => {
      const bundle = makeBundle(isServerMode);
      const { metrics } = bundle.metricsApi;

      // Distinct, large, unlikely-to-collide sentinels.
      const names = Object.keys(metrics).filter(
        (k) => typeof metrics[k] === "number" && k !== "startTime"
      );
      expect(names.length).toBeGreaterThan(20); // guard the premise

      const sentinelOf = new Map();
      names.forEach((name, i) => {
        const sentinel = 700000 + i * 13;
        sentinelOf.set(name, sentinel);
        metrics[name] = sentinel;
      });

      const haystack = [
        JSON.stringify(callRoute(bundle, "/metrics") ?? null),
        JSON.stringify(callRoute(bundle, "/network-metrics") ?? null),
        JSON.stringify(callRoute(bundle, "/status") ?? null),
        String(callRoute(bundle, "/prometheus") ?? "")
      ].join("\n");

      // Anchored on non-digit boundaries. A bare substring match lets one
      // sentinel be satisfied by a longer number that merely contains it — a
      // derived figure, or a Prometheus label — so the sweep would report a
      // counter as reachable when no endpoint exposes it, which is precisely
      // the defect this test exists to catch.
      const unreachable = names.filter(
        (name) =>
          !INTERNAL_ONLY.has(name) &&
          !new RegExp(`(?<!\\d)${sentinelOf.get(name)}(?!\\d)`).test(haystack)
      );

      // A counter that no endpoint returns cannot be used to diagnose
      // anything. Either surface it, or record here why it is internal.
      expect(unreachable).toEqual([]);
    });
  }

  test("the internal-only list stays honest", () => {
    const { metrics } = makeBundle(false).metricsApi;
    // An entry naming a counter that no longer exists means the list is stale
    // and could be hiding a real gap behind a dead name.
    for (const name of INTERNAL_ONLY.keys()) {
      expect(typeof metrics[name]).toBe("number");
    }
  });
});
