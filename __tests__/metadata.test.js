"use strict";

const {
  MetaCache,
  collectSnapshot,
  extractLiveMeta,
  buildMetaEnvelope,
  splitIntoPackets,
  isLikelyUnsafePathFilter,
  resolveSelfContext
} = require("../lib/metadata");

describe("MetaCache", () => {
  test("diff returns every entry on first call", () => {
    const cache = new MetaCache();
    const entries = [
      { context: "vessels.self", path: "navigation.speedOverGround", meta: { units: "m/s" } },
      { context: "vessels.self", path: "environment.wind.speedApparent", meta: { units: "m/s" } }
    ];
    expect(cache.diff(entries)).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  test("diff returns empty array on unchanged replay", () => {
    const cache = new MetaCache();
    const entries = [
      { context: "vessels.self", path: "navigation.speedOverGround", meta: { units: "m/s" } }
    ];
    cache.diff(entries);
    expect(cache.diff(entries)).toEqual([]);
  });

  test("diff returns only changed entries on partial change", () => {
    const cache = new MetaCache();
    const initial = [
      { context: "vessels.self", path: "a", meta: { units: "m/s" } },
      { context: "vessels.self", path: "b", meta: { units: "rad" } }
    ];
    cache.diff(initial);
    const changed = cache.diff([
      { context: "vessels.self", path: "a", meta: { units: "m/s" } },
      { context: "vessels.self", path: "b", meta: { units: "deg" } }
    ]);
    expect(changed).toHaveLength(1);
    expect(changed[0].path).toBe("b");
  });

  test("diff is stable across meta-object key ordering", () => {
    const cache = new MetaCache();
    cache.diff([{ context: "vessels.self", path: "a", meta: { units: "m/s", description: "x" } }]);
    const replay = cache.diff([
      { context: "vessels.self", path: "a", meta: { description: "x", units: "m/s" } }
    ]);
    expect(replay).toEqual([]);
  });

  test("replaceAll resets the cache to exactly the supplied entries", () => {
    const cache = new MetaCache();
    cache.diff([
      { context: "vessels.self", path: "a", meta: { units: "m/s" } },
      { context: "vessels.self", path: "b", meta: { units: "rad" } }
    ]);
    cache.replaceAll([{ context: "vessels.self", path: "c", meta: { units: "deg" } }]);
    expect(cache.size()).toBe(1);
    // "a" is no longer in the cache, so sending it again should be treated as new.
    const next = cache.diff([{ context: "vessels.self", path: "a", meta: { units: "m/s" } }]);
    expect(next).toHaveLength(1);
  });
});

describe("MetaCache non-mutating helpers", () => {
  test("computeDiff returns changed entries without mutating the cache", () => {
    const cache = new MetaCache();
    const entries = [{ context: "vessels.self", path: "a", meta: { units: "m" } }];
    const changed = cache.computeDiff(entries);
    expect(changed).toHaveLength(1);
    // Cache is still empty — no side effect.
    expect(cache.size()).toBe(0);
    // A second computeDiff still reports the same entry as changed.
    expect(cache.computeDiff(entries)).toHaveLength(1);
  });

  test("commit updates the cache so subsequent diff returns []", () => {
    const cache = new MetaCache();
    const entries = [{ context: "vessels.self", path: "a", meta: { units: "m" } }];
    expect(cache.computeDiff(entries)).toHaveLength(1);
    cache.commit(entries);
    expect(cache.size()).toBe(1);
    expect(cache.diff(entries)).toEqual([]);
  });
});

describe("extractLiveMeta", () => {
  const enabled = { enabled: true, intervalSec: 300, maxPathsPerPacket: 500 };
  // Most tests pass a non-null selfContext so "vessels.self" entries
  // are normalized to the concrete URN instead of being skipped.
  const selfUrn = "vessels.urn:mrn:imo:mmsi:12345";

  test("returns [] when config is null or disabled", () => {
    const delta = {
      context: "vessels.self",
      updates: [{ meta: [{ path: "x", value: { units: "m/s" } }], values: [] }]
    };
    expect(extractLiveMeta(delta, null, selfUrn)).toEqual([]);
    expect(extractLiveMeta(delta, { enabled: false, intervalSec: 300 }, selfUrn)).toEqual([]);
  });

  test("pulls meta entries from updates[].meta[]", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [],
          meta: [
            { path: "a", value: { units: "m/s" } },
            { path: "b", value: { units: "rad" } }
          ]
        }
      ]
    };
    const entries = extractLiveMeta(delta, enabled, selfUrn);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      context: selfUrn,
      path: "a",
      meta: { units: "m/s" }
    });
  });

  test("skips malformed meta entries", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [],
          meta: [{ path: "ok", value: { units: "m/s" } }, null, { value: {} }, { path: 5 }]
        }
      ]
    };
    expect(extractLiveMeta(delta, enabled, selfUrn)).toHaveLength(1);
  });

  test("skips vessels.self entries when selfContext is not yet resolvable", () => {
    // Without a resolved self URN, emitting "vessels.self" would mismatch
    // whatever URN collectSnapshot uses for the same path — so we drop the
    // entry until resolveSelfContext returns a concrete value.
    const delta = {
      updates: [{ values: [], meta: [{ path: "a", value: { units: "m" } }] }]
    };
    expect(extractLiveMeta(delta, enabled)).toEqual([]);
    expect(extractLiveMeta(delta, enabled, null)).toEqual([]);
  });

  test("applies includePathsMatching regex", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [],
          meta: [
            { path: "navigation.position", value: { units: "deg" } },
            { path: "environment.wind.speed", value: { units: "m/s" } }
          ]
        }
      ]
    };
    const cfg = { ...enabled, includePathsMatching: "^navigation\\." };
    const entries = extractLiveMeta(delta, cfg, selfUrn);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("navigation.position");
  });

  test("invalid regex falls back to allow-all", () => {
    const delta = {
      context: "vessels.self",
      updates: [{ values: [], meta: [{ path: "a", value: { units: "m/s" } }] }]
    };
    const cfg = { ...enabled, includePathsMatching: "[unclosed" };
    expect(extractLiveMeta(delta, cfg, selfUrn)).toHaveLength(1);
  });

  test("overly-long regex falls back to allow-all (ReDoS guard)", () => {
    const delta = {
      context: "vessels.self",
      updates: [{ values: [], meta: [{ path: "a", value: { units: "m/s" } }] }]
    };
    const cfg = { ...enabled, includePathsMatching: "(a+)+".repeat(100) };
    // Would normally filter to zero matches; the length cap forces allow-all.
    expect(extractLiveMeta(delta, cfg, selfUrn)).toHaveLength(1);
  });

  test("normalizes vessels.self context to the supplied self URN", () => {
    const delta = {
      context: "vessels.self",
      updates: [{ values: [], meta: [{ path: "a", value: { units: "m" } }] }]
    };
    const entries = extractLiveMeta(delta, enabled, "vessels.urn:mrn:imo:mmsi:12345");
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toBe("vessels.urn:mrn:imo:mmsi:12345");
  });

  test("leaves other contexts untouched", () => {
    const delta = {
      context: "vessels.urn:mrn:imo:mmsi:99999",
      updates: [{ values: [], meta: [{ path: "a", value: { units: "m" } }] }]
    };
    const entries = extractLiveMeta(delta, enabled, "vessels.urn:mrn:imo:mmsi:12345");
    expect(entries[0].context).toBe("vessels.urn:mrn:imo:mmsi:99999");
  });
});

describe("collectSnapshot", () => {
  const enabled = { enabled: true, intervalSec: 300, maxPathsPerPacket: 500 };

  test("returns [] when app.signalk is not present", () => {
    const app = { debug: () => {}, error: () => {} };
    expect(collectSnapshot(app, enabled)).toEqual([]);
  });

  test("returns [] when meta is disabled", () => {
    const app = {
      debug: () => {},
      error: () => {},
      signalk: { retrieve: () => ({ vessels: {} }) }
    };
    expect(collectSnapshot(app, { enabled: false, intervalSec: 300 })).toEqual([]);
    expect(collectSnapshot(app, null)).toEqual([]);
  });

  test("walks state tree and collects all meta nodes", () => {
    const tree = {
      vessels: {
        "urn:mrn:imo:mmsi:12345": {
          navigation: {
            speedOverGround: {
              value: 5.2,
              meta: { units: "m/s", description: "Speed over ground" }
            },
            position: {
              value: { latitude: 0, longitude: 0 },
              meta: { description: "GPS position" }
            }
          }
        }
      },
      self: "urn:mrn:imo:mmsi:12345",
      version: "1.0"
    };
    const app = {
      debug: () => {},
      error: () => {},
      signalk: { retrieve: () => tree }
    };
    const entries = collectSnapshot(app, enabled);
    expect(entries).toHaveLength(2);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["navigation.position", "navigation.speedOverGround"]);
    expect(entries[0].context).toBe("vessels.urn:mrn:imo:mmsi:12345");
  });

  test("handles retrieve() throwing gracefully", () => {
    const app = {
      debug: () => {},
      error: () => {},
      signalk: {
        retrieve: () => {
          throw new Error("boom");
        }
      }
    };
    expect(collectSnapshot(app, enabled)).toEqual([]);
  });
});

describe("isLikelyUnsafePathFilter", () => {
  test("flags nested unbounded quantifiers", () => {
    expect(isLikelyUnsafePathFilter("(a+)+")).toBe(true);
    expect(isLikelyUnsafePathFilter("(.*)*")).toBe(true);
    expect(isLikelyUnsafePathFilter("(a+)*")).toBe(true);
    expect(isLikelyUnsafePathFilter("(.+)+")).toBe(true);
    expect(isLikelyUnsafePathFilter("^prefix(.+)+suffix$")).toBe(true);
  });

  test("leaves benign patterns alone", () => {
    expect(isLikelyUnsafePathFilter("^navigation\\.")).toBe(false);
    expect(isLikelyUnsafePathFilter("environment\\.wind\\..*")).toBe(false);
    expect(isLikelyUnsafePathFilter("(foo|bar)")).toBe(false);
    expect(isLikelyUnsafePathFilter("(foo)+")).toBe(false); // one quantifier only
  });
});

describe("resolveSelfContext", () => {
  test("returns concrete URN when app.getSelfPath exposes mmsi", () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      getSelfPath: (p) => (p === "" ? { mmsi: "12345" } : null)
    };
    expect(resolveSelfContext(app)).toBe("vessels.urn:mrn:imo:mmsi:12345");
  });

  test("falls back to app.signalk.retrieve().self", () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      signalk: { retrieve: () => ({ self: "urn:mrn:imo:mmsi:99999" }) }
    };
    expect(resolveSelfContext(app)).toBe("vessels.urn:mrn:imo:mmsi:99999");
  });

  test("returns null when self URN cannot be resolved", () => {
    const app = { debug: jest.fn(), error: jest.fn() };
    expect(resolveSelfContext(app)).toBeNull();
  });
});

describe("splitIntoPackets", () => {
  test("returns [] for empty input", () => {
    expect(splitIntoPackets([], 10)).toEqual([]);
  });

  test("splits into chunks of the requested size", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      context: "vessels.self",
      path: `p${i}`,
      meta: {}
    }));
    const chunks = splitIntoPackets(entries, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(3);
    expect(chunks[1]).toHaveLength(3);
    expect(chunks[2]).toHaveLength(1);
  });

  test("clamps max to at least 1", () => {
    const chunks = splitIntoPackets([{ context: "c", path: "p", meta: {} }], 0);
    expect(chunks).toHaveLength(1);
  });
});

describe("buildMetaEnvelope", () => {
  test("produces v:1 envelope with expected fields", () => {
    const env = buildMetaEnvelope(
      [{ context: "c", path: "p", meta: { units: "m" } }],
      "snapshot",
      42,
      0,
      1
    );
    expect(env).toEqual({
      v: 1,
      kind: "snapshot",
      seq: 42,
      idx: 0,
      total: 1,
      entries: [{ context: "c", path: "p", meta: { units: "m" } }]
    });
  });

  test("normalizes seq to uint32", () => {
    const env = buildMetaEnvelope([], "diff", -1, 0, 1);
    expect(env.seq).toBe(0xffffffff);
  });
});
