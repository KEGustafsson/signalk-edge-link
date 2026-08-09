"use strict";

const createMetrics = require("../../lib/metrics");

/**
 * The metrics registry the v2 pipelines write into, for tests that drive real
 * pipelines but want the surrounding API functions stubbed.
 *
 * Built from the real `createMetrics()` factory rather than a hand-written
 * literal. Two end-to-end suites once kept their own copies, the copies drifted,
 * and a pipeline incrementing a missing counter wrote `NaN` into it — silently,
 * in the suite covering that very path. Replacing those copies with one shared
 * literal only moved the problem: this file then drifted from the registry the
 * same way, losing `packetLoss`, `acksSent`, `epochAuthMismatches`,
 * `encryptionErrors` and ten more. Deriving the object removes the class of bug
 * instead of relocating it — a counter added to the registry is present here the
 * moment it exists.
 *
 * `updateBandwidthRates` and `trackPathStats` are stubbed because these suites
 * assert on counters, not on derived rates; `recordError` is stubbed so a test
 * can assert what was reported. The metrics object itself is real.
 *
 * @returns a fresh metrics API; never share one instance between pipelines.
 */
function makeMetricsApi() {
  const real = createMetrics();
  return {
    metrics: real.metrics,
    formatBytes: real.formatBytes,
    getTopNPaths: real.getTopNPaths,
    resetMetrics: real.resetMetrics,
    recordError: jest.fn(),
    trackPathStats: jest.fn(),
    updateBandwidthRates: jest.fn()
  };
}

// `sampleDelta` is deliberately NOT shared: the two suites use different
// source shapes (`source` object vs `$source` string) and each is exercising
// that difference, so a single fixture would weaken both.
module.exports = { makeMetricsApi };
