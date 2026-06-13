"use strict";

/**
 * Unit tests for the L3 subscription-manager service in isolation.
 *
 * createDebouncedConfigHandler is mocked so the test can capture the
 * processConfig callback and drive the (re)subscribe choreography directly,
 * with no real file watching. All collaborators (subscribe, metaCache, the
 * metadata/snapshot callbacks) are injected fakes.
 */

let capturedOpts;
jest.mock("../../lib/config-watcher", () => ({
  createDebouncedConfigHandler: jest.fn((opts) => {
    capturedOpts = opts;
    const fn = jest.fn();
    fn.flush = jest.fn();
    return fn;
  })
}));

const { createSubscriptionManager } = require("../../lib/domain/subscription-manager");

function makeState(overrides = {}) {
  return {
    subscriptionFile: "/tmp/subscription.json",
    localSubscription: null,
    unsubscribes: [],
    subscribing: false,
    readyToSend: false,
    stopped: false,
    metaConfig: null,
    pendingMetaConfig: undefined,
    subscriptionRetryTimer: null,
    configDebounceTimers: {},
    configContentHashes: {},
    ...overrides
  };
}

function makeManager(overrides = {}) {
  capturedOpts = undefined;
  const state = overrides.state || makeState();
  const subscribe = overrides.subscribe || jest.fn();
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    subscriptionmanager: { subscribe }
  };
  const deps = {
    state,
    app,
    instanceId: "test",
    recordError: jest.fn(),
    processDelta: jest.fn(),
    setStatus: jest.fn(),
    metaCache: { clear: jest.fn() },
    parseMetaConfig: jest.fn(() => ({ enabled: true, intervalSec: 60 })),
    restartMetadataTimer: jest.fn(),
    scheduleMetadataSnapshot: jest.fn(),
    replayValuesSnapshot: jest.fn(),
    ...overrides
  };
  const manager = createSubscriptionManager(deps);
  return { manager, deps, state, app, subscribe, processConfig: capturedOpts.processConfig };
}

describe("domain/subscription-manager", () => {
  describe("(re)subscribe choreography", () => {
    test("tears down old listeners, subscribes, commits meta, and replays", () => {
      const oldUnsub = jest.fn();
      const state = makeState({ unsubscribes: [oldUnsub] });
      const { deps, processConfig, subscribe } = makeManager({ state });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });

      expect(oldUnsub).toHaveBeenCalledTimes(1); // previous listener torn down first
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(state.metaConfig).toEqual({ enabled: true, intervalSec: 60 });
      expect(deps.restartMetadataTimer).toHaveBeenCalledTimes(1);
      expect(deps.metaCache.clear).toHaveBeenCalledTimes(1);
      expect(deps.scheduleMetadataSnapshot).toHaveBeenCalledWith(2000);
      expect(deps.replayValuesSnapshot).toHaveBeenCalledWith("initial subscribe");
    });

    test("normalises the subscription config (dedupes duplicate paths)", () => {
      const { state, processConfig, subscribe } = makeManager();

      processConfig({
        context: "*",
        subscribe: [{ path: "nav.speed" }, { path: "nav.speed" }, { path: "nav.heading" }]
      });

      // state.localSubscription holds the normalised config the subscribe used.
      expect(state.localSubscription.subscribe).toEqual([
        { path: "nav.speed" },
        { path: "nav.heading" }
      ]);
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    test("collapses to the wildcard row when path='*' is present", () => {
      const { state, processConfig } = makeManager();

      processConfig({
        context: "*",
        subscribe: [{ path: "nav.speed" }, { path: "*" }]
      });

      expect(state.localSubscription.subscribe).toEqual([{ path: "*" }]);
    });
  });

  describe("delta handler generation guarding", () => {
    test("delivers while current, stops after invalidateGeneration", () => {
      let deltaHandler;
      const subscribe = jest.fn((_sub, _unsub, _onErr, handler) => {
        deltaHandler = handler;
      });
      const { manager, deps, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });

      deltaHandler({ d: 1 });
      expect(deps.processDelta).toHaveBeenCalledTimes(1);

      // A stop() bumps the generation; the stale handler must stop delivering.
      manager.invalidateGeneration();
      deltaHandler({ d: 2 });
      expect(deps.processDelta).toHaveBeenCalledTimes(1);
    });
  });

  describe("subscribe failure + retry", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("on subscribe throw: pauses, stashes meta, and schedules a retry", () => {
      const subscribe = jest.fn(() => {
        throw new Error("SK not ready");
      });
      const { deps, state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });

      expect(state.readyToSend).toBe(false);
      expect(deps.setStatus).toHaveBeenCalledWith(
        "Failed to subscribe - data transmission paused",
        false
      );
      expect(deps.recordError).toHaveBeenCalledWith(
        "subscription",
        expect.stringContaining("Failed to subscribe")
      );
      // New meta config is stashed for the retry to promote, not committed now.
      expect(state.pendingMetaConfig).toEqual({ enabled: true, intervalSec: 60 });
      expect(state.metaConfig).toBeNull();
      expect(state.subscriptionRetryTimer).not.toBeNull();
    });

    test("retry success restores readiness, promotes meta, and replays", () => {
      const subscribe = jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("SK not ready");
        })
        .mockImplementationOnce(() => {
          /* success */
        });
      const { deps, state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      expect(state.subscriptionRetryTimer).not.toBeNull();

      // Fire the first retry (5s base backoff).
      jest.advanceTimersByTime(5000);

      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(state.readyToSend).toBe(true);
      expect(deps.setStatus).toHaveBeenCalledWith("Subscription restored", true);
      expect(state.metaConfig).toEqual({ enabled: true, intervalSec: 60 });
      expect(state.pendingMetaConfig).toBeUndefined();
      expect(deps.replayValuesSnapshot).toHaveBeenCalledWith("subscription retry");
    });

    test("a stopped instance does not run a scheduled retry", () => {
      const subscribe = jest.fn(() => {
        throw new Error("SK not ready");
      });
      const { state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      state.stopped = true;
      jest.advanceTimersByTime(5000);

      expect(subscribe).toHaveBeenCalledTimes(1); // retry bailed out
    });
  });
});
