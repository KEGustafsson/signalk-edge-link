"use strict";

const createMetrics = require("../lib/metrics");
const { makeMetricsApi } = require("./helpers/metrics-fixture");

/**
 * The fixture is derived from `createMetrics()` precisely so it cannot drift,
 * but "derived" is an implementation detail a future refactor could undo. These
 * tests assert the property that actually matters: a pipeline incrementing any
 * registry counter under this fixture must not produce NaN.
 */
describe("metrics fixture parity with the real registry", () => {
  test("exposes every counter the registry defines", () => {
    const real = createMetrics().metrics;
    const fixture = makeMetricsApi().metrics;

    const missing = Object.keys(real).filter((key) => !(key in fixture));
    expect(missing).toEqual([]);
  });

  test("every numeric counter starts as a number, so ++ cannot yield NaN", () => {
    const fixture = makeMetricsApi().metrics;
    const real = createMetrics().metrics;

    const nonNumeric = Object.keys(real)
      .filter((key) => typeof real[key] === "number")
      .filter((key) => typeof fixture[key] !== "number");

    expect(nonNumeric).toEqual([]);
  });

  test("nested bandwidth and smartBatching counters are present", () => {
    const real = createMetrics().metrics;
    const fixture = makeMetricsApi().metrics;

    for (const group of ["bandwidth", "smartBatching"]) {
      const missing = Object.keys(real[group]).filter((key) => !(key in fixture[group]));
      expect({ group, missing }).toEqual({ group, missing: [] });
    }
  });

  test("returns an independent instance per call", () => {
    const a = makeMetricsApi();
    const b = makeMetricsApi();
    a.metrics.deltasSent = 42;
    expect(b.metrics.deltasSent).toBe(0);
  });
});
