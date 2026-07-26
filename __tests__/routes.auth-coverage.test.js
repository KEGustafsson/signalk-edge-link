"use strict";

/**
 * Every management route must be behind authentication.
 *
 * This is a *registration-shape* gate, not a per-route test. Most route modules
 * are guarded by `managementAuthMiddleware(action)` rather than an inline
 * `authorizeManagement` call — and every existing route-module test stubs that
 * middleware to a pass-through AND resolves the handler via
 * `route.handlers.at(-1)`, skipping middleware entirely. That combination means
 * deleting the guard from a route registration leaves the whole suite green
 * while the endpoint becomes unauthenticated.
 *
 * Here the real middleware chain is executed end to end with a management token
 * configured and no credentials supplied: every route must answer 401 and must
 * never reach its handler.
 */

const createRoutes = require("../lib/routes");

const TOKEN = "s3cret-management-token";

// Routes that are intentionally reachable without a management token.
// Adding a route here is a deliberate, reviewable decision.
const PUBLIC_ROUTES = new Set([]);

function makeRouterCollector() {
  const routes = [];
  const record =
    (method) =>
      (path, ...handlers) => {
        routes.push({ method, path, handlers });
      };
  return {
    routes,
    get: record("get"),
    post: record("post"),
    put: record("put"),
    delete: record("delete")
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    set() {
      return this;
    }
  };
}

function makeRequest(method, path) {
  return {
    method: method.toUpperCase(),
    path,
    params: { id: "test", filename: "delta_timer.json" },
    query: {},
    body: {},
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    ip: "127.0.0.1",
    app: { get: () => false }
  };
}

function makeBundle() {
  return {
    id: "test",
    name: "test",
    state: {
      instanceStatus: "running",
      isServerMode: false,
      options: { protocolVersion: 3 },
      deltas: []
    },
    metricsApi: { metrics: { errorCounts: {}, recentErrors: [] } }
  };
}

/**
 * Run a route's full handler chain (middleware included) until something
 * responds or the chain is exhausted.
 */
async function runChain(route) {
  const req = makeRequest(route.method, route.path);
  const res = makeResponse();
  let reachedHandler = false;

  for (let i = 0; i < route.handlers.length; i++) {
    const handler = route.handlers[i];
    const isLast = i === route.handlers.length - 1;
    let advanced = false;
    const next = () => {
      advanced = true;
    };

    if (isLast) {
      reachedHandler = true;
    }
    await handler(req, res, next);

    // Middleware that neither responded nor called next() ends the chain.
    if (!advanced) {
      break;
    }
  }

  return { res, reachedHandler };
}

describe("management route auth coverage", () => {
  let router;

  beforeAll(() => {
    const pluginRef = { _currentOptions: { managementApiToken: TOKEN } };
    const instanceRegistry = {
      getAll: () => [makeBundle()],
      getFirst: () => makeBundle(),
      getById: () => makeBundle(),
      get: () => makeBundle()
    };
    const routes = createRoutes(
      { debug: () => {}, error: () => {}, savePluginOptions: (_o, cb) => cb && cb(null) },
      instanceRegistry,
      pluginRef
    );
    router = makeRouterCollector();
    routes.registerWithRouter(router);
  });

  test("registers a non-trivial number of routes", () => {
    // Guards against the suite silently passing because registration changed
    // shape and nothing was collected.
    expect(router.routes.length).toBeGreaterThan(20);
  });

  test("every registered route is either public by allowlist or requires auth", async () => {
    const unguarded = [];

    for (const route of router.routes) {
      const key = `${route.method.toUpperCase()} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) {
        continue;
      }

      const { res, reachedHandler } = await runChain(route);

      // A guarded route rejects with 401 before reaching its handler. Some
      // routes legitimately answer 415 (content-type) first; those still never
      // reach the handler, so treat any 4xx-without-handler as guarded.
      const guarded = res.statusCode === 401 || (!reachedHandler && res.statusCode >= 400);
      if (!guarded) {
        unguarded.push(`${key} -> status ${res.statusCode}, handlerReached=${reachedHandler}`);
      }
    }

    expect(unguarded).toEqual([]);
  });

  test("auth rejection is a 401 for every route that reports one", async () => {
    for (const route of router.routes) {
      const key = `${route.method.toUpperCase()} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) {
        continue;
      }
      const { res } = await runChain(route);
      expect([401, 415]).toContain(res.statusCode);
    }
  });
});

describe("cross-site form protection on bodyless mutating routes", () => {
  const MUTATING_BODYLESS = [
    ["post", "/capture/start"],
    ["post", "/capture/stop"],
    ["post", "/bonding/failover"],
    ["post", "/connections/:id/bonding/failover"]
  ];

  let router;

  beforeAll(() => {
    // No management token configured: the documented open-access default, which
    // is exactly the case where CSRF matters.
    const pluginRef = { _currentOptions: {} };
    const instanceRegistry = {
      getAll: () => [makeBundle()],
      getFirst: () => makeBundle(),
      getById: () => makeBundle(),
      get: () => makeBundle()
    };
    const routes = createRoutes(
      { debug: () => {}, error: () => {}, savePluginOptions: (_o, cb) => cb && cb(null) },
      instanceRegistry,
      pluginRef
    );
    router = makeRouterCollector();
    routes.registerWithRouter(router);
  });

  function chainFor(method, path) {
    const route = router.routes.find((r) => r.method === method && r.path === path);
    expect(route).toBeDefined();
    return route;
  }

  async function runWithHeaders(route, headers) {
    const req = makeRequest(route.method, route.path);
    req.headers = { ...headers };
    const res = makeResponse();
    for (const handler of route.handlers) {
      let advanced = false;
      await handler(req, res, () => {
        advanced = true;
      });
      if (!advanced) {break;}
    }
    return res;
  }

  for (const [method, path] of MUTATING_BODYLESS) {
    test(`${method.toUpperCase()} ${path} rejects a cross-site form post`, async () => {
      const route = chainFor(method, path);

      // A cross-site <form> can only produce a "simple" content type, and modern
      // browsers additionally label the request.
      const formPost = await runWithHeaders(route, {
        "content-type": "application/x-www-form-urlencoded"
      });
      expect([403, 415]).toContain(formPost.statusCode);

      const crossSite = await runWithHeaders(route, { "sec-fetch-site": "cross-site" });
      expect(crossSite.statusCode).toBe(403);
    });

    test(`${method.toUpperCase()} ${path} still accepts a bodyless API call`, async () => {
      const route = chainFor(method, path);
      // The CLI sends no Content-Type when there is no body — this must not 415.
      const res = await runWithHeaders(route, {});
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).not.toBe(403);
    });
  }
});
