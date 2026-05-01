"use strict";

const { validateRuntimeConfigBody } = require("../src/routes/config-validation");
const configRoutes = require("../src/routes/config");
const connectionsRoutes = require("../src/routes/connections");

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
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

function registerLegacyConfigPostHandler() {
  const router = makeRouterCollector();
  const clientBundle = {
    state: {
      isServerMode: false,
      deltaTimerFile: "/tmp/delta_timer.json",
      subscriptionFile: "/tmp/subscription.json",
      sentenceFilterFile: "/tmp/sentence_filter.json"
    }
  };

  configRoutes.register(router, {
    app: {},
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    pluginRef: {},
    getFirstBundle: () => clientBundle,
    getFirstClientBundle: () => clientBundle,
    getConfigFilePath: (state, filename) =>
      state &&
      state[
        {
          "delta_timer.json": "deltaTimerFile",
          "subscription.json": "subscriptionFile",
          "sentence_filter.json": "sentenceFilterFile"
        }[filename]
      ],
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    managementAuthMiddleware: () => (req, res, next) => next()
  });

  return router.routes
    .find((route) => route.method === "post" && route.path === "/config/:filename")
    .handlers.at(-1);
}

function makeValidClient(overrides = {}) {
  return {
    name: "alpha",
    serverType: "client",
    udpPort: 4567,
    udpAddress: "192.168.1.1",
    secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#",
    testAddress: "192.168.1.1",
    testPort: 80,
    protocolVersion: 2,
    ...overrides
  };
}

function registerPluginConfigPostHandler() {
  const router = makeRouterCollector();
  const pluginRef = {
    _currentOptions: {},
    _restartPlugin: jest.fn()
  };
  const app = {
    readPluginOptions: jest.fn(() => ({ configuration: {} })),
    savePluginOptions: jest.fn(),
    error: jest.fn()
  };
  const clientBundle = {
    state: {
      isServerMode: false,
      deltaTimerFile: "/tmp/delta_timer.json",
      subscriptionFile: "/tmp/subscription.json",
      sentenceFilterFile: "/tmp/sentence_filter.json"
    }
  };

  configRoutes.register(router, {
    app,
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    pluginRef,
    getFirstBundle: () => clientBundle,
    getFirstClientBundle: () => clientBundle,
    getConfigFilePath: (state, filename) =>
      state &&
      state[
        {
          "delta_timer.json": "deltaTimerFile",
          "subscription.json": "subscriptionFile",
          "sentence_filter.json": "sentenceFilterFile"
        }[filename]
      ],
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    managementAuthMiddleware: () => (req, res, next) => next()
  });

  return {
    handler: router.routes
      .find((route) => route.method === "post" && route.path === "/plugin-config")
      .handlers.at(-1),
    pluginRef
  };
}

function registerConnectionConfigPostHandler() {
  const router = makeRouterCollector();
  const bundle = {
    state: {
      isServerMode: false,
      deltaTimerFile: "/tmp/delta_timer.json",
      subscriptionFile: "/tmp/subscription.json",
      sentenceFilterFile: "/tmp/sentence_filter.json"
    }
  };

  connectionsRoutes.register(router, {
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    instanceRegistry: { getAll: () => [] },
    getBundleById: () => bundle,
    getEffectiveNetworkQuality: () => ({}),
    getConfigFilePath: (state, filename) =>
      state &&
      state[
        {
          "delta_timer.json": "deltaTimerFile",
          "subscription.json": "subscriptionFile",
          "sentence_filter.json": "sentenceFilterFile"
        }[filename]
      ],
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    buildFullMetricsResponse: () => ({}),
    pluginRef: {},
    authorizeManagement: () => true,
    managementAuthMiddleware: () => (req, res, next) => next()
  });

  return router.routes
    .find((route) => route.method === "post" && route.path === "/connections/:id/config/:filename")
    .handlers.at(-1);
}

function registerInstancePutHandler() {
  const router = makeRouterCollector();
  const bundle = {
    id: "alpha",
    name: "alpha",
    state: {
      options: makeValidClient(),
      isServerMode: false
    }
  };
  const pluginRef = {
    _currentOptions: {
      connections: [makeValidClient()]
    },
    _restartPlugin: jest.fn()
  };

  connectionsRoutes.register(router, {
    rateLimitMiddleware: (req, res, next) => next(),
    requireJson: (req, res, next) => next(),
    instanceRegistry: { getAll: () => [bundle] },
    getBundleById: (id) => (id === "alpha" ? bundle : null),
    getEffectiveNetworkQuality: () => ({}),
    getConfigFilePath: (state, filename) =>
      state &&
      state[
        {
          "delta_timer.json": "deltaTimerFile",
          "subscription.json": "subscriptionFile",
          "sentence_filter.json": "sentenceFilterFile"
        }[filename]
      ],
    loadConfigFile: () => Promise.resolve({}),
    saveConfigFile: () => Promise.resolve(true),
    buildFullMetricsResponse: () => ({}),
    pluginRef,
    authorizeManagement: () => true,
    managementAuthMiddleware: () => (req, res, next) => next()
  });

  return {
    handler: router.routes
      .find((route) => route.method === "put" && route.path === "/instances/:id")
      .handlers.at(-1),
    pluginRef
  };
}

describe("validateRuntimeConfigBody", () => {
  test.each([
    ["delta_timer.json", { deltaTimer: 500 }],
    ["subscription.json", { subscribe: [] }],
    ["sentence_filter.json", { excludedSentences: ["GSV"] }],
    ["delta_timer.json", {}],
    ["subscription.json", {}],
    ["sentence_filter.json", {}]
  ])("accepts valid payloads for %s", (filename, body) => {
    expect(validateRuntimeConfigBody(filename, body)).toBeNull();
  });

  test.each([
    ["delta_timer.json", null, "Request body must be a JSON object"],
    ["delta_timer.json", [], "Request body must be a JSON object"],
    ["subscription.json", "bad", "Request body must be a JSON object"],
    ["delta_timer.json", { deltaTimer: 99 }, "deltaTimer must be a number between 100 and 10000"],
    [
      "delta_timer.json",
      { deltaTimer: 10001 },
      "deltaTimer must be a number between 100 and 10000"
    ],
    [
      "delta_timer.json",
      { deltaTimer: "1000" },
      "deltaTimer must be a number between 100 and 10000"
    ],
    ["subscription.json", { subscribe: {} }, "subscribe must be an array"],
    ["sentence_filter.json", { excludedSentences: {} }, "excludedSentences must be an array"]
  ])("rejects invalid payload for %s", (filename, body, expected) => {
    expect(validateRuntimeConfigBody(filename, body)).toBe(expected);
  });

  test("rejects subscribe array with non-object item", () => {
    expect(validateRuntimeConfigBody("subscription.json", { subscribe: ["not-an-object"] })).toBe(
      "subscribe[0] must be an object"
    );
  });

  test("rejects subscribe array with null item", () => {
    expect(validateRuntimeConfigBody("subscription.json", { subscribe: [null] })).toBe(
      "subscribe[0] must be an object"
    );
  });

  test("rejects subscribe array with nested array item", () => {
    expect(validateRuntimeConfigBody("subscription.json", { subscribe: [[]] })).toBe(
      "subscribe[0] must be an object"
    );
  });

  test("accepts subscribe array with valid objects", () => {
    expect(
      validateRuntimeConfigBody("subscription.json", { subscribe: [{ path: "foo" }] })
    ).toBeNull();
  });

  test("accepts subscription.json with a valid meta block", () => {
    expect(
      validateRuntimeConfigBody("subscription.json", {
        subscribe: [{ path: "*" }],
        meta: {
          enabled: true,
          intervalSec: 300,
          includePathsMatching: "^navigation\\.",
          maxPathsPerPacket: 500
        }
      })
    ).toBeNull();
  });

  test("rejects meta that is not an object", () => {
    expect(validateRuntimeConfigBody("subscription.json", { meta: "yes" })).toBe(
      "meta must be an object"
    );
    expect(validateRuntimeConfigBody("subscription.json", { meta: [] })).toBe(
      "meta must be an object"
    );
  });

  test("rejects meta.enabled that is not boolean", () => {
    expect(validateRuntimeConfigBody("subscription.json", { meta: { enabled: "yes" } })).toBe(
      "meta.enabled must be a boolean"
    );
  });

  test("rejects meta.intervalSec out of range", () => {
    expect(validateRuntimeConfigBody("subscription.json", { meta: { intervalSec: 10 } })).toBe(
      "meta.intervalSec must be a number between 30 and 86400"
    );
    expect(validateRuntimeConfigBody("subscription.json", { meta: { intervalSec: 100000 } })).toBe(
      "meta.intervalSec must be a number between 30 and 86400"
    );
  });

  test("rejects meta.maxPathsPerPacket out of range", () => {
    expect(validateRuntimeConfigBody("subscription.json", { meta: { maxPathsPerPacket: 5 } })).toBe(
      "meta.maxPathsPerPacket must be a number between 10 and 5000"
    );
  });

  test("rejects non-string meta.includePathsMatching", () => {
    expect(
      validateRuntimeConfigBody("subscription.json", { meta: { includePathsMatching: 42 } })
    ).toBe("meta.includePathsMatching must be a string or null");
  });

  test("accepts meta.includePathsMatching === null", () => {
    expect(
      validateRuntimeConfigBody("subscription.json", {
        meta: { enabled: true, includePathsMatching: null }
      })
    ).toBeNull();
  });

  test("rejects meta.includePathsMatching that is too long", () => {
    const huge = "a".repeat(257);
    expect(
      validateRuntimeConfigBody("subscription.json", {
        meta: { enabled: true, includePathsMatching: huge }
      })
    ).toBe("meta.includePathsMatching must be at most 256 characters");
  });

  test("rejects nested-unbounded-quantifier ReDoS shapes at save time", () => {
    expect(
      validateRuntimeConfigBody("subscription.json", {
        meta: { enabled: true, includePathsMatching: "(a+)+" }
      })
    ).toBe(
      "meta.includePathsMatching contains a nested unbounded quantifier (ReDoS shape); refused"
    );
  });

  test("rejects meta.includePathsMatching that fails to compile", () => {
    const result = validateRuntimeConfigBody("subscription.json", {
      meta: { enabled: true, includePathsMatching: "[unterminated" }
    });
    expect(result).toMatch(/^meta\.includePathsMatching failed to compile:/);
  });

  test("rejects excludedSentences array with non-string item", () => {
    expect(validateRuntimeConfigBody("sentence_filter.json", { excludedSentences: [42] })).toBe(
      "excludedSentences[0] must be a string"
    );
  });

  test("rejects excludedSentences array with null item", () => {
    expect(validateRuntimeConfigBody("sentence_filter.json", { excludedSentences: [null] })).toBe(
      "excludedSentences[0] must be a string"
    );
  });

  test("accepts excludedSentences array with valid strings", () => {
    expect(
      validateRuntimeConfigBody("sentence_filter.json", { excludedSentences: ["GSV", "GLL"] })
    ).toBeNull();
  });
});

describe("runtime config route validation parity", () => {
  const legacyPostHandler = registerLegacyConfigPostHandler();
  const connectionPostHandler = registerConnectionConfigPostHandler();

  test.each([
    ["delta_timer.json", null],
    ["delta_timer.json", []],
    ["delta_timer.json", { deltaTimer: 42 }],
    ["subscription.json", { subscribe: {} }],
    ["sentence_filter.json", { excludedSentences: {} }]
  ])("returns identical 400 payload for bad body on %s", async (filename, body) => {
    const legacyReq = { params: { filename }, body };
    const connectionReq = { params: { id: "c1", filename }, body };

    const legacyRes = makeResponse();
    const connectionRes = makeResponse();

    await legacyPostHandler(legacyReq, legacyRes);
    await connectionPostHandler(connectionReq, connectionRes);

    expect(legacyRes.statusCode).toBe(400);
    expect(connectionRes.statusCode).toBe(400);
    expect(connectionRes.body).toEqual(legacyRes.body);
  });
});

describe("connection udpMetaPort route validation", () => {
  test("legacy plugin-config save accepts udpMetaPort", async () => {
    const { handler, pluginRef } = registerPluginConfigPostHandler();
    const req = {
      body: {
        serverType: "server",
        udpPort: 4567,
        udpMetaPort: 5001,
        secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#"
      }
    };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(pluginRef._restartPlugin).toHaveBeenCalledWith({
      connections: [expect.objectContaining({ udpMetaPort: 5001 })]
    });
  });

  test("legacy plugin-config save rejects invalid udpMetaPort", async () => {
    const { handler } = registerPluginConfigPostHandler();
    const req = {
      body: {
        serverType: "server",
        udpPort: 4567,
        udpMetaPort: 100,
        secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#"
      }
    };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: "udpMetaPort must be an integer between 1024 and 65535"
    });
  });

  test("per-connection PATCH accepts udpMetaPort", async () => {
    const { handler, pluginRef } = registerInstancePutHandler();
    const req = {
      params: { id: "alpha" },
      body: { udpMetaPort: 5001 }
    };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(pluginRef._currentOptions.connections[0].udpMetaPort).toBe(5001);
  });

  test("per-connection PATCH rejects invalid udpMetaPort", async () => {
    const { handler } = registerInstancePutHandler();
    const req = {
      params: { id: "alpha" },
      body: { udpMetaPort: 100 }
    };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "udpMetaPort must be an integer between 1024 and 65535"
    });
  });
});
