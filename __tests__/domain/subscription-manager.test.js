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
jest.mock("../../lib/config-reload", () => ({
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

  describe("async subscription error callback", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("pauses transmission AND arms the retry loop", () => {
      let errorHandler;
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandler = onErr;
      });
      const { deps, state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      state.readyToSend = true;

      // signalk-server invokes the error callback asynchronously, long after
      // subscribe() returned — previously this paused the instance forever.
      errorHandler(new Error("bus error"));

      expect(state.readyToSend).toBe(false);
      expect(deps.setStatus).toHaveBeenCalledWith(
        "Subscription error - data transmission paused",
        false
      );
      expect(state.subscriptionRetryTimer).not.toBeNull();

      // The armed retry resubscribes and restores readiness.
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(state.readyToSend).toBe(true);
      expect(deps.setStatus).toHaveBeenCalledWith("Subscription restored", true);
    });

    test("does not postpone an already-scheduled retry", () => {
      let errorHandler;
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandler = onErr;
      });
      const { state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      errorHandler(new Error("first"));
      const firstTimer = state.subscriptionRetryTimer;
      expect(firstTimer).not.toBeNull();

      errorHandler(new Error("second"));
      expect(state.subscriptionRetryTimer).toBe(firstTimer);
    });

    test("repeated async errors escalate the retry backoff", () => {
      let errorHandler;
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandler = onErr;
      });
      const { processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });

      // First error → attempt 1 → 5s backoff. The retry resubscribes
      // (installing a fresh, generation-current error handler).
      errorHandler(new Error("err 1"));
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(2);

      // Second error inside the escalation window → attempt 2 → 10s backoff,
      // even though the resubscribe in between succeeded.
      errorHandler(new Error("err 2"));
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(2); // escalated delay not yet up
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(3);
    });

    test("a quiet period resets the error-retry escalation", () => {
      let errorHandler;
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandler = onErr;
      });
      const { processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });

      errorHandler(new Error("err 1"));
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(2);

      // More than 10 minutes of quiet — the next error is unrelated and
      // retries at the base 5s delay again instead of escalating.
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      errorHandler(new Error("err 2"));
      jest.advanceTimersByTime(5000);
      expect(subscribe).toHaveBeenCalledTimes(3);
    });

    test("a stale generation's late error is ignored after resubscribe", () => {
      const errorHandlers = [];
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandlers.push(onErr);
      });
      const { deps, state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      processConfig({ context: "*", subscribe: [{ path: "navigation.*" }] });
      state.readyToSend = true;

      // Late error from the FIRST (torn-down) subscription must not pause
      // or schedule a retry for its replacement.
      errorHandlers[0](new Error("late error from old subscription"));

      expect(state.readyToSend).toBe(true);
      expect(state.subscriptionRetryTimer).toBeNull();
      expect(deps.setStatus).not.toHaveBeenCalledWith(
        "Subscription error - data transmission paused",
        false
      );
    });

    test("an error after stop() is ignored", () => {
      let errorHandler;
      const subscribe = jest.fn((_sub, _unsub, onErr) => {
        errorHandler = onErr;
      });
      const { state, processConfig } = makeManager({ subscribe });

      processConfig({ context: "*", subscribe: [{ path: "*" }] });
      state.stopped = true;

      errorHandler(new Error("post-stop error"));
      expect(state.subscriptionRetryTimer).toBeNull();
    });
  });
});
