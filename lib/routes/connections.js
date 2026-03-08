"use strict";

const {
  validateConnectionConfig,
  sanitizeConnectionConfig,
  validateUniqueServerPorts,
  findConnectionIndexByInstanceId
} = require("../connection-config");
const { validateRuntimeConfigBody } = require("./config-validation");

/**
 * Registers multi-instance connection routes:
 *   /connections, /instances, /connections/:id/metrics, /connections/:id/network-metrics,
 *   /connections/:id/bonding, /connections/:id/congestion,
 *   /connections/:id/config/:filename, /connections/:id/monitoring/*,
 *   /connections/:id/bonding/failover
 *
 * @param {Object} router - Express router
 * @param {Object} ctx - Shared route context
 */
function register(router, ctx) {
  const {
    rateLimitMiddleware,
    requireJson,
    instanceRegistry,
    getBundleById,
    getEffectiveNetworkQuality,
    getConfigFilePath,
    loadConfigFile,
    saveConfigFile,
    buildFullMetricsResponse,
    pluginRef,
    authorizeManagement,
    managementAuthMiddleware
  } = ctx;

  function sanitizeOptions(options) {
    if (!options || typeof options !== "object") {
      return {};
    }

    const out = { ...options };
    if (Object.prototype.hasOwnProperty.call(out, "secretKey")) {
      out.secretKey = "[redacted]";
    }
    return out;
  }

  function getCurrentConnectionsConfig() {
    const options = pluginRef && pluginRef._currentOptions;
    if (options && Array.isArray(options.connections)) {
      return options.connections.map((c) => ({ ...c }));
    }

    if (options && options.serverType) {
      return [{ ...options, name: options.name || "default" }];
    }

    const all = instanceRegistry.getAll();
    return all.map((b) => ({ ...(b.state.options || {}), name: b.name }));
  }

  async function restartWithConnections(res, connections, successStatus = 200) {
    if (!pluginRef || typeof pluginRef._restartPlugin !== "function") {
      return res.status(503).json({ error: "Runtime restart handler unavailable" });
    }
    if (!Array.isArray(connections) || connections.length === 0) {
      return res.status(400).json({ error: "At least one instance must remain configured" });
    }

    const sanitizedConnections = connections.map((connection) =>
      sanitizeConnectionConfig(connection)
    );

    const currentOptions =
      pluginRef && pluginRef._currentOptions && typeof pluginRef._currentOptions === "object"
        ? pluginRef._currentOptions
        : {};
    const nextOptions = { ...currentOptions, connections: sanitizedConnections };

    await pluginRef._restartPlugin(nextOptions);
    pluginRef._currentOptions = nextOptions;
    return res.status(successStatus).json({ success: true });
  }
  router.get("/connections", rateLimitMiddleware, (req, res) => {
    try {
      const all = instanceRegistry.getAll();
      res.json(
        all.map((b) => ({
          id: b.id,
          name: b.name,
          type: b.state.isServerMode ? "server" : "client",
          port: b.state.options && b.state.options.udpPort,
          protocolVersion: b.state.options && b.state.options.protocolVersion,
          status: b.state.instanceStatus,
          healthy: b.state.isHealthy,
          readyToSend: b.state.readyToSend
        }))
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Alias for management tooling: keep shape close to the implementation plan
  // by exposing current status and a compact metrics summary.
  router.get("/instances", rateLimitMiddleware, (req, res) => {
    try {
      if (!authorizeManagement(req, res, "instances.list")) {
        return;
      }
      const all = instanceRegistry.getAll();
      const query = req.query || {};
      const stateFilter = typeof query.state === "string" ? query.state.trim() : "";
      const limitRaw = query.limit;
      const pageRaw = query.page;

      let limit = null;
      if (limitRaw !== undefined) {
        limit = Number.parseInt(limitRaw, 10);
        if (!Number.isInteger(limit) || limit <= 0) {
          return res.status(400).json({ error: "limit must be a positive integer" });
        }
      }

      let page = 1;
      if (pageRaw !== undefined) {
        page = Number.parseInt(pageRaw, 10);
        if (!Number.isInteger(page) || page <= 0) {
          return res.status(400).json({ error: "page must be a positive integer" });
        }
      }

      const mapped = all.map((b) => ({
        id: b.id,
        name: b.name,
        protocolVersion: b.state.options && b.state.options.protocolVersion,
        state: b.state.instanceStatus,
        currentLink:
          b.state.pipeline && b.state.pipeline.getBondingManager
            ? (b.state.pipeline.getBondingManager() &&
                b.state.pipeline.getBondingManager().getState().activeLink) ||
              "primary"
            : "primary",
        metrics: {
          deltasSent: b.metricsApi.metrics.deltasSent,
          deltasReceived: b.metricsApi.metrics.deltasReceived,
          udpSendErrors: b.metricsApi.metrics.udpSendErrors,
          duplicatePackets: b.metricsApi.metrics.duplicatePackets || 0
        }
      }));

      const filtered = stateFilter
        ? mapped.filter(
          (item) => String(item.state || "").toLowerCase() === stateFilter.toLowerCase()
        )
        : mapped;

      if (limit === null) {
        return res.json(filtered);
      }

      const start = (page - 1) * limit;
      const pageItems = filtered.slice(start, start + limit);
      return res.json({
        items: pageItems,
        pagination: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit)
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/instances/:id", rateLimitMiddleware, (req, res) => {
    try {
      if (!authorizeManagement(req, res, "instances.show")) {
        return;
      }
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Instance '${req.params.id}' not found` });
      }

      const { state } = bundle;
      const { metrics } = bundle.metricsApi;
      const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
      const bondingManager =
        state.pipeline && state.pipeline.getBondingManager
          ? state.pipeline.getBondingManager()
          : null;

      res.json({
        id: bundle.id,
        name: bundle.name,
        mode: state.isServerMode ? "server" : "client",
        protocolVersion: state.options && state.options.protocolVersion,
        state: state.instanceStatus,
        readyToSend: state.readyToSend,
        currentLink: bondingManager ? bondingManager.getActiveLinkName() : "primary",
        network: {
          rtt: effectiveNetwork.rtt,
          jitter: effectiveNetwork.jitter,
          packetLoss: effectiveNetwork.packetLoss,
          retransmissions: effectiveNetwork.retransmissions,
          queueDepth: effectiveNetwork.queueDepth,
          dataSource: effectiveNetwork.dataSource
        },
        metrics: {
          deltasSent: metrics.deltasSent,
          deltasReceived: metrics.deltasReceived,
          udpSendErrors: metrics.udpSendErrors,
          duplicatePackets: metrics.duplicatePackets || 0
        },
        bonding: bondingManager ? bondingManager.getState() : { enabled: false },
        config: sanitizeOptions(state.options)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/instances", rateLimitMiddleware, requireJson, (req, res) => {
    try {
      if (!authorizeManagement(req, res, "instances.create")) {
        return;
      }
      const body = req.body || {};
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }
      if (!body.name) {
        return res.status(400).json({ error: "Missing required field 'name'" });
      }

      const validationError = validateConnectionConfig(body);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const connections = getCurrentConnectionsConfig();
      connections.push(sanitizeConnectionConfig(body));

      const portError = validateUniqueServerPorts(connections);
      if (portError) {
        return res.status(400).json({ error: portError });
      }

      return restartWithConnections(res, connections, 201);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/instances/:id", rateLimitMiddleware, requireJson, (req, res) => {
    try {
      if (!authorizeManagement(req, res, "instances.update")) {
        return;
      }
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Instance '${req.params.id}' not found` });
      }

      const patch = req.body || {};
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }

      const patchKeys = Object.keys(patch);
      if (patchKeys.length === 0) {
        return res
          .status(400)
          .json({ error: "Request body must include at least one field to update" });
      }

      const connections = getCurrentConnectionsConfig();
      const idx = findConnectionIndexByInstanceId(connections, req.params.id);
      if (idx === -1) {
        return res
          .status(404)
          .json({ error: `Configuration for instance '${req.params.id}' not found` });
      }

      const immutable = new Set(["serverType", "udpPort", "secretKey"]);
      const mutableAllowed = new Set([
        "name",
        "protocolVersion",
        "useMsgpack",
        "usePathDictionary",
        "enableNotifications",
        "udpAddress",
        "helloMessageSender",
        "testAddress",
        "testPort",
        "pingIntervalTime",
        "reliability",
        "congestionControl",
        "bonding",
        "alertThresholds"
      ]);

      for (const key of patchKeys) {
        if (immutable.has(key)) {
          return res
            .status(400)
            .json({ error: `Field '${key}' is not updatable via /instances/:id` });
        }
        if (!mutableAllowed.has(key)) {
          return res
            .status(400)
            .json({ error: `Field '${key}' is not supported for /instances/:id updates` });
        }
      }

      const mergedConnection = { ...connections[idx], ...patch };
      const validationError = validateConnectionConfig(mergedConnection);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      connections[idx] = sanitizeConnectionConfig(mergedConnection);

      const portError = validateUniqueServerPorts(connections);
      if (portError) {
        return res.status(400).json({ error: portError });
      }

      return restartWithConnections(res, connections, 200);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/instances/:id", rateLimitMiddleware, (req, res) => {
    try {
      if (!authorizeManagement(req, res, "instances.delete")) {
        return;
      }
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Instance '${req.params.id}' not found` });
      }

      const connections = getCurrentConnectionsConfig();
      const idx = findConnectionIndexByInstanceId(connections, req.params.id);
      if (idx === -1) {
        return res
          .status(404)
          .json({ error: `Configuration for instance '${req.params.id}' not found` });
      }
      const next = [...connections.slice(0, idx), ...connections.slice(idx + 1)];
      return restartWithConnections(res, next, 200);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get(
    "/connections/:id/metrics",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const data = buildFullMetricsResponse(bundle);
      data.instanceId = req.params.id;
      res.json(data);
    }
  );

  router.get(
    "/connections/:id/network-metrics",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      const { metrics } = bundle.metricsApi;
      const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
      res.json({ instanceId: req.params.id, ...effectiveNetwork, timestamp: Date.now() });
    }
  );

  router.get(
    "/connections/:id/bonding",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-bonding.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      if (!state.pipeline || !state.pipeline.getBondingManager) {
        return res.json({ enabled: false });
      }
      const bonding = state.pipeline.getBondingManager();
      res.json(bonding ? bonding.getState() : { enabled: false });
    }
  );

  router.get(
    "/connections/:id/congestion",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      if (!state.pipeline || !state.pipeline.getCongestionControl) {
        return res.status(503).json({ error: "Congestion control not initialized" });
      }
      res.json(state.pipeline.getCongestionControl().getState());
    }
  );

  router.get(
    "/connections/:id/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-config.read"),
    async (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      try {
        const filePath = getConfigFilePath(state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }
        const config = await loadConfigFile(filePath);
        res.contentType("application/json").send(JSON.stringify(config || {}));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.post(
    "/connections/:id/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-config.update"),
    requireJson,
    async (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      try {
        const filePath = getConfigFilePath(state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }
        const validationError = validateRuntimeConfigBody(req.params.filename, req.body);
        if (validationError) {
          return res.status(400).json({ error: validationError });
        }
        const success = await saveConfigFile(filePath, req.body);
        res.status(success ? 200 : 500).send(success ? "OK" : "Failed to save configuration");
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  router.get(
    "/connections/:id/monitoring/alerts",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (!state.monitoring || !state.monitoring.alertManager) {
        return res.json({ thresholds: {}, activeAlerts: {} });
      }
      res.json(state.monitoring.alertManager.getState());
    }
  );

  router.get(
    "/connections/:id/monitoring/packet-loss",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
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
    }
  );

  router.get(
    "/connections/:id/monitoring/retransmissions",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-monitoring.read"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
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
    }
  );

  router.post(
    "/connections/:id/bonding/failover",
    rateLimitMiddleware,
    managementAuthMiddleware("connection-bonding.failover"),
    (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) {
        return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      }
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      if (!state.pipeline || !state.pipeline.getBondingManager) {
        return res.status(503).json({ error: "Bonding not available" });
      }
      const bonding = state.pipeline.getBondingManager();
      if (!bonding) {
        return res.status(503).json({ error: "Bonding not enabled" });
      }
      bonding.forceFailover();
      res.json({
        success: true,
        activeLink: bonding.getActiveLinkName(),
        links: bonding.getLinkHealth()
      });
    }
  );
}

module.exports = { register };
