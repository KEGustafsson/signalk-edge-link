import {
  formatManagementAuthPrometheusMetrics,
  formatPrometheusMetrics
} from "../domain/metrics/prometheus";
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
    getManagementAuthSnapshot,
    isManagementAuthEnabled,
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
        res.json({
          ...buildFullMetricsResponse(bundle),
          // Omit auth telemetry in open-access mode (see /status).
          ...(isManagementAuthEnabled() ? { managementAuth: getManagementAuthSnapshot() } : {})
        });
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
          // See the identical guard in routes.ts: 0 here would mean "measured a
          // 0 ms round trip", not "never measured one".
          rtt: effectiveNetwork.hasQualityBasis ? effectiveNetwork.rtt : undefined,
          jitter: effectiveNetwork.hasQualityBasis ? effectiveNetwork.jitter : undefined,
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
        // Both inputs required — see the identical guard in routes.ts.
        const nmRtt = effectiveNetwork.rtt;
        const nmJitter = effectiveNetwork.jitter;
        if (
          nmPublisher &&
          effectiveNetwork.hasQualityBasis &&
          nmRtt !== undefined &&
          nmJitter !== undefined
        ) {
          networkMetrics.linkQuality = nmPublisher.calculateLinkQuality({
            rtt: nmRtt,
            jitter: nmJitter,
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
        // Only expose management-auth telemetry when a management token is
        // configured, matching the JSON /metrics behaviour. In open-access mode
        // this audit history (management actions/reasons) would otherwise be
        // readable by any unauthenticated Prometheus scraper.
        if (isManagementAuthEnabled()) {
          parts.push(
            formatManagementAuthPrometheusMetrics(getManagementAuthSnapshot(), { sharedMeta })
          );
        }

        for (const bundle of allBundles) {
          const { state } = bundle;
          const { metrics, updateBandwidthRates } = bundle.metricsApi;
          updateBandwidthRates(state.isServerMode);
          const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);

          const extra: Record<string, unknown> = {};
          if (state.monitoring && state.monitoring.alertManager) {
            const alertState = state.monitoring.alertManager.getState();
            extra.activeAlerts = alertState.activeAlerts;
          }
          // One source for loss and retransmit rate, shared with /metrics,
          // /network-metrics and the web UI.
          //
          // This used to prefer the monitoring trackers when they existed and
          // fall back to getEffectiveNetworkQuality otherwise, so a scrape and
          // the dashboard could report different numbers for the same link at
          // the same moment: the trackers measure a bucketed window while
          // getEffectiveNetworkQuality reports the current figure (remote
          // telemetry when fresh, local measurement otherwise). Two defensible
          // definitions, but silently swapped depending on whether monitoring
          // happened to be enabled — so an alert built on the scrape could
          // disagree with the UI an operator was looking at.
          //
          // The trackers are not lost: they remain the windowed/heatmap view
          // behind /monitoring/packet-loss and /monitoring/retransmissions,
          // where the UI labels them for the window they cover.
          extra.packetLoss = effectiveNetwork.packetLoss;
          extra.retransmitRate = effectiveNetwork.retransmitRate;

          // Same measurement-basis gate as /metrics and /network-metrics.
          // Without it Prometheus scrapes a perfect 100 for a link that has
          // never been measured — and a dashboard built on the scrape is
          // exactly where that false green does the most damage.
          const promPublisher = getActiveMetricsPublisher(state);
          const promRtt = effectiveNetwork.rtt;
          const promJitter = effectiveNetwork.jitter;
          if (
            promPublisher &&
            effectiveNetwork.hasQualityBasis &&
            promRtt !== undefined &&
            promJitter !== undefined
          ) {
            extra.linkQuality = promPublisher.calculateLinkQuality({
              rtt: promRtt,
              jitter: promJitter,
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

          // rtt/jitter follow the same gate as linkQuality. Gating only the
          // quality score would still scrape an unmeasured link as a 0 ms round
          // trip — the same false green in a different series. `undefined` (not
          // omission) is deliberate: the spread above carries the seeded
          // `metrics.rtt: 0`, so the key has to be overwritten to suppress it,
          // and `emitNetworkQuality` skips the series when it is undefined.
          const prometheusMetrics = {
            ...metrics,
            rtt: effectiveNetwork.hasQualityBasis ? effectiveNetwork.rtt : undefined,
            jitter: effectiveNetwork.hasQualityBasis ? effectiveNetwork.jitter : undefined,
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
