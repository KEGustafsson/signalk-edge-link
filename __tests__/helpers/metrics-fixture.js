"use strict";

/**
 * The metrics registry shape the v2 pipelines write into, for tests that drive
 * real pipelines rather than the real `createMetrics()` factory.
 *
 * Shared because two end-to-end suites had grown their own copies and the
 * copies had already drifted: one omitted `rttSamples` and
 * `rejectedControlPackets`, so a pipeline incrementing either field wrote
 * `NaN` into it — silently, in the suite that exercises the same code path the
 * other suite covers correctly.
 *
 * @returns a fresh metrics API; never share one instance between pipelines.
 */
function makeMetricsApi() {
  return {
    metrics: {
      startTime: Date.now(),
      deltasSent: 0,
      deltasReceived: 0,
      udpRetries: 0,
      udpSendErrors: 0,
      duplicatePackets: 0,
      rateLimitedPackets: 0,
      malformedPackets: 0,
      rejectedControlPackets: 0,
      rtt: 0,
      jitter: 0,
      rttSamples: 0,
      queueDepth: 0,
      retransmissions: 0,
      smartBatching: {
        avgBytesPerDelta: 0,
        maxDeltasPerBatch: 0,
        oversizedPackets: 0,
        earlySends: 0,
        timerSends: 0
      },
      bandwidth: {
        packetsOut: 0,
        packetsIn: 0,
        bytesOut: 0,
        bytesIn: 0,
        bytesOutRaw: 0,
        bytesInRaw: 0,
        lastBytesOut: 0,
        lastBytesIn: 0,
        lastRateCalcTime: Date.now(),
        rateOut: 0,
        rateIn: 0,
        compressionRatio: 1,
        history: { toArray: () => [] }
      }
    },
    recordError: jest.fn(),
    trackPathStats: jest.fn(),
    updateBandwidthRates: jest.fn()
  };
}

// `sampleDelta` is deliberately NOT shared: the two suites use different
// source shapes (`source` object vs `$source` string) and each is exercising
// that difference, so a single fixture would weaken both.
module.exports = { makeMetricsApi };
