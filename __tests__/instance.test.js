"use strict";

/**
 * Tests for lib/instance.js – instance factory isolation and lifecycle
 */

// Mock external packages not available in the test environment
jest.mock("ping-monitor", () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  stop: jest.fn()
})), { virtual: true });

const { createInstance, slugify } = require("../lib/instance");

// ── slugify ───────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("lowercases and replaces spaces with dashes", () => {
    expect(slugify("Shore Server")).toBe("shore-server");
  });

  test("strips leading/trailing dashes", () => {
    expect(slugify("  my conn  ")).toBe("my-conn");
  });

  test("collapses consecutive non-alphanumeric chars", () => {
    expect(slugify("foo__bar!!baz")).toBe("foo-bar-baz");
  });

  test("falls back to 'connection' for empty string", () => {
    expect(slugify("")).toBe("connection");
  });

  test("handles numeric-only names", () => {
    expect(slugify("42")).toBe("42");
  });
});

// ── createInstance ────────────────────────────────────────────────────────

function makeMockApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn(),
    getSelfPath: jest.fn(() => "123456789"),
    handleMessage: jest.fn(),
    reportOutputMessages: jest.fn(),
    getDataDirPath: jest.fn(() => "/tmp/test-instance-" + Math.random().toString(36).slice(2)),
    subscriptionmanager: {
      subscribe: jest.fn((sub, unsubs, onError, onDelta) => {
        // store onDelta so tests can trigger it
        unsubs.push(() => {});
      })
    }
  };
}

function makeClientOptions(overrides = {}) {
  return {
    name: "test-client",
    serverType: "client",
    udpPort: 14446,
    secretKey: "abcdefghijklmnopqrstuvwxyz123456",
    protocolVersion: 1,
    udpAddress: "127.0.0.1",
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1,
    helloMessageSender: 60,
    ...overrides
  };
}

describe("createInstance", () => {
  test("returns expected API surface", () => {
    const app = makeMockApp();
    const inst = createInstance(app, makeClientOptions(), "test", "signalk-edge-link", jest.fn());
    expect(typeof inst.start).toBe("function");
    expect(typeof inst.stop).toBe("function");
    expect(typeof inst.getId).toBe("function");
    expect(typeof inst.getName).toBe("function");
    expect(typeof inst.getStatus).toBe("function");
    expect(typeof inst.getState).toBe("function");
    expect(typeof inst.getMetricsApi).toBe("function");
  });

  test("getId returns the instanceId passed in", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "my-id", "plugin", jest.fn());
    expect(inst.getId()).toBe("my-id");
  });

  test("getName returns the name from options", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions({ name: "Shore Server" }), "shore-server", "plugin", jest.fn());
    expect(inst.getName()).toBe("Shore Server");
  });

  test("getStatus returns { text, healthy } shape", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "x", "plugin", jest.fn());
    const status = inst.getStatus();
    expect(status).toHaveProperty("text");
    expect(status).toHaveProperty("healthy");
  });

  test("getState returns state object with instanceId", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "abc", "plugin", jest.fn());
    expect(inst.getState().instanceId).toBe("abc");
  });

  test("getMetricsApi returns metrics api with metrics object", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "x", "plugin", jest.fn());
    const api = inst.getMetricsApi();
    expect(api).toHaveProperty("metrics");
    expect(api.metrics).toHaveProperty("deltasSent");
  });

  test("two instances have independent state objects", () => {
    const inst1 = createInstance(makeMockApp(), makeClientOptions(), "a", "plugin", jest.fn());
    const inst2 = createInstance(makeMockApp(), makeClientOptions(), "b", "plugin", jest.fn());
    expect(inst1.getState()).not.toBe(inst2.getState());
  });

  test("two instances have independent metricsApi objects", () => {
    const inst1 = createInstance(makeMockApp(), makeClientOptions(), "a", "plugin", jest.fn());
    const inst2 = createInstance(makeMockApp(), makeClientOptions(), "b", "plugin", jest.fn());
    expect(inst1.getMetricsApi()).not.toBe(inst2.getMetricsApi());
  });

  test("two instances have independent metrics counters", () => {
    const inst1 = createInstance(makeMockApp(), makeClientOptions(), "a", "plugin", jest.fn());
    const inst2 = createInstance(makeMockApp(), makeClientOptions(), "b", "plugin", jest.fn());
    inst1.getMetricsApi().metrics.deltasSent = 42;
    expect(inst2.getMetricsApi().metrics.deltasSent).toBe(0);
  });

  test("stop marks state.stopped and state.isHealthy false", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "x", "plugin", jest.fn());
    const state = inst.getState();
    // Simulate minimal started state so stop() doesn't throw
    state.stopped = false;
    inst.stop();
    expect(state.stopped).toBe(true);
    expect(state.isHealthy).toBe(false);
  });

  test("onStatusChange callback is called when status changes", () => {
    const cb = jest.fn();
    const inst = createInstance(makeMockApp(), makeClientOptions(), "x", "plugin", cb);
    // Trigger a status update by calling stop (which sets "Stopped")
    inst.stop();
    expect(cb).toHaveBeenCalledWith("x", "Stopped");
  });

  test("state has correct initial defaults", () => {
    const inst = createInstance(makeMockApp(), makeClientOptions(), "defaults-test", "plugin", jest.fn());
    const state = inst.getState();
    expect(state.stopped).toBe(false);
    expect(state.isServerMode).toBe(false);
    expect(state.deltas).toEqual([]);
    expect(state.excludedSentences).toEqual(["GSV"]);
    expect(state.readyToSend).toBe(false);
    expect(state.configWatcherObjects).toEqual([]);
  });

  test("validates secretKey and rejects invalid key without starting", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ secretKey: "tooshort" }),
      "x",
      "plugin",
      jest.fn()
    );
    // start() should throw so Promise.all in index.js can detect startup failure
    await expect(inst.start()).rejects.toThrow(/Secret key validation failed/);
    expect(app.error).toHaveBeenCalled();
    expect(inst.getState().socketUdp).toBeNull();
  });

  test("validates udpPort and rejects invalid port without starting", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ udpPort: 80 }), // below minimum 1024
      "x",
      "plugin",
      jest.fn()
    );
    await expect(inst.start()).rejects.toThrow(/UDP port must be between/);
    expect(app.error).toHaveBeenCalled();
    expect(inst.getState().socketUdp).toBeNull();
  });
});
