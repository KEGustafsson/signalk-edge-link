"use strict";

/**
 * Unit tests for the L3 metadata-streamer service in isolation.
 *
 * collectSnapshot is mocked so snapshot content is controlled directly; the
 * MetaCache and pipeline are injected fakes. No real instance or socket.
 */

jest.mock("../../lib/metadata", () => {
  const actual = jest.requireActual("../../lib/metadata");
  return { ...actual, collectSnapshot: jest.fn(() => []) };
});

const { collectSnapshot } = require("../../lib/metadata");
const { createMetadataStreamer } = require("../../lib/domain/metadata-streamer");

function makeMetaCache(diffResult = []) {
  let gen = 0;
  return {
    replaceAll: jest.fn(),
    computeDiff: jest.fn(() => diffResult),
    commit: jest.fn(),
    generation: jest.fn(() => gen),
    clear: jest.fn(),
    bumpGeneration: () => {
      gen += 1;
    }
  };
}

function makeState(overrides = {}) {
  return {
    metaConfig: { enabled: true, intervalSec: 60 },
    stopped: false,
    readyToSend: true,
    metaDiffBuffer: [],
    metaDiffFlushTimer: null,
    metaTimer: null,
    metaSnapshotTimers: [],
    lastMetaRequestAt: 0,
    pipeline: null,
    ...overrides
  };
}

function makeStreamer(overrides = {}) {
  const sendMetadata = jest.fn().mockResolvedValue(undefined);
  const state = overrides.state || makeState({ pipeline: { sendMetadata } });
  const metaCache = overrides.metaCache || makeMetaCache();
  const app = { debug: jest.fn(), error: jest.fn() };
  const recordError = jest.fn();
  const deps = {
    state,
    options: { udpAddress: "1.2.3.4", udpPort: 9000, secretKey: "k" },
    app,
    appProxy: app,
    instanceId: "test",
    recordError,
    metaCache,
    ...overrides
  };
  const streamer = createMetadataStreamer(deps);
  return { streamer, state, metaCache, sendMetadata, app, recordError };
}

beforeEach(() => {
  collectSnapshot.mockReset();
  collectSnapshot.mockReturnValue([]);
});

describe("domain/metadata-streamer", () => {
  describe("sendMetadataSnapshot", () => {
    test("collects, sends a snapshot, and primes the cache on success", async () => {
      const entries = [{ context: "vessels.self", path: "nav.x", meta: { units: "m" } }];
      collectSnapshot.mockReturnValue(entries);
      const { streamer, metaCache, sendMetadata } = makeStreamer();

      await streamer.sendMetadataSnapshot();

      expect(sendMetadata).toHaveBeenCalledWith(entries, "snapshot", "k", "1.2.3.4", 9000);
      expect(metaCache.replaceAll).toHaveBeenCalledWith(entries);
    });

    test.each([
      ["meta disabled", { metaConfig: { enabled: false, intervalSec: 60 } }],
      ["stopped", { stopped: true }],
      ["not ready to send", { readyToSend: false }]
    ])("is a no-op when %s", async (_label, flags) => {
      const state = makeState({ pipeline: { sendMetadata: jest.fn() }, ...flags });
      const { streamer } = makeStreamer({ state });

      await streamer.sendMetadataSnapshot();

      expect(collectSnapshot).not.toHaveBeenCalled();
    });

    test("does not prime the cache when the pipeline cannot send metadata", async () => {
      collectSnapshot.mockReturnValue([{ context: "c", path: "p", meta: {} }]);
      const state = makeState({ pipeline: {} }); // no sendMetadata
      const { streamer, metaCache } = makeStreamer({ state });

      await streamer.sendMetadataSnapshot();

      expect(metaCache.replaceAll).not.toHaveBeenCalled();
    });
  });

  describe("enqueueMetaDiff", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("debounces, sends a diff, and commits the cache on success", async () => {
      const changed = [{ context: "c", path: "p", meta: { units: "m" } }];
      const metaCache = makeMetaCache(changed);
      const { streamer, state, sendMetadata } = makeStreamer({ metaCache });

      streamer.enqueueMetaDiff([{ context: "c", path: "p", meta: { units: "m" } }]);
      expect(state.metaDiffBuffer).toHaveLength(1);
      expect(sendMetadata).not.toHaveBeenCalled(); // still debouncing

      await jest.advanceTimersByTimeAsync(500);

      expect(sendMetadata).toHaveBeenCalledWith(changed, "diff", "k", "1.2.3.4", 9000);
      expect(metaCache.commit).toHaveBeenCalledWith(changed);
      expect(state.metaDiffFlushTimer).toBeNull();
    });

    test("empty entries are ignored", () => {
      const { streamer, state } = makeStreamer();
      streamer.enqueueMetaDiff([]);
      expect(state.metaDiffBuffer).toHaveLength(0);
      expect(state.metaDiffFlushTimer).toBeNull();
    });

    test("no diff means no send", async () => {
      const metaCache = makeMetaCache([]); // computeDiff -> []
      const { streamer, sendMetadata } = makeStreamer({ metaCache });

      streamer.enqueueMetaDiff([{ context: "c", path: "p", meta: {} }]);
      await jest.advanceTimersByTimeAsync(500);

      expect(sendMetadata).not.toHaveBeenCalled();
      expect(metaCache.commit).not.toHaveBeenCalled();
    });

    test("does not commit when the cache generation changed mid-send", async () => {
      const changed = [{ context: "c", path: "p", meta: { units: "m" } }];
      const metaCache = makeMetaCache(changed);
      // A resubscribe bumps the generation while the diff send is in flight.
      const sendMetadata = jest.fn().mockImplementation(async () => {
        metaCache.bumpGeneration();
      });
      const state = makeState({ pipeline: { sendMetadata } });
      const { streamer } = makeStreamer({ metaCache, state });

      streamer.enqueueMetaDiff([{ context: "c", path: "p", meta: { units: "m" } }]);
      await jest.advanceTimersByTimeAsync(500);

      expect(sendMetadata).toHaveBeenCalledTimes(1);
      expect(metaCache.commit).not.toHaveBeenCalled();
    });
  });

  describe("handleMetaRequest", () => {
    test("sends a snapshot then rate-limits repeats within the window", async () => {
      collectSnapshot.mockReturnValue([{ context: "c", path: "p", meta: {} }]);
      const { streamer, sendMetadata } = makeStreamer();

      streamer.handleMetaRequest();
      streamer.handleMetaRequest(); // immediately again -> suppressed
      await Promise.resolve();
      await Promise.resolve();

      expect(sendMetadata).toHaveBeenCalledTimes(1);
    });

    test("is a no-op when metadata is disabled", () => {
      const state = makeState({
        metaConfig: { enabled: false, intervalSec: 60 },
        pipeline: { sendMetadata: jest.fn() }
      });
      const { streamer } = makeStreamer({ state });

      streamer.handleMetaRequest();

      expect(collectSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("timers", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("restartMetadataTimer arms a periodic snapshot and clears when disabled", () => {
      const { streamer, state } = makeStreamer();
      streamer.restartMetadataTimer();
      expect(state.metaTimer).not.toBeNull();

      state.metaConfig = { enabled: false, intervalSec: 60 };
      streamer.restartMetadataTimer();
      expect(state.metaTimer).toBeNull();
    });

    test("scheduleMetadataSnapshot coalesces back-to-back calls into one timer", () => {
      const { streamer, state } = makeStreamer();
      streamer.scheduleMetadataSnapshot(1000);
      streamer.scheduleMetadataSnapshot(1000);
      expect(state.metaSnapshotTimers).toHaveLength(1);
    });
  });
});
