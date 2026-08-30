"use strict";

/**
 * Endpoint tests for the per-connection monitoring/failover routes in
 * src/routes/connections.ts — the twins of the /monitoring singletons. These
 * share their response bodies via routes/monitoring-views.ts; the cases here
 * pin the per-connection resolution (404s), the retransmission limit clamp,
 * and the failover error branches.
 */

const connectionsRoutes = require("../lib/routes/connections");

function makeRouterCollector() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) {
      routes.push({ method: "get", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "post", path, handlers });
    },
    put(path, ...handlers) {
      routes.push({ method: "put", path, handlers });
    },
    delete(path, ...handlers) {
      routes.push({ method: "delete", path, handlers });
    }
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
    }
  };
}

function makeCtx(bundlesById = {}) {
  return {
    app: { debug: jest.fn(), error: jest.fn() },
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    blockCrossSiteForm: (req, res, next) => next(),
    instanceRegistry: { getAll: () => Object.values(bundlesById), getFirst: () => null },
    getBundleById: (id) => bundlesById[id] || null,
    getEffectiveNetworkQuality: jest.fn(() => ({})),
    getConfigFilePath: jest.fn(() => null),
    loadConfigFile: jest.fn(),
    saveConfigFile: jest.fn(),
    buildFullMetricsResponse: jest.fn(() => ({})),
    pluginRef: null,
    authorizeManagement: () => true,
    managementAuthMiddleware: () => (req, res, next) => next()
  };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  const handlers = route.handlers;
  return (req, res) => {
    for (const handler of handlers) {
      let advanced = false;
      handler(req, res, () => {
        advanced = true;
      });
      if (!advanced) {
        break;
      }
    }
  };
}

describe("GET /connections/:id/monitoring/retransmissions", () => {
  function makeBundle(getChartData) {
    return {
      id: "c1",
      name: "c1",
      state: {
        isServerMode: false,
        monitoring: {
          retransmissionTracker: { getChartData, getSummary: () => ({ entries: 0 }) }
        }
      },
      metricsApi: { metrics: {} }
    };
  }

  test("unknown connection returns 404", () => {
    const router = makeRouterCollector();
    connectionsRoutes.register(router, makeCtx({}));
    const h = findHandler(router, "get", "/connections/:id/monitoring/retransmissions");
    const res = makeResponse();
    h({ params: { id: "nope" }, query: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  test("clamps the limit the same way the singleton route does", () => {
    // Regression: this route once lost the clamp its singleton twin had, so a
    // negative limit sliced from the wrong end of the history.
    const getChartData = jest.fn(() => []);
    const router = makeRouterCollector();
    connectionsRoutes.register(router, makeCtx({ c1: makeBundle(getChartData) }));
    const h = findHandler(router, "get", "/connections/:id/monitoring/retransmissions");

    h({ params: { id: "c1" }, query: { limit: "-5" } }, makeResponse());
    expect(getChartData).toHaveBeenLastCalledWith(undefined);

    h({ params: { id: "c1" }, query: { limit: "5000" } }, makeResponse());
    expect(getChartData).toHaveBeenLastCalledWith(1000);

    h({ params: { id: "c1" }, query: { limit: "50" } }, makeResponse());
    expect(getChartData).toHaveBeenLastCalledWith(50);
  });
});

describe("POST /connections/:id/bonding/failover", () => {
  function bundleWith(state) {
    return { id: "c1", name: "c1", state, metricsApi: { metrics: {} } };
  }

  function run(state) {
    const router = makeRouterCollector();
    connectionsRoutes.register(router, makeCtx({ c1: bundleWith(state) }));
    const h = findHandler(router, "post", "/connections/:id/bonding/failover");
    const res = makeResponse();
    h({ params: { id: "c1" }, query: {}, body: {} }, res);
    return res;
  }

  test("unknown connection returns 404", () => {
    const router = makeRouterCollector();
    connectionsRoutes.register(router, makeCtx({}));
    const h = findHandler(router, "post", "/connections/:id/bonding/failover");
    const res = makeResponse();
    h({ params: { id: "nope" }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  test("server mode returns 404", () => {
    const res = run({ isServerMode: true });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe("Not available in server mode");
  });

  test("no pipeline returns 503", () => {
    const res = run({ isServerMode: false, pipeline: null });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("Bonding not available");
  });

  test("bonding disabled returns 503", () => {
    const res = run({ isServerMode: false, pipeline: { getBondingManager: () => null } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("Bonding not enabled");
  });

  test("forces failover and reports the new link state", () => {
    const forceFailover = jest.fn();
    const res = run({
      isServerMode: false,
      pipeline: {
        getBondingManager: () => ({
          forceFailover,
          getActiveLinkName: () => "backup",
          getLinkHealth: () => ({ primary: false, backup: true })
        })
      }
    });
    expect(forceFailover).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      success: true,
      activeLink: "backup",
      links: { primary: false, backup: true }
    });
  });
});

describe("/instances mutation routes — restart rejection", () => {
  // Regression: a rejected _restartPlugin used to have its message serialized
  // straight into the 500 body, exposing configuration and filesystem detail
  // to management clients.
  const REJECTION = "EACCES: permission denied, open '/srv/signalk/keys'";

  function conn(name) {
    return {
      name,
      serverType: "client",
      udpPort: 4567,
      udpAddress: "127.0.0.1",
      secretKey: "12345678901234567890123456789012",
      protocolVersion: 3
    };
  }

  function bundle(id) {
    return { id, name: id, state: { options: conn(id) }, metricsApi: { metrics: {} } };
  }

  function setup(connections) {
    const router = makeRouterCollector();
    const ctx = makeCtx({ primary: bundle("primary"), secondary: bundle("secondary") });
    ctx.pluginRef = {
      _currentOptions: { connections },
      _restartPlugin: jest.fn(() => Promise.reject(new Error(REJECTION)))
    };
    connectionsRoutes.register(router, ctx);
    return { router, ctx };
  }

  function lastHandler(router, method, path) {
    return router.routes.find((r) => r.method === method && r.path === path).handlers.at(-1);
  }

  function expectGenericFailure(res, ctx) {
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(ctx.app.error).toHaveBeenCalledWith(expect.stringContaining(REJECTION));
  }

  test("POST /instances returns a generic 500 and logs the detail", async () => {
    const { router, ctx } = setup([conn("primary")]);
    const res = makeResponse();
    await lastHandler(router, "post", "/instances")({ body: conn("tertiary") }, res);
    expectGenericFailure(res, ctx);
  });

  test("PUT /instances/:id returns a generic 500 and logs the detail", async () => {
    const { router, ctx } = setup([conn("primary")]);
    const res = makeResponse();
    await lastHandler(
      router,
      "put",
      "/instances/:id"
    )({ params: { id: "primary" }, body: { name: "renamed" } }, res);
    expectGenericFailure(res, ctx);
  });

  test("DELETE /instances/:id returns a generic 500 and logs the detail", async () => {
    const { router, ctx } = setup([conn("primary"), conn("secondary")]);
    const res = makeResponse();
    await lastHandler(router, "delete", "/instances/:id")({ params: { id: "secondary" } }, res);
    expectGenericFailure(res, ctx);
  });
});
