// @ts-nocheck
"use strict";

const { formatPrometheusMetrics } = require("../prometheus.ts");

/**
 * Registers metrics-related routes: /metrics, /network-metrics, /prometheus
 *
 * @param {Object} router - Express router
 * @param {Object} ctx - Shared route context (helpers, middleware, registry)
 */
function register(router, ctx) {
  const {
    rateLimitMiddleware,
    instanceRegistry,
    getFirstBundle,
    getEffectiveNetworkQuality,
    getActiveMetricsPublisher,
    buildFullMetricsResponse
  } = ctx;

  router.get("/metrics", rateLimitMiddleware, (req, res) => {
    const bundle = getFirstBundle();
    if (!bundle) {
      return res.status(503).json({ error: "Plugin not started" });
    }
    res.json(buildFullMetricsResponse(bundle));
  });

  router.get("/network-metrics", rateLimitMiddleware, (req, res) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {
        return res.status(503).json({ error: "Plugin not started" });
      }
      const { state } = bundle;
      const { metrics } = bundle.metricsApi;
      const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
      const networkMetrics = {
        rtt: effectiveNetwork.rtt,
        jitter: effectiveNetwork.jitter,
        packetLoss: effectiveNetwork.packetLoss,
        retransmissions: effectiveNetwork.retransmissions,
        queueDepth: effectiveNetwork.queueDepth,
        acksSent: metrics.acksSent || 0,
        naksSent: metrics.naksSent || 0,
        activeLink: effectiveNetwork.activeLink,
        dataSource: effectiveNetwork.dataSource,
        timestamp: Date.now()
      };
      if (state.isServerMode && effectiveNetwork.lastUpdate > 0) {
        networkMetrics.lastRemoteUpdate = effectiveNetwork.lastUpdate;
      }

      const nmPublisher = getActiveMetricsPublisher(state);
      if (nmPublisher) {
        networkMetrics.linkQuality = nmPublisher.calculateLinkQuality({
          rtt: effectiveNetwork.rtt,
          jitter: effectiveNetwork.jitter,
          packetLoss: effectiveNetwork.packetLoss,
          retransmitRate: effectiveNetwork.retransmitRate
        });
      }

      res.json(networkMetrics);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/prometheus", rateLimitMiddleware, (req, res) => {
    try {
      const allBundles = instanceRegistry.getAll();
      if (!allBundles || allBundles.length === 0) {
        return res.status(503).json({ error: "Plugin not started" });
      }

      const sharedMeta = new Set();
      const parts = [];

      for (const bundle of allBundles) {
        const { state } = bundle;
        const { metrics, updateBandwidthRates } = bundle.metricsApi;
        updateBandwidthRates(state.isServerMode);
        const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);

        const extra = {};
        if (state.monitoring) {
          if (state.monitoring.packetLossTracker) {
            const summary = state.monitoring.packetLossTracker.getSummary();
            extra.packetLoss = summary.overallLossRate;
          }
          if (state.monitoring.retransmissionTracker) {
            const summary = state.monitoring.retransmissionTracker.getSummary();
            extra.retransmitRate = summary.currentRate;
          }
          if (state.monitoring.alertManager) {
            const alertState = state.monitoring.alertManager.getState();
            extra.activeAlerts = alertState.activeAlerts;
          }
        }
        if (extra.packetLoss === undefined) {
          extra.packetLoss = effectiveNetwork.packetLoss;
        }

        const promPublisher = getActiveMetricsPublisher(state);
        if (promPublisher) {
          extra.linkQuality = promPublisher.calculateLinkQuality({
            rtt: effectiveNetwork.rtt,
            jitter: effectiveNetwork.jitter,
            packetLoss: effectiveNetwork.packetLoss,
            retransmitRate: effectiveNetwork.retransmitRate
          });
        }

        if (state.pipeline && state.pipeline.getBondingManager) {
          const bonding = state.pipeline.getBondingManager();
          if (bonding) {
            extra.bonding = bonding.getState();
          }
        }

        const prometheusMetrics = {
          ...metrics,
          rtt: effectiveNetwork.rtt,
          jitter: effectiveNetwork.jitter,
          retransmissions: effectiveNetwork.retransmissions,
          queueDepth: effectiveNetwork.queueDepth
        };
        parts.push(formatPrometheusMetrics(prometheusMetrics, state, extra, { sharedMeta }));
      }

      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(parts.join(""));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
