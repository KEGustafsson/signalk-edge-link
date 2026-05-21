"use strict";

/**
 * Regression test for commit 98db6d8 ("sanitize before validate in route
 * handlers"). Pins the ordering: a POST /instances body that mixes v3-
 * shaped fields with stray v1-only fields (e.g. testAddress) MUST be
 * sanitized before validateConnectionConfig sees it, otherwise the
 * validator rejects the request as "field unknown for v3" and the route
 * returns 400 instead of accepting the config.
 *
 * If this test fails, double-check that routes/connections.ts is calling
 * sanitizeConnectionConfig() before validateConnectionConfig() on both
 * the POST and PUT paths.
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
  const res = {
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
  return res;
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return route.handlers.at(-1);
}

function registerRoutes({ getCurrentConnectionsConfig, restartCapture, getBundleById }) {
  const router = makeRouterCollector();
  connectionsRoutes.register(router, {
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    instanceRegistry: { getAll: () => [] },
    getBundleById: getBundleById || (() => null),
    getEffectiveNetworkQuality: () => ({}),
    getConfigFilePath: () => null,
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    buildFullMetricsResponse: () => ({}),
    pluginRef: {
      _currentOptions: { connections: getCurrentConnectionsConfig() },
      _restartPlugin: async (config) => {
        restartCapture.lastConfig = config;
      }
    },
    authorizeManagement: () => true,
    managementAuthMiddleware: () => (req, res, next) => next(),
    app: {
      debug: () => {},
      error: () => {}
    }
  });
  return router;
}

describe("POST /instances — sanitize before validate ordering (regression for 98db6d8)", () => {
  test("accepts a v3 config that carries stray v1-only fields", async () => {
    const restartCapture = {};
    const router = registerRoutes({
      getCurrentConnectionsConfig: () => [],
      restartCapture
    });
    const handler = findHandler(router, "post", "/instances");
    const res = makeResponse();
    // v3 connection with two v1-only fields (testAddress, testPort) and
    // one v2/v3-only field (reliability). Sanitizer strips testAddress
    // and testPort because protocolVersion >= 2 doesn't use them; if
    // validation ran first, those v1-only fields would be rejected.
    await handler(
      {
        body: {
          name: "Test Connection",
          serverType: "client",
          udpPort: 4567,
          udpAddress: "127.0.0.1",
          secretKey: "12345678901234567890123456789012",
          protocolVersion: 3,
          testAddress: "leftover.from.v1",
          testPort: 80,
          reliability: { ackInterval: 100 }
        }
      },
      res
    );

    // 201 == sanitize-then-validate succeeded. 400 with "testAddress"
    // in the error message would indicate the order was flipped.
    expect(res.statusCode).toBe(201);
    // The persisted config must have v1-only fields stripped.
    const persisted = restartCapture.lastConfig;
    expect(persisted).toBeDefined();
    const persistedConn = Array.isArray(persisted.connections)
      ? persisted.connections[0]
      : persisted;
    expect(persistedConn).not.toHaveProperty("testAddress");
    expect(persistedConn).not.toHaveProperty("testPort");
    expect(persistedConn.protocolVersion).toBe(3);
  });
});

describe("PUT /instances/:id — sanitize before validate ordering (regression for 98db6d8)", () => {
  test("accepts patch that promotes v1 → v3 even with stray v1-only fields in the merged config", async () => {
    const existingConfig = {
      name: "Existing",
      serverType: "client",
      udpPort: 4567,
      udpAddress: "127.0.0.1",
      secretKey: "12345678901234567890123456789012",
      protocolVersion: 1,
      testAddress: "remains.from.v1",
      testPort: 80
    };
    const restartCapture = {};
    const router = registerRoutes({
      getCurrentConnectionsConfig: () => [existingConfig],
      getBundleById: () => ({
        id: "existing",
        name: "Existing",
        state: { instanceId: "existing", options: existingConfig }
      }),
      restartCapture
    });
    const handler = findHandler(router, "put", "/instances/:id");
    const res = makeResponse();
    // Patch promotes protocolVersion to 3. The merged config still
    // carries the legacy testAddress / testPort because the patch
    // doesn't override them. sanitize-then-validate strips them; the
    // wrong order would return 400.
    await handler(
      {
        params: { id: "existing" },
        body: { protocolVersion: 3 }
      },
      res
    );

    expect(res.statusCode).toBe(200);
    const persisted = restartCapture.lastConfig;
    expect(persisted).toBeDefined();
    const persistedConn = Array.isArray(persisted.connections)
      ? persisted.connections[0]
      : persisted;
    expect(persistedConn).not.toHaveProperty("testAddress");
    expect(persistedConn).not.toHaveProperty("testPort");
    expect(persistedConn.protocolVersion).toBe(3);
  });
});
