"use strict";

/**
 * Shared response bodies for the monitoring/bonding views that exist both as
 * singleton routes (`/monitoring/*`, `/bonding/failover`) and per-connection
 * routes (`/connections/:id/...`). Only bundle resolution and the auth-action
 * names differ between the two registrations; keeping one body per view
 * prevents the drift that once let the per-connection retransmissions route
 * lose its limit clamp.
 *
 * @module routes/monitoring-views
 */

import type { InstanceState, RouteRequest, RouteResponse } from "./types";

/** Respond with the alert manager's thresholds and active alerts. */
export function sendAlertsState(state: InstanceState, res: RouteResponse): void {
  if (!state.monitoring || !state.monitoring.alertManager) {
    res.json({ thresholds: {}, activeAlerts: {} });
    return;
  }
  res.json(state.monitoring.alertManager.getState());
}

/** Respond with the packet-loss heatmap and summary. */
export function sendPacketLossView(state: InstanceState, res: RouteResponse): void {
  if (!state.monitoring || !state.monitoring.packetLossTracker) {
    res.json({
      heatmap: [],
      summary: { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 }
    });
    return;
  }
  res.json({
    heatmap: state.monitoring.packetLossTracker.getHeatmapData(),
    summary: state.monitoring.packetLossTracker.getSummary()
  });
}

/** Respond with retransmission chart data, clamping the limit to [1, 1000]. */
export function sendRetransmissionsView(
  state: InstanceState,
  req: RouteRequest,
  res: RouteResponse
): void {
  if (!state.monitoring || !state.monitoring.retransmissionTracker) {
    res.json({
      chartData: [],
      summary: { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 }
    });
    return;
  }
  const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined;
  res.json({
    chartData: state.monitoring.retransmissionTracker.getChartData(limit),
    summary: state.monitoring.retransmissionTracker.getSummary()
  });
}

/** Force a bonding failover and respond with the resulting link state. */
export function sendBondingFailover(state: InstanceState, res: RouteResponse): void {
  if (!state.pipeline || !state.pipeline.getBondingManager) {
    res.status(503).json({ error: "Bonding not available" });
    return;
  }
  const bonding = state.pipeline.getBondingManager();
  if (!bonding) {
    res.status(503).json({ error: "Bonding not enabled" });
    return;
  }
  bonding.forceFailover();
  res.json({
    success: true,
    activeLink: bonding.getActiveLinkName(),
    links: bonding.getLinkHealth()
  });
}
