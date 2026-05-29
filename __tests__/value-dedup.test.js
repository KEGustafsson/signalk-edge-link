"use strict";

const {
  DUP_SENTINEL,
  createValueDedupState,
  dedupDelta,
  dedupDeltaArray,
  dedupDeltaPayload,
  isDupSentinel,
  undedupDelta,
  undedupDeltaArray
} = require("../lib/value-dedup");

function makeDelta(values, context = "vessels.self") {
  return {
    context,
    updates: [{ source: { label: "test" }, timestamp: "2026-05-28T00:00:00Z", values }]
  };
}

// ── isDupSentinel ─────────────────────────────────────────────────────────────

describe("DUP_SENTINEL / isDupSentinel", () => {
  test("recognizes the sentinel object", () => {
    expect(isDupSentinel(DUP_SENTINEL)).toBe(true);
    expect(isDupSentinel({ $$: "dup" })).toBe(true);
  });

  test("rejects similar-but-different objects", () => {
    expect(isDupSentinel({ $$: "other" })).toBe(false);
    expect(isDupSentinel({ $$: "dup", extra: 1 })).toBe(false);
    expect(isDupSentinel({ otherKey: "dup" })).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isDupSentinel(null)).toBe(false);
    expect(isDupSentinel(undefined)).toBe(false);
    expect(isDupSentinel(42)).toBe(false);
    expect(isDupSentinel("dup")).toBe(false);
    expect(isDupSentinel(["$$", "dup"])).toBe(false);
  });
});

// ── Sender: dedupDelta ────────────────────────────────────────────────────────

describe("dedupDelta — sender side", () => {
  test("first occurrence of a value is sent absolute", () => {
    const state = createValueDedupState();
    const d = makeDelta([{ path: "navigation.state", value: "moored" }]);
    const out = dedupDelta(d, state);
    expect(out).toBe(d);
    expect(out.updates[0].values[0].value).toBe("moored");
  });

  test("identical follow-up is replaced with the sentinel", () => {
    const state = createValueDedupState();
    dedupDelta(makeDelta([{ path: "navigation.state", value: "moored" }]), state);
    const second = dedupDelta(makeDelta([{ path: "navigation.state", value: "moored" }]), state);
    expect(isDupSentinel(second.updates[0].values[0].value)).toBe(true);
  });

  test("change in value re-emits the absolute and re-primes the cache", () => {
    const state = createValueDedupState();
    dedupDelta(makeDelta([{ path: "navigation.state", value: "moored" }]), state);
    dedupDelta(makeDelta([{ path: "navigation.state", value: "moored" }]), state);
    const changed = dedupDelta(makeDelta([{ path: "navigation.state", value: "underway" }]), state);
    expect(changed.updates[0].values[0].value).toBe("underway");
    // Next identical → sentinel again
    const dup = dedupDelta(makeDelta([{ path: "navigation.state", value: "underway" }]), state);
    expect(isDupSentinel(dup.updates[0].values[0].value)).toBe(true);
  });

  test("contexts are independent — same path in different vessels does not collide", () => {
    const state = createValueDedupState();
    dedupDelta(makeDelta([{ path: "navigation.state", value: "X" }], "vessels.A"), state);
    const other = dedupDelta(
      makeDelta([{ path: "navigation.state", value: "X" }], "vessels.B"),
      state
    );
    expect(other.updates[0].values[0].value).toBe("X");
  });

  test("deeply-equal object values are detected as duplicates", () => {
    const state = createValueDedupState();
    const pos = { latitude: 60.16958, longitude: 24.93548 };
    dedupDelta(makeDelta([{ path: "navigation.position", value: pos }]), state);
    const second = dedupDelta(
      // New object reference but same shape — should still be detected
      makeDelta([
        { path: "navigation.position", value: { latitude: 60.16958, longitude: 24.93548 } }
      ]),
      state
    );
    expect(isDupSentinel(second.updates[0].values[0].value)).toBe(true);
  });

  test("returns identical reference when no values change vs cache (no allocation)", () => {
    const state = createValueDedupState();
    const d = makeDelta([{ path: "p", value: 1 }]);
    expect(dedupDelta(d, state)).toBe(d); // first call, cache empty → all absolute
    expect(dedupDelta(d, state)).not.toBe(d); // second call → sentinel substituted
  });
});

// ── Receiver: undedupDelta ────────────────────────────────────────────────────

describe("undedupDelta — receiver side", () => {
  test("absolute values pass through and prime the cache", () => {
    const state = createValueDedupState();
    const d = makeDelta([{ path: "navigation.state", value: "moored" }]);
    const out = undedupDelta(d, state);
    expect(out.updates[0].values[0].value).toBe("moored");
  });

  test("sentinel is restored from the cached value", () => {
    const state = createValueDedupState();
    undedupDelta(makeDelta([{ path: "navigation.state", value: "moored" }]), state);
    const incoming = makeDelta([{ path: "navigation.state", value: DUP_SENTINEL }]);
    const out = undedupDelta(incoming, state);
    expect(out.updates[0].values[0].value).toBe("moored");
  });

  test("sentinel with no prior cache entry is silently dropped from the update", () => {
    const state = createValueDedupState();
    const incoming = makeDelta([
      { path: "navigation.state", value: DUP_SENTINEL },
      { path: "other", value: "kept" }
    ]);
    const out = undedupDelta(incoming, state);
    // The sentinel-only entry dropped, the other kept
    expect(out.updates[0].values.length).toBe(1);
    expect(out.updates[0].values[0].path).toBe("other");
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("end-to-end dedup → undedup round-trip", () => {
  test("steady-state stream of identical values reconstructs perfectly", () => {
    const sender = createValueDedupState();
    const receiver = createValueDedupState();
    const samples = [
      makeDelta([{ path: "navigation.state", value: "moored" }]),
      makeDelta([{ path: "navigation.state", value: "moored" }]),
      makeDelta([{ path: "navigation.state", value: "moored" }]),
      makeDelta([{ path: "navigation.state", value: "underway" }]),
      makeDelta([{ path: "navigation.state", value: "underway" }])
    ];
    const received = samples.map((s) => undedupDelta(dedupDelta(s, sender), receiver));
    const values = received.map((r) => r.updates[0].values[0].value);
    expect(values).toEqual(["moored", "moored", "moored", "underway", "underway"]);
  });

  test("realistic mixed delta (some changing, some static) round-trips", () => {
    const sender = createValueDedupState();
    const receiver = createValueDedupState();
    function frame(speed) {
      return makeDelta([
        { path: "navigation.speedOverGround", value: speed },
        { path: "navigation.state", value: "underway" },
        { path: "propulsion.main.state", value: "started" }
      ]);
    }
    const speeds = [6.2, 6.3, 6.3, 6.5];
    const out = speeds.map((s) => undedupDelta(dedupDelta(frame(s), sender), receiver));
    out.forEach((f, i) => {
      const vs = f.updates[0].values;
      const byPath = Object.fromEntries(vs.map((v) => [v.path, v.value]));
      expect(byPath["navigation.speedOverGround"]).toBe(speeds[i]);
      expect(byPath["navigation.state"]).toBe("underway");
      expect(byPath["propulsion.main.state"]).toBe("started");
    });
  });
});

// ── Array / Record payload helpers ────────────────────────────────────────────

describe("dedupDeltaArray", () => {
  test("dedups across a batch in order", () => {
    const state = createValueDedupState();
    const batch = [makeDelta([{ path: "p", value: "x" }]), makeDelta([{ path: "p", value: "x" }])];
    const out = dedupDeltaArray(batch, state);
    expect(out[0].updates[0].values[0].value).toBe("x");
    expect(isDupSentinel(out[1].updates[0].values[0].value)).toBe(true);
  });
});

describe("dedupDeltaPayload — payload shapes", () => {
  test("Delta payload", () => {
    const state = createValueDedupState();
    const d = makeDelta([{ path: "p", value: 1 }]);
    const out = dedupDeltaPayload(d, state);
    expect(out).toBe(d);
  });
  test("Delta[] payload", () => {
    const state = createValueDedupState();
    const arr = [makeDelta([{ path: "p", value: 1 }])];
    const out = dedupDeltaPayload(arr, state);
    expect(out).toBe(arr);
  });
  test("Record<string, Delta> payload", () => {
    const state = createValueDedupState();
    const rec = { a: makeDelta([{ path: "p", value: 1 }]) };
    const out = dedupDeltaPayload(rec, state);
    expect(out).toBe(rec);
    dedupDeltaPayload(rec, state); // prime
    const dup = dedupDeltaPayload({ a: makeDelta([{ path: "p", value: 1 }]) }, state);
    expect(isDupSentinel(dup.a.updates[0].values[0].value)).toBe(true);
  });
});

describe("undedupDeltaArray", () => {
  test("expands every delta in order", () => {
    const sender = createValueDedupState();
    const receiver = createValueDedupState();
    const batch = [makeDelta([{ path: "p", value: 42 }]), makeDelta([{ path: "p", value: 42 }])];
    const wire = dedupDeltaArray(batch, sender);
    const recv = undedupDeltaArray(wire, receiver);
    expect(recv[0].updates[0].values[0].value).toBe(42);
    expect(recv[1].updates[0].values[0].value).toBe(42);
  });
});
