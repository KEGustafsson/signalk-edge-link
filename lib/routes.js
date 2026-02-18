"use strict";

const { readFile, writeFile } = require("fs").promises;
const { getAllPaths, PATH_CATEGORIES } = require("./pathDictionary");
const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS } = require("./constants");
const { formatPrometheusMetrics } = require("./prometheus");

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
   * Returns the active metrics publisher from the v2 client or server pipeline
   * @returns {Object|null} MetricsPublisher instance or null
   */
  function getActiveMetricsPublisher() {
    if (state.pipeline && state.pipeline.getMetricsPublisher) {
      return state.pipeline.getMetricsPublisher();
    }
    if (state.pipelineServer && state.pipelineServer.getMetricsPublisher) {
      return state.pipelineServer.getMetricsPublisher();
    }
    return null;
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
        protocolVersion: (state.options && state.options.protocolVersion) || 1,
        stats: {
          deltasSent: metrics.deltasSent,
          deltasReceived: metrics.deltasReceived,
          udpSendErrors: metrics.udpSendErrors,
          udpRetries: metrics.udpRetries,
          compressionErrors: metrics.compressionErrors,
          encryptionErrors: metrics.encryptionErrors,
          subscriptionErrors: metrics.subscriptionErrors,
          duplicatePackets: metrics.duplicatePackets || 0
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
        networkQuality: (() => {
          const networkData = {
            rtt: metrics.rtt || 0,
            jitter: metrics.jitter || 0,
            retransmissions: metrics.retransmissions || 0,
            queueDepth: metrics.queueDepth || 0,
            acksSent: metrics.acksSent || 0,
            naksSent: metrics.naksSent || 0
          };

          // Calculate link quality if a v2 pipeline has a metrics publisher
          const publisher = getActiveMetricsPublisher();
          if (publisher) {
            const retransmitRate = metrics.bandwidth.packetsOut > 0 ?
              (metrics.retransmissions || 0) / metrics.bandwidth.packetsOut : 0;

            networkData.linkQuality = publisher.calculateLinkQuality({
              rtt: metrics.rtt || 0,
              jitter: metrics.jitter || 0,
              packetLoss: 0,
              retransmitRate: retransmitRate
            });
          }

          return networkData;
        })(),
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

    /**
     * GET /plugins/signalk-edge-link/network-metrics
     * Returns current network quality metrics including link quality score
     */
    router.get("/network-metrics", rateLimitMiddleware, (req, res) => {
      try {
        const networkMetrics = {
          rtt: metrics.rtt || 0,
          jitter: metrics.jitter || 0,
          retransmissions: metrics.retransmissions || 0,
          queueDepth: metrics.queueDepth || 0,
          acksSent: metrics.acksSent || 0,
          naksSent: metrics.naksSent || 0,
          timestamp: Date.now()
        };

        // Calculate link quality if a v2 pipeline has a metrics publisher
        const nmPublisher = getActiveMetricsPublisher();
        if (nmPublisher) {
          const retransmitRate = metrics.bandwidth.packetsOut > 0 ?
            (metrics.retransmissions || 0) / metrics.bandwidth.packetsOut : 0;

          networkMetrics.linkQuality = nmPublisher.calculateLinkQuality({
            rtt: metrics.rtt || 0,
            jitter: metrics.jitter || 0,
            packetLoss: 0,
            retransmitRate: retransmitRate
          });
        }

        res.json(networkMetrics);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/congestion
     * Returns current congestion control state
     */
    router.get("/congestion", rateLimitMiddleware, (req, res) => {
      try {
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        if (!state.pipeline || !state.pipeline.getCongestionControl) {
          return res.status(503).json({ error: "Congestion control not initialized" });
        }

        const cc = state.pipeline.getCongestionControl();
        res.json(cc.getState());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /plugins/signalk-edge-link/delta-timer
     * Manually set delta timer value (disables congestion control auto-adjustment)
     *
     * Body: { "value": 500 }
     * To re-enable auto mode: { "mode": "auto" }
     */
    router.post("/delta-timer", rateLimitMiddleware, requireJson, (req, res) => {
      try {
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        const { value, mode } = req.body;

        // Re-enable automatic congestion control
        if (mode === "auto") {
          if (state.pipeline && state.pipeline.getCongestionControl) {
            state.pipeline.getCongestionControl().enableAutoMode();
            return res.json({
              deltaTimer: state.pipeline.getCongestionControl().getCurrentDeltaTimer(),
              mode: "auto"
            });
          }
          return res.status(503).json({ error: "Congestion control not initialized" });
        }

        // Manual override
        if (value === undefined || typeof value !== "number") {
          return res.status(400).json({ error: "value must be a number" });
        }

        if (value < 100 || value > 10000) {
          return res.status(400).json({ error: "Invalid timer value. Must be between 100 and 10000ms" });
        }

        // Set manual override on congestion control
        if (state.pipeline && state.pipeline.getCongestionControl) {
          state.pipeline.getCongestionControl().setManualDeltaTimer(value);
        }

        // Update shared state delta timer
        state.deltaTimerTime = value;

        res.json({ deltaTimer: value, mode: "manual" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/bonding
     * Returns current bonding state including per-link health
     */
    router.get("/bonding", rateLimitMiddleware, (req, res) => {
      try {
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        if (!state.pipeline || !state.pipeline.getBondingManager) {
          return res.status(503).json({ error: "Bonding not available" });
        }

        const bonding = state.pipeline.getBondingManager();
        if (!bonding) {
          return res.json({ enabled: false });
        }

        res.json(bonding.getState());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /plugins/signalk-edge-link/bonding/failover
     * Manually trigger failover to the other link
     */
    router.post("/bonding/failover", rateLimitMiddleware, (req, res) => {
      try {
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
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/prometheus
     * Returns metrics in Prometheus text exposition format
     */
    router.get("/prometheus", rateLimitMiddleware, (req, res) => {
      try {
        updateBandwidthRates(state.isServerMode);

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

        // Link quality from metrics publisher
        const promPublisher = getActiveMetricsPublisher();
        if (promPublisher) {
          const retransmitRate = metrics.bandwidth.packetsOut > 0 ?
            (metrics.retransmissions || 0) / metrics.bandwidth.packetsOut : 0;
          extra.linkQuality = promPublisher.calculateLinkQuality({
            rtt: metrics.rtt || 0,
            jitter: metrics.jitter || 0,
            packetLoss: 0,
            retransmitRate
          });
        }

        // Bonding metrics
        if (state.pipeline && state.pipeline.getBondingManager) {
          const bonding = state.pipeline.getBondingManager();
          if (bonding) {
            extra.bonding = bonding.getState();
          }
        }

        const text = formatPrometheusMetrics(metrics, state, extra);
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(text);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/packet-loss
     * Returns packet loss heatmap data for visualization
     */
    router.get("/monitoring/packet-loss", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetLossTracker) {
          return res.json({ heatmap: [], summary: { overallLossRate: 0, maxLossRate: 0, trend: "stable", bucketCount: 0 } });
        }
        res.json({
          heatmap: state.monitoring.packetLossTracker.getHeatmapData(),
          summary: state.monitoring.packetLossTracker.getSummary()
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/path-latency
     * Returns per-path latency tracking data
     */
    router.get("/monitoring/path-latency", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.pathLatencyTracker) {
          return res.json({ paths: [] });
        }
        const topN = parseInt(req.query.limit, 10) || 20;
        res.json({
          paths: state.monitoring.pathLatencyTracker.getAllStats(topN)
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/retransmissions
     * Returns retransmission rate chart data
     */
    router.get("/monitoring/retransmissions", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.retransmissionTracker) {
          return res.json({ chartData: [], summary: { avgRate: 0, maxRate: 0, currentRate: 0, entries: 0 } });
        }
        const limit = parseInt(req.query.limit, 10) || undefined;
        res.json({
          chartData: state.monitoring.retransmissionTracker.getChartData(limit),
          summary: state.monitoring.retransmissionTracker.getSummary()
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/alerts
     * Returns current alert thresholds and active alerts
     */
    router.get("/monitoring/alerts", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.alertManager) {
          return res.json({ thresholds: {}, activeAlerts: {} });
        }
        res.json(state.monitoring.alertManager.getState());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /plugins/signalk-edge-link/monitoring/alerts
     * Update alert thresholds
     * Body: { "metric": "rtt", "warning": 300, "critical": 800 }
     */
    router.post("/monitoring/alerts", rateLimitMiddleware, requireJson, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.alertManager) {
          return res.status(503).json({ error: "Alert manager not initialized" });
        }

        const { metric, warning, critical } = req.body;
        if (!metric) {
          return res.status(400).json({ error: "metric is required" });
        }

        const update = {};
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
        if (update.warning !== undefined && update.critical !== undefined && update.warning > update.critical) {
          return res.status(400).json({ error: "warning must be less than or equal to critical" });
        }

        state.monitoring.alertManager.setThreshold(metric, update);

        // Keep runtime options in sync and persist best-effort without restart.
        if (state.options) {
          if (!state.options.alertThresholds || typeof state.options.alertThresholds !== "object") {
            state.options.alertThresholds = {};
          }
          state.options.alertThresholds[metric] = {
            ...(state.options.alertThresholds[metric] || {}),
            ...update
          };
        }

        if (typeof app.readPluginOptions === "function" && typeof app.savePluginOptions === "function") {
          try {
            const pluginOptions = app.readPluginOptions() || {};
            const currentConfig = pluginOptions.configuration || {};
            const persistedThresholds = {
              ...(currentConfig.alertThresholds || {}),
              ...((state.options && state.options.alertThresholds) || {})
            };
            app.savePluginOptions(
              { ...currentConfig, alertThresholds: persistedThresholds },
              (saveErr) => {
                if (saveErr) {
                  app.error(`Failed to persist alert thresholds: ${saveErr.message}`);
                }
              }
            );
          } catch (persistErr) {
            app.error(`Failed to persist alert thresholds: ${persistErr.message}`);
          }
        }

        res.json({
          success: true,
          thresholds: state.monitoring.alertManager.getState().thresholds
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/capture
     * Returns packet capture statistics
     */
    router.get("/capture", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.json({ enabled: false, captured: 0, dropped: 0, buffered: 0 });
        }
        res.json(state.monitoring.packetCapture.getStats());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /plugins/signalk-edge-link/capture/start
     * Start packet capture
     */
    router.post("/capture/start", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        state.monitoring.packetCapture.start();
        res.json({ success: true, enabled: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /plugins/signalk-edge-link/capture/stop
     * Stop packet capture
     */
    router.post("/capture/stop", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        state.monitoring.packetCapture.stop();
        res.json({ success: true, enabled: false });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/capture/export
     * Export captured packets as .pcap file
     */
    router.get("/capture/export", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetCapture) {
          return res.status(503).json({ error: "Packet capture not initialized" });
        }
        const pcapBuffer = state.monitoring.packetCapture.exportPcap();
        res.set("Content-Type", "application/vnd.tcpdump.pcap");
        res.set("Content-Disposition", `attachment; filename="edge-link-capture-${Date.now()}.pcap"`);
        res.send(pcapBuffer);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/inspector
     * Returns packet inspector statistics
     */
    router.get("/monitoring/inspector", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.monitoring || !state.monitoring.packetInspector) {
          return res.json({ enabled: false, packetsInspected: 0, clientsConnected: 0 });
        }
        res.json(state.monitoring.packetInspector.getStats());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /plugins/signalk-edge-link/monitoring/simulation
     * Returns current network simulation state (testing mode)
     */
    router.get("/monitoring/simulation", rateLimitMiddleware, (req, res) => {
      try {
        if (!state.networkSimulator) {
          return res.json({ enabled: false });
        }
        res.json({
          enabled: true,
          conditions: state.networkSimulator.getConditions(),
          stats: state.networkSimulator.getStats()
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
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
        const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
        const validateNumberRange = (obj, key, min, max, label) => {
          if (obj && obj[key] !== undefined) {
            if (!isFiniteNumber(obj[key]) || obj[key] < min || obj[key] > max) {
              return `${label} must be a number between ${min} and ${max}`;
            }
          }
          return null;
        };

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
          if (
            !isFiniteNumber(newConfig.testPort) ||
            newConfig.testPort < 1 ||
            newConfig.testPort > 65535
          ) {
            return res.status(400).json({ success: false, error: "testPort must be between 1 and 65535 in client mode" });
          }

          const helloErr = validateNumberRange(
            newConfig,
            "helloMessageSender",
            10,
            3600,
            "helloMessageSender"
          );
          if (helloErr) {
            return res.status(400).json({ success: false, error: helloErr });
          }

          const pingErr = validateNumberRange(
            newConfig,
            "pingIntervalTime",
            0.1,
            60,
            "pingIntervalTime"
          );
          if (pingErr) {
            return res.status(400).json({ success: false, error: pingErr });
          }
        }

        // Validate optional reliability settings (mode-specific)
        if (newConfig.reliability !== undefined) {
          if (!newConfig.reliability || typeof newConfig.reliability !== "object" || Array.isArray(newConfig.reliability)) {
            return res.status(400).json({ success: false, error: "reliability must be an object" });
          }

          const reliability = newConfig.reliability;
          const reliabilityChecks = newConfig.serverType === "server"
            ? [
              ["ackInterval", 20, 5000, "reliability.ackInterval"],
              ["ackResendInterval", 100, 10000, "reliability.ackResendInterval"],
              ["nakTimeout", 20, 5000, "reliability.nakTimeout"]
            ]
            : [
              ["retransmitQueueSize", 100, 50000, "reliability.retransmitQueueSize"],
              ["maxRetransmits", 1, 20, "reliability.maxRetransmits"],
              ["retransmitMaxAge", 1000, 300000, "reliability.retransmitMaxAge"],
              ["retransmitMinAge", 200, 30000, "reliability.retransmitMinAge"],
              ["retransmitRttMultiplier", 2, 20, "reliability.retransmitRttMultiplier"],
              ["ackIdleDrainAge", 500, 30000, "reliability.ackIdleDrainAge"],
              ["forceDrainAfterMs", 2000, 120000, "reliability.forceDrainAfterMs"],
              ["recoveryBurstSize", 10, 1000, "reliability.recoveryBurstSize"],
              ["recoveryBurstIntervalMs", 50, 5000, "reliability.recoveryBurstIntervalMs"],
              ["recoveryAckGapMs", 500, 120000, "reliability.recoveryAckGapMs"]
            ];

          for (const [key, min, max, label] of reliabilityChecks) {
            const err = validateNumberRange(reliability, key, min, max, label);
            if (err) {
              return res.status(400).json({ success: false, error: err });
            }
          }

          if (
            reliability.forceDrainAfterAckIdle !== undefined &&
            typeof reliability.forceDrainAfterAckIdle !== "boolean"
          ) {
            return res.status(400).json({
              success: false,
              error: "reliability.forceDrainAfterAckIdle must be a boolean"
            });
          }

          if (
            reliability.recoveryBurstEnabled !== undefined &&
            typeof reliability.recoveryBurstEnabled !== "boolean"
          ) {
            return res.status(400).json({
              success: false,
              error: "reliability.recoveryBurstEnabled must be a boolean"
            });
          }

          if (
            reliability.retransmitMinAge !== undefined &&
            reliability.retransmitMaxAge !== undefined &&
            reliability.retransmitMinAge > reliability.retransmitMaxAge
          ) {
            return res.status(400).json({
              success: false,
              error: "reliability.retransmitMinAge must be less than or equal to reliability.retransmitMaxAge"
            });
          }
        }

        // Validate optional congestion control settings
        if (newConfig.congestionControl !== undefined) {
          if (
            !newConfig.congestionControl ||
            typeof newConfig.congestionControl !== "object" ||
            Array.isArray(newConfig.congestionControl)
          ) {
            return res.status(400).json({ success: false, error: "congestionControl must be an object" });
          }

          const cc = newConfig.congestionControl;
          const ccChecks = [
            ["targetRTT", 50, 2000, "congestionControl.targetRTT"],
            ["nominalDeltaTimer", 100, 10000, "congestionControl.nominalDeltaTimer"],
            ["minDeltaTimer", 50, 1000, "congestionControl.minDeltaTimer"],
            ["maxDeltaTimer", 1000, 30000, "congestionControl.maxDeltaTimer"]
          ];

          for (const [key, min, max, label] of ccChecks) {
            const err = validateNumberRange(cc, key, min, max, label);
            if (err) {
              return res.status(400).json({ success: false, error: err });
            }
          }

          if (cc.enabled !== undefined && typeof cc.enabled !== "boolean") {
            return res.status(400).json({ success: false, error: "congestionControl.enabled must be a boolean" });
          }

          if (
            cc.minDeltaTimer !== undefined &&
            cc.maxDeltaTimer !== undefined &&
            cc.minDeltaTimer > cc.maxDeltaTimer
          ) {
            return res.status(400).json({
              success: false,
              error: "congestionControl.minDeltaTimer must be less than or equal to congestionControl.maxDeltaTimer"
            });
          }
        }

        // Sanitize: only keep known configuration properties to prevent
        // stale or unknown fields from accumulating in the saved config
        const VALID_CONFIG_KEYS = [
          "serverType", "udpPort", "secretKey", "useMsgpack", "usePathDictionary",
          "protocolVersion",
          "udpAddress", "helloMessageSender", "testAddress", "testPort", "pingIntervalTime",
          "reliability", "congestionControl", "bonding", "alertThresholds"
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

      // Validate config content based on filename
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
