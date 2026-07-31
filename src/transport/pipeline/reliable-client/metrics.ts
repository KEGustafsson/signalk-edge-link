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
  // Latency is reported only once an ACK has actually been timed. `|| 0` here
  // published a 0 ms round trip for a link that had never completed one, and a
  // server ingesting that telemetry could not tell it from a real measurement —
  // it displayed "0 ms" and scored the link a perfect 100.
  const measuredRtt = (metrics.rttSamples ?? 0) > 0;
  metricsPublisher.publish({
    rtt: measuredRtt ? (metrics.rtt ?? 0) : undefined,
    jitter: measuredRtt ? (metrics.jitter ?? 0) : undefined,
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
  if (!canEmitTelemetry(ctx) || !state.options) {
    return;
  }
  // canEmitTelemetry() already guaranteed these are present; capture them so
  // the sendDelta() call below is statically known to receive strings/numbers.
  const { secretKey, udpAddress, udpPort } = state.options;
  if (!secretKey || !udpAddress || !udpPort) {
    return;
  }

  // The full quality set, unconditionally.
  //
  // `skipOwnData` used to suppress everything here except RTT, which is why a
  // server saw a real round trip from its client and 0 ms jitter beside it: the
  // jitter was never sent, and the receiver substitutes 0 for a value the peer
  // never reported. The same silence hid packet loss, retransmissions, queue
  // depth, retransmit rate and the active link.
  //
  // That coupling was wrong on its own terms. `skipOwnData` means "do not
  // forward my Signal K tree's networking.edgeLink.* paths as ordinary data,
  // so a chain cannot feed its own metrics back around". This delta is not
  // ordinary data — it is the dedicated, source-labelled link telemetry the
  // peer needs in order to report the link at all, and since the receiver
  // consumes it rather than dispatching it into its own tree, forwarding it
  // creates no loop to prevent. RTT was already exempted on exactly this
  // reasoning; the reasoning was never specific to RTT.
  // rtt and jitter are omitted until an ACK has actually been timed, for the
  // same reason the receiver reports a field the peer never sent as absent
  // rather than 0: `metrics.rtt` is seeded to 0, not undefined, so publishing
  // it unconditionally hands the peer a 0 ms round trip it cannot tell from a
  // measured one. `rttSamples` exists precisely to make that distinction, and
  // `publishNetworkQuality` above already gates on it. A measured 0 is still
  // sent — the gate is on whether a sample exists, not on the value.
  const measuredRtt = (metrics.rttSamples ?? 0) > 0;
  const telemetryValues = [
    ...(measuredRtt
      ? [
          { path: "networking.edgeLink.rtt", value: metrics.rtt ?? 0 },
          { path: "networking.edgeLink.jitter", value: metrics.jitter ?? 0 }
        ]
      : []),
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
        values: telemetryValues
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
