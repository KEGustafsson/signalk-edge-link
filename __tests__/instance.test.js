"use strict";

/**
 * Tests for lib/instance.js – instance factory isolation and lifecycle
 */

// Mock external packages not available in the test environment
const monitorInstances = [];
jest.mock("ping-monitor", () =>
  jest.fn().mockImplementation(() => {
    const handlers = new Map();
    const monitor = {
      on: jest.fn((event, cb) => {
        handlers.set(event, cb);
      }),
      emit: (event, payload) => {
        const cb = handlers.get(event);
        if (cb) {
          cb(payload);
        }
      },
      stop: jest.fn()
    };
    monitorInstances.push(monitor);
    return monitor;
  })
);

const { createInstance, slugify } = require("../lib/instance");
const path = require("path");
const EventEmitter = require("events");
const dgram = require("dgram");

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
    getDataDirPath: jest.fn(() =>
      path.join(
        process.cwd(),
        "__tests__",
        "temp",
        "test-instance-" + Math.random().toString(36).slice(2)
      )
    ),
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
    secretKey: "6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536",
    protocolVersion: 1,
    udpAddress: "127.0.0.1",
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1,
    helloMessageSender: 60,
    ...overrides
  };
}

function makeMockUdpSocket() {
  const emitter = new EventEmitter();
  const socket = {
    on: jest.fn((event, handler) => {
      emitter.on(event, handler);
      return socket;
    }),
    once: jest.fn((event, handler) => {
      emitter.once(event, handler);
      return socket;
    }),
    removeListener: jest.fn((event, handler) => {
      emitter.removeListener(event, handler);
      return socket;
    }),
    removeAllListeners: jest.fn((event) => {
      emitter.removeAllListeners(event);
      return socket;
    }),
    emit: (event, ...args) => emitter.emit(event, ...args),
    listenerCount: (event) => emitter.listenerCount(event),
    close: jest.fn(),
    bind: jest.fn(() => {
      setImmediate(() => emitter.emit("listening"));
      return socket;
    }),
    send: jest.fn((message, portOrCallback, hostOrCallback, maybeCallback) => {
      const callback =
        typeof portOrCallback === "function"
          ? portOrCallback
          : typeof hostOrCallback === "function"
            ? hostOrCallback
            : maybeCallback;
      if (typeof callback === "function") {
        callback(null, Buffer.isBuffer(message) ? message.length : 0);
      }
      return true;
    })
  };
  return socket;
}

function mockDgramSockets(sequence) {
  const created = [];
  let index = 0;
  jest.spyOn(dgram, "createSocket").mockImplementation(() => {
    const next = sequence && index < sequence.length ? sequence[index] : makeMockUdpSocket();
    index++;
    created.push(next);
    return next;
  });
  return created;
}

describe("createInstance", () => {
  beforeEach(() => {
    monitorInstances.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
    const inst = createInstance(
      makeMockApp(),
      makeClientOptions({ name: "Shore Server" }),
      "shore-server",
      "plugin",
      jest.fn()
    );
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
    const inst = createInstance(
      makeMockApp(),
      makeClientOptions(),
      "defaults-test",
      "plugin",
      jest.fn()
    );
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

  test("readyToSend is true immediately after start() for client mode (v1)", async () => {
    const app = makeMockApp();
    const inst = createInstance(app, makeClientOptions(), "x", "plugin", jest.fn());
    await inst.start();
    try {
      expect(inst.getState().readyToSend).toBe(true);
      expect(inst.getState().isHealthy).toBe(true);
    } finally {
      inst.stop();
    }
  });

  test("v1 ping-monitor events do not affect readyToSend or isHealthy", async () => {
    const app = makeMockApp();
    const inst = createInstance(app, makeClientOptions(), "x", "plugin", jest.fn());

    await inst.start();

    // v1 creates a ping-monitor (for RTT only)
    const monitor = monitorInstances[0];
    expect(monitor).toBeDefined();

    // Socket creation already set readyToSend and isHealthy
    expect(inst.getState().readyToSend).toBe(true);
    expect(inst.getState().isHealthy).toBe(true);

    // ping events no longer gate transmission or health
    monitor.emit("down");
    expect(inst.getState().readyToSend).toBe(true);
    expect(inst.getState().isHealthy).toBe(true);

    monitor.emit("error", { message: "simulated" });
    expect(inst.getState().readyToSend).toBe(true);
    expect(inst.getState().isHealthy).toBe(true);

    inst.stop();
  });

  test("v2/v3 instances do not create a ping-monitor", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "x",
      "plugin",
      jest.fn()
    );
    await inst.start();
    try {
      expect(monitorInstances).toHaveLength(0);
      expect(inst.getState().readyToSend).toBe(true);
    } finally {
      inst.stop();
    }
  });
  test("flushDeltaBatch caps each send at state.maxDeltasPerBatch (not full buffer)", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "mtu-cap-test",
      "plugin",
      jest.fn()
    );

    await inst.start();
    try {
      const state = inst.getState();
      state.readyToSend = true;
      state.maxDeltasPerBatch = 3;

      const batchSizes = [];
      state.pipeline.sendDelta = jest.fn().mockImplementation((batch) => {
        batchSizes.push(batch.length);
        return Promise.resolve();
      });

      // Pre-fill buffer with 8 raw deltas (bypassing processDelta)
      const delta = {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1.0 }] }]
      };
      for (let i = 0; i < 8; i++) {
        state.deltas.push(delta);
      }

      // processDelta triggers flush: 8 + 1 = 9 buffered, batchReady since 9 >= 3
      state.processDelta(delta);

      // Drain microtasks + setImmediate for each of the 3 batches
      for (let round = 0; round < 3; round++) {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      // Final microtask drain for the last batch
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(batchSizes.length).toBe(3); // 3 sends of 3 each
      expect(batchSizes.every((s) => s <= 3)).toBe(true); // each within maxDeltasPerBatch
      expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(9); // all 9 deltas flushed
      expect(state.deltas.length).toBe(0);
    } finally {
      inst.stop();
    }
  });

  test("recursive setImmediate drain empties full buffer in MTU-safe chunks", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "drain-loop-test",
      "plugin",
      jest.fn()
    );

    await inst.start();
    try {
      const state = inst.getState();
      state.readyToSend = true;
      state.maxDeltasPerBatch = 5;

      state.pipeline.sendDelta = jest.fn().mockResolvedValue(undefined);

      // Fill buffer with 20 deltas (4 full batches of 5)
      const delta = {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingTrue", value: 1.57 }] }]
      };
      for (let i = 0; i < 20; i++) {
        state.deltas.push(delta);
      }

      // Trigger first flush manually via processDelta
      state.processDelta(delta);

      // Drain all 5 batches (20 pre-filled + 1 from processDelta = 21 → ceil(21/5) = 5 batches)
      for (let round = 0; round < 5; round++) {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(5);
      const sentCounts = state.pipeline.sendDelta.mock.calls.map((c) => c[0].length);
      expect(sentCounts.every((n) => n <= 5)).toBe(true);
      expect(sentCounts.reduce((a, b) => a + b, 0)).toBe(21);
      expect(state.deltas.length).toBe(0);
    } finally {
      inst.stop();
    }
  });

  test("buffer overflow drops DELTA_BUFFER_DROP_RATIO oldest deltas and records metrics", async () => {
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "overflow-test",
      "plugin",
      jest.fn()
    );

    await inst.start();
    try {
      const state = inst.getState();
      const metrics = inst.getMetricsApi().metrics;
      state.readyToSend = true;
      // Block sending so the buffer doesn't drain during this test
      state.batchSendInFlight = true;

      // Fill buffer to the limit (MAX_DELTAS_BUFFER_SIZE = 1000)
      const stub = { context: "vessels.self", updates: [] };
      for (let i = 0; i < 1000; i++) {
        state.deltas.push(stub);
      }

      const delta = {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 2.0 }] }]
      };

      // processDelta sees 1000 >= 1000, drops 500 oldest, then pushes new delta → 501 remaining
      state.processDelta(delta);

      // Overflow metrics are recorded synchronously before any flush
      expect(metrics.droppedDeltaCount).toBe(500);
      expect(metrics.droppedDeltaBatches).toBe(1);
      expect(state.deltas.length).toBe(501); // 1000 - 500 + 1
      expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("Delta buffer overflow"));
    } finally {
      inst.stop();
    }
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
      state.pipeline.sendDelta = jest
        .fn()
        .mockRejectedValueOnce(sendError)
        .mockRejectedValueOnce(sendError);

      state.processDelta({
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1.2 }] }]
      });

      // Drain all pending microtask chains (sendDeltaBatch → flushDeltaBatch continuation)
      await Promise.resolve();
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

  test("pending batch retry blocks new deltas from bypassing backoff", async () => {
    jest.useFakeTimers();
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "retry-backoff-test",
      "plugin",
      jest.fn()
    );

    try {
      await inst.start();
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const state = inst.getState();
      state.readyToSend = true;
      state.maxDeltasPerBatch = 1;

      const firstDelta = {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1.2 }] }]
      };
      const secondDelta = {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingTrue", value: 1.57 }] }]
      };

      state.pipeline.sendDelta = jest
        .fn()
        .mockRejectedValueOnce(new Error("forced UDP send failure"))
        .mockResolvedValue(undefined);

      state.processDelta(firstDelta);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(1);
      expect(state.pendingRetry).not.toBeNull();

      state.processDelta(secondDelta);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(1);
      expect(state.deltas.length).toBe(2);

      await jest.advanceTimersByTimeAsync(100);

      expect(state.pipeline.sendDelta).toHaveBeenCalledTimes(2);
      expect(state.pipeline.sendDelta.mock.calls[1][0][0].updates[0].values[0].path).toBe(
        "navigation.speedOverGround"
      );
    } finally {
      inst.stop();
      jest.useRealTimers();
    }
  });

  test("cancels pending socket recovery on stop", async () => {
    jest.useFakeTimers();
    const createdSockets = mockDgramSockets();
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "socket-recovery-stop",
      "plugin",
      jest.fn()
    );

    await inst.start();
    const state = inst.getState();
    const initialSocket = createdSockets[0];

    initialSocket.emit("error", Object.assign(new Error("forced socket failure"), { code: "EIO" }));

    expect(state.socketRecoveryTimer).not.toBeNull();
    expect(state.socketRecoveryInProgress).toBe(true);
    expect(state.socketUdp).toBeNull();

    inst.stop();
    expect(state.socketRecoveryTimer).toBeNull();
    expect(state.socketRecoveryInProgress).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);

    expect(dgram.createSocket).toHaveBeenCalledTimes(1);
    expect(state.socketUdp).toBeNull();
    jest.useRealTimers();
  });

  test("does not duplicate control packet listeners after recovery", async () => {
    jest.useFakeTimers();
    const initialSocket = makeMockUdpSocket();
    const recoveredSocket = makeMockUdpSocket();
    mockDgramSockets([initialSocket, recoveredSocket, recoveredSocket]);
    const app = makeMockApp();
    const inst = createInstance(
      app,
      makeClientOptions({ protocolVersion: 2 }),
      "socket-recovery-listeners",
      "plugin",
      jest.fn()
    );

    await inst.start();
    initialSocket.emit("error", Object.assign(new Error("first failure"), { code: "EIO" }));
    await jest.advanceTimersByTimeAsync(5000);

    expect(recoveredSocket.listenerCount("message")).toBe(1);

    recoveredSocket.emit("error", Object.assign(new Error("second failure"), { code: "EIO" }));
    await jest.advanceTimersByTimeAsync(5000);

    expect(recoveredSocket.removeAllListeners).toHaveBeenCalledWith("message");
    expect(recoveredSocket.listenerCount("message")).toBe(1);

    inst.stop();
    jest.useRealTimers();
  });

  test("stop cancels timers, workers, and heartbeat handle cleanup fields", () => {
    jest.useFakeTimers();
    const inst = createInstance(
      makeMockApp(),
      makeClientOptions({ protocolVersion: 2 }),
      "cleanup-fields",
      "plugin",
      jest.fn()
    );
    const state = inst.getState();
    const heartbeatStop = jest.fn();
    const watcherClose = jest.fn();
    const pipelineStopMetrics = jest.fn();
    const pipelineStopCongestion = jest.fn();
    const pipelineStopBonding = jest.fn();
    const serverStopAck = jest.fn();
    const serverStopMetrics = jest.fn();
    const sequenceReset = jest.fn();

    state.stopped = false;
    state.subscriptionRetryTimer = setTimeout(jest.fn(), 1000);
    state.socketRecoveryTimer = setTimeout(jest.fn(), 1000);
    state.pendingRetry = setTimeout(jest.fn(), 1000);
    state.sourceSnapshotTimer = setInterval(jest.fn(), 1000);
    state.metaTimer = setInterval(jest.fn(), 1000);
    state.metaDiffFlushTimer = setTimeout(jest.fn(), 1000);
    state.metaSnapshotTimers = [setTimeout(jest.fn(), 1000)];
    state.configDebounceTimers = {
      subscriptionRetryTimer: setTimeout(jest.fn(), 1000),
      sentenceFilter: setTimeout(jest.fn(), 1000)
    };
    state.configContentHashes = { Subscription: "abc" };
    state.configWatcherObjects = [{ close: watcherClose }];
    state.heartbeatHandle = { stop: heartbeatStop };
    state.pipeline = {
      stopBonding: pipelineStopBonding,
      stopMetricsPublishing: pipelineStopMetrics,
      stopCongestionControl: pipelineStopCongestion
    };
    state.pipelineServer = {
      stopACKTimer: serverStopAck,
      stopMetricsPublishing: serverStopMetrics,
      getSequenceTracker: () => ({ reset: sequenceReset })
    };

    inst.stop();

    expect(state.subscriptionRetryTimer).toBeNull();
    expect(state.socketRecoveryTimer).toBeNull();
    expect(state.pendingRetry).toBeNull();
    expect(state.sourceSnapshotTimer).toBeNull();
    expect(state.metaTimer).toBeNull();
    expect(state.metaSnapshotTimers).toEqual([]);
    expect(state.configDebounceTimers).toEqual({});
    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    expect(watcherClose).toHaveBeenCalledTimes(1);
    expect(pipelineStopMetrics).toHaveBeenCalledTimes(1);
    expect(pipelineStopCongestion).toHaveBeenCalledTimes(1);
    expect(pipelineStopBonding).toHaveBeenCalledTimes(1);
    expect(serverStopAck).toHaveBeenCalledTimes(1);
    expect(serverStopMetrics).toHaveBeenCalledTimes(1);
    expect(sequenceReset).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
