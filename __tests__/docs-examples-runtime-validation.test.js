"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { register } = require("../lib/routes/config");

function makeRouter() {
  const routes = { post: new Map() };
  return {
    routes,
    get() {},
    post(routePath, ...handlers) {
      routes.post.set(routePath, handlers[handlers.length - 1]);
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

describe("docs/configuration-schema examples", () => {
  test("examples pass runtime /plugin-config validation", () => {
    const router = makeRouter();
    const ctx = {
      app: {
        error: jest.fn(),
        savePluginOptions: jest.fn(),
        readPluginOptions: jest.fn(() => ({}))
      },
      rateLimitMiddleware: (_req, _res, next) => next(),
      requireJson: (_req, _res, next) => next(),
      pluginRef: {
        _restartPlugin: jest.fn(),
        schema: {}
      },
      getFirstBundle: () => null,
      getFirstClientBundle: () => null,
      getConfigFilePath: () => null,
      loadConfigFile: async () => ({}),
      saveConfigFile: async () => true
    };

    register(router, ctx);

    const pluginConfigPost = router.routes.post.get("/plugin-config");
    expect(typeof pluginConfigPost).toBe("function");

    const docsSchema = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "docs", "configuration-schema.json"), "utf8")
    );
    expect(Array.isArray(docsSchema.examples)).toBe(true);
    expect(docsSchema.examples.length).toBeGreaterThan(0);

    for (const [index, example] of docsSchema.examples.entries()) {
      const req = { body: example };
      const res = makeResponse();

      pluginConfigPost(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true
        })
      );
      expect(ctx.pluginRef._restartPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: expect.any(Array)
        })
      );

      if (res.statusCode !== 200) {
        throw new Error(`Example ${index} failed with error: ${res.body && res.body.error}`);
      }
    }
  });
});
