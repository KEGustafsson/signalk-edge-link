"use strict";

const { collectValuesSnapshot } = require("../lib/values-snapshot");

function makeApp(tree) {
  return {
    signalk: {
      retrieve: () => tree
    },
    debug: () => {}
  };
}

describe("collectValuesSnapshot", () => {
  test("returns [] when app.signalk is absent", () => {
    expect(collectValuesSnapshot({ debug: () => {} })).toEqual([]);
  });

  test("returns [] when tree is empty", () => {
    const app = makeApp({ sources: {}, vessels: {} });
    expect(collectValuesSnapshot(app)).toEqual([]);
  });

  test("includes a normal (non-edge-link) value", () => {
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            speedOverGround: {
              value: 3.5,
              timestamp: "2024-01-01T00:00:00.000Z",
              $source: "pypilot.compass"
            }
          }
        }
      },
      sources: {
        pypilot: {
          compass: { label: "pypilot", type: "NMEA2000" }
        }
      }
    });

    const deltas = collectValuesSnapshot(app);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].updates[0].values).toEqual([
      { path: "navigation.speedOverGround", value: 3.5 }
    ]);
    expect(deltas[0].updates[0].$source).toBe("pypilot.compass");
  });

  test("excludes edge-link value when resolved label is also signalk-edge-link", () => {
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            speedOverGround: {
              value: 3.5,
              timestamp: "2024-01-01T00:00:00.000Z",
              $source: "signalk-edge-link.somekey"
            }
          }
        }
      },
      sources: {
        "signalk-edge-link": {
          somekey: { label: "signalk-edge-link", type: "plugin" }
        }
      }
    });

    const deltas = collectValuesSnapshot(app);
    expect(deltas).toHaveLength(0);
  });

  test("excludes edge-link value when source is not in the sources table", () => {
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            speedOverGround: {
              value: 3.5,
              timestamp: "2024-01-01T00:00:00.000Z",
              $source: "signalk-edge-link.unknownkey"
            }
          }
        }
      },
      sources: {}
    });

    const deltas = collectValuesSnapshot(app);
    expect(deltas).toHaveLength(0);
  });

  test("includes edge-link value when sources table resolves it to a real sensor label", () => {
    // This is the relay scenario: downstream client sent data that SK stored
    // under "signalk-edge-link.pypilot". The sources table retains the original
    // label so the snapshot can include it for server-restart re-priming.
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            headingTrue: {
              value: 1.57,
              timestamp: "2024-01-01T00:00:00.000Z",
              $source: "signalk-edge-link.pypilot"
            }
          }
        }
      },
      sources: {
        "signalk-edge-link": {
          pypilot: { label: "pypilot", type: "NMEA2000" }
        }
      }
    });

    const deltas = collectValuesSnapshot(app);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].updates[0].values).toEqual([{ path: "navigation.headingTrue", value: 1.57 }]);
    expect(deltas[0].updates[0].$source).toBe("signalk-edge-link.pypilot");
    expect(deltas[0].updates[0].source).toEqual({ label: "pypilot", type: "NMEA2000" });
  });

  test("includes relay data alongside local data in a mixed tree", () => {
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            speedOverGround: {
              value: 3.5,
              timestamp: "2024-01-01T00:00:00.000Z",
              $source: "pypilot.compass"
            },
            headingTrue: {
              value: 1.57,
              timestamp: "2024-01-01T00:00:01.000Z",
              $source: "signalk-edge-link.openplotter"
            },
            depth: {
              value: 5.0,
              timestamp: "2024-01-01T00:00:02.000Z",
              $source: "signalk-edge-link.nolabel"
            }
          }
        }
      },
      sources: {
        pypilot: {
          compass: { label: "pypilot", type: "NMEA2000" }
        },
        "signalk-edge-link": {
          openplotter: { label: "openplotter", type: "NMEA2000" },
          nolabel: { label: "signalk-edge-link", type: "plugin" }
        }
      }
    });

    const deltas = collectValuesSnapshot(app);
    const paths = deltas.flatMap((d) => d.updates.flatMap((u) => u.values.map((v) => v.path)));
    expect(paths).toContain("navigation.speedOverGround");
    expect(paths).toContain("navigation.headingTrue");
    expect(paths).not.toContain("navigation.depth"); // label is "signalk-edge-link" — excluded
  });

  test("emits only the current top-level $source, not historical entries in values: { … }", () => {
    // signalk-server's `values: { … }` map is append-only — entries from a
    // source that has since stopped writing (e.g. previous N2K address,
    // earlier edge-link build) stay there with no TTL. Walking that map
    // would replicate ghosts to the receiver where they'd never refresh.
    // The snapshot must mirror live behaviour: just the current writer.
    const app = makeApp({
      vessels: {
        self: {
          electrical: {
            batteries: {
              bedroom: {
                voltage: {
                  value: 12.6,
                  timestamp: "2026-05-19T15:32:00.000Z",
                  $source: "bedroom",
                  values: {
                    bedroom: {
                      value: 12.6,
                      timestamp: "2026-05-19T15:32:00.000Z"
                    },
                    // Stale entry from an earlier session / source — older
                    // timestamp, no live writer.
                    "bedroom.XX": {
                      value: 12.4,
                      timestamp: "2026-05-19T14:07:00.000Z"
                    }
                  }
                }
              }
            }
          }
        }
      },
      sources: {}
    });

    const deltas = collectValuesSnapshot(app);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].updates[0].$source).toBe("bedroom");
    expect(deltas[0].updates[0].timestamp).toBe("2026-05-19T15:32:00.000Z");
    expect(deltas[0].updates[0].values).toEqual([
      { path: "electrical.batteries.bedroom.voltage", value: 12.6 }
    ]);
  });

  test("falls back to values: { … } map only when no top-level value is present", () => {
    // Older signalk-server versions / partial trees may populate only the
    // multi-source map without a top-level `value` mirror. In that case
    // we still want every entry to ride through.
    const app = makeApp({
      vessels: {
        self: {
          navigation: {
            speedOverGround: {
              values: {
                "pypilot.compass": {
                  value: 3.5,
                  timestamp: "2024-01-01T00:00:00.000Z"
                },
                "n2k-gateway.3": {
                  value: 3.6,
                  timestamp: "2024-01-01T00:00:01.000Z"
                }
              }
            }
          }
        }
      },
      sources: {}
    });

    const deltas = collectValuesSnapshot(app);
    const sources = deltas.map((d) => d.updates[0].$source).sort();
    expect(sources).toEqual(["n2k-gateway.3", "pypilot.compass"]);
  });
});
