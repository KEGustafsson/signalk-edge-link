import { findConnectionIndexByInstanceId } from "../connection-config";

/**
 * Registers monitoring and capture routes:
 *   /monitoring/packet-loss, /monitoring/path-latency, /monitoring/retransmissions,
 *   /monitoring/alerts (GET+POST), /monitoring/inspector, /monitoring/simulation,
 *   /capture, /capture/start, /capture/stop, /capture/export
 *
 * @param router - Express router
 * @param ctx - Shared route context
 */
function register(router: any, ctx: any): void {
  const {
    app,
    rateLimitMiddleware,
    requireJson,
    getFirstBundle,
    managementAuthMiddleware,
    pluginRef
  } = ctx;

  function getPersistedConfigConnections(configuration: any, bundle: any): any {
    if (Array.isArray(configuration.connections)) {
      return {
        usesConnectionsArray: true,
        connections: configuration.connections.map((connection: any) => ({ ...connection }))
      };
    }

    if (configuration && typeof configuration === "object" && configuration.serverType) {
      return {
        usesConnectionsArray: false,
        connections: [{ ...configuration, name: configuration.name || bundle.name || "default" }]
      };
    }

    return {
      usesConnectionsArray: false,
      connections: []
    };
  }

  function persistAlertThresholds(bundle: any, thresholds: any): void {
    if (
      typeof app.readPluginOptions !== "function" ||
      typeof app.savePluginOptions !== "function"
    ) {
      return;
    }

    try {
      const pluginOptions = app.readPluginOptions() || {};
      const currentConfig = pluginOptions.configuration || {};
      const persisted = getPersistedConfigConnections(currentConfig, bundle);
      let nextConfig = null;

      if (persisted.connections.length > 0) {
        let index = findConnectionIndexByInstanceId(persisted.connections, bundle.id);
        if (index === -1 && persisted.connections.length === 1) {
          index = 0;
        }

        if (index !== -1) {
          const nextConnections = persisted.connections.map((connection: any) => ({
            ...connection
          }));
          nextConnections[index] = {
            ...nextConnections[index],
            alertThresholds: {
              ...(nextConnections[index].alertThresholds || {}),
              ...thresholds
            }
          };

          nextConfig = persisted.usesConnectionsArray
            ? { ...currentConfig, connections: nextConnections }
            : { ...nextConnections[0] };

          if (pluginRef && pluginRef._currentOptions) {
            if (persisted.usesConnectionsArray) {
              pluginRef._currentOptions = {
                ...pluginRef._currentOptions,
                connections: nextConnections
              };
            } else {
              pluginRef._currentOptions = {
                ...pluginRef._currentOptions,
                ...nextConnections[0]
              };
            }
          }
        }
      }

      if (!nextConfig) {
        nextConfig = {
          ...currentConfig,
          alertThresholds: {
            ...(currentConfig.alertThresholds || {}),
            ...thresholds
          }
        };
      }

      app.savePluginOptions(nextConfig, (saveErr: any) => {
        if (saveErr) {
          app.error(`Failed to persist alert thresholds: ${saveErr.message}`);
        }
      });
    } catch (persistErr: any) {
      app.error(`Failed to persist alert thresholds: ${persistErr.message}`);
    }
  }

  router.get(
    "/monitoring/packet-loss",
    rateLimitMiddleware,
    managementAuthMiddleware("monitoring.read"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.packetLossTracker) {
          return res.json({
            heatmap: [],
            summary: { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 }
          });
        }
        res.json({
          heatmap: state.monitoring.packetLossTracker.getHeatmapData(),
          summary: state.monitoring.packetLossTracker.getSummary()
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get(
    "/monitoring/path-latency",
    rateLimitMiddleware,
    managementAuthMiddleware("monitoring.read"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.pathLatencyTracker) {
          return res.json({ paths: [] });
        }
        const topN = parseInt(req.query.limit, 10) || 20;
        res.json({
          paths: state.monitoring.pathLatencyTracker.getAllStats(topN)
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get(
    "/monitoring/retransmissions",
    rateLimitMiddleware,
    managementAuthMiddleware("monitoring.read"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.retransmissionTracker) {
          return res.json({
            chartData: [],
            summary: { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 }
          });
        }
        const limit = parseInt(req.query.limit, 10) || undefined;
        res.json({
          chartData: state.monitoring.retransmissionTracker.getChartData(limit),
          summary: state.monitoring.retransmissionTracker.getSummary()
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get(
    "/monitoring/alerts",
    rateLimitMiddleware,
    managementAuthMiddleware("monitoring.alerts.read"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.alertManager) {
          return res.json({ thresholds: {}, activeAlerts: {} });
        }
        res.json(state.monitoring.alertManager.getState());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.post(
    "/monitoring/alerts",
    rateLimitMiddleware,
    managementAuthMiddleware("monitoring.alerts.update"),
    requireJson,
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.alertManager) {
          return res.status(503).json({ error: "Alert manager not initialized" });
        }

        const { metric, warning, critical } = req.body;
        if (!metric) {
          return res.status(400).json({ error: "metric is required" });
        }
        const validAlertMetrics = ["rtt", "packetLoss", "retransmitRate", "jitter", "queueDepth"];
        if (!validAlertMetrics.includes(metric)) {
          return res
            .status(400)
            .json({ error: `metric must be one of: ${validAlertMetrics.join(", ")}` });
        }

        const update: any = {};
        if (warning !== undefined) {
          if (typeof warning !== "number" || !Number.isFinite(warning)) {
            return res.status(400).json({ error: "warning must be a finite number" });
          }
          update.warning = warning;
        }
        if (critical !== undefined) {
          if (typeof critical !== "number" || !Number.isFinite(critical)) {
            return res.status(400).json({ error: "critical must be a finite number" });
          }
          update.critical = critical;
        }
        if (Object.keys(update).length === 0) {
          return res.status(400).json({ error: "At least one of warning or critical is required" });
        }

        const existingThreshold = state.monitoring.alertManager.thresholds[metric] || {};
        const effectiveWarning =
          update.warning !== undefined ? update.warning : existingThreshold.warning;
        const effectiveCritical =
          update.critical !== undefined ? update.critical : existingThreshold.critical;
        if (
          effectiveWarning !== undefined &&
          effectiveCritical !== undefined &&
          effectiveWarning > effectiveCritical
        ) {
          return res.status(400).json({ error: "warning must be less than or equal to critical" });
        }

        state.monitoring.alertManager.setThreshold(metric, update);

        if (state.options) {
          if (!state.options.alertThresholds || typeof state.options.alertThresholds !== "object") {
            state.options.alertThresholds = {};
          }
          state.options.alertThresholds[metric] = {
            ...(state.options.alertThresholds[metric] || {}),
            ...update
          };
        }

        persistAlertThresholds(bundle, (state.options && state.options.alertThresholds) || {});

        res.json({
          success: true,
          thresholds: state.monitoring.alertManager.getState().thresholds
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Packet capture routes
  router.get(
    "/capture",
    rateLimitMiddleware,
    managementAuthMiddleware("capture.read"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.json({ enabled: false, captured: 0, dropped: 0, buffered: 0 });
        }
        res.json(state.monitoring.packetCapture.getStats());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.post(
    "/capture/start",
    rateLimitMiddleware,
    managementAuthMiddleware("capture.update"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        state.monitoring.packetCapture.start();
        res.json({ success: true, enabled: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.post(
    "/capture/stop",
    rateLimitMiddleware,
    managementAuthMiddleware("capture.update"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        state.monitoring.packetCapture.stop();
        res.json({ success: true, enabled: false });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get(
    "/capture/export",
    rateLimitMiddleware,
    managementAuthMiddleware("capture.export"),
    (req: any, res: any) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        const pcapBuffer = state.monitoring.packetCapture.exportPcap();
        res.set("Content-Type", "application/vnd.tcpdump.pcap");
        res.set(
          "Content-Disposition",
          `attachment; filename="edge-link-capture-${Date.now()}.pcap"`
        );
        res.send(pcapBuffer);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get("/monitoring/inspector", rateLimitMiddleware, (req: any, res: any) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {
        return res.status(503).json({ error: "Plugin not started" });
      }
      const { state } = bundle;
      if (!state.monitoring || !state.monitoring.packetInspector) {
        return res.json({ enabled: false, packetsInspected: 0, clientsConnected: 0 });
      }
      res.json(state.monitoring.packetInspector.getStats());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/monitoring/simulation", rateLimitMiddleware, (req: any, res: any) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {
        return res.status(503).json({ error: "Plugin not started" });
      }
      const { state } = bundle;
      if (!state.networkSimulator) {
        return res.json({ enabled: false });
      }
      res.json({
        enabled: true,
        conditions: state.networkSimulator.getConditions(),
        stats: state.networkSimulator.getStats()
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

export { register };
