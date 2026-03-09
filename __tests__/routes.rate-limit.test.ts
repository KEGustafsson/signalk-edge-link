// @ts-nocheck
"use strict";

const createRoutes = require("../lib/routes.ts");
const { RATE_LIMIT_MAX_REQUESTS } = require("../lib/constants.ts");

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

function makeBundle() {
  return {
    id: "test",
    name: "test",
    state: { isServerMode: false, options: {}, deltas: [], readyToSend: false },
    metricsApi: {
      metrics: {
        startTime: Date.now(),
        deltasSent: 0,
        deltasReceived: 0,
        udpSendErrors: 0,
        udpRetries: 0,
        compressionErrors: 0,
        encryptionErrors: 0,
        subscriptionErrors: 0,
        duplicatePackets: 0,
        errorCounts: { general: 0, subscription: 0, udpSend: 0 },
        recentErrors: [],
        bandwidth: {
          packetsOut: 0,
          packetsIn: 0,
          bytesOut: 0,
          bytesIn: 0,
          bytesOutRaw: 0,
          bytesInRaw: 0,
          rateOut: 0,
          rateIn: 0,
          compressionRatio: 1,
          history: { toArray: () => [] }
        },
        smartBatching: {
          earlySends: 0,
          timerSends: 0,
          oversizedPackets: 0,
          avgBytesPerDelta: 0,
          maxDeltasPerBatch: 0
        }
      },
      updateBandwidthRates: jest.fn(),
      formatBytes: jest.fn(() => "0 B"),
      getTopNPaths: jest.fn(() => [])
    }
  };
}

describe("rate limit middleware client identity", () => {
  test("allows request when client IP cannot be determined", () => {
    const app = { get: jest.fn(() => false) };
    const instanceRegistry = {
      get: jest.fn(() => makeBundle()),
      getFirst: jest.fn(() => makeBundle()),
      getAll: jest.fn(() => [makeBundle()])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const rateLimitMiddleware = metricsRoute.handlers[0];

    const req = { headers: {}, ip: null, socket: {}, app: { get: () => false } };
    const res = { status: jest.fn(() => ({ json: jest.fn() })) };
    const next = jest.fn();

    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("allows request when req.ip is present", () => {
    const app = { get: jest.fn(() => false) };
    const instanceRegistry = {
      get: jest.fn(() => makeBundle()),
      getFirst: jest.fn(() => makeBundle()),
      getAll: jest.fn(() => [makeBundle()])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const rateLimitMiddleware = metricsRoute.handlers[0];

    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const res = { status: jest.fn(() => ({ json: jest.fn() })) };
    const next = jest.fn();

    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("rate-limits repeated requests when IP cannot be determined", () => {
    const app = { get: jest.fn(() => false) };
    const instanceRegistry = {
      get: jest.fn(() => makeBundle()),
      getFirst: jest.fn(() => makeBundle()),
      getAll: jest.fn(() => [makeBundle()])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const rateLimitMiddleware = metricsRoute.handlers[0];

    const req = { headers: {}, ip: null, socket: {}, app: { get: () => false } };
    const next = jest.fn();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      rateLimitMiddleware(req, res, next);
    }
    rateLimitMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ error: "Too many requests, please try again later" });
  });

  test("uses first x-forwarded-for IP when trust proxy is enabled", () => {
    const app = { get: jest.fn(() => false) };
    const instanceRegistry = {
      get: jest.fn(() => makeBundle()),
      getFirst: jest.fn(() => makeBundle()),
      getAll: jest.fn(() => [makeBundle()])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const rateLimitMiddleware = metricsRoute.handlers[0];

    const reqA = {
      headers: { "x-forwarded-for": "198.51.100.10, 10.0.0.5" },
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      app: { get: (name) => name === "trust proxy" }
    };
    const reqB = {
      headers: { "x-forwarded-for": "198.51.100.11, 10.0.0.5" },
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      app: { get: (name) => name === "trust proxy" }
    };
    const nextA = jest.fn();
    const nextB = jest.fn();
    const res = { status: jest.fn(() => ({ json: jest.fn() })) };

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      rateLimitMiddleware(reqA, res, nextA);
    }
    rateLimitMiddleware(reqB, res, nextB);

    expect(nextB).toHaveBeenCalled();
  });

  test("separates unknown-client buckets using stable header traits", () => {
    const app = { get: jest.fn(() => false) };
    const instanceRegistry = {
      get: jest.fn(() => makeBundle()),
      getFirst: jest.fn(() => makeBundle()),
      getAll: jest.fn(() => [makeBundle()])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const rateLimitMiddleware = metricsRoute.handlers[0];

    const reqA = {
      headers: { "user-agent": "client-A", "accept-language": "en-US", host: "edge.local" },
      ip: null,
      socket: {},
      app: { get: () => false }
    };
    const reqB = {
      headers: { "user-agent": "client-B", "accept-language": "en-US", host: "edge.local" },
      ip: null,
      socket: {},
      app: { get: () => false }
    };

    const res = { status: jest.fn(() => ({ json: jest.fn() })) };
    const nextA = jest.fn();
    const nextB = jest.fn();

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      rateLimitMiddleware(reqA, res, nextA);
    }
    rateLimitMiddleware(reqB, res, nextB);

    expect(nextB).toHaveBeenCalled();
  });
});

describe("instances management route", () => {
  test("registers /instances and returns compact instance status", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.state.instanceStatus = "running";
    bundle.state.options.protocolVersion = 2;

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    expect(instancesRoute).toBeDefined();

    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instancesRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "test",
        protocolVersion: 2,
        state: "running",
        metrics: expect.objectContaining({
          deltasSent: 0,
          deltasReceived: 0,
          udpSendErrors: 0,
          duplicatePackets: 0
        })
      })
    ]);
  });

  test("supports /instances filtering by state and paginated responses", () => {
    const app = { get: jest.fn(() => false) };
    const a = makeBundle();
    a.id = "a";
    a.name = "a";
    a.state.instanceStatus = "running";

    const b = makeBundle();
    b.id = "b";
    b.name = "b";
    b.state.instanceStatus = "stopped";

    const c = makeBundle();
    c.id = "c";
    c.name = "c";
    c.state.instanceStatus = "running";

    const instanceRegistry = {
      get: jest.fn(() => null),
      getFirst: jest.fn(() => a),
      getAll: jest.fn(() => [a, b, c])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const req = {
      query: { state: "running", limit: "1", page: "2" },
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instancesRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "c", state: "running" })],
        pagination: expect.objectContaining({ page: 2, limit: 1, total: 2, totalPages: 2 })
      })
    );
  });

  test("rejects invalid /instances pagination params", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const json = jest.fn();
    const req = {
      query: { limit: "0" },
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    instancesRoute.handlers[1](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "limit must be a positive integer" });
  });
  test("registers /instances/:id and returns detailed instance status", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.state.instanceStatus = "running";
    bundle.state.options.protocolVersion = 2;
    bundle.state.options.someOption = true;
    bundle.state.readyToSend = true;

    const instanceRegistry = {
      get: jest.fn((id) => (id === "test" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instanceRoute = router.routes.find(
      (r) => r.method === "get" && r.path === "/instances/:id"
    );
    expect(instanceRoute).toBeDefined();

    const req = {
      params: { id: "test" },
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instanceRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test",
        protocolVersion: 2,
        state: "running",
        readyToSend: true,
        config: expect.objectContaining({ someOption: true }),
        network: expect.objectContaining({ rtt: 0, dataSource: "local" }),
        metrics: expect.objectContaining({ deltasSent: 0, duplicatePackets: 0 }),
        bonding: expect.objectContaining({ enabled: false })
      })
    );
  });

  test("registers /bonding and reports per-instance bonding state", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.state.pipeline = {
      getBondingManager: () => ({
        getState: () => ({ enabled: true, activeLink: "primary" }),
        failoverThresholds: { rttThreshold: 500 }
      })
    };

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const bondingRoute = router.routes.find((r) => r.method === "get" && r.path === "/bonding");
    expect(bondingRoute).toBeDefined();

    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    bondingRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        totalInstances: 1,
        bondingEnabledInstances: 1,
        instances: [expect.objectContaining({ enabled: true })]
      })
    );
  });

  test("registers POST /bonding and validates unsupported keys", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const bondingRoute = router.routes.find((r) => r.method === "post" && r.path === "/bonding");
    expect(bondingRoute).toBeDefined();

    const req = {
      body: { unsupported: 1 },
      headers: { "content-type": "application/json", "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const json = jest.fn();
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    bondingRoute.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Unsupported bonding setting 'unsupported'" });
  });

  test("redacts secretKey in /instances/:id response config", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.state.instanceStatus = "running";
    bundle.state.options.secretKey = "12345678901234567890123456789012";

    const instanceRegistry = {
      get: jest.fn((id) => (id === "test" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _restartPlugin: jest.fn(),
      _currentOptions: {
        connections: [{ name: "test", serverType: "client", udpPort: 4446, secretKey: "123" }]
      }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instanceRoute = router.routes.find(
      (r) => r.method === "get" && r.path === "/instances/:id"
    );
    const req = {
      params: { id: "test" },
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instanceRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ secretKey: "[redacted]" })
      })
    );
  });

  test("POST /instances appends a new connection and triggers restart", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);
    const pluginRef = {
      _restartPlugin: restart,
      _currentOptions: {
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");
    const req = {
      body: {
        name: "new",
        serverType: "server",
        udpPort: 4500,
        secretKey: "abcdefghijklmnopqrstuvwxyz123456"
      },
      headers: { "content-type": "application/json", "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await route.handlers[2](req, res);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.arrayContaining([
          expect.objectContaining({ name: "base" }),
          expect.objectContaining({ name: "new", udpPort: 4500 })
        ])
      })
    );
  });

  test("POST /instances preserves managementApiToken across restart and keeps auth enforced", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);
    const pluginRef = {
      _restartPlugin: restart,
      _currentOptions: {
        managementApiToken: "secret-token",
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const createRoute = router.routes.find((r) => r.method === "post" && r.path === "/instances");
    const createReq = {
      body: {
        name: "new",
        serverType: "server",
        udpPort: 4500,
        secretKey: "abcdefghijklmnopqrstuvwxyz123456"
      },
      headers: { "content-type": "application/json", "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const createRes = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await createRoute.handlers[2](createReq, createRes);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ managementApiToken: "secret-token" })
    );
    expect(pluginRef._currentOptions.managementApiToken).toBe("secret-token");

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const deniedReq = {
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const deniedJson = jest.fn();
    const deniedRes = { json: jest.fn(), status: jest.fn(() => ({ json: deniedJson })) };

    instancesRoute.handlers[1](deniedReq, deniedRes);

    expect(deniedRes.status).toHaveBeenCalledWith(401);
    expect(deniedJson).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
  });

  test("PUT /instances/:id rejects immutable field updates", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "base";

    const pluginRef = {
      _restartPlugin: jest.fn().mockResolvedValue(undefined),
      _currentOptions: {
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "base" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "put" && r.path === "/instances/:id");
    const json = jest.fn();
    const req = {
      params: { id: "base" },
      body: { udpPort: 9000 },
      headers: { "content-type": "application/json", "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Field 'udpPort' is not updatable via /instances/:id"
    });
  });

  test("PUT /instances/:id rejects unknown mutable keys", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "base";

    const pluginRef = {
      _restartPlugin: jest.fn().mockResolvedValue(undefined),
      _currentOptions: {
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "base" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "put" && r.path === "/instances/:id");
    const json = jest.fn();
    const req = {
      params: { id: "base" },
      body: { foo: "bar" },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Field 'foo' is not supported for /instances/:id updates"
    });
  });
  test("POST /instances validates secretKey length", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);

    const routes = createRoutes(
      app,
      {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      },
      {
        _restartPlugin: restart,
        _currentOptions: {
          connections: [
            {
              name: "base",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }
    );

    const router = makeRouterCollector();
    routes.registerWithRouter(router);
    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");

    const json = jest.fn();
    const req = {
      body: { name: "bad", serverType: "client", udpPort: 4446, secretKey: "short" },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error:
        "Secret key must be exactly 32 bytes: use a 32-character ASCII string, 64-character hex string, or 44-character base64 string"
    });
    expect(restart).not.toHaveBeenCalled();
  });

  test("POST /instances accepts 64-character hex secret keys", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);

    const routes = createRoutes(
      app,
      {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      },
      {
        _restartPlugin: restart,
        _currentOptions: {
          connections: [
            {
              name: "base",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }
    );

    const router = makeRouterCollector();
    routes.registerWithRouter(router);
    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");

    const req = {
      body: {
        name: "hex-key",
        serverType: "server",
        udpPort: 4501,
        secretKey: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
      },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await route.handlers[2](req, res);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.arrayContaining([
          expect.objectContaining({
            name: "hex-key",
            secretKey: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
          })
        ])
      })
    );
  });

  test("POST /instances accepts 44-character base64 secret keys", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);

    const routes = createRoutes(
      app,
      {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      },
      {
        _restartPlugin: restart,
        _currentOptions: {
          connections: [
            {
              name: "base",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }
    );

    const router = makeRouterCollector();
    routes.registerWithRouter(router);
    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");

    const req = {
      body: {
        name: "base64-key",
        serverType: "server",
        udpPort: 4502,
        secretKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
      },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await route.handlers[2](req, res);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.arrayContaining([
          expect.objectContaining({
            name: "base64-key",
            secretKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
          })
        ])
      })
    );
  });

  test("PUT /instances/:id validates the fully merged connection", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "base";

    const pluginRef = {
      _restartPlugin: jest.fn().mockResolvedValue(undefined),
      _currentOptions: {
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "127.0.0.1",
            testAddress: "127.0.0.1",
            testPort: 80
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "base" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "put" && r.path === "/instances/:id");
    const json = jest.fn();
    const req = {
      params: { id: "base" },
      body: { bonding: { mode: "invalid-mode" } },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "bonding.mode must be 'main-backup'" });
    expect(pluginRef._restartPlugin).not.toHaveBeenCalled();
  });

  test("PUT /instances/:id preserves managementApiToken across restart and keeps auth enforced", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "base";
    const restart = jest.fn().mockResolvedValue(undefined);

    const pluginRef = {
      _restartPlugin: restart,
      _currentOptions: {
        managementApiToken: "secret-token",
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012",
            protocolVersion: 2,
            udpAddress: "127.0.0.1",
            testAddress: "127.0.0.1",
            testPort: 80,
            pingIntervalTime: 10,
            helloMessageSender: 60
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "base" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const updateRoute = router.routes.find(
      (r) => r.method === "put" && r.path === "/instances/:id"
    );
    const updateReq = {
      params: { id: "base" },
      body: { protocolVersion: 3 },
      headers: { "content-type": "application/json", "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const updateRes = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await updateRoute.handlers[2](updateReq, updateRes);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ managementApiToken: "secret-token" })
    );
    expect(pluginRef._currentOptions.managementApiToken).toBe("secret-token");

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const deniedReq = {
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const deniedJson = jest.fn();
    const deniedRes = { json: jest.fn(), status: jest.fn(() => ({ json: deniedJson })) };

    instancesRoute.handlers[1](deniedReq, deniedRes);

    expect(deniedRes.status).toHaveBeenCalledWith(401);
    expect(deniedJson).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
  });

  test("DELETE /instances/:id preserves managementApiToken across restart and keeps auth enforced", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "alpha";

    const restart = jest.fn().mockResolvedValue(undefined);
    const pluginRef = {
      _restartPlugin: restart,
      _currentOptions: {
        managementApiToken: "secret-token",
        connections: [
          {
            name: "alpha",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "beta",
            serverType: "client",
            udpPort: 4447,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "alpha" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const deleteRoute = router.routes.find(
      (r) => r.method === "delete" && r.path === "/instances/:id"
    );
    const deleteReq = {
      params: { id: "alpha" },
      headers: { "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const deleteRes = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    await deleteRoute.handlers[1](deleteReq, deleteRes);

    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ managementApiToken: "secret-token" })
    );
    expect(pluginRef._currentOptions.managementApiToken).toBe("secret-token");

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const deniedReq = {
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const deniedJson = jest.fn();
    const deniedRes = { json: jest.fn(), status: jest.fn(() => ({ json: deniedJson })) };

    instancesRoute.handlers[1](deniedReq, deniedRes);

    expect(deniedRes.status).toHaveBeenCalledWith(401);
    expect(deniedJson).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
  });

  test("POST /instances rejects duplicate server UDP ports", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const restart = jest.fn().mockResolvedValue(undefined);

    const routes = createRoutes(
      app,
      {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      },
      {
        _restartPlugin: restart,
        _currentOptions: {
          connections: [
            {
              name: "s1",
              serverType: "server",
              udpPort: 4500,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }
    );

    const router = makeRouterCollector();
    routes.registerWithRouter(router);
    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");

    const json = jest.fn();
    const req = {
      body: {
        name: "s2",
        serverType: "server",
        udpPort: 4500,
        secretKey: "abcdefghijklmnopqrstuvwxyz123456"
      },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Duplicate server ports are not allowed: 4500" });
    expect(restart).not.toHaveBeenCalled();
  });

  test("PUT /instances/:id rejects empty patch payloads", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "base";

    const pluginRef = {
      _restartPlugin: jest.fn().mockResolvedValue(undefined),
      _currentOptions: {
        connections: [
          {
            name: "base",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "base" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "put" && r.path === "/instances/:id");
    const json = jest.fn();
    const req = {
      params: { id: "base" },
      body: {},
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Request body must include at least one field to update"
    });
    expect(pluginRef._restartPlugin).not.toHaveBeenCalled();
  });

  test("DELETE /instances/:id rejects deleting the last configured instance", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.name = "solo";

    const pluginRef = {
      _restartPlugin: jest.fn().mockResolvedValue(undefined),
      _currentOptions: {
        connections: [
          {
            name: "solo",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "solo" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "delete" && r.path === "/instances/:id");
    const json = jest.fn();
    const req = {
      params: { id: "solo" },
      headers: {},
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[1](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "At least one instance must remain configured" });
    expect(pluginRef._restartPlugin).not.toHaveBeenCalled();
  });

  test("POST /instances fails gracefully when restart handler is unavailable", async () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();

    const routes = createRoutes(
      app,
      {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      },
      {
        _currentOptions: {
          connections: [
            {
              name: "base",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }
    );

    const router = makeRouterCollector();
    routes.registerWithRouter(router);
    const route = router.routes.find((r) => r.method === "post" && r.path === "/instances");

    const json = jest.fn();
    const req = {
      body: {
        name: "new",
        serverType: "client",
        udpPort: 4447,
        secretKey: "abcdefghijklmnopqrstuvwxyz123456",
        udpAddress: "127.0.0.1",
        testAddress: "8.8.8.8",
        testPort: 53
      },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    await route.handlers[2](req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ error: "Runtime restart handler unavailable" });
  });
});

describe("status and error summary routes", () => {
  test("returns aggregated /status with recent errors", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.id = "alpha";
    bundle.name = "Alpha";
    bundle.state.instanceStatus = "Subscription error - data transmission paused";
    bundle.metricsApi.metrics.lastError = "Subscription error";
    bundle.metricsApi.metrics.lastErrorTime = 123;
    bundle.metricsApi.metrics.errorCounts = { subscription: 3, general: 1 };
    bundle.metricsApi.metrics.recentErrors = [
      { category: "subscription", message: "failed", timestamp: 111 }
    ];

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const statusRoute = router.routes.find((r) => r.method === "get" && r.path === "/status");
    expect(statusRoute).toBeDefined();

    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    statusRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        healthyInstances: 0,
        totalInstances: 1,
        instances: [
          expect.objectContaining({
            id: "alpha",
            healthy: false,
            errorCounts: { subscription: 3, general: 1 },
            recentErrors: [{ category: "subscription", message: "failed", timestamp: 111 }]
          })
        ]
      })
    );
  });

  test("includes error summaries in /metrics response", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    bundle.metricsApi.metrics.errorCounts = { general: 2, udpSend: 1 };
    bundle.metricsApi.metrics.recentErrors = [
      { category: "udpSend", message: "socket down", timestamp: 42 }
    ];

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {});
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const metricsRoute = router.routes.find((r) => r.method === "get" && r.path === "/metrics");
    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    metricsRoute.handlers[1](req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({
          errorCounts: { general: 2, udpSend: 1 }
        }),
        recentErrors: [{ category: "udpSend", message: "socket down", timestamp: 42 }]
      })
    );
  });
});

describe("monitoring alert persistence", () => {
  test("persists alert thresholds into the matching connection entry", () => {
    const thresholds = {};
    const app = {
      get: jest.fn(() => false),
      readPluginOptions: jest.fn(() => ({
        configuration: {
          connections: [
            {
              name: "alpha",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012",
              udpAddress: "127.0.0.1",
              testAddress: "8.8.8.8",
              testPort: 53,
              alertThresholds: {
                packetLoss: { warning: 0.1, critical: 0.2 }
              }
            },
            {
              name: "beta",
              serverType: "client",
              udpPort: 4447,
              secretKey: "12345678901234567890123456789012",
              udpAddress: "127.0.0.2",
              testAddress: "1.1.1.1",
              testPort: 443
            }
          ]
        }
      })),
      savePluginOptions: jest.fn((_config, cb) => cb(null)),
      error: jest.fn()
    };

    const bundle = makeBundle();
    bundle.id = "beta";
    bundle.name = "beta";
    bundle.state.options = {
      name: "beta",
      serverType: "client",
      udpPort: 4447,
      secretKey: "12345678901234567890123456789012",
      udpAddress: "127.0.0.2",
      testAddress: "1.1.1.1",
      testPort: 443,
      alertThresholds: {}
    };
    bundle.state.monitoring = {
      alertManager: {
        thresholds,
        setThreshold: jest.fn((metric, update) => {
          thresholds[metric] = { ...(thresholds[metric] || {}), ...update };
        }),
        getState: jest.fn(() => ({ thresholds, activeAlerts: {} }))
      }
    };

    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const pluginRef = {
      _currentOptions: {
        connections: [
          {
            name: "alpha",
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "beta",
            serverType: "client",
            udpPort: 4447,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      }
    };

    const routes = createRoutes(app, instanceRegistry, pluginRef);
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const route = router.routes.find((r) => r.method === "post" && r.path === "/monitoring/alerts");
    const req = {
      body: { metric: "rtt", warning: 250 },
      headers: { "content-type": "application/json" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    route.handlers[3](req, res);

    expect(app.savePluginOptions).toHaveBeenCalled();
    const savedConfig = app.savePluginOptions.mock.calls[0][0];
    expect(savedConfig.alertThresholds).toBeUndefined();
    expect(savedConfig.connections[0].alertThresholds).toEqual({
      packetLoss: { warning: 0.1, critical: 0.2 }
    });
    expect(savedConfig.connections[1].alertThresholds).toEqual({
      rtt: { warning: 250 }
    });
    expect(pluginRef._currentOptions.connections[1].alertThresholds).toEqual({
      rtt: { warning: 250 }
    });
  });
});

describe("management API token authorization", () => {
  test("rejects /instances when managementApiToken is configured and missing", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false }, query: {} };
    const json = jest.fn();
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    instancesRoute.handlers[1](req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
  });

  test("allows /instances when token is supplied via Bearer auth", () => {
    const app = { get: jest.fn(() => false), debug: jest.fn() };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const req = {
      headers: { authorization: "Bearer secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instancesRoute.handlers[1](req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
  });

  test("allows /instances with x-edge-link-token header", () => {
    const app = { get: jest.fn(() => false), debug: jest.fn() };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const req = {
      headers: { "x-edge-link-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instancesRoute.handlers[1](req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("authorized action=instances.list")
    );
  });

  test("allows /instances with legacy x-management-token header", () => {
    const app = { get: jest.fn(() => false), debug: jest.fn() };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const instancesRoute = router.routes.find((r) => r.method === "get" && r.path === "/instances");
    const req = {
      headers: { "x-management-token": "secret-token" },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false },
      query: {}
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    instancesRoute.handlers[1](req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
  });

  test("accepts valid Bearer token when x-edge-link-token is present but invalid", () => {
    const app = { get: jest.fn(() => false), debug: jest.fn() };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const statusRoute = router.routes.find((r) => r.method === "get" && r.path === "/status");
    const req = {
      headers: {
        "x-edge-link-token": "wrong-token",
        authorization: "Bearer secret-token"
      },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    statusRoute.handlers[1](req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
  });

  test("accepts first value when authorization header is provided as an array", () => {
    const app = { get: jest.fn(() => false), debug: jest.fn() };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const statusRoute = router.routes.find((r) => r.method === "get" && r.path === "/status");
    const req = {
      headers: { authorization: ["Bearer secret-token", "Bearer ignored"] },
      ip: "127.0.0.1",
      socket: {},
      app: { get: () => false }
    };
    const res = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };

    statusRoute.handlers[1](req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
  });
  test("uses SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN when plugin option is absent", () => {
    const original = process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN;
    process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN = "env-token";

    try {
      const app = { get: jest.fn(() => false), debug: jest.fn() };
      const bundle = makeBundle();
      const instanceRegistry = {
        get: jest.fn(() => bundle),
        getFirst: jest.fn(() => bundle),
        getAll: jest.fn(() => [bundle])
      };

      const routes = createRoutes(app, instanceRegistry, {});
      const router = makeRouterCollector();
      routes.registerWithRouter(router);

      const statusRoute = router.routes.find((r) => r.method === "get" && r.path === "/status");

      const reqDenied = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
      const deniedJson = jest.fn();
      const deniedRes = { json: jest.fn(), status: jest.fn(() => ({ json: deniedJson })) };
      statusRoute.handlers[1](reqDenied, deniedRes);

      expect(deniedRes.status).toHaveBeenCalledWith(401);
      expect(deniedJson).toHaveBeenCalledWith({ error: "Unauthorized management API request" });

      const reqAllowed = {
        headers: { authorization: "bearer env-token" },
        ip: "127.0.0.1",
        socket: {},
        app: { get: () => false }
      };
      const allowedRes = { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };
      statusRoute.handlers[1](reqAllowed, allowedRes);

      expect(allowedRes.json).toHaveBeenCalled();
    } finally {
      process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN = original;
    }
  });

  test("rejects /status when token configured and no token provided", () => {
    const app = { get: jest.fn(() => false) };
    const bundle = makeBundle();
    const instanceRegistry = {
      get: jest.fn(() => bundle),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const statusRoute = router.routes.find((r) => r.method === "get" && r.path === "/status");
    const req = { headers: {}, ip: "127.0.0.1", socket: {}, app: { get: () => false } };
    const json = jest.fn();
    const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

    statusRoute.handlers[1](req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
  });

  test("rejects sensitive config and control routes when token is missing", () => {
    const app = {
      get: jest.fn(() => false),
      readPluginOptions: jest.fn(() => ({
        configuration: {
          connections: [
            {
              name: "alpha",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      }))
    };
    const bundle = makeBundle();
    bundle.id = "alpha";
    bundle.name = "alpha";
    bundle.state.options = {
      name: "alpha",
      serverType: "client",
      udpPort: 4446,
      secretKey: "12345678901234567890123456789012"
    };
    bundle.state.deltaTimerFile = "delta_timer.json";
    bundle.state.subscriptionFile = "subscription.json";
    bundle.state.sentenceFilterFile = "sentence_filter.json";
    bundle.state.pipeline = {
      getBondingManager: jest.fn(() => ({
        forceFailover: jest.fn(),
        getActiveLinkName: jest.fn(() => "primary"),
        getLinkHealth: jest.fn(() => ({}))
      })),
      getCongestionControl: jest.fn(() => ({
        enableAutoMode: jest.fn(),
        getCurrentDeltaTimer: jest.fn(() => 200),
        setManualDeltaTimer: jest.fn()
      }))
    };
    bundle.state.monitoring = {
      alertManager: {
        thresholds: {},
        getState: jest.fn(() => ({ thresholds: {}, activeAlerts: {} })),
        setThreshold: jest.fn()
      },
      packetCapture: {
        getStats: jest.fn(() => ({ enabled: false, captured: 0, dropped: 0, buffered: 0 })),
        start: jest.fn(),
        stop: jest.fn(),
        exportPcap: jest.fn(() => Buffer.from("pcap"))
      }
    };

    const instanceRegistry = {
      get: jest.fn((id) => (id === "alpha" ? bundle : null)),
      getFirst: jest.fn(() => bundle),
      getAll: jest.fn(() => [bundle])
    };

    const routes = createRoutes(app, instanceRegistry, {
      _currentOptions: { managementApiToken: "secret-token" }
    });
    const router = makeRouterCollector();
    routes.registerWithRouter(router);

    const specs = [
      { method: "get", path: "/plugin-config" },
      { method: "post", path: "/plugin-config" },
      {
        method: "get",
        path: "/config/:filename",
        req: { params: { filename: "delta_timer.json" } }
      },
      {
        method: "post",
        path: "/config/:filename",
        req: { params: { filename: "delta_timer.json" }, body: {} }
      },
      {
        method: "get",
        path: "/connections/:id/config/:filename",
        req: { params: { id: "alpha", filename: "delta_timer.json" } }
      },
      {
        method: "post",
        path: "/connections/:id/config/:filename",
        req: { params: { id: "alpha", filename: "delta_timer.json" }, body: {} }
      },
      { method: "get", path: "/monitoring/alerts" },
      { method: "post", path: "/monitoring/alerts", req: { body: { metric: "rtt", warning: 1 } } },
      { method: "get", path: "/capture" },
      { method: "post", path: "/capture/start" },
      { method: "post", path: "/capture/stop" },
      { method: "get", path: "/capture/export" },
      { method: "post", path: "/delta-timer", req: { body: { value: 200 } } },
      { method: "post", path: "/bonding/failover" },
      {
        method: "post",
        path: "/connections/:id/bonding/failover",
        req: { params: { id: "alpha" } }
      }
    ];

    for (const spec of specs) {
      const route = router.routes.find(
        (entry) => entry.method === spec.method && entry.path === spec.path
      );
      expect(route).toBeDefined();

      const json = jest.fn();
      const req = {
        headers: {},
        ip: "127.0.0.1",
        socket: {},
        app: { get: () => false },
        params: {},
        query: {},
        body: {},
        ...(spec.req || {})
      };
      const res = { json: jest.fn(), status: jest.fn(() => ({ json })) };

      route.handlers[1](req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: "Unauthorized management API request" });
    }
  });
});
