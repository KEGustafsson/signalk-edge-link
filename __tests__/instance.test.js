"use strict";

/**
 * Tests for lib/instance.js – instance factory isolation and lifecycle
 */

// Mock external packages not available in the test environment
const monitorInstances = [];
jest.mock("ping-monitor", () => jest.fn().mockImplementation(() => {
  const handlers = new Map();
  const monitor = {
    on: jest.fn((event, cb) => {
      handlers.set(event, cb);
    }),
    emit: (event, payload) => {
      const cb = handlers.get(event);
      if (cb) { cb(payload); }
    },
    stop: jest.fn()
  };
  monitorInstances.push(monitor);
  return monitor;
}), { virtual: true });

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
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn(),
    getSelfPath: jest.fn(() => "123456789"),
    handleMessage: jest.fn(),
    reportOutputMessages: jest.fn(),
    getDataDirPath: jest.fn(() => "/tmp/test-instance-" + Math.random().toString(36).slice(2)),
    subscriptionmanager: {
      subscribe: jest.fn((_sub, unsubs, _onError, onDelta) => {
        app.__onDelta = onDelta;
        unsubs.push(() => {});
      })
    }
  };
  return app;
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
  beforeEach(() => {
    monitorInstances.length = 0;
  });

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


  test("marks client unhealthy when post-connectivity ping timeout elapses", async () => {
    const app = makeMockApp();
    const inst = createInstance(app, makeClientOptions(), "x", "plugin", jest.fn());

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timeoutCallbacks = [];

    global.setTimeout = jest.fn((cb) => {
      timeoutCallbacks.push(cb);
      return timeoutCallbacks.length;
    });
    global.clearTimeout = jest.fn();

    try {
      await inst.start();
      const monitor = monitorInstances[0];
      monitor.emit("up", { time: 18 });

      const before = inst.getStatus().text;
      expect(before).toBe("Connected");

      const lastTimeoutCb = timeoutCallbacks[timeoutCallbacks.length - 1];
      expect(typeof lastTimeoutCb).toBe("function");
      lastTimeoutCb();

      expect(inst.getState().isHealthy).toBe(false);
      expect(inst.getStatus().text).toBe("Connection monitor timeout");
      expect(inst.getState().readyToSend).toBe(false);
    } finally {
      inst.stop();
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  test("marks client unhealthy on monitor down/timeout/error events", async () => {
    const app = makeMockApp();
    const inst = createInstance(app, makeClientOptions(), "x", "plugin", jest.fn());

    await inst.start();

    const monitor = monitorInstances[0];
    expect(monitor).toBeDefined();

    monitor.emit("up", { time: 22 });
    expect(inst.getState().isHealthy).toBe(true);

    monitor.emit("down");
    expect(inst.getState().isHealthy).toBe(false);
    expect(inst.getStatus().text).toContain("Connection monitor: down");

    monitor.emit("error", { message: "simulated" });
    expect(inst.getState().isHealthy).toBe(false);
    expect(inst.getStatus().text).toContain("Connection monitor error");

    inst.stop();
  });
  test("retries one failed batch then drops it with explicit metrics", async () => {
    jest.useFakeTimers();
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "retry-test",
      "plugin",
      jest.fn()
    );

    try {
      await inst.start();
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const state = inst.getState();
      const metrics = inst.getMetricsApi().metrics;
      state.readyToSend = true;
      state.maxDeltasPerBatch = 1;

      const sendError = new Error("forced UDP send failure");
      state.pipeline.sendDelta = jest.fn()
        .mockRejectedValueOnce(sendError)
        .mockRejectedValueOnce(sendError);

      state.processDelta({
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1.2 }] }]
      });

      await Promise.resolve();
      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(1);
      expect(state.deltas.length).toBe(1);

      await jest.advanceTimersByTimeAsync(100);

      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(2);
      expect(state.deltas.length).toBe(0);
      expect(metrics.droppedDeltaBatches).toBe(1);
      expect(metrics.droppedDeltaCount).toBe(1);
      expect(metrics.errorCounts.sendFailure).toBeGreaterThan(0);
      expect(app.error).toHaveBeenCalledWith(expect.stringContaining("Dropped delta batch"));
    } finally {
      inst.stop();
      jest.useRealTimers();
    }
  });

});
