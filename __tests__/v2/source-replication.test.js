"use strict";

const {
  createSourceRegistry,
  SOURCE_REPLICATION_SCHEMA_VERSION
} = require("../../lib/source-replication");

describe("source replication registry", () => {
  test("preserves client source payload without label parsing side-effects", () => {
    const registry = createSourceRegistry({ debug: jest.fn() });
    registry.upsertFromDelta(
      {
        context: "vessels.self",
        updates: [
          {
            timestamp: "2026-04-27T00:00:00.000Z",
            source: {
              label: "Boat Inputs ws.DEV_01",
              type: "WS",
              sentence: "MWV"
            },
            values: [{ path: "environment.wind.speedApparent", value: 2.1 }]
          }
        ]
      },
      "client-a"
    );

    const snap = registry.snapshot();
    expect(snap.schemaVersion).toBe(SOURCE_REPLICATION_SCHEMA_VERSION);
    expect(snap.size).toBe(1);
    expect(snap.sources[0].raw.source).toEqual({
      label: "Boat Inputs ws.DEV_01",
      type: "WS",
      sentence: "MWV"
    });
    expect(snap.sources[0].identity.deviceId).toBe("client-a");
    expect(snap.sources[0].identity.type).toBe("WS");
    expect(snap.sources[0].metadata.sentence).toBe("MWV");
  });

  test("merges partial legacy and structured source metadata", () => {
    const registry = createSourceRegistry({ debug: jest.fn() });
    registry.upsertFromDelta(
      {
        context: "vessels.self",
        updates: [
          {
            timestamp: "2026-04-27T00:00:00.000Z",
            $source: "n2k.123.1",
            values: [{ path: "navigation.speedOverGround", value: 3.4 }]
          }
        ]
      },
      "client-a"
    );
    registry.upsertFromDelta(
      {
        context: "vessels.self",
        updates: [
          {
            timestamp: "2026-04-27T00:00:01.000Z",
            $source: "n2k.123.1",
            source: {
              label: "N2K speed",
              type: "NMEA2000",
              pgn: 128259
            },
            values: [{ path: "navigation.speedOverGround", value: 3.6 }]
          }
        ]
      },
      "client-b"
    );

    const snap = registry.snapshot();
    const n2k = snap.sources.find((s) => s.raw.$source === "n2k.123.1");
    expect(n2k).toBeDefined();
    expect(n2k.identity.pgn).toBe(128259);
    expect(n2k.provenance.sourceClientInstanceId).toBe("client-b");
    expect(snap.legacy.bySourceRef["n2k.123.1"]).toBe(n2k.key);
  });

  test("dedupes no-op merges via hash", () => {
    const registry = createSourceRegistry({ debug: jest.fn() });
    const delta = {
      context: "vessels.self",
      updates: [
        {
          timestamp: "2026-04-27T00:00:00.000Z",
          source: { label: "A", type: "plugin" },
          values: [{ path: "x", value: 1 }]
        }
      ]
    };
    registry.upsertFromDelta(delta, "client-a");
    registry.upsertFromDelta(delta, "client-a");
    const metrics = registry.getMetrics();
    expect(metrics.upserts).toBe(1);
    expect(metrics.noops).toBe(1);
  });
});
