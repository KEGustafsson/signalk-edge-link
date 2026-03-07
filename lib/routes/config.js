"use strict";

const { getAllPaths, PATH_CATEGORIES } = require("../pathDictionary");
const {
  validateConnectionConfig,
  sanitizeConnectionConfig,
  validateUniqueServerPorts
} = require("../connection-config");

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

  router.get("/paths", rateLimitMiddleware, (req, res) => {
    const paths = getAllPaths();
    const categorized = {};

    for (const [key, category] of Object.entries(PATH_CATEGORIES)) {
      categorized[key] = {
        ...category,
        paths: paths.filter((path) => path.startsWith(category.prefix))
      };
    }

    res.json({ total: paths.length, categories: categorized });
  });

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
        connectionList = req.body.connections.map((connection) => ({ ...connection }));
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

      for (let index = 0; index < connectionList.length; index++) {
        const prefix = connectionList.length > 1 ? `connections[${index}].` : "";
        const validationError = validateConnectionConfig(connectionList[index], prefix);
        if (validationError) {
          return res.status(400).json({ success: false, error: validationError });
        }
      }

      const uniquePortError = validateUniqueServerPorts(connectionList);
      if (uniquePortError) {
        return res.status(400).json({ success: false, error: uniquePortError });
      }

      const finalConfig = {
        connections: connectionList.map((connection) => sanitizeConnectionConfig(connection))
      };

      if (typeof pluginRef._restartPlugin === "function") {
        pluginRef._restartPlugin(finalConfig);
        return res.json({
          success: true,
          message: "Configuration saved. Plugin restarting...",
          restarting: true
        });
      }

      app.savePluginOptions(finalConfig, (error) => {
        if (error) {
          app.error(`Error saving plugin config: ${error.message}`);
          return res.status(500).json({ success: false, error: error.message });
        }

        return res.json({
          success: true,
          message: "Configuration saved. Restart plugin to apply changes.",
          restarting: false
        });
      });
    } catch (error) {
      app.error(`Error saving plugin config: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get("/plugin-schema", rateLimitMiddleware, (req, res) => {
    const bundle = getFirstBundle();
    res.json({
      schema: pluginRef.schema,
      currentMode: bundle ? (bundle.state.isServerMode ? "server" : "client") : "unknown"
    });
  });

  const clientModeMiddleware = (req, res, next) => {
    const bundle = getFirstClientBundle();
    if (!bundle) {return res.status(404).json({ error: "Not available in server mode" });}
    if (!bundle.state.deltaTimerFile || !bundle.state.subscriptionFile) {
      return res.status(503).json({ error: "Plugin not fully initialized" });
    }
    next();
  };

  router.get(
    "/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("config-file.read"),
    clientModeMiddleware,
    async (req, res) => {
      try {
        const bundle = getFirstClientBundle();
        if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}

        const filePath = getConfigFilePath(bundle.state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }

        res.contentType("application/json");
        const config = await loadConfigFile(filePath);
        res.send(JSON.stringify(config || {}));
      } catch (error) {
        res.status(500).json({ error: error.message });
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

        const filePath = getConfigFilePath(bundle.state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }

        const body = req.body;
        const filename = req.params.filename;

        if (filename === "delta_timer.json") {
          if (
            body.deltaTimer !== undefined &&
            (typeof body.deltaTimer !== "number" || body.deltaTimer < 100 || body.deltaTimer > 10000)
          ) {
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
          return res.status(200).send("OK");
        }

        return res.status(500).send("Failed to save configuration");
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  );
}

module.exports = { register };
