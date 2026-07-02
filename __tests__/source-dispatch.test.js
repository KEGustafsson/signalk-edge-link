"use strict";

/**
 * Tests for src/source-dispatch.ts.
 *
 * The big design point being verified here: `handleMessageBySource` strips
 * the structured `source` object and hands `$source` to signalk-server as a
 * string. This works around two signalk-server / signalk-schema behaviours:
 *
 *   1. The plugin handleMessage wrapper substitutes the calling plugin's id
 *      for any providerId we pass, so per-source dispatch is a no-op.
 *   2. `FullSignalK.addValue` unconditionally recomputes the leaf's $source
 *      via `getSourceId(source)` when a structured source is present, which
 *      would clobber our chosen `$source` string with `signalk-edge-link.XX`
 *      (the hardcoded fallback from signalk-schema for a labelled-but-
 *      otherwise-empty source after the providerId rewrite).
 *
 * Passing source as a string instead bypasses that recomputation, so the
 * receiver stores `$source` verbatim.
 */

const { handleMessageBySource, normalizeDeltaSourceRefs } = require("../lib/source-dispatch");

function makeAppCapturer() {
  const calls = [];
  return {
    calls,
    handleMessage(providerId, delta) {
      calls.push({ providerId, delta });
    }
  };
}

describe("handleMessageBySource", () => {
  test('always dispatches once with providerId="signalk-edge-link" — per-source dispatch is a no-op against signalk-server\'s plugin wrapper, but the providerId still names the data-log discriminator', () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        { source: { label: "bedroom" }, $source: "bedroom", values: [{ path: "p", value: 1 }] },
        { source: { label: "salon" }, $source: "salon", values: [{ path: "q", value: 2 }] }
      ]
    });
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].providerId).toBe("signalk-edge-link");
  });

  test("preserves explicit $source from the wire", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "bedroom", type: "battery-monitor" },
          $source: "bedroom",
          timestamp: "2024-01-01T00:00:00.000Z",
          values: [{ path: "electrical.batteries.bedroom.voltage", value: 12.5 }]
        }
      ]
    });
    const update = app.calls[0].delta.updates[0];
    expect(update.$source).toBe("bedroom");
    // structured source dropped so FullSignalK.addValue won't recompute $source
    expect(update.source).toBeUndefined();
  });

  test("derives $source from source.label when no explicit $source — no .XX fallback", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "bedroom" },
          timestamp: "2024-01-01T00:00:00.000Z",
          values: [{ path: "electrical.batteries.bedroom.voltage", value: 12.5 }]
        }
      ]
    });
    const update = app.calls[0].delta.updates[0];
    // Bare label, NOT "bedroom.XX" — we don't want signalk-schema's literal
    // .XX fallback bleeding into receiver storage keys.
    expect(update.$source).toBe("bedroom");
    expect(update.source).toBeUndefined();
  });

  test("derives $source from source.src (NMEA2000-style)", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "n2k-gateway", type: "NMEA2000", src: "3", pgn: 129029 },
          timestamp: "2024-01-01T00:00:00.000Z",
          values: [{ path: "navigation.speedOverGround", value: 5.14 }]
        }
      ]
    });
    expect(app.calls[0].delta.updates[0].$source).toBe("n2k-gateway.3");
  });

  test("derives $source from source.talker (NMEA0183-style)", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "actisense", type: "NMEA0183", talker: "GP" },
          values: [{ path: "navigation.position", value: { latitude: 60, longitude: 25 } }]
        }
      ]
    });
    expect(app.calls[0].delta.updates[0].$source).toBe("actisense.GP");
  });

  test("prefers structured source over stale signalk-edge-link.* $source", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "bedroom" },
          $source: "signalk-edge-link.42",
          values: [{ path: "electrical.batteries.bedroom.voltage", value: 12.5 }]
        }
      ]
    });
    // Stale signalk-edge-link.* $source from an earlier hop is ignored in
    // favour of the fresh structured source, so attribution survives the relay.
    expect(app.calls[0].delta.updates[0].$source).toBe("bedroom");
  });

  test("keeps a stale $source when the derived ref would also be stale (no key swap to another edge-link label)", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          // Both attribution sources are stale signalk-edge-link.* — swapping
          // would collapse one stale key into another instead of recovering
          // real attribution.
          source: { label: "signalk-edge-link" },
          $source: "signalk-edge-link.42",
          values: [{ path: "p", value: 1 }]
        }
      ]
    });
    expect(app.calls[0].delta.updates[0].$source).toBe("signalk-edge-link.42");
  });

  test("keeps a stale signalk-edge-link.* $source when no usable source object is present (non-edgeLink path)", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          $source: "signalk-edge-link.42",
          values: [{ path: "navigation.speedOverGround", value: 1 }]
        }
      ]
    });
    // Non-edgeLink path: we have nothing better to fall back to — keep stale.
    expect(app.calls[0].delta.updates[0].$source).toBe("signalk-edge-link.42");
  });

  test("normalises signalk-edge-link.XX to canonical signalk-edge-link for networking.edgeLink.* values", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          $source: "signalk-edge-link.XX",
          values: [{ path: "networking.edgeLink.arabella.rtt", value: 105.8 }]
        }
      ]
    });
    // Old plugin versions produce .XX from a label-only source object;
    // normalise to the canonical base label so both ends store the same key.
    expect(app.calls[0].delta.updates[0].$source).toBe("signalk-edge-link");
  });

  test("normalises qualified signalk-edge-link:instanceId to canonical for networking.edgeLink.* values", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          $source: "signalk-edge-link:arabella",
          values: [{ path: "networking.edgeLink.arabella.rtt", value: 102.1 }]
        }
      ]
    });
    expect(app.calls[0].delta.updates[0].$source).toBe("signalk-edge-link");
  });

  test("does not alter the base signalk-edge-link $source for networking.edgeLink.* values", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          $source: "signalk-edge-link",
          values: [{ path: "networking.edgeLink.proxyin.rtt", value: 126.6 }]
        }
      ]
    });
    expect(app.calls[0].delta.updates[0].$source).toBe("signalk-edge-link");
  });

  test("drops $source entirely when neither a usable source object nor a $source string is present", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [{ values: [{ path: "p", value: 1 }] }]
    });
    // No attribution available — let signalk-server fall back to its own
    // providerId-derived key rather than fabricating one here.
    expect(app.calls[0].delta.updates[0].$source).toBeUndefined();
    expect(app.calls[0].delta.updates[0].source).toBeUndefined();
  });

  test("preserves timestamp, values, and meta", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, {
      context: "vessels.self",
      updates: [
        {
          source: { label: "bedroom" },
          $source: "bedroom",
          timestamp: "2024-01-01T12:00:00.000Z",
          values: [{ path: "p", value: 1.23 }],
          meta: [{ path: "p", value: { units: "V" } }]
        }
      ]
    });
    const update = app.calls[0].delta.updates[0];
    expect(update.timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(update.values).toEqual([{ path: "p", value: 1.23 }]);
    expect(update.meta).toEqual([{ path: "p", value: { units: "V" } }]);
  });

  test("no-op on empty/null deltas", () => {
    const app = makeAppCapturer();
    handleMessageBySource(app, null);
    handleMessageBySource(app, { context: "vessels.self" });
    handleMessageBySource(app, { context: "vessels.self", updates: [] });
    expect(app.calls).toHaveLength(0);
  });
});

describe("normalizeDeltaSourceRefs", () => {
  test("strips stale signalk-edge-link.* $source when a real source label is present", () => {
    const out = normalizeDeltaSourceRefs({
      context: "vessels.self",
      updates: [
        {
          source: { label: "bedroom" },
          $source: "signalk-edge-link.42",
          values: [{ path: "p", value: 1 }]
        }
      ]
    });
    expect(out.updates[0].$source).toBeUndefined();
    expect(out.updates[0].source).toEqual({ label: "bedroom" });
  });

  test("keeps stale $source when the structured label is an edge-link namespace too (prefix-aware)", () => {
    // The structured label is `signalk-edge-link:<instanceId>` (colon
    // variant) — still stale, must not be used as a fresh fallback.
    const out = normalizeDeltaSourceRefs({
      context: "vessels.self",
      updates: [
        {
          source: { label: "signalk-edge-link:proxy-01" },
          $source: "signalk-edge-link.42",
          values: [{ path: "p", value: 1 }]
        }
      ]
    });
    expect(out.updates[0].$source).toBe("signalk-edge-link.42");
  });

  test("keeps stale $source when only an edge-link-labelled source is available", () => {
    const out = normalizeDeltaSourceRefs({
      context: "vessels.self",
      updates: [
        {
          source: { label: "signalk-edge-link" },
          $source: "signalk-edge-link.42",
          values: [{ path: "p", value: 1 }]
        }
      ]
    });
    expect(out.updates[0].$source).toBe("signalk-edge-link.42");
  });

  test("returns the original delta unchanged when nothing needs stripping", () => {
    const delta = {
      context: "vessels.self",
      updates: [
        { source: { label: "bedroom" }, $source: "bedroom", values: [{ path: "p", value: 1 }] }
      ]
    };
    expect(normalizeDeltaSourceRefs(delta)).toBe(delta);
  });
});
