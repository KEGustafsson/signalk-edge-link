"use strict";

/**
 * Error-contract tests for the config routes: a throwing dependency or a
 * rejected save must produce the stable generic body, with the detail kept
 * to the server log.
 */

const mockPathDictionary = { failPaths: false };
jest.mock("../src/codec/path-dictionary", () => {
  const actual = jest.requireActual("../src/codec/path-dictionary");
  return {
    ...actual,
    getAllPaths: (...args) => {
      if (mockPathDictionary.failPaths) {
        throw new Error("streambundle unavailable: /srv/signalk/paths");
      }
      return actual.getAllPaths(...args);
    }
  };
});

const configRoutes = require("../src/routes/config");

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

function registerRoutes(overrides = {}) {
  const router = makeRouterCollector();
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    readPluginOptions: () => ({ configuration: {} }),
    ...overrides.app
  };
  configRoutes.register(router, {
    app,
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    pluginRef: overrides.pluginRef || {},
    getFirstBundle: overrides.getFirstBundle || (() => null),
    getFirstClientBundle: () => null,
    getConfigFilePath: () => null,
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    managementAuthMiddleware: () => (req, res, next) => next()
  });
  return { router, app };
}

function lastHandler(router, method, path) {
  return router.routes.find((r) => r.method === method && r.path === path).handlers.at(-1);
}

afterEach(() => {
  mockPathDictionary.failPaths = false;
});

describe("config route error contract", () => {
  test("GET /paths returns a generic 500 when the path dictionary throws", () => {
    const { router, app } = registerRoutes();
    mockPathDictionary.failPaths = true;
    const res = makeResponse();
    lastHandler(router, "get", "/paths")({ query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("streambundle unavailable"));
  });

  test("GET /plugin-schema returns a generic 500 when bundle resolution throws", () => {
    const { router, app } = registerRoutes({
      getFirstBundle: () => {
        throw new Error("registry corrupted: /srv/signalk/state");
      }
    });
    const res = makeResponse();
    lastHandler(router, "get", "/plugin-schema")({ query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("registry corrupted"));
  });

  test("POST /plugin-config returns a generic 500 when the save rejects", async () => {
    const SAVE_ERROR = "EACCES: permission denied, open '/srv/signalk/plugin-config.json'";
    const { router, app } = registerRoutes({
      app: {
        savePluginOptions: (config, cb) => cb(new Error(SAVE_ERROR))
      }
    });
    const res = makeResponse();
    await lastHandler(
      router,
      "post",
      "/plugin-config"
    )(
      {
        body: {
          connections: [
            {
              name: "primary",
              serverType: "client",
              udpPort: 4567,
              udpAddress: "127.0.0.1",
              secretKey: "12345678901234567890123456789012",
              protocolVersion: 3
            }
          ]
        }
      },
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to save configuration" });
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  test("POST /plugin-config returns a generic 500 when the restart handler rejects", async () => {
    const { router, app } = registerRoutes({
      pluginRef: {
        _restartPlugin: () => Promise.reject(new Error("ENOSPC: no space left on device"))
      }
    });
    const res = makeResponse();
    await lastHandler(
      router,
      "post",
      "/plugin-config"
    )(
      {
        body: {
          connections: [
            {
              name: "primary",
              serverType: "client",
              udpPort: 4567,
              udpAddress: "127.0.0.1",
              secretKey: "12345678901234567890123456789012",
              protocolVersion: 3
            }
          ]
        }
      },
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to save configuration" });
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
  });
});
