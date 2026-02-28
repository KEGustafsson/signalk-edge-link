"use strict";

const { getAllPaths, PATH_CATEGORIES } = require("./pathDictionary");
const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS } = require("./constants");
const { formatPrometheusMetrics } = require("./prometheus");
const { validateSecretKey } = require("./crypto");
const { loadConfigFile: loadConfigFileShared, saveConfigFile: saveConfigFileShared } = require("./config-io");

/**
 * Creates the HTTP route handlers for the plugin's REST API.
 * @param {Object} app - SignalK app object
 * @param {Object} instanceRegistry - Registry providing access to active plugin instances
 * @param {Object} pluginRef - Reference to plugin object (for schema access)
 * @returns {Object} Routes API
 */
function createRoutes(app, instanceRegistry, pluginRef) {
  const REMOTE_TELEMETRY_TTL_MS = 15000;

  function getFirstBundle() {
    return instanceRegistry.getFirst() || null;
  }

  function getBundleById(id) {
    return instanceRegistry.get(id) || null;
  }

  /**
   * Find the first client-mode instance.
   * Used by legacy flat routes (/config/:filename) so they don't fail when the
   * first instance happens to be a server.
   */
  function getFirstClientBundle() {
    for (const bundle of instanceRegistry.getAll()) {
      if (!bundle.state.isServerMode) { return bundle; }
    }
    return null;
  }

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
   * @param {Object} state - Instance state
   * @param {string} filename - Config filename
   * @returns {string|null} Full file path or null if invalid
   */
  function getConfigFilePath(state, filename) {
    switch (filename) {
      case "delta_timer.json": return state.deltaTimerFile;
      case "subscription.json": return state.subscriptionFile;
      case "sentence_filter.json": return state.sentenceFilterFile;
      default: return null;
    }
  }

  function loadConfigFile(filePath) {
    return loadConfigFileShared(filePath, app);
  }

  function saveConfigFile(filePath, data) {
    return saveConfigFileShared(filePath, data, app);
  }

  /**
   * Returns the active metrics publisher from the v2 client or server pipeline
   * @param {Object} state - Instance state
   * @returns {Object|null} MetricsPublisher instance or null
   */
  function getActiveMetricsPublisher(state) {
    if (state.pipeline && state.pipeline.getMetricsPublisher) {
      return state.pipeline.getMetricsPublisher();
    }
    if (state.pipelineServer && state.pipelineServer.getMetricsPublisher) {
      return state.pipelineServer.getMetricsPublisher();
    }
    return null;
  }

  /**
   * Returns the effective network quality snapshot for API/UI.
   * In server mode, prefers recent client-reported telemetry.
   *
   * @param {Object} state - Instance state
   * @param {Object} metrics - Metrics object
   * @param {number} [now]
   * @returns {Object}
   */
  function getEffectiveNetworkQuality(state, metrics, now = Date.now()) {
    const remote = metrics.remoteNetworkQuality || {};
    const hasFreshRemote =
      state.isServerMode &&
      Number.isFinite(remote.lastUpdate) &&
      remote.lastUpdate > 0 &&
      (now - remote.lastUpdate) <= REMOTE_TELEMETRY_TTL_MS;

    const clientRetransmitRate = metrics.bandwidth.packetsOut > 0
      ? (metrics.retransmissions || 0) / metrics.bandwidth.packetsOut
      : 0;
    const hasOnlyLocalServerValues = state.isServerMode && !hasFreshRemote;

    return {
      rtt: hasFreshRemote ? (remote.rtt ?? 0) : (hasOnlyLocalServerValues ? 0 : (metrics.rtt ?? 0)),
      jitter: hasFreshRemote ? (remote.jitter ?? 0) : (hasOnlyLocalServerValues ? 0 : (metrics.jitter ?? 0)),
      packetLoss: hasFreshRemote ? (remote.packetLoss ?? 0) : (metrics.packetLoss ?? 0),
      retransmissions: hasFreshRemote ? (remote.retransmissions ?? 0) : (hasOnlyLocalServerValues ? 0 : (metrics.retransmissions ?? 0)),
      queueDepth: hasFreshRemote ? (remote.queueDepth ?? 0) : (hasOnlyLocalServerValues ? 0 : (metrics.queueDepth ?? 0)),
      retransmitRate: hasFreshRemote ? (remote.retransmitRate ?? 0) : (hasOnlyLocalServerValues ? 0 : clientRetransmitRate),
      activeLink: hasFreshRemote ? (remote.activeLink ?? "primary") : "primary",
      dataSource: hasFreshRemote ? "remote-client" : "local",
      lastUpdate: hasFreshRemote ? remote.lastUpdate : 0
    };
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
      const clientIp = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
      if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: "Too many requests, please try again later" });
      }
      next();
    };

    /**
     * Build the full metrics response object for a given bundle.
     * Shared by GET /metrics and GET /connections/:id/metrics.
     */
    function buildFullMetricsResponse(bundle) {
      const { state } = bundle;
      const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
          const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
          const networkData = {
            rtt: effectiveNetwork.rtt,
            jitter: effectiveNetwork.jitter,
            packetLoss: effectiveNetwork.packetLoss,
            retransmissions: effectiveNetwork.retransmissions,
            queueDepth: effectiveNetwork.queueDepth,
            acksSent: metrics.acksSent || 0,
            naksSent: metrics.naksSent || 0,
            dataSource: effectiveNetwork.dataSource
          };
          if (state.isServerMode && effectiveNetwork.lastUpdate > 0) {
            networkData.lastRemoteUpdate = effectiveNetwork.lastUpdate;
          }
          if (state.isServerMode) {
            networkData.activeLink = effectiveNetwork.activeLink;
          }

          // Calculate link quality if a v2 pipeline has a metrics publisher
          const publisher = getActiveMetricsPublisher(state);
          if (publisher) {
            networkData.linkQuality = publisher.calculateLinkQuality({
              rtt: effectiveNetwork.rtt,
              jitter: effectiveNetwork.jitter,
              packetLoss: effectiveNetwork.packetLoss,
              retransmitRate: effectiveNetwork.retransmitRate
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

      return metricsData;
    }

    // Metrics endpoint (available in both client and server mode)
    router.get("/metrics", rateLimitMiddleware, (req, res) => {
      const bundle = getFirstBundle();
      if (!bundle) return res.status(503).json({ error: "Plugin not started" });
      res.json(buildFullMetricsResponse(bundle));
    });

    /**
     * GET /plugins/signalk-edge-link/network-metrics
     * Returns current network quality metrics including link quality score
     */
    router.get("/network-metrics", rateLimitMiddleware, (req, res) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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

        // Calculate link quality if a v2 pipeline has a metrics publisher
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

    /**
     * GET /plugins/signalk-edge-link/congestion
     * Returns current congestion control state
     */
    router.get("/congestion", rateLimitMiddleware, (req, res) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
     * Returns metrics in Prometheus text exposition format.
     * When multiple connections are active each gets an `instance` label so
     * Prometheus can distinguish their time-series.  # HELP / # TYPE lines are
     * emitted only once per metric family (shared across instances).
     */
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

          // Link quality from metrics publisher
          const promPublisher = getActiveMetricsPublisher(state);
          if (promPublisher) {
            extra.linkQuality = promPublisher.calculateLinkQuality({
              rtt: effectiveNetwork.rtt,
              jitter: effectiveNetwork.jitter,
              packetLoss: effectiveNetwork.packetLoss,
              retransmitRate: effectiveNetwork.retransmitRate
            });
          }

          // Bonding metrics
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

    /**
     * GET /plugins/signalk-edge-link/monitoring/packet-loss
     * Returns packet loss heatmap data for visualization
     */
    router.get("/monitoring/packet-loss", rateLimitMiddleware, (req, res) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
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
          return res.status(400).json({ error: `metric must be one of: ${validAlertMetrics.join(", ")}` });
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

        // For partial updates, merge with current stored thresholds so the
        // cross-constraint (warning ≤ critical) is checked against the full
        // resulting state, not just the fields present in this request.
        const existingThreshold = state.monitoring.alertManager.thresholds[metric] || {};
        const effectiveWarning  = update.warning  !== undefined ? update.warning  : existingThreshold.warning;
        const effectiveCritical = update.critical !== undefined ? update.critical : existingThreshold.critical;
        if (effectiveWarning !== undefined && effectiveCritical !== undefined && effectiveWarning > effectiveCritical) {
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const bundle = getFirstBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
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
        const pluginConfig = (typeof app.readPluginOptions === "function" ? app.readPluginOptions() : {}) || {};
        res.json({
          success: true,
          configuration: pluginConfig.configuration || {}
        });
      } catch (error) {
        app.error(`Error reading plugin config: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ── Helpers for connection validation (used by POST /plugin-config) ─────────

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
     * @param {string} prefix - prefix for error messages, e.g. "connections[0]."
     * @returns {string|null} error string or null if valid
     */
    function validateOneConnection(c, prefix) {
      const p = prefix || "";

      // Normalise serverType boolean legacy format
      if (c.serverType === true) { c.serverType = "server"; }
      if (c.serverType === false) { c.serverType = "client"; }

      if (c.serverType !== "server" && c.serverType !== "client") {
        return `${p}serverType must be 'server' or 'client'`;
      }

      // Reject client-only fields when configuring a server instance.
      // (sanitizeOneConnection also removes them, but explicit rejection is clearer.)
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
        "name", "serverType", "udpPort", "secretKey", "useMsgpack", "usePathDictionary",
        "protocolVersion",
        "udpAddress", "helloMessageSender", "testAddress", "testPort", "pingIntervalTime",
        "reliability", "congestionControl", "bonding", "alertThresholds"
      ];
      const out = {};
      for (const key of VALID_KEYS) {
        if (c[key] !== undefined) { out[key] = c[key]; }
      }
      // Client-only fields have no meaning on a server instance
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

    // Plugin configuration endpoint - save config
    // Accepts: { connections: [ {serverType, udpPort, ...}, ... ] }
    // Legacy: flat single-connection object is automatically wrapped.
    router.post("/plugin-config", rateLimitMiddleware, requireJson, (req, res) => {
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          return res.status(400).json({ success: false, error: "Request body must be a JSON object" });
        }

        // ── Normalise to a connections array ────────────────────────────────
        let connectionList;
        if (Array.isArray(req.body.connections)) {
          if (req.body.connections.length === 0) {
            return res.status(400).json({ success: false, error: "connections array must contain at least one entry" });
          }
          connectionList = req.body.connections.map((c) => ({ ...c }));
        } else if (req.body.serverType) {
          // Legacy flat single-connection format
          connectionList = [{ ...req.body }];
        } else {
          return res.status(400).json({
            success: false,
            error: "Request body must have a 'connections' array or a top-level 'serverType' field"
          });
        }

        // ── Validate each connection ────────────────────────────────────────
        for (let i = 0; i < connectionList.length; i++) {
          const prefix = connectionList.length > 1 ? `connections[${i}].` : "";
          const err = validateOneConnection(connectionList[i], prefix);
          if (err) {
            return res.status(400).json({ success: false, error: err });
          }
        }

        // ── Reject duplicate server ports ───────────────────────────────────
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

        // ── Sanitize and build final config ─────────────────────────────────
        const sanitizedConnections = connectionList.map(sanitizeOneConnection);
        const finalConfig = { connections: sanitizedConnections };

        // ── Save and restart ─────────────────────────────────────────────────
        // pluginRef._restartPlugin is set in plugin.start() on the plugin object
        // itself (not on any individual instance), so it is always available
        // regardless of how many connections are running.
        // Fall back to savePluginOptions if the plugin has not been started yet.
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
      if (!b) return res.status(404).json({ error: "Not available in server mode" });
      if (!b.state.deltaTimerFile || !b.state.subscriptionFile) return res.status(503).json({ error: "Plugin not fully initialized" });
      next();
    };

    // Config routes (only available in client mode)
    // Uses the first client-mode instance so they work even when the first
    // configured connection happens to be a server.
    router.get("/config/:filename", rateLimitMiddleware, clientModeMiddleware, async (req, res) => {
      try {
        const bundle = getFirstClientBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
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
    });

    router.post("/config/:filename", rateLimitMiddleware, requireJson, clientModeMiddleware, async (req, res) => {
      try {
        const bundle = getFirstClientBundle();
        if (!bundle) return res.status(503).json({ error: "Plugin not started" });
        const { state } = bundle;
        const filePath = getConfigFilePath(state, req.params.filename);
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
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Multi-instance: list all connections ──────────────────────────────────
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

    // ── Multi-instance: per-connection metrics (full response) ──────────────
    router.get("/connections/:id/metrics", rateLimitMiddleware, (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      const data = buildFullMetricsResponse(bundle);
      data.instanceId = req.params.id;
      res.json(data);
    });

    // ── Multi-instance: per-connection network-metrics ────────────────────────
    router.get("/connections/:id/network-metrics", rateLimitMiddleware, (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      const { state } = bundle;
      const { metrics } = bundle.metricsApi;
      const effectiveNetwork = getEffectiveNetworkQuality(state, metrics);
      res.json({ instanceId: req.params.id, ...effectiveNetwork, timestamp: Date.now() });
    });

    // ── Multi-instance: per-connection bonding ────────────────────────────────
    router.get("/connections/:id/bonding", rateLimitMiddleware, (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      const { state } = bundle;
      if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
      if (!state.pipeline || !state.pipeline.getBondingManager) return res.json({ enabled: false });
      const bonding = state.pipeline.getBondingManager();
      res.json(bonding ? bonding.getState() : { enabled: false });
    });

    // ── Multi-instance: per-connection congestion ─────────────────────────────
    router.get("/connections/:id/congestion", rateLimitMiddleware, (req, res) => {
      const bundle = getBundleById(req.params.id);
      if (!bundle) return res.status(404).json({ error: `Connection '${req.params.id}' not found` });
      const { state } = bundle;
      if (state.isServerMode) return res.status(404).json({ error: "Not available in server mode" });
      if (!state.pipeline || !state.pipeline.getCongestionControl) return res.status(503).json({ error: "Congestion control not initialized" });
      res.json(state.pipeline.getCongestionControl().getState());
    });

    // ── Multi-instance: per-connection config files ───────────────────────────
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

    // ── Multi-instance: per-connection monitoring ──────────────────────────────
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

    // ── Multi-instance: per-connection bonding failover ─────────────────────
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

  return {
    registerWithRouter,
    loadConfigFile,
    saveConfigFile,
    startRateLimitCleanup,
    stopRateLimitCleanup
  };
}

module.exports = createRoutes;
