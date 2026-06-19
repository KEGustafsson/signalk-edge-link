"use strict";

/**
 * Signal K Edge Link - reliable client metrics publishing.
 *
 * Extracted from the v2 client factory: the periodic metrics publisher, its
 * Signal K telemetry emission, and the start/stop timers.
 *
 * @module transport/pipeline/reliable-client/metrics
 */

import { METRICS_PUBLISH_INTERVAL } from "../../../foundation/constants";
import type { ClientContext } from "./context";
import { calculatePacketLoss, pruneRetransmitQueue } from "./reliability";
import { sendDelta } from "./delta-sender";

interface PeriodRates {
  uploadBandwidth: number;
  packetsSentPerSec: number;
  packetsSent: number;
  retransmitRate: number;
  packetLoss: number;
}

/** Publish the network-quality snapshot to the MetricsPublisher + alert hooks. */
function publishNetworkQuality(ctx: ClientContext, rates: PeriodRates): void {
  const { metricsApi, metricsPublisher, packetBuilder, retransmitQueue, mut } = ctx;
  const { metrics } = metricsApi;
  metricsPublisher.publish({
    rtt: metrics.rtt || 0,
    jitter: metrics.jitter || 0,
    packetLoss: rates.packetLoss,
    uploadBandwidth: rates.uploadBandwidth,
    packetsSentPerSec: rates.packetsSentPerSec,
    retransmissions: metrics.retransmissions,
    sequenceNumber: packetBuilder.getCurrentSequence(),
    queueDepth: retransmitQueue.getSize(),
    retransmitRate: rates.retransmitRate,
    activeLink: mut.bondingManager ? mut.bondingManager.getActiveLinkName() : "primary",
    compressionRatio: metrics.bandwidth.compressionRatio || 0
  });

  const monitoringHooks = mut.monitoringHooks;
  if (monitoringHooks) {
    if (monitoringHooks.retransmissionTracker) {
      monitoringHooks.retransmissionTracker.snapshot(
        metrics.bandwidth.packetsOut,
        metrics.retransmissions ?? 0
      );
    }
    if (monitoringHooks.alertManager) {
      monitoringHooks.alertManager.checkAll({
        rtt: metrics.rtt || 0,
        jitter: metrics.jitter || 0,
        packetLoss: rates.packetLoss,
        retransmitRate: rates.retransmitRate,
        queueDepth: retransmitQueue.getSize()
      });
    }
  }
}

/**
 * Whether the client telemetry delta can be emitted this period: not already
 * in flight, ready to send, and the connection has the v2+ secret/address/port
 * needed to build a packet.
 */
function canEmitTelemetry(ctx: ClientContext): boolean {
  const { state, mut } = ctx;
  const options = state.options;
  return (
    !mut.telemetrySendInFlight &&
    !!state.readyToSend &&
    !!options &&
    (options.protocolVersion ?? 0) >= 2 &&
    !!options.secretKey &&
    !!options.udpAddress &&
    !!options.udpPort
  );
}

/** Emit the client RTT/quality telemetry delta back over the link. */
function emitTelemetryDelta(ctx: ClientContext, rates: PeriodRates): void {
  const { app, state, metricsApi, retransmitQueue, mut } = ctx;
  const { metrics } = metricsApi;
  // RTT is always published — operators rely on it for link-health visibility
  // even when skipOwnData suppresses the rest of edge-link's own metrics.
  if (!canEmitTelemetry(ctx) || !state.options) {
    return;
  }
  // canEmitTelemetry() already guaranteed these are present; capture them so
  // the sendDelta() call below is statically known to receive strings/numbers.
  const { secretKey, udpAddress, udpPort } = state.options;
  if (!secretKey || !udpAddress || !udpPort) {
    return;
  }

  const rttValues = [{ path: "networking.edgeLink.rtt", value: metrics.rtt || 0 }];

  const extraValues = state.options.skipOwnData
    ? []
    : [
        { path: "networking.edgeLink.jitter", value: metrics.jitter || 0 },
        { path: "networking.edgeLink.packetLoss", value: rates.packetLoss },
        { path: "networking.edgeLink.retransmissions", value: metrics.retransmissions || 0 },
        { path: "networking.edgeLink.queueDepth", value: retransmitQueue.getSize() },
        { path: "networking.edgeLink.retransmitRate", value: rates.retransmitRate },
        {
          path: "networking.edgeLink.activeLink",
          value: mut.bondingManager ? mut.bondingManager.getActiveLinkName() : "primary"
        }
      ];

  const telemetryDelta = {
    context: "vessels.self",
    updates: [
      {
        source: { label: ctx.clientTelemetrySource, type: "plugin" },
        timestamp: new Date().toISOString(),
        values: [...rttValues, ...extraValues]
      }
    ]
  };

  // Guard the flag with try-catch so that any synchronous throw cannot leave
  // it permanently true.
  try {
    mut.telemetrySendInFlight = true;
    sendDelta(ctx, [telemetryDelta], secretKey, udpAddress, udpPort)
      .catch((err: unknown) => {
        app.debug(
          `Failed to send client telemetry: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        mut.telemetrySendInFlight = false;
      });
  } catch (syncErr: unknown) {
    mut.telemetrySendInFlight = false;
    app.debug(
      `Telemetry send initialisation failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`
    );
  }
}

/** Collect and publish metrics to Signal K. */
export function publishMetrics(ctx: ClientContext): void {
  const { metricsApi, mut } = ctx;
  const { metrics, updateBandwidthRates } = metricsApi;
  updateBandwidthRates(false);

  pruneRetransmitQueue(ctx, "metrics");

  const now = Date.now();
  const elapsed = (now - mut.lastMetricsTime) / 1000; // seconds
  if (elapsed <= 0) {
    return;
  }

  const bytesSent = metrics.bandwidth.bytesOut - mut.lastBytesSent;
  const packetsSent = metrics.bandwidth.packetsOut - mut.lastPacketsSent;

  const periodRetransmissions = (metrics.retransmissions ?? 0) - mut.lastRetransmissions;
  const packetLoss = calculatePacketLoss(ctx);
  metrics.packetLoss = packetLoss;

  const rates: PeriodRates = {
    uploadBandwidth: bytesSent / elapsed,
    packetsSentPerSec: packetsSent / elapsed,
    packetsSent,
    retransmitRate: packetsSent > 0 ? periodRetransmissions / packetsSent : 0,
    packetLoss
  };

  publishNetworkQuality(ctx, rates);
  emitTelemetryDelta(ctx, rates);

  mut.lastMetricsTime = now;
  mut.lastBytesSent = metrics.bandwidth.bytesOut;
  mut.lastPacketsSent = metrics.bandwidth.packetsOut;
  mut.lastRetransmissions = metrics.retransmissions ?? 0;
}

/** Start periodic metrics publishing. */
export function startMetricsPublishing(ctx: ClientContext): void {
  const { metricsApi, mut } = ctx;
  const { metrics } = metricsApi;
  if (mut.metricsInterval) {
    return;
  }
  mut.lastMetricsTime = Date.now();
  mut.lastBytesSent = metrics.bandwidth.bytesOut;
  mut.lastPacketsSent = metrics.bandwidth.packetsOut;
  mut.lastRetransmissions = metrics.retransmissions ?? 0;

  mut.metricsInterval = setInterval(() => {
    publishMetrics(ctx);
  }, METRICS_PUBLISH_INTERVAL);
}

/** Stop periodic metrics publishing (and any in-flight recovery drain timer). */
export function stopMetricsPublishing(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.metricsInterval) {
    clearInterval(mut.metricsInterval);
    mut.metricsInterval = null;
  }
  if (mut.recoveryDrainTimer) {
    clearInterval(mut.recoveryDrainTimer);
    mut.recoveryDrainTimer = null;
  }
}
