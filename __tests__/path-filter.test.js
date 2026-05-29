"use strict";

const { isPathAllowed, filterDelta, filterDeltaPayload } = require("../lib/delta-sanitizer");

function makeDelta(values, context = "vessels.self") {
  return {
    context,
    updates: [{ source: { label: "test" }, timestamp: "2026-05-29T00:00:00Z", values }]
  };
}

// ── isPathAllowed ─────────────────────────────────────────────────────────────

describe("isPathAllowed", () => {
  describe("no rules (empty config)", () => {
    test("allows everything when config is empty", () => {
      expect(isPathAllowed("navigation.speedOverGround", {})).toBe(true);
      expect(isPathAllowed("anything", {})).toBe(true);
    });
    test("allows everything when allow/deny arrays are empty", () => {
      expect(isPathAllowed("navigation.speed", { allow: [], deny: [] })).toBe(true);
    });
  });

  describe("allow list", () => {
    const cfg = { allow: ["navigation.*", "environment.depth.belowKeel"] };

    test("passes paths matching an allow pattern", () => {
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(true);
      expect(isPathAllowed("navigation.courseOverGroundTrue", cfg)).toBe(true);
      expect(isPathAllowed("environment.depth.belowKeel", cfg)).toBe(true);
    });

    test("blocks paths not matching any allow pattern", () => {
      expect(isPathAllowed("environment.outside.temperature", cfg)).toBe(false);
      expect(isPathAllowed("propulsion.main.revolutions", cfg)).toBe(false);
    });

    test("wildcard * allows all paths", () => {
      const all = { allow: ["*"] };
      expect(isPathAllowed("any.path.here", all)).toBe(true);
    });
  });

  describe("deny list", () => {
    const cfg = { deny: ["networking.*", "sensors.internal.*"] };

    test("blocks paths matching a deny pattern", () => {
      expect(isPathAllowed("networking.edgeLink.rtt", cfg)).toBe(false);
      expect(isPathAllowed("sensors.internal.cpu", cfg)).toBe(false);
    });

    test("passes paths not matching any deny pattern", () => {
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(true);
      expect(isPathAllowed("environment.outside.temperature", cfg)).toBe(true);
    });
  });

  describe("allow + deny combined", () => {
    const cfg = {
      allow: ["navigation.*"],
      deny: ["navigation.edgeLink.*"]
    };

    test("allow-then-deny: passes allowed but not denied", () => {
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(true);
    });

    test("allow-then-deny: deny overrides allow for matching paths", () => {
      expect(isPathAllowed("navigation.edgeLink.test", cfg)).toBe(false);
    });

    test("deny blocks paths that would fail allow anyway", () => {
      expect(isPathAllowed("environment.outside.temperature", cfg)).toBe(false);
    });
  });

  describe("glob patterns", () => {
    test("exact match", () => {
      const cfg = { allow: ["navigation.speedOverGround"] };
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(true);
      expect(isPathAllowed("navigation.speed", cfg)).toBe(false);
      expect(isPathAllowed("navigation.speedOverGroundXXX", cfg)).toBe(false);
    });

    test("prefix glob matches all children", () => {
      const cfg = { allow: ["navigation.*"] };
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(true);
      expect(isPathAllowed("navigation.position.latitude", cfg)).toBe(true);
      expect(isPathAllowed("navigation", cfg)).toBe(false); // exact parent doesn't match
      expect(isPathAllowed("navigations.speed", cfg)).toBe(false);
    });

    test("nested prefix glob", () => {
      const cfg = { allow: ["navigation.position.*"] };
      expect(isPathAllowed("navigation.position.latitude", cfg)).toBe(true);
      expect(isPathAllowed("navigation.position.longitude", cfg)).toBe(true);
      expect(isPathAllowed("navigation.speedOverGround", cfg)).toBe(false);
    });
  });
});

// ── filterDelta ────────────────────────────────────────────────────────────────

describe("filterDelta", () => {
  test("returns original reference when nothing is filtered", () => {
    const d = makeDelta([{ path: "navigation.speedOverGround", value: 7.3 }]);
    const out = filterDelta(d, { allow: ["navigation.*"] });
    expect(out).toBe(d); // identity: no allocation
  });

  test("removes paths not in allow list", () => {
    const d = makeDelta([
      { path: "navigation.speedOverGround", value: 7.3 },
      { path: "environment.outside.temperature", value: 18 }
    ]);
    const out = filterDelta(d, { allow: ["navigation.*"] });
    expect(out).not.toBeNull();
    expect(out.updates[0].values).toHaveLength(1);
    expect(out.updates[0].values[0].path).toBe("navigation.speedOverGround");
  });

  test("returns null when all values filtered out", () => {
    const d = makeDelta([{ path: "environment.outside.temperature", value: 18 }]);
    expect(filterDelta(d, { allow: ["navigation.*"] })).toBeNull();
  });

  test("removes denied paths", () => {
    const d = makeDelta([
      { path: "navigation.speedOverGround", value: 7.3 },
      { path: "networking.edgeLink.rtt", value: 45 }
    ]);
    const out = filterDelta(d, { deny: ["networking.*"] });
    expect(out).not.toBeNull();
    expect(out.updates[0].values).toHaveLength(1);
    expect(out.updates[0].values[0].path).toBe("navigation.speedOverGround");
  });

  test("returns null when all values are denied", () => {
    const d = makeDelta([{ path: "networking.edgeLink.rtt", value: 45 }]);
    expect(filterDelta(d, { deny: ["networking.*"] })).toBeNull();
  });

  test("update with no values is dropped", () => {
    const d = {
      context: "vessels.self",
      updates: [
        { source: { label: "a" }, values: [{ path: "networking.test", value: 1 }] },
        { source: { label: "b" }, values: [{ path: "navigation.speed", value: 2 }] }
      ]
    };
    const out = filterDelta(d, { deny: ["networking.*"] });
    expect(out).not.toBeNull();
    expect(out.updates).toHaveLength(1); // only the navigation update survived
    expect(out.updates[0].values[0].path).toBe("navigation.speed");
  });

  test("null returns null (guard)", () => {
    expect(filterDelta({ context: "v", updates: null }, { deny: ["*"] })).toBeNull();
  });
});

// ── filterDeltaPayload ─────────────────────────────────────────────────────────

describe("filterDeltaPayload — no-op cases", () => {
  test("null/undefined config passes through", () => {
    const d = makeDelta([{ path: "p", value: 1 }]);
    expect(filterDeltaPayload(d, null)).toBe(d);
    expect(filterDeltaPayload(d, undefined)).toBe(d);
  });

  test("empty config (no allow/deny) passes through", () => {
    const d = makeDelta([{ path: "p", value: 1 }]);
    expect(filterDeltaPayload(d, {})).toBe(d);
    expect(filterDeltaPayload(d, { allow: [], deny: [] })).toBe(d);
  });
});

describe("filterDeltaPayload — Delta shape", () => {
  test("filters a single Delta", () => {
    const d = makeDelta([
      { path: "navigation.speedOverGround", value: 7.3 },
      { path: "networking.rtt", value: 45 }
    ]);
    const out = filterDeltaPayload(d, { deny: ["networking.*"] });
    expect(out.updates[0].values).toHaveLength(1);
  });

  test("returns null when entire Delta filtered", () => {
    const d = makeDelta([{ path: "networking.rtt", value: 45 }]);
    expect(filterDeltaPayload(d, { allow: ["navigation.*"] })).toBeNull();
  });
});

describe("filterDeltaPayload — Delta[] shape", () => {
  test("filters deltas in an array", () => {
    const arr = [
      makeDelta([{ path: "navigation.speed", value: 7 }]),
      makeDelta([{ path: "networking.rtt", value: 45 }])
    ];
    const out = filterDeltaPayload(arr, { allow: ["navigation.*"] });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].updates[0].values[0].path).toBe("navigation.speed");
  });

  test("returns null when all deltas in array are filtered", () => {
    const arr = [
      makeDelta([{ path: "networking.rtt", value: 45 }]),
      makeDelta([{ path: "networking.jitter", value: 5 }])
    ];
    expect(filterDeltaPayload(arr, { allow: ["navigation.*"] })).toBeNull();
  });
});

describe("filterDeltaPayload — Record<string, Delta> shape", () => {
  test("filters entries in a record", () => {
    const rec = {
      a: makeDelta([{ path: "navigation.speed", value: 7 }]),
      b: makeDelta([{ path: "networking.rtt", value: 45 }])
    };
    const out = filterDeltaPayload(rec, { deny: ["networking.*"] });
    expect(typeof out).toBe("object");
    expect("a" in out).toBe(true);
    expect("b" in out).toBe(false);
  });

  test("returns null when all record entries are filtered", () => {
    const rec = {
      a: makeDelta([{ path: "networking.rtt", value: 45 }])
    };
    expect(filterDeltaPayload(rec, { allow: ["navigation.*"] })).toBeNull();
  });
});

// ── Integration: deny networking data ─────────────────────────────────────────

describe("integration: deny networking paths in a mixed delta", () => {
  test("only navigation and environment paths survive", () => {
    const d = {
      context: "vessels.self",
      updates: [
        {
          source: { label: "test" },
          timestamp: "2026-05-29T00:00:00Z",
          values: [
            { path: "navigation.speedOverGround", value: 7.3 },
            { path: "navigation.courseOverGroundTrue", value: 3.14 },
            { path: "environment.depth.belowKeel", value: 12.5 },
            { path: "networking.edgeLink.rtt", value: 45 },
            { path: "networking.edgeLink.jitter", value: 3 },
            { path: "networking.edgeLink.packetLoss", value: 0.02 }
          ]
        }
      ]
    };
    const out = filterDelta(d, { deny: ["networking.*"] });
    expect(out).not.toBeNull();
    const paths = out.updates[0].values.map((v) => v.path);
    expect(paths).toEqual([
      "navigation.speedOverGround",
      "navigation.courseOverGroundTrue",
      "environment.depth.belowKeel"
    ]);
  });
});
