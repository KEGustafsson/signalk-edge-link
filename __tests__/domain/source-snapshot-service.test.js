"use strict";

/**
 * Unit tests for the L3 source/values snapshot service in isolation.
 *
 * collectSourceSnapshot / collectValuesSnapshot are mocked so snapshot content
 * is controlled directly; the pipeline, app, and processDelta are injected
 * fakes. No real instance or socket.
 */

jest.mock("../../lib/source-snapshot", () => ({ collectSourceSnapshot: jest.fn(() => ({})) }));
jest.mock("../../lib/values-snapshot", () => ({ collectValuesSnapshot: jest.fn(() => []) }));

const { collectSourceSnapshot } = require("../../lib/source-snapshot");
const { collectValuesSnapshot } = require("../../lib/values-snapshot");
const { createSourceSnapshotService } = require("../../lib/domain/source-snapshot-service");

function makeState(overrides = {}) {
  return {
    stopped: false,
    readyToSend: true,
    pipeline: null,
    processDelta: null,
    sourceSnapshotTimer: null,
    lastFullStatusRequestAt: 0,
    ...overrides
  };
}

function makeService(overrides = {}) {
  const sendSourceSnapshotFn = jest.fn().mockResolvedValue(undefined);
  const state =
    overrides.state || makeState({ pipeline: { sendSourceSnapshot: sendSourceSnapshotFn } });
  const metrics = overrides.metrics || {};
  const app = { debug: jest.fn(), error: jest.fn() };
  const cascade = overrides.cascade || null;
  const deps = {
    state,
    options: {
      secretKey: "k",
      udpAddress: "1.2.3.4",
      udpPort: 9000,
      protocolVersion: 3
    },
    app,
    appProxy: app,
    instanceId: "test",
    metrics,
    getFullStatusCascadeHandler: () => cascade,
    ...overrides
  };
  const service = createSourceSnapshotService(deps);
  return { service, state, metrics, app, sendSourceSnapshotFn };
}

beforeEach(() => {
  collectSourceSnapshot.mockReset().mockReturnValue({});
  collectValuesSnapshot.mockReset().mockReturnValue([]);
});

describe("domain/source-snapshot-service", () => {
  describe("sendSourceSnapshot", () => {
    test("collects and sends the source registry via the pipeline", async () => {
      collectSourceSnapshot.mockReturnValue({ "navigation.x": { value: "GPS" } });
      const { service, sendSourceSnapshotFn } = makeService();

      await service.sendSourceSnapshot();

      expect(sendSourceSnapshotFn).toHaveBeenCalledWith(
        { "navigation.x": { value: "GPS" } },
        "k",
        "1.2.3.4",
        9000
      );
    });

    test("does nothing for an empty source set", async () => {
      collectSourceSnapshot.mockReturnValue({});
      const { service, sendSourceSnapshotFn } = makeService();

      await service.sendSourceSnapshot();

      expect(sendSourceSnapshotFn).not.toHaveBeenCalled();
    });

    test.each([
      ["stopped", { stopped: true }],
      ["not ready", { readyToSend: false }],
      ["no pipeline", { pipeline: null }],
      ["pipeline lacks sendSourceSnapshot", { pipeline: {} }]
    ])("is a no-op when %s", async (_label, flags) => {
      collectSourceSnapshot.mockReturnValue({ a: 1 });
      const base = { pipeline: { sendSourceSnapshot: jest.fn() } };
      const state = makeState({ ...base, ...flags });
      const { service } = makeService({ state });

      await service.sendSourceSnapshot();

      expect(collectSourceSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("replayValuesSnapshot", () => {
    test("feeds collected deltas through state.processDelta and records metrics", async () => {
      const deltas = [{ d: 1 }, { d: 2 }, { d: 3 }];
      collectValuesSnapshot.mockReturnValue(deltas);
      const processDelta = jest.fn();
      const state = makeState({ processDelta });
      const { service, metrics } = makeService({ state });

      service.replayValuesSnapshot("initial subscribe");
      // Drain the setImmediate chunk pump.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(processDelta).toHaveBeenCalledTimes(3);
      expect(metrics.snapshotsReplayed.initialSubscribe).toBe(1);
      expect(metrics.snapshotReplayDeltas).toBe(3);
    });

    test.each([
      ["stopped", { stopped: true }],
      ["not ready", { readyToSend: false }],
      ["no processDelta", { processDelta: null }]
    ])("is a no-op when %s", (_label, flags) => {
      collectValuesSnapshot.mockReturnValue([{ d: 1 }]);
      const state = makeState({ processDelta: jest.fn(), ...flags });
      const { service } = makeService({ state });

      service.replayValuesSnapshot("socket recovery");

      expect(collectValuesSnapshot).not.toHaveBeenCalled();
    });

    test("empty snapshot records nothing", () => {
      collectValuesSnapshot.mockReturnValue([]);
      const processDelta = jest.fn();
      const state = makeState({ processDelta });
      const { service, metrics } = makeService({ state });

      service.replayValuesSnapshot("initial subscribe");

      expect(processDelta).not.toHaveBeenCalled();
      expect(metrics.snapshotsReplayed).toBeUndefined();
    });
  });

  describe("handleFullStatusRequest", () => {
    test("replays, fires the cascade handler, and counts it", () => {
      collectValuesSnapshot.mockReturnValue([{ d: 1 }]);
      const cascade = jest.fn();
      const processDelta = jest.fn();
      const state = makeState({ processDelta });
      const { service, metrics } = makeService({ state, cascade });

      service.handleFullStatusRequest();

      expect(cascade).toHaveBeenCalledTimes(1);
      expect(metrics.fullStatusCascadeFired).toBe(1);
    });

    test("rate-limits repeats within the window", () => {
      const cascade = jest.fn();
      const state = makeState({ processDelta: jest.fn() });
      const { service } = makeService({ state, cascade });

      service.handleFullStatusRequest();
      service.handleFullStatusRequest();

      expect(cascade).toHaveBeenCalledTimes(1);
    });
  });

  describe("restartSourceSnapshotTimer", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("does not arm a timer for protocol < 2", () => {
      const state = makeState();
      const { service } = makeService({
        state,
        options: { protocolVersion: 1, secretKey: "k", udpAddress: "1.2.3.4", udpPort: 9000 }
      });

      service.restartSourceSnapshotTimer();

      expect(state.sourceSnapshotTimer).toBeNull();
    });

    test("arms a periodic timer for protocol >= 2", () => {
      const { service, state } = makeService();
      service.restartSourceSnapshotTimer();
      expect(state.sourceSnapshotTimer).not.toBeNull();
    });
  });
});
