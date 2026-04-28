import { formatPrometheusMetrics } from "../prometheus";
import { RouteRequest, RouteResponse, Router, RouteContext } from "./types";

/**
 * Registers metrics-related routes: /metrics, /network-metrics, /prometheus
 *
 * @param router - Express router
 * @param ctx - Shared route context (helpers, middleware, registry)
 */
function register(router: Router, ctx: RouteContext): void {
  const {
    rateLimitMiddleware,
    instanceRegistry,
    getFirstBundle,
    getEffectiveNetworkQuality,
    getActiveMetricsPublisher,
    buildFullMetricsResponse,
    managementAuthMiddleware
  } = ctx;

  router.get(
    "/metrics",
    rateLimitMiddleware,
    managementAuthMiddleware("metrics.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        res.json(buildFullMetricsResponse(bundle));
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.get(
    "/network-metrics",
    rateLimitMiddleware,
    managementAuthMiddleware("network-metrics.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        const { metrics } = bundle.metricsApi;
        const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
        const networkMetrics: Record<string, unknown> = {
          rtt: effectiveNetwork.rtt,
          jitter: effectiveNetwork.jitter,
          packetLoss: effectiveNetwork.packetLoss,
          retransmissions: effectiveNetwork.retransmissions,
          queueDepth: effectiveNetwork.queueDepth,
          retransmitRate: effectiveNetwork.retransmitRate,
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
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.get(
    "/prometheus",
    rateLimitMiddleware,
    managementAuthMiddleware("prometheus.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const allBundles = instanceRegistry.getAll();
        if (!allBundles || allBundles.length === 0) {
          return res.status(503).json({ error: "Plugin not started" });
        }

        const sharedMeta = new Set<string>();
        const parts: string[] = [];

        for (const bundle of allBundles) {
          const { state } = bundle;
          const { metrics, updateBandwidthRates } = bundle.metricsApi;
          updateBandwidthRates(state.isServerMode);
          const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);

          const extra: Record<string, unknown> = {};
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
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.get(
    "/sources",
    rateLimitMiddleware,
    managementAuthMiddleware("sources.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const serverBundle =
          instanceRegistry
            .getAll()
            .find(
              (bundle) => bundle.state && bundle.state.isServerMode && bundle.state.sourceRegistry
            ) || null;
        const bundle = serverBundle || getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.sourceRegistry) {
          return res.json({
            schemaVersion: 1,
            size: 0,
            sources: [],
            legacy: { byLabel: {}, bySourceRef: {} }
          });
        }
        return res.json(state.sourceRegistry.snapshot());
      } catch (err: unknown) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

export { register };
