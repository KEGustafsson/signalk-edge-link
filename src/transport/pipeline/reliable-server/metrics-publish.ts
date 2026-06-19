"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: metrics publishing
 *
 * Aggregates per-session packet-loss windows, blends in fresh remote telemetry,
 * and publishes the server-side network-quality snapshot to Signal K.
 *
 * @module transport/pipeline/reliable-server/metrics-publish
 */

import { getFirstSessionTracker } from "./sessions";
import { isFreshRemoteTelemetry } from "./telemetry";
import type { ServerContext } from "./context";

/**
 * Aggregate per-session packet loss for the current period, then advance each
 * session's loss baselines for the next period. Returns the period's loss ratio
 * (falls back to the last-known metrics value when nothing was expected).
 */
function aggregatePacketLoss(ctx: ServerContext): number {
  const { metrics, clientSessions } = ctx;
  let aggPeriodExpected = 0;
  let aggPeriodReceived = 0;
  for (const session of clientSessions.values()) {
    if (session.lossBaseSeq === null || session.lossHighestSeq === null) {
      continue;
    }
    const totalExpected = (((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0;
    const totalReceived = session.lossReceivedCount;
    aggPeriodExpected += Math.max(0, totalExpected - session.lastLossExpected);
    aggPeriodReceived += Math.max(0, totalReceived - session.lastLossReceived);
  }
  const packetLoss =
    aggPeriodExpected > 0
      ? Math.max(0, (aggPeriodExpected - aggPeriodReceived) / aggPeriodExpected)
      : metrics.packetLoss || 0;
  metrics.packetLoss = packetLoss;
  // Advance per-session baselines for the next period
  for (const session of clientSessions.values()) {
    if (session.lossBaseSeq === null) {
      continue;
    }
    session.lastLossExpected =
      session.lossBaseSeq !== null && session.lossHighestSeq !== null
        ? (((session.lossHighestSeq - session.lossBaseSeq) >>> 0) + 1) >>> 0
        : 0;
    session.lastLossReceived = session.lossReceivedCount;
  }
  return packetLoss;
}

/**
 * Log source-replication deltas (new missing-identity / conflict events) since
 * the last publish, and advance the baselines.
 */
function logSourceReplicationDeltas(
  ctx: ServerContext,
  sourceReplicationMetrics: {
    upserts: number;
    noops: number;
    missingIdentity: number;
    conflicts: number;
  }
): void {
  const { app, state, mut } = ctx;
  const deltaMissing = sourceReplicationMetrics.missingIdentity - mut.previousSourceMissingIdentity;
  const deltaConflicts = sourceReplicationMetrics.conflicts - mut.previousSourceConflicts;
  if (deltaMissing > 0 || deltaConflicts > 0) {
    app.debug(
      `[source-replication] +missingIdentity=${deltaMissing} +conflicts=${deltaConflicts} totalMissingIdentity=${sourceReplicationMetrics.missingIdentity} totalConflicts=${sourceReplicationMetrics.conflicts} size=${state.sourceRegistry!.snapshot().size}`
    );
  }
  mut.previousSourceMissingIdentity = sourceReplicationMetrics.missingIdentity;
  mut.previousSourceConflicts = sourceReplicationMetrics.conflicts;
}

/**
 * Collect and publish server-side metrics to Signal K.
 */
export function publishServerMetrics(ctx: ServerContext): void {
  const { app, state, metrics, mut, metricsPublisher, updateBandwidthRates } = ctx;
  updateBandwidthRates(true);

  const now = Date.now();
  const elapsed = (now - mut.lastMetricsTime) / 1000;
  if (elapsed <= 0) {
    return;
  }

  // Calculate rates
  const bytesReceived = metrics.bandwidth.bytesIn - mut.lastBytesReceived;
  const packetsReceived = metrics.bandwidth.packetsIn - mut.lastPacketsReceived;

  const downloadBandwidth = bytesReceived / elapsed;
  const packetsReceivedPerSec = packetsReceived / elapsed;

  const packetLoss = aggregatePacketLoss(ctx);

  const hasRemoteTelemetry = isFreshRemoteTelemetry(ctx, now);
  const remote = metrics.remoteNetworkQuality || {};
  const effectiveRtt = hasRemoteTelemetry ? remote.rtt || 0 : 0;
  const effectiveJitter = hasRemoteTelemetry ? remote.jitter || 0 : 0;
  const effectivePacketLoss = hasRemoteTelemetry ? remote.packetLoss || 0 : packetLoss;
  const effectiveRetransmissions = hasRemoteTelemetry ? remote.retransmissions || 0 : 0;
  const effectiveQueueDepth = hasRemoteTelemetry ? remote.queueDepth || 0 : 0;
  const effectiveRetransmitRate = hasRemoteTelemetry ? remote.retransmitRate || 0 : 0;
  const effectiveActiveLink = hasRemoteTelemetry ? remote.activeLink || "primary" : "primary";
  const sourceReplicationMetrics = state.sourceRegistry
    ? state.sourceRegistry.getMetrics()
    : { upserts: 0, noops: 0, missingIdentity: 0, conflicts: 0 };
  logSourceReplicationDeltas(ctx, sourceReplicationMetrics);

  // Publish to Signal K
  metricsPublisher.publish({
    rtt: effectiveRtt,
    jitter: effectiveJitter,
    downloadBandwidth: downloadBandwidth,
    packetsReceivedPerSec: packetsReceivedPerSec,
    packetLoss: effectivePacketLoss,
    retransmissions: effectiveRetransmissions,
    queueDepth: effectiveQueueDepth,
    retransmitRate: effectiveRetransmitRate,
    activeLink: effectiveActiveLink,
    sequenceNumber: getFirstSessionTracker(ctx).expectedSeq ?? undefined,
    compressionRatio: metrics.bandwidth.compressionRatio || 0
  });

  // Update last values
  mut.lastMetricsTime = now;
  mut.lastBytesReceived = metrics.bandwidth.bytesIn;
  mut.lastPacketsReceived = metrics.bandwidth.packetsIn;
  // Per-session loss baselines are updated inside aggregatePacketLoss above.
}
