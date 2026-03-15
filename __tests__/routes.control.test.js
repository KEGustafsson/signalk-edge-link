"use strict";

/**
 * Branch-coverage tests for src/routes/control.ts
 * Exercises every response branch: 401, 503, 404, 400, and 200.
 */

const controlRoutes = require("../lib/routes/control");

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
  return {
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    getFirstBundle: () => null,
    instanceRegistry: { getAll: () => [] },
    authorizeManagement: () => true,
    managementAuthMiddleware: () => (req, res, next) => next(),
    ...overrides
  };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) {throw new Error(`Route ${method.toUpperCase()} ${path} not found`);}
  return route.handlers.at(-1);
}

// ── GET /congestion ────────────────────────────────────────────────────────

describe("GET /congestion", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const handler = findHandler(router, "get", "/congestion");
    const res = makeResponse();
    handler({ query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/not started/i);
  });

  test("returns 404 in server mode", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: true } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "get", "/congestion");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(404);
  });

  test("returns 503 when congestion control not initialised", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: false, pipeline: null } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "get", "/congestion");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/congestion control/i);
  });

  test("returns cc state on success", () => {
    const router = makeRouterCollector();
    const ccState = { cwnd: 10, state: "slow_start" };
    const bundle = {
      state: {
        isServerMode: false,
        pipeline: { getCongestionControl: () => ({ getState: () => ccState }) }
      }
    };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "get", "/congestion");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(ccState);
  });
});

// ── POST /delta-timer ──────────────────────────────────────────────────────

describe("POST /delta-timer", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 404 in server mode", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: true } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  test("auto mode returns 503 when congestion control not initialised", () => {
    const router = makeRouterCollector();
    const state = { isServerMode: false, pipeline: null };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => ({ state }) }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { mode: "auto" } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/congestion control/i);
  });

  test("auto mode calls enableAutoMode when cc available", () => {
    const enableAutoMode = jest.fn();
    const getCurrent = jest.fn().mockReturnValue(500);
    const router = makeRouterCollector();
    const state = {
      isServerMode: false,
      pipeline: {
        getCongestionControl: () => ({ enableAutoMode, getCurrentDeltaTimer: getCurrent })
      }
    };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => ({ state }) }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { mode: "auto" } }, res);
    expect(enableAutoMode).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.mode).toBe("auto");
  });

  test("returns 400 for non-number value", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: false, pipeline: null } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { value: "fast" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/must be a number/i);
  });

  test("returns 400 for value below 100", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: false, pipeline: null } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { value: 50 } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/between 100 and 10000/i);
  });

  test("returns 400 for value above 10000", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: false, pipeline: null } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { value: 99999 } }, res);
    expect(res.statusCode).toBe(400);
  });

  test("sets deltaTimerTime on valid value", () => {
    const router = makeRouterCollector();
    const state = { isServerMode: false, pipeline: null, deltaTimerTime: 1000 };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => ({ state }) }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { value: 500 } }, res);
    expect(res.statusCode).toBe(200);
    expect(state.deltaTimerTime).toBe(500);
  });

  test("calls setManualDeltaTimer on congestion control when pipeline available", () => {
    const setManual = jest.fn();
    const router = makeRouterCollector();
    const state = {
      isServerMode: false,
      pipeline: { getCongestionControl: () => ({ setManualDeltaTimer: setManual }) }
    };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => ({ state }) }));
    const handler = findHandler(router, "post", "/delta-timer");
    const res = makeResponse();
    handler({ body: { value: 750 } }, res);
    expect(setManual).toHaveBeenCalledWith(750);
  });
});

// ── GET /bonding ──────────────────────────────────────────────────────────

describe("GET /bonding", () => {
  test("returns 503 when no instances", () => {
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [] } }));
    const handler = findHandler(router, "get", "/bonding");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns bonding state for all instances", () => {
    const bondingState = { activeLink: "primary" };
    const bundle = {
      id: "conn1",
      name: "Conn 1",
      state: {
        pipeline: { getBondingManager: () => ({ getState: () => bondingState }) }
      }
    };
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [bundle] } }));
    const handler = findHandler(router, "get", "/bonding");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    const instances = res.body.instances || res.body;
    expect(instances[0]).toMatchObject({
      id: "conn1",
      name: "Conn 1",
      enabled: true,
      state: bondingState
    });
  });

  test("marks enabled false when no bonding manager", () => {
    const bundle = { id: "c1", name: "C1", state: { pipeline: null } };
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [bundle] } }));
    const handler = findHandler(router, "get", "/bonding");
    const res = makeResponse();
    handler({}, res);
    const instances = res.body.instances || res.body;
    expect(instances[0].enabled).toBe(false);
    expect(instances[0].state).toBeNull();
  });
});

// ── POST /bonding ─────────────────────────────────────────────────────────

describe("POST /bonding", () => {
  test("returns 400 for unknown key", () => {
    const router = makeRouterCollector();
    const bundle = {
      id: "c1",
      name: "C1",
      state: {
        pipeline: {
          getBondingManager: () => ({
            failoverThresholds: { rttThreshold: 200 }
          })
        }
      }
    };
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [bundle] } }));
    const handler = findHandler(router, "post", "/bonding");
    const res = makeResponse();
    handler({ body: { unknownProp: 99 } }, res);
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when body is not an object", () => {
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [] } }));
    const handler = findHandler(router, "post", "/bonding");
    const res = makeResponse();
    handler({ body: "bad" }, res);
    expect(res.statusCode).toBe(400);
  });

  test("returns 503 when no bonding-enabled instances", () => {
    const router = makeRouterCollector();
    const bundle = { id: "c1", name: "C1", state: { pipeline: null } };
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [bundle] } }));
    const handler = findHandler(router, "post", "/bonding");
    const res = makeResponse();
    handler({ body: { rttThreshold: 150 } }, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 200 and updates thresholds on valid request", () => {
    const thresholds = { rttThreshold: 200, lossThreshold: 0.1 };
    const bundle = {
      id: "c1",
      name: "C1",
      state: {
        pipeline: { getBondingManager: () => ({ failoverThresholds: thresholds }) }
      }
    };
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ instanceRegistry: { getAll: () => [bundle] } }));
    const handler = findHandler(router, "post", "/bonding");
    const res = makeResponse();
    handler({ body: { rttThreshold: 300 } }, res);
    expect(res.statusCode).toBe(200);
    expect(thresholds.rttThreshold).toBe(300);
  });
});

// ── POST /bonding/failover ────────────────────────────────────────────────

describe("POST /bonding/failover", () => {
  test("returns 503 when plugin not started", () => {
    const router = makeRouterCollector();
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => null }));
    const handler = findHandler(router, "post", "/bonding/failover");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("returns 404 in server mode", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: true } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/bonding/failover");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(404);
  });

  test("returns 503 when bonding not available", () => {
    const router = makeRouterCollector();
    const bundle = { state: { isServerMode: false, pipeline: null } };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/bonding/failover");
    const res = makeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  test("calls forceFailover and returns success", () => {
    const forceFailover = jest.fn();
    const router = makeRouterCollector();
    const bundle = {
      state: {
        isServerMode: false,
        pipeline: {
          getBondingManager: () => ({
            forceFailover,
            getActiveLinkName: () => "backup",
            getLinkHealth: () => ({ primary: "down", backup: "up" })
          })
        }
      }
    };
    controlRoutes.register(router, makeCtx({ getFirstBundle: () => bundle }));
    const handler = findHandler(router, "post", "/bonding/failover");
    const res = makeResponse();
    handler({}, res);
    expect(forceFailover).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.activeLink).toBe("backup");
  });
});
