"use strict";

const {
  sanitizeDeltaForSignalK,
  sanitizeDeltaPayloadForSignalK,
  stripOwnDataFromDelta
} = require("../lib/delta-sanitizer");

describe("sanitizeDeltaForSignalK", () => {
  test("drops invalid value entries and empty updates", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.speedOverGround", value: 5 },
            null,
            { value: 1 },
            { path: "", value: 2 }
          ]
        },
        { values: [] }
      ]
    };

    expect(sanitizeDeltaForSignalK(delta)).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [{ path: "navigation.speedOverGround", value: 5 }]
        }
      ]
    });
  });

  test("preserves metadata-only updates", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          timestamp: "2026-04-25T09:03:50.000Z",
          values: [],
          meta: [{ path: "navigation.speedOverGround", value: { units: "m/s" } }]
        }
      ]
    };

    expect(sanitizeDeltaForSignalK(delta)).toEqual(delta);
  });

  test("returns null when an array payload has no deliverable deltas", () => {
    expect(
      sanitizeDeltaPayloadForSignalK([
        { context: "vessels.self", updates: [{ values: [] }] },
        { context: "vessels.self", updates: [{ values: [{ value: 1 }] }] }
      ])
    ).toBeNull();
  });

  test("sanitizes indexed delta batch payloads without dropping the batch shape", () => {
    expect(
      sanitizeDeltaPayloadForSignalK({
        0: {
          context: "vessels.self",
          updates: [{ values: [{ path: "navigation.speedOverGround", value: 5 }] }]
        },
        1: {
          context: "vessels.self",
          updates: [{ values: [{ value: "missing path" }] }]
        }
      })
    ).toEqual({
      0: {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 5 }] }]
      }
    });
  });
});

describe("stripOwnDataFromDelta", () => {
  test("drops networking.edgeLink.* but always keeps RTT paths", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.speedOverGround", value: 5 },
            { path: "networking.edgeLink.rtt", value: 42 },
            { path: "networking.edgeLink.shore-server.rtt", value: 50 },
            { path: "networking.edgeLink.shore-server.jitter", value: 1 },
            { path: "networking.modem.rtt", value: 0.05 },
            { path: "networking.modem.shore-server.rtt", value: 0.05 },
            { path: "navigation.position", value: { latitude: 1, longitude: 2 } }
          ]
        }
      ]
    };

    expect(stripOwnDataFromDelta(delta)).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.speedOverGround", value: 5 },
            { path: "networking.edgeLink.rtt", value: 42 },
            { path: "networking.edgeLink.shore-server.rtt", value: 50 },
            { path: "networking.modem.rtt", value: 0.05 },
            { path: "networking.modem.shore-server.rtt", value: 0.05 },
            { path: "navigation.position", value: { latitude: 1, longitude: 2 } }
          ]
        }
      ]
    });
  });

  test("preserves non-RTT data under networking.modem.* alongside RTT", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "networking.modem.signalStrength", value: -72 },
            { path: "networking.modem.lte.txBytes", value: 12345 },
            { path: "networking.modem.shore-server.rtt", value: 0.05 }
          ]
        }
      ]
    };

    expect(stripOwnDataFromDelta(delta)).toBe(delta);
  });

  test("drops non-RTT edgeLink entries while keeping RTT", () => {
    expect(
      stripOwnDataFromDelta({
        context: "vessels.self",
        updates: [
          { values: [{ path: "networking.edgeLink.jitter", value: 1 }] },
          {
            values: [
              { path: "networking.edgeLink.rtt", value: 42 },
              { path: "navigation.speedOverGround", value: 5 }
            ]
          }
        ]
      })
    ).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "networking.edgeLink.rtt", value: 42 },
            { path: "navigation.speedOverGround", value: 5 }
          ]
        }
      ]
    });
  });

  test("returns null when nothing remains after stripping", () => {
    expect(
      stripOwnDataFromDelta({
        context: "vessels.self",
        updates: [
          { values: [{ path: "networking.edgeLink.jitter", value: 1 }] },
          { values: [{ path: "networking.edgeLink.shore-server.packetLoss", value: 0 }] }
        ]
      })
    ).toBeNull();
  });

  test("returns the original delta unchanged when no own-data paths present", () => {
    const delta = {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 5 }] }]
    };
    expect(stripOwnDataFromDelta(delta)).toBe(delta);
  });

  test("strips own-data meta entries but keeps RTT meta", () => {
    expect(
      stripOwnDataFromDelta({
        context: "vessels.self",
        updates: [
          {
            values: [{ path: "navigation.speedOverGround", value: 5 }],
            meta: [
              { path: "navigation.speedOverGround", value: { units: "m/s" } },
              { path: "networking.edgeLink.rtt", value: { units: "ms" } },
              { path: "networking.edgeLink.jitter", value: { units: "ms" } }
            ]
          }
        ]
      })
    ).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [{ path: "navigation.speedOverGround", value: 5 }],
          meta: [
            { path: "navigation.speedOverGround", value: { units: "m/s" } },
            { path: "networking.edgeLink.rtt", value: { units: "ms" } }
          ]
        }
      ]
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("quantizeDelta — per-path numeric precision", () => {
  const { quantizeDelta, quantizeDeltaPayload } = require("../lib/delta-sanitizer");

  function makeDelta(values) {
    return {
      context: "vessels.self",
      updates: [{ source: { label: "test" }, timestamp: "2026-05-28T00:00:00Z", values }]
    };
  }

  test("rounds a configured numeric path to N decimals", () => {
    const out = quantizeDelta(
      makeDelta([{ path: "navigation.speedOverGround", value: 7.234567890123456 }]),
      { "navigation.speedOverGround": 2 }
    );
    expect(out.updates[0].values[0].value).toBe(7.23);
  });

  test("leaves paths not in the map unchanged", () => {
    const original = makeDelta([
      { path: "navigation.speedOverGround", value: 7.234567 },
      { path: "navigation.headingTrue", value: 1.523456 }
    ]);
    const out = quantizeDelta(original, { "navigation.speedOverGround": 2 });
    expect(out.updates[0].values[0].value).toBe(7.23);
    expect(out.updates[0].values[1].value).toBe(1.523456);
  });

  test("recurses into object values using dotted paths", () => {
    const out = quantizeDelta(
      makeDelta([
        {
          path: "navigation.position",
          value: { latitude: 60.16958123, longitude: 24.93547651 }
        }
      ]),
      {
        "navigation.position.latitude": 5,
        "navigation.position.longitude": 5
      }
    );
    expect(out.updates[0].values[0].value).toEqual({
      latitude: 60.16958,
      longitude: 24.93548
    });
  });

  test("returns the same object reference when no values change (no allocation)", () => {
    const original = makeDelta([{ path: "navigation.headingTrue", value: 1.5 }]);
    // Empty map → no-op
    expect(quantizeDelta(original, {})).toBe(original);
    // Path not in map → no-op
    expect(quantizeDelta(original, { "environment.wind.speed": 1 })).toBe(original);
  });

  test("leaves non-numeric values untouched", () => {
    const original = makeDelta([
      { path: "navigation.state", value: "moored" },
      { path: "design.aisShipType", value: { id: 36, name: "Sailing" } }
    ]);
    const out = quantizeDelta(original, { "navigation.state": 2 });
    expect(out.updates[0].values[0].value).toBe("moored");
  });

  test("undefined or empty precisionMap → identity", () => {
    const original = makeDelta([{ path: "p", value: 1.234 }]);
    expect(quantizeDelta(original, undefined)).toBe(original);
    expect(quantizeDelta(original, {})).toBe(original);
  });

  test("handles negative numbers and zero decimals", () => {
    const out = quantizeDelta(
      makeDelta([
        { path: "p1", value: -7.876 },
        { path: "p2", value: 12345.678 }
      ]),
      { p1: 1, p2: 0 }
    );
    expect(out.updates[0].values[0].value).toBe(-7.9);
    expect(out.updates[0].values[1].value).toBe(12346);
  });

  test("non-finite numbers (NaN, Infinity) are passed through unchanged", () => {
    const out = quantizeDelta(
      makeDelta([
        { path: "p1", value: NaN },
        { path: "p2", value: Infinity }
      ]),
      { p1: 2, p2: 2 }
    );
    expect(Number.isNaN(out.updates[0].values[0].value)).toBe(true);
    expect(out.updates[0].values[1].value).toBe(Infinity);
  });

  test("quantizeDeltaPayload handles array payloads", () => {
    const out = quantizeDeltaPayload(
      [makeDelta([{ path: "p", value: 1.234 }]), makeDelta([{ path: "p", value: 5.678 }])],
      { p: 1 }
    );
    expect(out[0].updates[0].values[0].value).toBe(1.2);
    expect(out[1].updates[0].values[0].value).toBe(5.7);
  });

  test("quantizeDeltaPayload handles Record-style payloads", () => {
    const out = quantizeDeltaPayload(
      {
        alpha: makeDelta([{ path: "p", value: 1.234 }]),
        beta: makeDelta([{ path: "p", value: 5.678 }])
      },
      { p: 1 }
    );
    expect(out.alpha.updates[0].values[0].value).toBe(1.2);
    expect(out.beta.updates[0].values[0].value).toBe(5.7);
  });
});
