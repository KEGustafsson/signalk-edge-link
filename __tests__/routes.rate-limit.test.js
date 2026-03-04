"use strict";

const createRoutes = require("../lib/routes");
const { RATE_LIMIT_MAX_REQUESTS } = require("../lib/constants");

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
