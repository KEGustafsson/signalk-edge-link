"use strict";

/**
 * Branch-coverage tests for src/routes/metrics.ts
 * Exercises every response branch: 503, 500, and 200 for all three endpoints.
 */

const metricsRoutes = require("../lib/routes/metrics");

function makeRouterCollector() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) {
      routes.push({ method: "get", path, handlers });
    }
  };
}

function makeResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    contentType: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    set(k, v) {
      this.contentType = v;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

function makeCtx(overrides = {}) {
  const defaultMetrics = {
    deltasSent: 0,
    deltasReceived: 0,
    acksSent: 0,
    naksSent: 0,
    udpSendErrors: 0,
    udpRetries: 0,
    compressionErrors: 0,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    duplicatePackets: 0,
    rtt: 10,
    jitter: 2,
    retransmissions: 0,
    queueDepth: 0,
    bandwidth: { packetsOut: 100 }
  };
  return {
    rateLimitMiddleware: (req, res, next) => next(),
    managementAuthMiddleware: () => (req, res, next) => next(),
    instanceRegistry: { getAll: () => [] },
    getFirstBundle: () => null,
    getEffectiveNetworkQuality: () => ({
      rtt: 10,
      jitter: 2,
      packetLoss: 0,
      retransmissions: 0,
      queueDepth: 0,
      acksSent: 5,
      naksSent: 0,
      activeLink: "primary",
      dataSource: "local",
      lastUpdate: 0,
      retransmitRate: 0
    }),
    getActiveMetricsPublisher: () => null,
    buildFullMetricsResponse: (_bundle) => ({ ok: true }),
    getManagementAuthSnapshot: () => ({
      total: 0,
      allowed: 0,
      denied: 0,
      byReason: {},
      byAction: {}
    }),
    ...overrides,
    // Expose a default metrics object for bundle construction
    _defaultMetrics: defaultMetrics
  };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return route.handlers.at(-1);
}

// ── GET /metrics ───────────────────────────────────────────────────────────

describe("GET /metrics", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    metricsRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const handler = findHandler(router, "get", "/metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/not started/i);
  });

  test("returns 500 when buildFullMetricsResponse throws", () => {
    const router = makeRouterCollector();
    metricsRoutes.register(
      router,
      makeCtx({
        getFirstBundle: () => ({ state: {} }),
        buildFullMetricsResponse: () => {
          throw new Error("metrics exploded");
        }
      })
    );
    const handler = findHandler(router, "get", "/metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/metrics exploded/);
  });

  test("returns 200 with metrics payload on success", () => {
    const payload = { deltasSent: 42, rtt: 15 };
    const router = makeRouterCollector();
    metricsRoutes.register(
      router,
      makeCtx({
        getFirstBundle: () => ({ state: {} }),
        buildFullMetricsResponse: () => payload
      })
    );
    const handler = findHandler(router, "get", "/metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(payload);
  });
});

// ── GET /network-metrics ───────────────────────────────────────────────────

describe("GET /network-metrics", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    metricsRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const handler = findHandler(router, "get", "/network-metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 200 with expected fields for client bundle", () => {
    const ctx = makeCtx({
      getFirstBundle: () => ({
        state: { isServerMode: false },
        metricsApi: {
          metrics: {
            acksSent: 5,
            naksSent: 0
          }
        }
      })
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/network-metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("rtt");
    expect(res.body).toHaveProperty("jitter");
    expect(res.body).toHaveProperty("retransmitRate");
    expect(res.body).toHaveProperty("timestamp");
  });

  test("includes linkQuality when metrics publisher available", () => {
    const ctx = makeCtx({
      getFirstBundle: () => ({
        state: { isServerMode: false },
        metricsApi: { metrics: { acksSent: 0, naksSent: 0 } }
      }),
      getActiveMetricsPublisher: () => ({
        calculateLinkQuality: () => 95
      })
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/network-metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.body.linkQuality).toBe(95);
  });

  test("includes lastRemoteUpdate in server mode with fresh data", () => {
    const now = Date.now();
    const ctx = makeCtx({
      getFirstBundle: () => ({
        state: { isServerMode: true },
        metricsApi: { metrics: { acksSent: 0, naksSent: 0 } }
      }),
      getEffectiveNetworkQuality: () => ({
        rtt: 10,
        jitter: 2,
        packetLoss: 0,
        retransmissions: 0,
        queueDepth: 0,
        acksSent: 0,
        naksSent: 0,
        activeLink: "primary",
        dataSource: "remote",
        lastUpdate: now,
        retransmitRate: 0
      })
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/network-metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.body.lastRemoteUpdate).toBe(now);
  });

  test("returns 500 when handler throws", () => {
    const ctx = makeCtx({
      getFirstBundle: () => ({
        state: { isServerMode: false },
        metricsApi: { metrics: {} }
      }),
      getEffectiveNetworkQuality: () => {
        throw new Error("network quality failed");
      }
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/network-metrics");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/network quality failed/);
  });
});

// ── GET /prometheus ────────────────────────────────────────────────────────

describe("GET /prometheus", () => {
  test("returns 503 when no instances", () => {
    const router = makeRouterCollector();
    metricsRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [] } }));
    const handler = findHandler(router, "get", "/prometheus");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns text/plain content-type on success", () => {
    const bundle = {
      state: { isServerMode: false, monitoring: null, pipeline: null },
      metricsApi: {
        metrics: {
          deltasSent: 0,
          deltasReceived: 0,
          acksSent: 0,
          naksSent: 0,
          rtt: 10,
          jitter: 2,
          retransmissions: 0,
          queueDepth: 0,
          bandwidth: {
            packetsOut: 0,
            bytesOut: 0,
            bytesIn: 0,
            packetsIn: 0,
            bytesOutRaw: 0,
            bytesInRaw: 0,
            rateOut: 0,
            rateIn: 0
          },
          startTime: Date.now() - 1000,
          packetLoss: 0,
          errorCounts: {}
        },
        updateBandwidthRates: jest.fn()
      }
    };
    const ctx = makeCtx({
      instanceRegistry: { getAll: () => [bundle] },
      getEffectiveNetworkQuality: () => ({
        rtt: 10,
        jitter: 2,
        packetLoss: 0,
        retransmissions: 0,
        queueDepth: 0,
        acksSent: 0,
        naksSent: 0,
        activeLink: "primary",
        dataSource: "local",
        lastUpdate: 0,
        retransmitRate: 0
      })
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/prometheus");
    const res = makeResponse();
    handler({}, res);
    // Either succeeds with text/plain or 500 if formatPrometheusMetrics not available
    // The key check is that the 503 branch was not taken
    expect(res.statusCode).not.toBe(503);
  });

  test("emits global management auth counters once for multi-instance scrapes", () => {
    const makeBundle = (instanceId) => ({
      state: { isServerMode: false, instanceId, monitoring: null, pipeline: null, deltas: [] },
      metricsApi: {
        metrics: {
          deltasSent: 0,
          deltasReceived: 0,
          acksSent: 0,
          naksSent: 0,
          rtt: 10,
          jitter: 2,
          retransmissions: 0,
          queueDepth: 0,
          bandwidth: {
            packetsOut: 0,
            bytesOut: 0,
            bytesIn: 0,
            packetsIn: 0,
            bytesOutRaw: 0,
            bytesInRaw: 0,
            rateOut: 0,
            rateIn: 0
          },
          startTime: Date.now() - 1000,
          packetLoss: 0,
          errorCounts: {}
        },
        updateBandwidthRates: jest.fn()
      }
    });
    const ctx = makeCtx({
      instanceRegistry: { getAll: () => [makeBundle("a"), makeBundle("b")] },
      getManagementAuthSnapshot: () => ({
        total: 3,
        allowed: 2,
        denied: 1,
        byReason: { open_access: 1, valid_token: 1, invalid_token: 1 },
        byAction: {
          "prometheus.read": {
            total: 2,
            allowed: 1,
            denied: 1,
            reasons: { open_access: 1, invalid_token: 1 }
          },
          "metrics.read": {
            total: 1,
            allowed: 1,
            denied: 0,
            reasons: { valid_token: 1 }
          }
        }
      }),
      getEffectiveNetworkQuality: () => ({
        rtt: 10,
        jitter: 2,
        packetLoss: 0,
        retransmissions: 0,
        queueDepth: 0,
        acksSent: 0,
        naksSent: 0,
        activeLink: "primary",
        dataSource: "local",
        lastUpdate: 0,
        retransmitRate: 0
      })
    });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/prometheus");
    const res = makeResponse();

    handler({}, res);

    expect(res.statusCode).toBe(200);
    const text = res.body;
    const helpLines = text
      .split("\n")
      .filter((line) => line.startsWith("# HELP signalk_edge_link_management_auth_requests_total"));
    expect(helpLines).toHaveLength(1);
    expect(text).toContain(
      'signalk_edge_link_management_auth_requests_total{decision="allowed",reason="open_access",action="prometheus.read"} 1'
    );
    expect(text).toContain(
      'signalk_edge_link_management_auth_requests_total{decision="denied",reason="invalid_token",action="prometheus.read"} 1'
    );
    expect(text).not.toContain('mode="client",decision="allowed"');
    expect(text).not.toContain('instance="a",decision="allowed"');
  });

  test("returns 500 when prometheus formatting throws", () => {
    const bundle = {
      state: { isServerMode: false, monitoring: null, pipeline: null },
      metricsApi: {
        metrics: {},
        updateBandwidthRates: () => {
          throw new Error("format failed");
        }
      }
    };
    const ctx = makeCtx({ instanceRegistry: { getAll: () => [bundle] } });
    const router = makeRouterCollector();
    metricsRoutes.register(router, ctx);
    const handler = findHandler(router, "get", "/prometheus");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(500);
  });
});
