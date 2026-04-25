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
  test("drops networking.edgeLink.* and the modem RTT paths", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.speedOverGround", value: 5 },
            { path: "networking.edgeLink.rtt", value: 42 },
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
            { path: "navigation.position", value: { latitude: 1, longitude: 2 } }
          ]
        }
      ]
    });
  });

  test("preserves non-RTT data under networking.modem.*", () => {
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

    expect(stripOwnDataFromDelta(delta)).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "networking.modem.signalStrength", value: -72 },
            { path: "networking.modem.lte.txBytes", value: 12345 }
          ]
        }
      ]
    });
  });

  test("drops updates that become empty after stripping", () => {
    expect(
      stripOwnDataFromDelta({
        context: "vessels.self",
        updates: [
          { values: [{ path: "networking.edgeLink.rtt", value: 1 }] },
          { values: [{ path: "navigation.speedOverGround", value: 5 }] }
        ]
      })
    ).toEqual({
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 5 }] }]
    });
  });

  test("returns null when nothing remains after stripping", () => {
    expect(
      stripOwnDataFromDelta({
        context: "vessels.self",
        updates: [
          { values: [{ path: "networking.edgeLink.rtt", value: 1 }] },
          { values: [{ path: "networking.modem.rtt", value: 0.05 }] }
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

  test("strips own-data meta entries too", () => {
    expect(
      stripOwnDataFromDelta({
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
      })
    ).toEqual({
      context: "vessels.self",
      updates: [
        {
          values: [{ path: "navigation.speedOverGround", value: 5 }],
          meta: [{ path: "navigation.speedOverGround", value: { units: "m/s" } }]
        }
      ]
    });
  });
});
