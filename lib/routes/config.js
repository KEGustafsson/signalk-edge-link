"use strict";

const { getAllPaths, PATH_CATEGORIES } = require("../pathDictionary");
const { validateSecretKey } = require("../crypto");

/**
 * Registers config routes: /paths, /plugin-config (GET+POST), /plugin-schema,
 * /config/:filename (GET+POST)
 *
 * @param {Object} router - Express router
 * @param {Object} ctx - Shared route context
 */
function register(router, ctx) {
  const {
    app, rateLimitMiddleware, requireJson, pluginRef,
    getFirstBundle, getFirstClientBundle,
    getConfigFilePath, loadConfigFile, saveConfigFile,
    managementAuthMiddleware
  } = ctx;
  const REDACTED_SECRET = "[redacted]";

  // ── Helpers for connection validation ─────────────────────────────────────

  const _isFinite = (v) => typeof v === "number" && Number.isFinite(v);
  const _isValidPort = (v, min = 1) => Number.isInteger(v) && v >= min && v <= 65535;
  const _numRange = (obj, key, min, max, label) => {
    if (obj && obj[key] !== undefined) {
      if (!_isFinite(obj[key]) || obj[key] < min || obj[key] > max) {
        return `${label} must be a number between ${min} and ${max}`;
      }
    }
    return null;
  };

  /**
   * Validate a single connection config object.
   * @param {Object} c      - connection config
   * @param {string} prefix - prefix for error messages
   * @returns {string|null} error string or null if valid
   */
  function validateOneConnection(c, prefix) {
    const p = prefix || "";

    if (c.serverType === true) { c.serverType = "server"; }
    if (c.serverType === false) { c.serverType = "client"; }

    if (c.serverType !== "server" && c.serverType !== "client") {
      return `${p}serverType must be 'server' or 'client'`;
    }

    if (c.serverType === "server") {
      if (c.congestionControl !== undefined) {
        return `${p}congestionControl is not supported in server mode`;
      }
      if (c.bonding !== undefined) {
        return `${p}bonding is not supported in server mode`;
      }
      if (c.alertThresholds !== undefined) {
        return `${p}alertThresholds is not supported in server mode`;
      }
    }

    if (!_isValidPort(c.udpPort, 1024)) {
      return `${p}udpPort must be an integer between 1024 and 65535`;
    }
    try {
      validateSecretKey(c.secretKey);
    } catch (e) {
      return `${p}${e.message}`;
    }
    if (c.protocolVersion !== undefined && c.protocolVersion !== 1 && c.protocolVersion !== 2) {
      return `${p}protocolVersion must be 1 or 2`;
    }
    if (c.useMsgpack !== undefined && typeof c.useMsgpack !== "boolean") {
      return `${p}useMsgpack must be a boolean`;
    }
    if (c.usePathDictionary !== undefined && typeof c.usePathDictionary !== "boolean") {
      return `${p}usePathDictionary must be a boolean`;
    }
    if (c.enableNotifications !== undefined && typeof c.enableNotifications !== "boolean") {
      return `${p}enableNotifications must be a boolean`;
    }
    if (c.name !== undefined && (typeof c.name !== "string" || c.name.length > 40)) {
      return `${p}name must be a string of at most 40 characters`;
    }

    if (c.serverType === "client") {
      if (!c.udpAddress || typeof c.udpAddress !== "string") {
        return `${p}udpAddress is required in client mode`;
      }
      if (!c.testAddress || typeof c.testAddress !== "string") {
        return `${p}testAddress is required in client mode`;
      }
      if (!_isValidPort(c.testPort, 1)) {
        return `${p}testPort must be between 1 and 65535 in client mode`;
      }
      const helloErr = _numRange(c, "helloMessageSender", 10, 3600, `${p}helloMessageSender`);
      if (helloErr) { return helloErr; }
      const pingErr = _numRange(c, "pingIntervalTime", 0.1, 60, `${p}pingIntervalTime`);
      if (pingErr) { return pingErr; }
    }

    if (c.alertThresholds !== undefined) {
      if (!c.alertThresholds || typeof c.alertThresholds !== "object" || Array.isArray(c.alertThresholds)) {
        return `${p}alertThresholds must be an object`;
      }
      const validMetrics = ["rtt", "packetLoss", "retransmitRate", "jitter", "queueDepth"];
      for (const [metric, threshold] of Object.entries(c.alertThresholds)) {
        if (!validMetrics.includes(metric)) {
          return `${p}alertThresholds: unknown metric '${metric}'`;
        }
        if (!threshold || typeof threshold !== "object" || Array.isArray(threshold)) {
          return `${p}alertThresholds.${metric} must be an object`;
        }
        if (threshold.warning !== undefined && !_isFinite(threshold.warning)) {
          return `${p}alertThresholds.${metric}.warning must be a finite number`;
        }
        if (threshold.critical !== undefined && !_isFinite(threshold.critical)) {
          return `${p}alertThresholds.${metric}.critical must be a finite number`;
        }
        if (threshold.warning !== undefined && threshold.critical !== undefined && threshold.warning > threshold.critical) {
          return `${p}alertThresholds.${metric}.warning must be ≤ critical`;
        }
      }
    }

    if (c.reliability !== undefined) {
      if (!c.reliability || typeof c.reliability !== "object" || Array.isArray(c.reliability)) {
        return `${p}reliability must be an object`;
      }
      const rel = c.reliability;
      const relChecks = c.serverType === "server"
        ? [
          ["ackInterval", 20, 5000, `${p}reliability.ackInterval`],
          ["ackResendInterval", 100, 10000, `${p}reliability.ackResendInterval`],
          ["nakTimeout", 20, 5000, `${p}reliability.nakTimeout`]
        ]
        : [
          ["retransmitQueueSize", 100, 50000, `${p}reliability.retransmitQueueSize`],
          ["maxRetransmits", 1, 20, `${p}reliability.maxRetransmits`],
          ["retransmitMaxAge", 1000, 300000, `${p}reliability.retransmitMaxAge`],
          ["retransmitMinAge", 200, 30000, `${p}reliability.retransmitMinAge`],
          ["retransmitRttMultiplier", 2, 20, `${p}reliability.retransmitRttMultiplier`],
          ["ackIdleDrainAge", 500, 30000, `${p}reliability.ackIdleDrainAge`],
          ["forceDrainAfterMs", 2000, 120000, `${p}reliability.forceDrainAfterMs`],
          ["recoveryBurstSize", 10, 1000, `${p}reliability.recoveryBurstSize`],
          ["recoveryBurstIntervalMs", 50, 5000, `${p}reliability.recoveryBurstIntervalMs`],
          ["recoveryAckGapMs", 500, 120000, `${p}reliability.recoveryAckGapMs`]
        ];
      for (const [key, min, max, label] of relChecks) {
        const err = _numRange(rel, key, min, max, label);
        if (err) { return err; }
      }
      if (rel.forceDrainAfterAckIdle !== undefined && typeof rel.forceDrainAfterAckIdle !== "boolean") {
        return `${p}reliability.forceDrainAfterAckIdle must be a boolean`;
      }
      if (rel.recoveryBurstEnabled !== undefined && typeof rel.recoveryBurstEnabled !== "boolean") {
        return `${p}reliability.recoveryBurstEnabled must be a boolean`;
      }
      if (rel.retransmitMinAge !== undefined && rel.retransmitMaxAge !== undefined &&
          rel.retransmitMinAge > rel.retransmitMaxAge) {
        return `${p}reliability.retransmitMinAge must be ≤ retransmitMaxAge`;
      }
    }

    if (c.bonding !== undefined) {
      if (!c.bonding || typeof c.bonding !== "object" || Array.isArray(c.bonding)) {
        return `${p}bonding must be an object`;
      }
      const bonding = c.bonding;
      if (bonding.enabled !== undefined && typeof bonding.enabled !== "boolean") {
        return `${p}bonding.enabled must be a boolean`;
      }
      if (bonding.mode !== undefined && bonding.mode !== "main-backup") {
        return `${p}bonding.mode must be 'main-backup'`;
      }
      for (const linkKey of ["primary", "backup"]) {
        if (bonding[linkKey] !== undefined) {
          const link = bonding[linkKey];
          if (!link || typeof link !== "object" || Array.isArray(link)) {
            return `${p}bonding.${linkKey} must be an object`;
          }
          if (link.address !== undefined && typeof link.address !== "string") {
            return `${p}bonding.${linkKey}.address must be a string`;
          }
          if (link.port !== undefined && !_isValidPort(link.port, 1024)) {
            return `${p}bonding.${linkKey}.port must be between 1024 and 65535`;
          }
          if (link.interface !== undefined && typeof link.interface !== "string") {
            return `${p}bonding.${linkKey}.interface must be a string`;
          }
        }
      }
      if (bonding.failover !== undefined) {
        if (!bonding.failover || typeof bonding.failover !== "object" || Array.isArray(bonding.failover)) {
          return `${p}bonding.failover must be an object`;
        }
        const foChecks = [
          ["rttThreshold", 100, 5000, `${p}bonding.failover.rttThreshold`],
          ["lossThreshold", 0.01, 0.5, `${p}bonding.failover.lossThreshold`],
          ["healthCheckInterval", 500, 10000, `${p}bonding.failover.healthCheckInterval`],
          ["failbackDelay", 5000, 300000, `${p}bonding.failover.failbackDelay`],
          ["heartbeatTimeout", 1000, 30000, `${p}bonding.failover.heartbeatTimeout`]
        ];
        for (const [key, min, max, label] of foChecks) {
          const err = _numRange(bonding.failover, key, min, max, label);
          if (err) { return err; }
        }
      }
    }

    if (c.congestionControl !== undefined) {
      if (!c.congestionControl || typeof c.congestionControl !== "object" || Array.isArray(c.congestionControl)) {
        return `${p}congestionControl must be an object`;
      }
      const cc = c.congestionControl;
      const ccChecks = [
        ["targetRTT", 50, 2000, `${p}congestionControl.targetRTT`],
        ["nominalDeltaTimer", 100, 10000, `${p}congestionControl.nominalDeltaTimer`],
        ["minDeltaTimer", 50, 1000, `${p}congestionControl.minDeltaTimer`],
        ["maxDeltaTimer", 1000, 30000, `${p}congestionControl.maxDeltaTimer`]
      ];
      for (const [key, min, max, label] of ccChecks) {
        const err = _numRange(cc, key, min, max, label);
        if (err) { return err; }
      }
      if (cc.enabled !== undefined && typeof cc.enabled !== "boolean") {
        return `${p}congestionControl.enabled must be a boolean`;
      }
      if (cc.minDeltaTimer !== undefined && cc.maxDeltaTimer !== undefined &&
          cc.minDeltaTimer > cc.maxDeltaTimer) {
        return `${p}congestionControl.minDeltaTimer must be ≤ maxDeltaTimer`;
      }
    }

    return null;
  }

  /**
   * Strip unknown / mode-inappropriate fields from a single connection config.
   */
  function sanitizeOneConnection(c) {
    const VALID_KEYS = [
      "name", "serverType", "udpPort", "secretKey", "useMsgpack", "usePathDictionary", "enableNotifications",
      "protocolVersion",
      "udpAddress", "helloMessageSender", "testAddress", "testPort", "pingIntervalTime",
      "reliability", "congestionControl", "bonding", "alertThresholds"
    ];
    const out = {};
    for (const key of VALID_KEYS) {
      if (c[key] !== undefined) { out[key] = c[key]; }
    }
    if (out.serverType === "server") {
      delete out.udpAddress;
      delete out.helloMessageSender;
      delete out.testAddress;
      delete out.testPort;
      delete out.pingIntervalTime;
      delete out.congestionControl;
      delete out.bonding;
      delete out.alertThresholds;
    }
    return out;
  }

  function redactSecretKeys(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => redactSecretKeys(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === "secretKey" ? REDACTED_SECRET : redactSecretKeys(entry);
    }
    return out;
  }

  function getPersistedConfiguration() {
    const options = (typeof app.readPluginOptions === "function" ? app.readPluginOptions() : {}) || {};
    return options.configuration || {};
  }

  function getPersistedConnections(config) {
    if (Array.isArray(config.connections)) {
      return config.connections.map((connection) => ({ ...connection }));
    }

    if (config && typeof config === "object" && config.serverType) {
      return [{ ...config }];
    }

    return [];
  }

  function restoreRedactedSecretKeys(connectionList, persistedConfig) {
    const persistedConnections = getPersistedConnections(persistedConfig);

    return connectionList.map((connection, index) => {
      if (!connection || connection.secretKey !== REDACTED_SECRET) {
        return connection;
      }

      const persisted = persistedConnections[index];
      if (!persisted || typeof persisted.secretKey !== "string" || !persisted.secretKey) {
        throw new Error(
          `connections[${index}].secretKey is redacted, but no stored secretKey exists for that connection`
        );
      }

      return {
        ...connection,
        secretKey: persisted.secretKey
      };
    });
  }

  // Signal K paths dictionary endpoint
  router.get("/paths", rateLimitMiddleware, (req, res) => {
    const paths = getAllPaths();
    const categorized = {};

    for (const [key, category] of Object.entries(PATH_CATEGORIES)) {
      categorized[key] = {
        ...category,
        paths: paths.filter((p) => p.startsWith(category.prefix))
      };
    }

    res.json({ total: paths.length, categories: categorized });
  });

  // Plugin configuration endpoint - get current config
  router.get("/plugin-config", rateLimitMiddleware, managementAuthMiddleware("config.read"), (req, res) => {
    try {
      const pluginConfig = (typeof app.readPluginOptions === "function" ? app.readPluginOptions() : {}) || {};
      res.json({
        success: true,
        configuration: redactSecretKeys(pluginConfig.configuration || {})
      });
    } catch (error) {
      app.error(`Error reading plugin config: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Plugin configuration endpoint - save config
  router.post("/plugin-config", rateLimitMiddleware, managementAuthMiddleware("config.update"), requireJson, (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ success: false, error: "Request body must be a JSON object" });
      }

      const persistedConfig = getPersistedConfiguration();
      let connectionList;
      if (Array.isArray(req.body.connections)) {
        if (req.body.connections.length === 0) {
          return res.status(400).json({ success: false, error: "connections array must contain at least one entry" });
        }
        connectionList = req.body.connections.map((c) => ({ ...c }));
      } else if (req.body.serverType) {
        connectionList = [{ ...req.body }];
      } else {
        return res.status(400).json({
          success: false,
          error: "Request body must have a 'connections' array or a top-level 'serverType' field"
        });
      }

      try {
        connectionList = restoreRedactedSecretKeys(connectionList, persistedConfig);
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }

      for (let i = 0; i < connectionList.length; i++) {
        const prefix = connectionList.length > 1 ? `connections[${i}].` : "";
        const err = validateOneConnection(connectionList[i], prefix);
        if (err) {
          return res.status(400).json({ success: false, error: err });
        }
      }

      const serverPorts = connectionList
        .filter((c) => c.serverType === "server")
        .map((c) => c.udpPort);
      const dupPort = serverPorts.find((p, i) => serverPorts.indexOf(p) !== i);
      if (dupPort !== undefined) {
        return res.status(400).json({
          success: false,
          error: `Duplicate server port ${dupPort}: each server connection must use a unique UDP port`
        });
      }

      const sanitizedConnections = connectionList.map(sanitizeOneConnection);
      const finalConfig = { connections: sanitizedConnections };

      if (typeof pluginRef._restartPlugin === "function") {
        pluginRef._restartPlugin(finalConfig);
        res.json({
          success: true,
          message: "Configuration saved. Plugin restarting...",
          restarting: true
        });
      } else {
        app.savePluginOptions(finalConfig, (err) => {
          if (err) {
            app.error(`Error saving plugin config: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
          } else {
            res.json({
              success: true,
              message: "Configuration saved. Restart plugin to apply changes.",
              restarting: false
            });
          }
        });
      }
    } catch (error) {
      app.error(`Error saving plugin config: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get schema for configuration UI
  router.get("/plugin-schema", rateLimitMiddleware, (req, res) => {
    const bundle = getFirstBundle();
    res.json({
      schema: pluginRef.schema,
      currentMode: bundle ? (bundle.state.isServerMode ? "server" : "client") : "unknown"
    });
  });

  /**
   * Middleware to check client mode and storage initialization
   */
  const clientModeMiddleware = (req, res, next) => {
    const b = getFirstClientBundle();
    if (!b) {return res.status(404).json({ error: "Not available in server mode" });}
    if (!b.state.deltaTimerFile || !b.state.subscriptionFile) {return res.status(503).json({ error: "Plugin not fully initialized" });}
    next();
  };

  // Config file routes (only available in client mode)
  router.get(
    "/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("config-file.read"),
    clientModeMiddleware,
    async (req, res) => {
    try {
      const bundle = getFirstClientBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
      const { state } = bundle;
      const filePath = getConfigFilePath(state, req.params.filename);
      if (!filePath) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      res.contentType("application/json");
      const config = await loadConfigFile(filePath);
      res.send(JSON.stringify(config || {}));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    }
  );

  router.post(
    "/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("config-file.update"),
    requireJson,
    clientModeMiddleware,
    async (req, res) => {
    try {
      const bundle = getFirstClientBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
      const { state } = bundle;
      const filePath = getConfigFilePath(state, req.params.filename);
      if (!filePath) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      const body = req.body;
      const filename = req.params.filename;

      if (filename === "delta_timer.json") {
        if (body.deltaTimer !== undefined && (typeof body.deltaTimer !== "number" || body.deltaTimer < 100 || body.deltaTimer > 10000)) {
          return res.status(400).json({ error: "deltaTimer must be a number between 100 and 10000" });
        }
      } else if (filename === "subscription.json") {
        if (body.subscribe !== undefined && !Array.isArray(body.subscribe)) {
          return res.status(400).json({ error: "subscribe must be an array" });
        }
      } else if (filename === "sentence_filter.json") {
        if (body.excludedSentences !== undefined && !Array.isArray(body.excludedSentences)) {
          return res.status(400).json({ error: "excludedSentences must be an array" });
        }
      }

      const success = await saveConfigFile(filePath, body);
      if (success) {
        res.status(200).send("OK");
      } else {
        res.status(500).send("Failed to save configuration");
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    }
  );
}

module.exports = { register };
