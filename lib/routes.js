"use strict";

const { readFile, writeFile } = require("fs").promises;
const { getAllPaths, PATH_CATEGORIES } = require("./pathDictionary");
const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS } = require("./constants");

/**
 * Creates the HTTP route handlers for the plugin's REST API.
 * @param {Object} app - SignalK app object
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @param {Object} pluginRef - Reference to plugin object (for schema access)
 * @returns {Object} Routes API
 */
function createRoutes(app, state, metricsApi, pluginRef) {
  const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = metricsApi;

  // Rate limiting state
  const rateLimitMap = new Map();
  let rateLimitCleanupInterval;

  /**
   * Simple rate limiting check
   * @param {string} ip - Client IP address
   * @returns {boolean} True if request should be allowed
   */
  function checkRateLimit(ip) {
    const now = Date.now();
    const clientData = rateLimitMap.get(ip);

    if (!clientData || now > clientData.resetTime) {
      rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      return true;
    }

    if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }

    clientData.count++;
    return true;
  }

  /**
   * Starts the rate limit cleanup interval
   */
  function startRateLimitCleanup() {
    if (rateLimitCleanupInterval) {
      clearInterval(rateLimitCleanupInterval);
    }
    rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of rateLimitMap.entries()) {
        if (now > data.resetTime) {
          rateLimitMap.delete(ip);
        }
      }
    }, RATE_LIMIT_WINDOW);
  }

  /**
   * Stops the rate limit cleanup interval and clears state
   */
  function stopRateLimitCleanup() {
    clearInterval(rateLimitCleanupInterval);
    rateLimitCleanupInterval = null;
    rateLimitMap.clear();
  }

  /**
   * Resolves a config filename to its full file path
   * @param {string} filename - Config filename
   * @returns {string|null} Full file path or null if invalid
   */
  function getConfigFilePath(filename) {
    switch (filename) {
      case "delta_timer.json": return state.deltaTimerFile;
      case "subscription.json": return state.subscriptionFile;
      case "sentence_filter.json": return state.sentenceFilterFile;
      default: return null;
    }
  }

  /**
   * Loads a configuration file from persistent storage
   * @param {string} filePath - Full path to the config file
   * @returns {Promise<Object|null>} Parsed JSON or null
   */
  async function loadConfigFile(filePath) {
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch (err) {
      app.debug(`Config file not found or error loading ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Saves configuration data to persistent storage
   * @param {string} filePath - Full path to the config file
   * @param {Object} data - Configuration data to save
   * @returns {Promise<boolean>} True if successful
   */
  async function saveConfigFile(filePath, data) {
    try {
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      app.debug(`Configuration saved to ${filePath}`);
      return true;
    } catch (err) {
      app.error(`Error saving ${filePath}: ${err.message}`);
      return false;
    }
  }

  /**
   * Registers all HTTP routes with the Express router
   * @param {Object} router - Express router instance
   */
  function registerWithRouter(router) {
    /**
     * Content-Type validation middleware for JSON POST endpoints
     */
    const requireJson = (req, res, next) => {
      const contentType = req.headers["content-type"];
      if (!contentType || !contentType.includes("application/json")) {
        return res.status(415).json({ error: "Content-Type must be application/json" });
      }
      next();
    };

    /**
     * Rate limiting middleware for API endpoints
     */
    const rateLimitMiddleware = (req, res, next) => {
      const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
      if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: "Too many requests, please try again later" });
      }
      next();
    };

    // Metrics endpoint (available in both client and server mode)
    router.get("/metrics", rateLimitMiddleware, (req, res) => {
      updateBandwidthRates(state.isServerMode);

      const uptime = Date.now() - metrics.startTime;
      const uptimeSeconds = Math.floor(uptime / 1000);
      const uptimeMinutes = Math.floor(uptimeSeconds / 60);
      const uptimeHours = Math.floor(uptimeMinutes / 60);

      const pathStatsArray = getTopNPaths(50, uptimeSeconds);

      const totalPathBytes = pathStatsArray.reduce((sum, p) => sum + p.bytes, 0);
      pathStatsArray.forEach((p) => {
        p.percentage = totalPathBytes > 0 ? Math.round((p.bytes / totalPathBytes) * 100) : 0;
      });

      const metricsData = {
        uptime: {
          milliseconds: uptime,
          seconds: uptimeSeconds,
          formatted: `${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`
        },
        mode: state.isServerMode ? "server" : "client",
        stats: {
          deltasSent: metrics.deltasSent,
          deltasReceived: metrics.deltasReceived,
          udpSendErrors: metrics.udpSendErrors,
          udpRetries: metrics.udpRetries,
          compressionErrors: metrics.compressionErrors,
          encryptionErrors: metrics.encryptionErrors,
          subscriptionErrors: metrics.subscriptionErrors
        },
        status: {
          readyToSend: state.readyToSend,
          deltasBuffered: state.deltas.length
        },
        bandwidth: (() => {
          const packets = state.isServerMode ? metrics.bandwidth.packetsIn : metrics.bandwidth.packetsOut;
          const bytes = state.isServerMode ? metrics.bandwidth.bytesIn : metrics.bandwidth.bytesOut;
          const avgPacketSize = packets > 0 ? Math.round(bytes / packets) : 0;

          return {
            bytesOut: metrics.bandwidth.bytesOut,
            bytesIn: metrics.bandwidth.bytesIn,
            bytesOutRaw: metrics.bandwidth.bytesOutRaw,
            bytesInRaw: metrics.bandwidth.bytesInRaw,
            bytesOutFormatted: formatBytes(metrics.bandwidth.bytesOut),
            bytesInFormatted: formatBytes(metrics.bandwidth.bytesIn),
            bytesOutRawFormatted: formatBytes(metrics.bandwidth.bytesOutRaw),
            packetsOut: metrics.bandwidth.packetsOut,
            packetsIn: metrics.bandwidth.packetsIn,
            rateOut: metrics.bandwidth.rateOut,
            rateIn: metrics.bandwidth.rateIn,
            rateOutFormatted: formatBytes(metrics.bandwidth.rateOut) + "/s",
            rateInFormatted: formatBytes(metrics.bandwidth.rateIn) + "/s",
            compressionRatio: metrics.bandwidth.compressionRatio,
            avgPacketSize,
            avgPacketSizeFormatted: avgPacketSize > 0 ? formatBytes(avgPacketSize) : "0 B",
            history: metrics.bandwidth.history.toArray().slice(-30)
          };
        })(),
        pathStats: pathStatsArray,
        pathCategories: PATH_CATEGORIES,
        smartBatching: state.isServerMode
          ? null
          : {
            earlySends: metrics.smartBatching.earlySends,
            timerSends: metrics.smartBatching.timerSends,
            oversizedPackets: metrics.smartBatching.oversizedPackets,
            avgBytesPerDelta: metrics.smartBatching.avgBytesPerDelta,
            maxDeltasPerBatch: metrics.smartBatching.maxDeltasPerBatch
          },
        lastError: metrics.lastError
          ? {
            message: metrics.lastError,
            timestamp: metrics.lastErrorTime,
            timeAgo: metrics.lastErrorTime ? Date.now() - metrics.lastErrorTime : null
          }
          : null
      };

      res.json(metricsData);
    });

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
    router.get("/plugin-config", rateLimitMiddleware, (req, res) => {
      try {
        const pluginConfig = app.readPluginOptions();
        res.json({
          success: true,
          configuration: pluginConfig.configuration || {}
        });
      } catch (error) {
        app.error(`Error reading plugin config: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Plugin configuration endpoint - save config
    router.post("/plugin-config", rateLimitMiddleware, requireJson, (req, res) => {
      try {
        const newConfig = req.body;

        if (!newConfig.serverType) {
          return res.status(400).json({ success: false, error: "serverType is required" });
        }
        if (!newConfig.udpPort || newConfig.udpPort < 1024 || newConfig.udpPort > 65535) {
          return res.status(400).json({ success: false, error: "Valid udpPort (1024-65535) is required" });
        }
        if (!newConfig.secretKey || newConfig.secretKey.length !== 32) {
          return res.status(400).json({ success: false, error: "secretKey must be exactly 32 characters" });
        }

        if (newConfig.serverType === "client") {
          if (!newConfig.udpAddress) {
            return res.status(400).json({ success: false, error: "udpAddress is required in client mode" });
          }
          if (!newConfig.testAddress) {
            return res.status(400).json({ success: false, error: "testAddress is required in client mode" });
          }
          if (!newConfig.testPort) {
            return res.status(400).json({ success: false, error: "testPort is required in client mode" });
          }
        }

        // Sanitize: only keep known configuration properties to prevent
        // stale or unknown fields from accumulating in the saved config
        const VALID_CONFIG_KEYS = [
          "serverType", "udpPort", "secretKey", "useMsgpack", "usePathDictionary",
          "udpAddress", "helloMessageSender", "testAddress", "testPort", "pingIntervalTime"
        ];
        const sanitizedConfig = {};
        for (const key of VALID_CONFIG_KEYS) {
          if (newConfig[key] !== undefined) {
            sanitizedConfig[key] = newConfig[key];
          }
        }

        // Remove client-only fields when saving in server mode
        if (sanitizedConfig.serverType === "server") {
          delete sanitizedConfig.udpAddress;
          delete sanitizedConfig.helloMessageSender;
          delete sanitizedConfig.testAddress;
          delete sanitizedConfig.testPort;
          delete sanitizedConfig.pingIntervalTime;
        }

        // Save configuration and restart plugin to apply changes.
        // SignalK's restartPlugin(config) saves the config to disk AND
        // triggers stop/start. If restartPlugin is not available (plugin
        // not started yet), fall back to savePluginOptions only.
        if (typeof state.restartPlugin === "function") {
          state.restartPlugin(sanitizedConfig);
          res.json({
            success: true,
            message: "Configuration saved. Plugin restarting...",
            restarting: true
          });
        } else {
          app.savePluginOptions(sanitizedConfig, (err) => {
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
      res.json({
        schema: pluginRef.schema,
        currentMode: state.isServerMode ? "server" : "client"
      });
    });

    /**
     * Middleware to check client mode and storage initialization
     */
    const clientModeMiddleware = (req, res, next) => {
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }
      if (!state.deltaTimerFile || !state.subscriptionFile) {
        return res.status(503).json({ error: "Plugin not fully initialized" });
      }
      next();
    };

    // Config routes (only available in client mode)
    router.get("/config/:filename", rateLimitMiddleware, clientModeMiddleware, async (req, res) => {
      const filePath = getConfigFilePath(req.params.filename);
      if (!filePath) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      res.contentType("application/json");
      const config = await loadConfigFile(filePath);
      res.send(JSON.stringify(config || {}));
    });

    router.post("/config/:filename", rateLimitMiddleware, requireJson, clientModeMiddleware, async (req, res) => {
      const filePath = getConfigFilePath(req.params.filename);
      if (!filePath) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      const success = await saveConfigFile(filePath, req.body);
      if (success) {
        res.status(200).send("OK");
      } else {
        res.status(500).send("Failed to save configuration");
      }
    });
  }

  return {
    registerWithRouter,
    loadConfigFile,
    saveConfigFile,
    startRateLimitCleanup,
    stopRateLimitCleanup
  };
}

module.exports = createRoutes;
