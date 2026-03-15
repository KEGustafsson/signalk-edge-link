"use strict";

/**
 * Branch-coverage tests for src/routes/monitoring.ts
 * Exercises every response branch for all 11 endpoints.
 */

const monitoringRoutes = require("../lib/routes/monitoring");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRouterCollector() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) {
      routes.push({ method: "get", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "post", path, handlers });
    }
  };
}

function makeResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    _contentType: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    set(_k, _v) {
      return this;
    },
    contentType(t) {
      this._contentType = t;
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
  return {
    app: {
      debug: jest.fn(),
      error: jest.fn(),
      readPluginOptions: jest.fn(() => ({})),
      savePluginOptions: jest.fn()
    },
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    getFirstBundle: () => null,
    managementAuthMiddleware: () => (req, res, next) => next(),
    pluginRef: null,
    ...overrides
  };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return route.handlers.at(-1);
}

function makeMonitoringBundle(monitoringOverrides = {}) {
  return {
    id: "test-id",
    name: "test",
    state: {
      monitoring: {
        packetLossTracker: {
          getHeatmapData: () => [1, 2],
          getSummary: () => ({ overallLossRate: 0.01 })
        },
        pathLatencyTracker: { getAllStats: (_n) => [{ path: "test", latency: 10 }] },
        retransmissionTracker: {
          getChartData: (_limit) => [{ t: 1, rate: 0 }],
          getSummary: () => ({ avgRate: 0, maxRate: 0, currentRate: 0, entries: 1 })
        },
        alertManager: {
          getState: () => ({ thresholds: { rtt: {} }, activeAlerts: {} }),
          setThreshold: jest.fn(),
          thresholds: { rtt: { warning: 100, critical: 200 } }
        },
        packetCapture: {
          getStats: () => ({ enabled: false, captured: 0, dropped: 0, buffered: 0 }),
          start: jest.fn(),
          stop: jest.fn(),
          exportPcap: () => Buffer.from("pcap")
        },
        packetInspector: {
          getStats: () => ({ enabled: true, packetsInspected: 5, clientsConnected: 1 })
        },
        ...monitoringOverrides
      },
      networkSimulator: null,
      options: { alertThresholds: {} }
    }
  };
}

// ── GET /monitoring/packet-loss ───────────────────────────────────────────────

describe("GET /monitoring/packet-loss", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/packet-loss");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns empty heatmap when no packetLossTracker", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/packet-loss");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.heatmap).toEqual([]);
  });

  test("returns empty heatmap when monitoring is null", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: null } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/packet-loss");
    const res = makeResponse();
    h({}, res);
    expect(res.body.heatmap).toEqual([]);
  });

  test("returns heatmap data when tracker is present", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/monitoring/packet-loss");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.heatmap).toEqual([1, 2]);
  });

  test("returns 500 on thrown error", () => {
    const router = makeRouterCollector();
    const bundle = {
      id: "x",
      name: "x",
      state: {
        monitoring: {
          packetLossTracker: {
            getHeatmapData: () => {
              throw new Error("boom");
            },
            getSummary: () => ({})
          }
        }
      }
    };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/packet-loss");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(500);
  });
});

// ── GET /monitoring/path-latency ─────────────────────────────────────────────

describe("GET /monitoring/path-latency", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/path-latency");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns empty paths when no pathLatencyTracker", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/path-latency");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.body.paths).toEqual([]);
  });

  test("returns path stats with default limit", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/monitoring/path-latency");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.paths)).toBe(true);
  });

  test("respects limit query param", () => {
    const router = makeRouterCollector();
    const getAllStats = jest.fn(() => []);
    const bundle = makeMonitoringBundle({
      pathLatencyTracker: { getAllStats }
    });
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/path-latency");
    const res = makeResponse();
    h({ query: { limit: "5" } }, res);
    expect(getAllStats).toHaveBeenCalledWith(5);
  });

  test("clamps limit to 1–1000", () => {
    const router = makeRouterCollector();
    const getAllStats = jest.fn(() => []);
    const bundle = makeMonitoringBundle({ pathLatencyTracker: { getAllStats } });
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/path-latency");
    h({ query: { limit: "99999" } }, makeResponse());
    expect(getAllStats).toHaveBeenCalledWith(1000);
  });
});

// ── GET /monitoring/retransmissions ──────────────────────────────────────────

describe("GET /monitoring/retransmissions", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/retransmissions");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns empty chart when no retransmissionTracker", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/retransmissions");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.body.chartData).toEqual([]);
  });

  test("returns chart data with no limit", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/monitoring/retransmissions");
    const res = makeResponse();
    h({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.chartData)).toBe(true);
  });

  test("passes limit to getChartData when valid", () => {
    const router = makeRouterCollector();
    const getChartData = jest.fn(() => []);
    const bundle = makeMonitoringBundle({
      retransmissionTracker: {
        getChartData,
        getSummary: () => ({ avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 })
      }
    });
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/retransmissions");
    h({ query: { limit: "50" } }, makeResponse());
    expect(getChartData).toHaveBeenCalledWith(50);
  });

  test("passes undefined to getChartData when limit is negative", () => {
    const router = makeRouterCollector();
    const getChartData = jest.fn(() => []);
    const bundle = makeMonitoringBundle({
      retransmissionTracker: {
        getChartData,
        getSummary: () => ({ avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 })
      }
    });
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/retransmissions");
    h({ query: { limit: "-5" } }, makeResponse());
    expect(getChartData).toHaveBeenCalledWith(undefined);
  });
});

// ── GET /monitoring/alerts ───────────────────────────────────────────────────

describe("GET /monitoring/alerts", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/alerts");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns empty state when no alertManager", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/alerts");
    const res = makeResponse();
    h({}, res);
    expect(res.body).toEqual({ thresholds: {}, activeAlerts: {} });
  });

  test("returns alertManager state on success", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/monitoring/alerts");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("thresholds");
  });
});

// ── POST /monitoring/alerts ──────────────────────────────────────────────────

describe("POST /monitoring/alerts", () => {
  function makePostHandler(ctxOverrides = {}) {
    const router = makeRouterCollector();
    monitoringRoutes.register(
      router,
      makeCtx({ getFirstBundle: () => makeMonitoringBundle(), ...ctxOverrides })
    );
    return findHandler(router, "post", "/monitoring/alerts");
  }

  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const h = findHandler(router, "post", "/monitoring/alerts");
    const res = makeResponse();
    h({ body: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 503 when no alertManager", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "post", "/monitoring/alerts");
    const res = makeResponse();
    h({ body: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 400 when metric is missing", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/metric is required/i);
  });

  test("returns 400 when metric is invalid", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "invalid" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/metric must be one of/i);
  });

  test("returns 400 when warning is not a finite number", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "rtt", warning: "not-a-number" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/warning must be a finite number/i);
  });

  test("returns 400 when critical is not a finite number", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "rtt", critical: "bad" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/critical must be a finite number/i);
  });

  test("returns 400 when neither warning nor critical is supplied", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "rtt" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  test("returns 400 when warning > critical", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "rtt", warning: 300, critical: 100 } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/warning must be less than or equal to critical/i);
  });

  test("accepts valid metric and warning only", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "rtt", warning: 100 } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("accepts valid metric and critical only", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "packetLoss", critical: 0.5 } }, res);
    expect(res.statusCode).toBe(200);
  });

  test("accepts both warning and critical with warning <= critical", () => {
    const h = makePostHandler();
    const res = makeResponse();
    h({ body: { metric: "jitter", warning: 50, critical: 100 } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── GET /capture ─────────────────────────────────────────────────────────────

describe("GET /capture", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/capture");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns defaults when no packetCapture", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/capture");
    const res = makeResponse();
    h({}, res);
    expect(res.body).toEqual({ enabled: false, captured: 0, dropped: 0, buffered: 0 });
  });

  test("returns capture stats when initialized", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/capture");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("enabled");
  });
});

// ── POST /capture/start ───────────────────────────────────────────────────────

describe("POST /capture/start", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "post", "/capture/start");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 503 when no packetCapture", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "post", "/capture/start");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("starts capture and returns success", () => {
    const router = makeRouterCollector();
    const bundle = makeMonitoringBundle();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "post", "/capture/start");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(bundle.state.monitoring.packetCapture.start).toHaveBeenCalled();
  });
});

// ── POST /capture/stop ────────────────────────────────────────────────────────

describe("POST /capture/stop", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "post", "/capture/stop");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 503 when no packetCapture", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "post", "/capture/stop");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("stops capture and returns success", () => {
    const router = makeRouterCollector();
    const bundle = makeMonitoringBundle();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "post", "/capture/stop");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(bundle.state.monitoring.packetCapture.stop).toHaveBeenCalled();
  });
});

// ── GET /capture/export ───────────────────────────────────────────────────────

describe("GET /capture/export", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/capture/export");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 503 when no packetCapture", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/capture/export");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("exports pcap buffer", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/capture/export");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });
});

// ── GET /monitoring/inspector ─────────────────────────────────────────────────

describe("GET /monitoring/inspector", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/inspector");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns defaults when no packetInspector", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {} } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/inspector");
    const res = makeResponse();
    h({}, res);
    expect(res.body).toEqual({ enabled: false, packetsInspected: 0, clientsConnected: 0 });
  });

  test("returns inspector stats when initialized", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => makeMonitoringBundle() }));
    const h = findHandler(router, "get", "/monitoring/inspector");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.packetsInspected).toBe(5);
  });
});

// ── GET /monitoring/simulation ────────────────────────────────────────────────

describe("GET /monitoring/simulation", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    monitoringRoutes.register(router, makeCtx());
    const h = findHandler(router, "get", "/monitoring/simulation");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns disabled when no networkSimulator", () => {
    const router = makeRouterCollector();
    const bundle = { id: "x", name: "x", state: { monitoring: {}, networkSimulator: null } };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/simulation");
    const res = makeResponse();
    h({}, res);
    expect(res.body).toEqual({ enabled: false });
  });

  test("returns simulator state when present", () => {
    const router = makeRouterCollector();
    const bundle = {
      id: "x",
      name: "x",
      state: {
        monitoring: {},
        networkSimulator: {
          getConditions: () => ({ latency: 50 }),
          getStats: () => ({ packets: 10 })
        }
      }
    };
    monitoringRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const h = findHandler(router, "get", "/monitoring/simulation");
    const res = makeResponse();
    h({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.conditions).toEqual({ latency: 50 });
  });
});
