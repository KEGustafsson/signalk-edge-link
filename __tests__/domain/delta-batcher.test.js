"use strict";

/**
 * Unit tests for the L3 delta-batcher service in isolation.
 *
 * The batcher is driven entirely through injected dependencies (state,
 * metrics, app, options, recordError, getV1Pipeline), so these tests need no
 * real socket, pipeline, or instance. State is a plain object mutated in place,
 * exactly as the batcher expects.
 */

const { createDeltaBatcher } = require("../../lib/domain/delta-batcher");

function makeState(overrides = {}) {
  return {
    deltas: [],
    timer: false,
    batchSendInFlight: false,
    pendingRetry: null,
    stopped: false,
    readyToSend: true,
    socketRecoveryInProgress: false,
    maxDeltasPerBatch: 100,
    deltaTimer: null,
    deltaTimerTime: 1000,
    lastPacketTime: 0,
    droppedDeltaBatches: 0,
    droppedDeltaCount: 0,
    pipeline: null,
    ...overrides
  };
}

function makeMetrics() {
  return {
    droppedDeltaBatches: 0,
    droppedDeltaCount: 0,
    smartBatching: { earlySends: 0, timerSends: 0 }
  };
}

function makeDeps(overrides = {}) {
  const state = overrides.state || makeState();
  const metrics = overrides.metrics || makeMetrics();
  const sendDelta = jest.fn().mockResolvedValue(undefined);
  const packCrypt = jest.fn().mockResolvedValue(undefined);
  if (!("pipeline" in (overrides.state || {}))) {
    state.pipeline = { sendDelta };
  }
  const recordError = jest.fn();
  const app = { debug: jest.fn(), error: jest.fn() };
  const deps = {
    state,
    metrics,
    app,
    options: { secretKey: "k", udpAddress: "1.2.3.4", udpPort: 9000 },
    instanceId: "test",
    recordError,
    getV1Pipeline: () => ({ packCrypt }),
    ...overrides
  };
  return { deps, state, metrics, sendDelta, packCrypt, recordError, app };
}

describe("domain/delta-batcher", () => {
  describe("flushDeltaBatch", () => {
    test("sends buffered deltas via the v2/v3 pipeline and clears the buffer", async () => {
      const { deps, state, sendDelta } = makeDeps();
      state.deltas.push({ a: 1 }, { a: 2 });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();

      expect(sendDelta).toHaveBeenCalledTimes(1);
      expect(sendDelta).toHaveBeenCalledWith([{ a: 1 }, { a: 2 }], "k", "1.2.3.4", 9000);
      expect(state.deltas).toHaveLength(0);
      expect(state.timer).toBe(false);
      expect(state.lastPacketTime).toBeGreaterThan(0);
    });

    test("falls back to the v1 pipeline when no pipeline is configured", async () => {
      const state = makeState({ pipeline: null });
      state.deltas.push({ a: 1 });
      const { deps, packCrypt } = makeDeps({ state });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();

      expect(packCrypt).toHaveBeenCalledWith([{ a: 1 }], "k", "1.2.3.4", 9000);
      expect(state.deltas).toHaveLength(0);
    });

    test("caps each send at maxDeltasPerBatch and drains the rest via setImmediate", async () => {
      const { deps, state, sendDelta } = makeDeps();
      state.maxDeltasPerBatch = 2;
      state.deltas.push({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();
      // First send takes only the first 2; the finally block re-schedules.
      expect(sendDelta).toHaveBeenLastCalledWith([{ n: 1 }, { n: 2 }], "k", "1.2.3.4", 9000);

      // Let the setImmediate drain run to completion.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(state.deltas).toHaveLength(0);
      // 5 deltas / 2 per batch => 3 sends (2,2,1).
      expect(sendDelta).toHaveBeenCalledTimes(3);
    });

    test.each([
      ["not ready to send", { readyToSend: false }],
      ["stopped", { stopped: true }],
      ["send already in flight", { batchSendInFlight: true }],
      ["a retry is pending", { pendingRetry: setTimeout(() => {}, 10000) }],
      ["socket recovery in progress", { socketRecoveryInProgress: true }]
    ])("is a no-op when %s", async (_label, flags) => {
      const state = makeState(flags);
      state.deltas.push({ a: 1 });
      const { deps, sendDelta } = makeDeps({ state });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();

      expect(sendDelta).not.toHaveBeenCalled();
      expect(state.deltas).toHaveLength(1);
      if (state.pendingRetry) {
        clearTimeout(state.pendingRetry);
      }
    });

    test("resets timer and does nothing for an empty buffer", async () => {
      const { deps, state, sendDelta } = makeDeps();
      state.timer = true;
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();

      expect(sendDelta).not.toHaveBeenCalled();
      expect(state.timer).toBe(false);
    });
  });

  describe("flushDeltaBatch retry/back-off", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("retries once after a transient failure then succeeds", async () => {
      const sendDelta = jest
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined);
      const state = makeState({ pipeline: { sendDelta } });
      state.deltas.push({ a: 1 });
      const { deps } = makeDeps({ state });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();
      // First attempt failed and scheduled a retry; buffer untouched.
      expect(state.deltas).toHaveLength(1);
      expect(state.pendingRetry).not.toBeNull();

      await jest.advanceTimersByTimeAsync(100);

      expect(sendDelta).toHaveBeenCalledTimes(2);
      expect(state.deltas).toHaveLength(0);
    });

    test("drops the batch and records metrics after exhausting retries", async () => {
      const sendDelta = jest.fn().mockRejectedValue(new Error("persistent"));
      const state = makeState({ pipeline: { sendDelta } });
      state.deltas.push({ a: 1 }, { a: 2 });
      const { deps, metrics, recordError, app } = makeDeps({ state });
      const batcher = createDeltaBatcher(deps);

      await batcher.flushDeltaBatch();
      await jest.advanceTimersByTimeAsync(100);

      expect(state.deltas).toHaveLength(0);
      expect(state.droppedDeltaBatches).toBe(1);
      expect(state.droppedDeltaCount).toBe(2);
      expect(metrics.droppedDeltaBatches).toBe(1);
      expect(metrics.droppedDeltaCount).toBe(2);
      expect(recordError).toHaveBeenCalledWith("sendFailure", expect.stringContaining("Dropped"));
      expect(app.error).toHaveBeenCalled();
    });
  });

  describe("scheduleDeltaTimer", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("flips state.timer to true after deltaTimerTime and re-arms", () => {
      const { deps, state } = makeDeps();
      state.deltaTimerTime = 500;
      const batcher = createDeltaBatcher(deps);

      batcher.scheduleDeltaTimer();
      expect(state.timer).toBe(false);

      jest.advanceTimersByTime(500);
      expect(state.timer).toBe(true);
      expect(state.deltaTimer).not.toBeNull();
    });

    test("stops re-arming once state.stopped is set", () => {
      const { deps, state } = makeDeps();
      state.deltaTimerTime = 500;
      const batcher = createDeltaBatcher(deps);

      batcher.scheduleDeltaTimer();
      state.stopped = true;
      jest.advanceTimersByTime(500);

      expect(state.timer).toBe(false);
    });
  });
});
