"use strict";

/**
 * Unit tests for buildOutboundDedupeKey — the structural duplicate-
 * suppression key that replaced JSON.stringify(delta) on the
 * processDelta hot path. These tests pin the contract that the dedupe
 * relies on:
 *
 *   - Two structurally identical deltas → identical keys (suppressed).
 *   - Any structurally distinguishable difference (path, value,
 *     timestamp, $source, source.{label,type,src}, context, value
 *     order within an update) → distinct keys (forwarded).
 *
 * If a future change to buildOutboundDedupeKey causes a hash collision
 * across genuinely different deltas, this file catches it before live
 * traffic does.
 */

jest.mock("ping-monitor", () => jest.fn().mockImplementation(() => ({})));

const { buildOutboundDedupeKey } = require("../lib/instance");

function makeDelta(overrides = {}) {
  return {
    context: "vessels.urn:mrn:imo:mmsi:123",
    updates: [
      {
        $source: "n2k.0",
        source: { label: "n2k", type: "NMEA2000", src: "10" },
        timestamp: "2026-05-21T10:00:00.000Z",
        values: [{ path: "navigation.speedOverGround", value: 5.2 }]
      }
    ],
    ...overrides
  };
}

describe("buildOutboundDedupeKey", () => {
  test("returns identical key for structurally identical deltas", () => {
    expect(buildOutboundDedupeKey(makeDelta())).toBe(buildOutboundDedupeKey(makeDelta()));
  });

  test("different context produces different key", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey(makeDelta({ context: "vessels.urn:mrn:imo:mmsi:999" }));
    expect(a).not.toBe(b);
  });

  test("different timestamp produces different key", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [{ ...makeDelta().updates[0], timestamp: "2026-05-21T10:00:00.001Z" }]
    });
    expect(a).not.toBe(b);
  });

  test("different value produces different key", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [
        {
          ...makeDelta().updates[0],
          values: [{ path: "navigation.speedOverGround", value: 5.3 }]
        }
      ]
    });
    expect(a).not.toBe(b);
  });

  test("different $source produces different key", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [{ ...makeDelta().updates[0], $source: "n2k.1" }]
    });
    expect(a).not.toBe(b);
  });

  test("different source.label produces different key", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [
        {
          ...makeDelta().updates[0],
          source: { label: "gps", type: "NMEA2000", src: "10" }
        }
      ]
    });
    expect(a).not.toBe(b);
  });

  test("value order within update matters (insertion-order stable)", () => {
    const a = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [
        {
          ...makeDelta().updates[0],
          values: [
            { path: "a", value: 1 },
            { path: "b", value: 2 }
          ]
        }
      ]
    });
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [
        {
          ...makeDelta().updates[0],
          values: [
            { path: "b", value: 2 },
            { path: "a", value: 1 }
          ]
        }
      ]
    });
    expect(a).not.toBe(b);
  });

  test("handles null / undefined / missing fields without throwing", () => {
    expect(() => buildOutboundDedupeKey({ context: "x", updates: [] })).not.toThrow();
    expect(() => buildOutboundDedupeKey({ context: "x", updates: [{ values: [] }] })).not.toThrow();
    expect(() =>
      buildOutboundDedupeKey({
        context: "x",
        updates: [{ values: [{ path: "p", value: null }] }]
      })
    ).not.toThrow();
  });

  test("nested object values still distinguishable via JSON fallback", () => {
    const a = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          values: [{ path: "p", value: { lat: 1, lon: 2 } }]
        }
      ]
    });
    const b = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          values: [{ path: "p", value: { lat: 1, lon: 3 } }]
        }
      ]
    });
    expect(a).not.toBe(b);
  });

  test("multi-update delta: distinct update blocks produce distinct keys", () => {
    const a = buildOutboundDedupeKey(makeDelta());
    const b = buildOutboundDedupeKey({
      ...makeDelta(),
      updates: [
        makeDelta().updates[0],
        {
          $source: "n2k.1",
          source: { label: "compass", type: "NMEA2000", src: "11" },
          timestamp: "2026-05-21T10:00:00.000Z",
          values: [{ path: "navigation.headingMagnetic", value: 1.2 }]
        }
      ]
    });
    expect(a).not.toBe(b);
  });

  test("delimiter-bearing values cannot collide with multi-value deltas", () => {
    // A peer-controlled value text that mimics our internal delimiter
    // shape (e.g. "|v") MUST NOT collide with a delta that legitimately
    // has two values. Without length-prefix encoding, the two would
    // hash equal and one of them would be silently suppressed in live
    // traffic.
    const singleValueWithDelimiter = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          $source: "s",
          timestamp: "t",
          values: [{ path: "a", value: "1|vp1:b=2" }]
        }
      ]
    });
    const twoSeparateValues = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          $source: "s",
          timestamp: "t",
          values: [
            { path: "a", value: "1" },
            { path: "b", value: 2 }
          ]
        }
      ]
    });
    expect(singleValueWithDelimiter).not.toBe(twoSeparateValues);
  });

  test("path containing '=' cannot collide with the next value's path", () => {
    // Path "a=foo" with value "1" vs. path "a" with value "foo|vb=1"
    // would have collided under the old "path=value" delimiter style.
    const a = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          values: [{ path: "a=foo", value: "1" }]
        }
      ]
    });
    const b = buildOutboundDedupeKey({
      context: "x",
      updates: [
        {
          values: [{ path: "a", value: "foo|vb=1" }]
        }
      ]
    });
    expect(a).not.toBe(b);
  });
});
