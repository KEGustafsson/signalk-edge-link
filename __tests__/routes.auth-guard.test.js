"use strict";

/**
 * Regression tests for the authorizeManagement auth-guard bug.
 *
 * Previously authorizeManagement returned res.status(401).json(...) on failure.
 * In real Express res.json() returns the Response object (truthy), so
 *   if (!authorizeManagement(req, res, action)) { return; }
 * never fired — the route handler continued executing after a 401 was sent.
 *
 * The fix: send the 401, then explicitly `return false`.
 * These tests verify that route handlers stop executing after a 401 and that
 * the mock response behaves like real Express (json() returns `this`).
 */

const createRoutes = require("../lib/routes");

function makeRouterCollector() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) { routes.push({ method: "get", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "post", path, handlers }); },
    put(path, ...handlers) { routes.push({ method: "put", path, handlers }); },
    delete(path, ...handlers) { routes.push({ method: "delete", path, handlers }); }
  };
}

function makeResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    // Returns `this` (truthy), matching real Express — the guard must not rely on a falsy return
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; }
  };
  return res;
}

function setupRoutes(tokenValue) {
  const pluginRef = { _currentOptions: { managementApiToken: tokenValue } };
  const instanceRegistry = {
    getAll: jest.fn().mockReturnValue([]),
    getFirst: jest.fn().mockReturnValue(null)
  };
  const routes = createRoutes({ debug: () => {} }, instanceRegistry, pluginRef);
  const router = makeRouterCollector();
  routes.registerWithRouter(router);
  return { router, instanceRegistry };
}

function findHandler(router, method, path) {
  const route = router.routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  // Return the last handler (skipping middleware)
  return route.handlers.at(-1);
}

describe("authorizeManagement auth guard", () => {
  const SECRET = "test-secret-token";

  test("GET /status returns 401 and does not call instanceRegistry when token is wrong", async () => {
    const { router, instanceRegistry } = setupRoutes(SECRET);
    const handler = findHandler(router, "get", "/status");

    const req = { headers: { "x-edge-link-token": "wrong-token" }, ip: "127.0.0.1" };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized management API request" });
    // Critical: handler must have stopped — downstream logic must not have run
    expect(instanceRegistry.getAll).not.toHaveBeenCalled();
  });

  test("GET /status returns 401 and does not call instanceRegistry when no token is provided", async () => {
    const { router, instanceRegistry } = setupRoutes(SECRET);
    const handler = findHandler(router, "get", "/status");

    const req = { headers: {}, ip: "127.0.0.1" };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(instanceRegistry.getAll).not.toHaveBeenCalled();
  });

  test("GET /status proceeds past auth guard when correct token is supplied", async () => {
    const { router, instanceRegistry } = setupRoutes(SECRET);
    const handler = findHandler(router, "get", "/status");

    const req = { headers: { "x-edge-link-token": SECRET }, ip: "127.0.0.1" };
    const res = makeResponse();

    await handler(req, res);

    // Auth passed — instanceRegistry.getAll should have been called (returns [] → 503)
    expect(instanceRegistry.getAll).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(401);
  });

  test("GET /status proceeds when no management token is configured (open access)", async () => {
    const { router, instanceRegistry } = setupRoutes(null);
    const handler = findHandler(router, "get", "/status");

    const req = { headers: {}, ip: "127.0.0.1" };
    const res = makeResponse();

    await handler(req, res);

    expect(instanceRegistry.getAll).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(401);
  });
});
