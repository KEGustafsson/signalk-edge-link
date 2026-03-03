"use strict";

/**
 * Registers multi-instance connection routes:
 *   /connections, /connections/:id/metrics, /connections/:id/network-metrics,
 *   /connections/:id/bonding, /connections/:id/congestion,
 *   /connections/:id/config/:filename, /connections/:id/monitoring/*,
 *   /connections/:id/bonding/failover
 *
 * @param {Object} router - Express router
 * @param {Object} ctx - Shared route context
 */
function register(router, ctx) {
  const {
    rateLimitMiddleware, requireJson, instanceRegistry,
    getBundleById, getEffectiveNetworkQuality,
    getConfigFilePath, loadConfigFile, saveConfigFile,
    buildFullMetricsResponse
  } = ctx;

  router.get("/connections", rateLimitMiddleware, (req, res) => {
    try {
      const all = instanceRegistry.getAll();
      res.json(all.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.state.isServerMode ? "server" : "client",
        port: b.state.options && b.state.options.udpPort,
        protocolVersion: b.state.options && b.state.options.protocolVersion,
        status: b.state.instanceStatus,
        healthy: b.state.isHealthy,
        readyToSend: b.state.readyToSend
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/connections/:id/metrics", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const data = buildFullMetricsResponse(bundle);
    data.instanceId = req.params.id;
    res.json(data);
  });

  router.get("/connections/:id/network-metrics", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    const { metrics } = bundle.metricsApi;
    const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
    res.json({ instanceId: req.params.id, ...effectiveNetwork, timestamp: Date.now() });
  });

  router.get("/connections/:id/bonding", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
    if (!state.pipeline || !state.pipeline.getBondingManager) return res.json({ enabled: false });
    const bonding = state.pipeline.getBondingManager();
    res.json(bonding ? bonding.getState() : { enabled: false });
  });

  router.get("/connections/:id/congestion", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
    if (!state.pipeline || !state.pipeline.getCongestionControl) return res.status(503).json({ error: "Congestion control not initialized" });
    res.json(state.pipeline.getCongestionControl().getState());
  });

  router.get("/connections/:id/config/:filename", rateLimitMiddleware, async (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
    try {
      const filePath = getConfigFilePath(state, req.params.filename);
      if (!filePath) return res.status(400).json({ error: "Invalid filename" });
      const config = await loadConfigFile(filePath);
      res.contentType("application/json").send(JSON.stringify(config || {}));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/connections/:id/config/:filename", rateLimitMiddleware, requireJson, async (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
    try {
      const filePath = getConfigFilePath(state, req.params.filename);
      if (!filePath) return res.status(400).json({ error: "Invalid filename" });
      const success = await saveConfigFile(filePath, req.body);
      res.status(success ? 200 : 500).send(success ? "OK" : "Failed to save configuration");
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/connections/:id/monitoring/alerts", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (!state.monitoring || !state.monitoring.alertManager) {
      return res.json({ thresholds: {}, activeAlerts: {} });
    }
    res.json(state.monitoring.alertManager.getState());
  });

  router.get("/connections/:id/monitoring/packet-loss", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (!state.monitoring || !state.monitoring.packetLossTracker) {
      return res.json({ heatmap: [], summary: { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 } });
    }
    res.json({
      heatmap: state.monitoring.packetLossTracker.getHeatmapData(),
      summary: state.monitoring.packetLossTracker.getSummary()
    });
  });

  router.get("/connections/:id/monitoring/retransmissions", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (!state.monitoring || !state.monitoring.retransmissionTracker) {
      return res.json({ chartData: [], summary: { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 } });
    }
    const limit = parseInt(req.query.limit, 10) || undefined;
    res.json({
      chartData: state.monitoring.retransmissionTracker.getChartData(limit),
      summary: state.monitoring.retransmissionTracker.getSummary()
    });
  });

  router.post("/connections/:id/bonding/failover", rateLimitMiddleware, (req, res) => {
    const bundle = getBundleById(req.params.id);
    if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
    const { state } = bundle;
    if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
    if (!state.pipeline || !state.pipeline.getBondingManager) {
      return res.status(503).json({ error: "Bonding not available" });
    }
    const bonding = state.pipeline.getBondingManager();
    if (!bonding) return res.status(503).json({ error: "Bonding not enabled" });
    bonding.forceFailover();
    res.json({ success: true, activeLink: bonding.getActiveLinkName(), links: bonding.getLinkHealth() });
  });
}

module.exports = { register };
