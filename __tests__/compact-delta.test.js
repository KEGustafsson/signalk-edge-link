"use strict";

const {
  encodeCompactDelta,
  encodeCompactPayload,
  decodeCompactDelta,
  decodeCompactDeltaArray,
  isCompactDeltaArray
} = require("../lib/compact-delta");

function makeDelta(
  values,
  context = "vessels.self",
  source = { label: "test" },
  timestamp = "2026-05-29T00:00:00Z"
) {
  return { context, updates: [{ source, $source: "test.0", timestamp, values }] };
}

// ── encodeCompactDelta / decodeCompactDelta round-trips ────────────────────────

describe("encodeCompactDelta", () => {
  test("encodes context in slot 0 and updates in slot 1", () => {
    const d = makeDelta([{ path: "navigation.speedOverGround", value: 7.3 }]);
    const enc = encodeCompactDelta(d);
    expect(enc[0]).toBe("vessels.self");
    expect(Array.isArray(enc[1])).toBe(true);
    expect(enc[1]).toHaveLength(1);
  });

  test("update tuple has 5 positional slots", () => {
    const d = makeDelta([{ path: "navigation.speedOverGround", value: 7.3 }]);
    const enc = encodeCompactDelta(d);
    const update = enc[1][0];
    expect(update).toHaveLength(5);
    expect(update[0]).toEqual({ label: "test" });
    expect(update[1]).toBe("test.0");
    expect(update[2]).toBe("2026-05-29T00:00:00Z");
    expect(Array.isArray(update[3])).toBe(true);
    expect(update[4]).toBeNull();
  });

  test("values are encoded as [path, value] pairs", () => {
    const d = makeDelta([
      { path: "navigation.speedOverGround", value: 7.3 },
      { path: "navigation.courseOverGroundTrue", value: 1.5 }
    ]);
    const enc = encodeCompactDelta(d);
    const values = enc[1][0][3];
    expect(values).toEqual([
      ["navigation.speedOverGround", 7.3],
      ["navigation.courseOverGroundTrue", 1.5]
    ]);
  });

  test("meta entries are encoded when present", () => {
    const d = {
      context: "vessels.self",
      updates: [
        {
          source: { label: "test" },
          timestamp: "2026-05-29T00:00:00Z",
          values: [{ path: "nav.speed", value: 1 }],
          meta: [{ path: "nav.speed", value: { units: "m/s" } }]
        }
      ]
    };
    const enc = encodeCompactDelta(d);
    const meta = enc[1][0][4];
    expect(meta).toEqual([["nav.speed", { units: "m/s" }]]);
  });

  test("null context becomes null", () => {
    const d = { updates: [{ values: [{ path: "p", value: 1 }] }] };
    const enc = encodeCompactDelta(d);
    expect(enc[0]).toBeNull();
  });

  test("absent source/timestamp become null", () => {
    const d = { context: "vessels.self", updates: [{ values: [{ path: "p", value: 1 }] }] };
    const enc = encodeCompactDelta(d);
    const update = enc[1][0];
    expect(update[0]).toBeNull();
    expect(update[1]).toBeNull();
    expect(update[2]).toBeNull();
  });
});

describe("decodeCompactDelta round-trip", () => {
  test("basic value round-trip preserves context, path, and value", () => {
    const d = makeDelta([{ path: "navigation.speedOverGround", value: 7.3 }]);
    const roundTripped = decodeCompactDelta(encodeCompactDelta(d));
    expect(roundTripped.context).toBe("vessels.self");
    expect(roundTripped.updates[0].values[0].path).toBe("navigation.speedOverGround");
    expect(roundTripped.updates[0].values[0].value).toBe(7.3);
  });

  test("multiple values in one update round-trip", () => {
    const d = makeDelta([
      { path: "navigation.speedOverGround", value: 5.0 },
      { path: "navigation.courseOverGroundTrue", value: 3.14 }
    ]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values).toHaveLength(2);
    expect(rt.updates[0].values[1].path).toBe("navigation.courseOverGroundTrue");
  });

  test("source and timestamp are preserved", () => {
    const d = makeDelta([{ path: "p", value: 42 }]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].source).toEqual({ label: "test" });
    expect(rt.updates[0].$source).toBe("test.0");
    expect(rt.updates[0].timestamp).toBe("2026-05-29T00:00:00Z");
  });

  test("meta entries survive round-trip", () => {
    const d = {
      context: "vessels.self",
      updates: [
        {
          source: { label: "test" },
          timestamp: "2026-05-29T00:00:00Z",
          values: [{ path: "nav.speed", value: 1 }],
          meta: [{ path: "nav.speed", value: { units: "m/s" } }]
        }
      ]
    };
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].meta).toEqual([{ path: "nav.speed", value: { units: "m/s" } }]);
  });

  test("object values (position) survive round-trip", () => {
    const pos = { latitude: 60.16, longitude: 24.93 };
    const d = makeDelta([{ path: "navigation.position", value: pos }]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values[0].value).toEqual(pos);
  });

  test("multiple updates in one delta round-trip", () => {
    const d = {
      context: "vessels.self",
      updates: [
        {
          source: { label: "a" },
          timestamp: "2026-05-29T00:00:00Z",
          values: [{ path: "p1", value: 1 }]
        },
        {
          source: { label: "b" },
          timestamp: "2026-05-29T00:00:01Z",
          values: [{ path: "p2", value: 2 }]
        }
      ]
    };
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates).toHaveLength(2);
    expect(rt.updates[0].values[0].path).toBe("p1");
    expect(rt.updates[1].values[0].path).toBe("p2");
  });

  test("returns null for non-array input", () => {
    expect(decodeCompactDelta(null)).toBeNull();
    expect(decodeCompactDelta("string")).toBeNull();
    expect(decodeCompactDelta({})).toBeNull();
  });

  test("returns null for array shorter than 2", () => {
    expect(decodeCompactDelta(["only-one"])).toBeNull();
  });

  test("malformed update tuples are skipped", () => {
    // A compact delta where the updates array contains a bad entry
    const encoded = ["vessels.self", [null, ["too", "short"]]];
    const rt = decodeCompactDelta(encoded);
    // Should decode without throwing; bad entries produce no updates
    expect(rt).not.toBeNull();
    expect(rt.updates).toHaveLength(0);
  });
});

// ── encodeCompactPayload ───────────────────────────────────────────────────────

describe("encodeCompactPayload", () => {
  test("single Delta is wrapped in an array", () => {
    const d = makeDelta([{ path: "p", value: 1 }]);
    const out = encodeCompactPayload(d);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBe("vessels.self");
  });

  test("Delta[] produces one compact entry per delta", () => {
    const arr = [
      makeDelta([{ path: "p1", value: 1 }], "vessels.A"),
      makeDelta([{ path: "p2", value: 2 }], "vessels.B")
    ];
    const out = encodeCompactPayload(arr);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe("vessels.A");
    expect(out[1][0]).toBe("vessels.B");
  });

  test("Record<string, Delta> produces one entry per delta", () => {
    const rec = {
      a: makeDelta([{ path: "p1", value: 1 }], "vessels.A"),
      b: makeDelta([{ path: "p2", value: 2 }], "vessels.B")
    };
    const out = encodeCompactPayload(rec);
    expect(out).toHaveLength(2);
  });
});

// ── decodeCompactDeltaArray ────────────────────────────────────────────────────

describe("decodeCompactDeltaArray", () => {
  test("decodes an array of compact deltas", () => {
    const arr = [
      makeDelta([{ path: "p1", value: 1 }], "vessels.A"),
      makeDelta([{ path: "p2", value: 2 }], "vessels.B")
    ];
    const encoded = encodeCompactPayload(arr);
    const decoded = decodeCompactDeltaArray(encoded);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].context).toBe("vessels.A");
    expect(decoded[1].context).toBe("vessels.B");
  });

  test("returns empty array for non-array input", () => {
    expect(decodeCompactDeltaArray(null)).toEqual([]);
    expect(decodeCompactDeltaArray({})).toEqual([]);
    expect(decodeCompactDeltaArray("string")).toEqual([]);
  });

  test("skips malformed entries without throwing", () => {
    const mixed = [
      encodeCompactDelta(makeDelta([{ path: "p", value: 1 }])),
      null,
      "garbage",
      encodeCompactDelta(makeDelta([{ path: "q", value: 2 }]))
    ];
    const decoded = decodeCompactDeltaArray(mixed);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].updates[0].values[0].path).toBe("p");
    expect(decoded[1].updates[0].values[0].path).toBe("q");
  });
});

// ── isCompactDeltaArray ────────────────────────────────────────────────────────

describe("isCompactDeltaArray", () => {
  test("recognizes a compact-encoded array", () => {
    const arr = encodeCompactPayload([makeDelta([{ path: "p", value: 1 }])]);
    expect(isCompactDeltaArray(arr)).toBe(true);
  });

  test("returns false for a standard Signal K delta array", () => {
    const standard = [makeDelta([{ path: "p", value: 1 }])];
    expect(isCompactDeltaArray(standard)).toBe(false);
  });

  test("returns false for empty array", () => {
    expect(isCompactDeltaArray([])).toBe(false);
  });

  test("returns false for null/undefined/string", () => {
    expect(isCompactDeltaArray(null)).toBe(false);
    expect(isCompactDeltaArray(undefined)).toBe(false);
    expect(isCompactDeltaArray("string")).toBe(false);
  });

  test("returns false for an array of primitives", () => {
    expect(isCompactDeltaArray([1, 2, 3])).toBe(false);
  });

  test("returns false for a 1-element array that is an array with non-array slot 1", () => {
    expect(isCompactDeltaArray([["ctx", "not-an-array"]])).toBe(false);
  });
});

// ── Full end-to-end encode → decode round-trip via payload helpers ─────────────

describe("encode/decode payload round-trip", () => {
  test("payload array round-trips correctly", () => {
    const deltas = [
      makeDelta([{ path: "navigation.speedOverGround", value: 6.2 }], "vessels.self"),
      makeDelta([{ path: "navigation.courseOverGroundTrue", value: 1.57 }], "vessels.self")
    ];
    const encoded = encodeCompactPayload(deltas);
    const decoded = decodeCompactDeltaArray(encoded);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].updates[0].values[0].value).toBe(6.2);
    expect(decoded[1].updates[0].values[0].value).toBe(1.57);
  });

  test("null values survive round-trip", () => {
    const d = makeDelta([{ path: "p", value: null }]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values[0].value).toBeNull();
  });

  test("boolean values survive round-trip", () => {
    const d = makeDelta([{ path: "p", value: true }]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values[0].value).toBe(true);
  });

  test("zero numeric value survives round-trip", () => {
    const d = makeDelta([{ path: "p", value: 0 }]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values[0].value).toBe(0);
  });

  test("empty values array produces empty update", () => {
    const d = makeDelta([]);
    const rt = decodeCompactDelta(encodeCompactDelta(d));
    expect(rt.updates[0].values).toHaveLength(0);
  });
});
