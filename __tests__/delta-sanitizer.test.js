"use strict";

const {
  sanitizeDeltaForSignalK,
  sanitizeDeltaPayloadForSignalK
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
