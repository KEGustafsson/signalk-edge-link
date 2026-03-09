// @ts-nocheck
"use strict";

const crypto = require("node:crypto");

const { PATH_CATEGORIES } = require("./pathDictionary.ts");
const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS } = require("./constants.ts");
const {
  loadConfigFile: loadConfigFileShared,
  saveConfigFile: saveConfigFileShared
} = require("./config-io.ts");

// Route sub-modules
const metricsRoutes = require("./routes/metrics.ts");
const monitoringRoutes = require("./routes/monitoring.ts");
const controlRoutes = require("./routes/control.ts");
const configRoutes = require("./routes/config.ts");
const connectionsRoutes = require("./routes/connections.ts");

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

  function getFirstHeaderValue(value) {
    if (Array.isArray(value)) {
      return value.find((entry) => typeof entry === "string" && entry.trim()) || null;
    }
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    return null;
  }

  function getManagementToken() {
    const fromOptions =
      pluginRef && pluginRef._currentOptions && pluginRef._currentOptions.managementApiToken;
    if (typeof fromOptions === "string" && fromOptions.trim()) {
      return fromOptions.trim();
    }

    const fromEnv = process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN;
    if (typeof fromEnv === "string" && fromEnv.trim()) {
      return fromEnv.trim();
    }

    return null;
  }

  function authorizeManagement(req, res, action) {
    const expectedToken = getManagementToken();
    if (!expectedToken) {
      return true;
    }

    const headerToken = req.headers
      ? getFirstHeaderValue(req.headers["x-edge-link-token"]) ||
        getFirstHeaderValue(req.headers["x-management-token"])
      : null;

    const authorization = req.headers ? getFirstHeaderValue(req.headers.authorization) : null;
    const bearerMatch =
      typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
    const bearerToken = bearerMatch ? bearerMatch[1].trim() : null;

    const providedCandidates = [];
    if (typeof headerToken === "string" && headerToken.trim()) {
      providedCandidates.push(headerToken.trim());
    }
    if (typeof bearerToken === "string" && bearerToken.trim()) {
      providedCandidates.push(bearerToken.trim());
    }

    const isValid = providedCandidates.some((token) => safeTokenEquals(expectedToken, token));
    if (!isValid) {
      if (app && typeof app.debug === "function") {
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
        app.debug(`[management-api] denied action=${action || "unknown"} ip=${ip}`);
      }
      return res.status(401).json({ error: "Unauthorized management API request" });
    }

    if (app && typeof app.debug === "function") {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
      app.debug(`[management-api] authorized action=${action || "unknown"} ip=${ip}`);
    }

    return true;
  }

  function managementAuthMiddleware(action) {
    return function managementAuth(req, res, next) {
      if (!authorizeManagement(req, res, action)) {
        return;
      }
      next();
    };
  }

  function safeTokenEquals(expected, provided) {
    if (typeof expected !== "string" || typeof provided !== "string") {
      return false;
    }

    // Compare fixed-length digests to avoid length-dependent timing differences.
    const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
    const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();

    return crypto.timingSafeEqual(expectedDigest, providedDigest);
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
      if (!bundle.state.isServerMode) {
        return bundle;
      }
    }
    return null;
  }

  // Rate limiting state
  const rateLimitMap = new Map();
  let rateLimitCleanupInterval;

  /**
   * Simple rate limiting check
   * @param {string} key - Rate-limit identity key
   * @returns {boolean} True if request should be allowed
   */
  function checkRateLimit(key) {
    const now = Date.now();
    const clientData = rateLimitMap.get(key);

    if (!clientData || now > clientData.resetTime) {
      rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
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
      for (const [key, data] of rateLimitMap.entries()) {
        if (now > data.resetTime) {
          rateLimitMap.delete(key);
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
      case "delta_timer.json":
        return state.deltaTimerFile;
      case "subscription.json":
        return state.subscriptionFile;
      case "sentence_filter.json":
        return state.sentenceFilterFile;
      default:
        return null;
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
      now - remote.lastUpdate <= REMOTE_TELEMETRY_TTL_MS;

    const clientRetransmitRate =
      metrics.bandwidth.packetsOut > 0
        ? (metrics.retransmissions || 0) / metrics.bandwidth.packetsOut
        : 0;
    const hasOnlyLocalServerValues = state.isServerMode && !hasFreshRemote;

    return {
      rtt: hasFreshRemote ? (remote.rtt ?? 0) : hasOnlyLocalServerValues ? 0 : (metrics.rtt ?? 0),
      jitter: hasFreshRemote
        ? (remote.jitter ?? 0)
        : hasOnlyLocalServerValues
          ? 0
          : (metrics.jitter ?? 0),
      packetLoss: hasFreshRemote ? (remote.packetLoss ?? 0) : (metrics.packetLoss ?? 0),
      retransmissions: hasFreshRemote
        ? (remote.retransmissions ?? 0)
        : hasOnlyLocalServerValues
          ? 0
          : (metrics.retransmissions ?? 0),
      queueDepth: hasFreshRemote
        ? (remote.queueDepth ?? 0)
        : hasOnlyLocalServerValues
          ? 0
          : (metrics.queueDepth ?? 0),
      retransmitRate: hasFreshRemote
        ? (remote.retransmitRate ?? 0)
        : hasOnlyLocalServerValues
          ? 0
          : clientRetransmitRate,
      activeLink: hasFreshRemote ? (remote.activeLink ?? "primary") : "primary",
      dataSource: hasFreshRemote ? "remote-client" : "local",
      lastUpdate: hasFreshRemote ? remote.lastUpdate : 0
    };
  }

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
        duplicatePackets: metrics.duplicatePackets || 0,
        errorCounts: { ...(metrics.errorCounts || {}) }
      },
      status: {
        readyToSend: state.readyToSend,
        deltasBuffered: state.deltas.length
      },
      bandwidth: (() => {
        const packets = state.isServerMode
          ? metrics.bandwidth.packetsIn
          : metrics.bandwidth.packetsOut;
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
      recentErrors: Array.isArray(metrics.recentErrors)
        ? metrics.recentErrors.slice(-10).map((err) => ({
          category: err.category,
          message: err.message,
          timestamp: err.timestamp
        }))
        : [],
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
      const headers = req.headers || {};
      const trustProxy =
        req.app && typeof req.app.get === "function" && !!req.app.get("trust proxy");
      const forwarded = trustProxy ? headers["x-forwarded-for"] : null;
      const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null;
      const remoteAddress =
        req.socket && typeof req.socket.remoteAddress === "string"
          ? req.socket.remoteAddress
          : null;
      const clientIp = forwardedIp || req.ip || remoteAddress || null;

      // Deterministic fallback key when IP cannot be determined.
      // Include a few stable request traits to reduce cross-client bucket sharing.
      const unknownIdentityParts = [
        headers["user-agent"] || "na",
        headers["accept-language"] || "na",
        headers.host || "na"
      ];
      const unknownIdentity = unknownIdentityParts.map((p) => String(p).slice(0, 64)).join("|");

      const rateLimitKey =
        typeof clientIp === "string" && clientIp.length > 0
          ? clientIp
          : `unknown-client:${unknownIdentity}`;
      if (!checkRateLimit(rateLimitKey)) {
        return res.status(429).json({ error: "Too many requests, please try again later" });
      }
      next();
    };

    // Shared context passed to all route sub-modules
    const ctx = {
      app,
      instanceRegistry,
      pluginRef,
      rateLimitMiddleware,
      requireJson,
      getFirstBundle,
      getBundleById,
      getFirstClientBundle,
      getConfigFilePath,
      loadConfigFile,
      saveConfigFile,
      getActiveMetricsPublisher,
      getEffectiveNetworkQuality,
      buildFullMetricsResponse,
      authorizeManagement,
      managementAuthMiddleware
    };

    router.get("/status", rateLimitMiddleware, (req, res) => {
      if (!authorizeManagement(req, res, "status.read")) {
        return;
      }

      const allBundles = instanceRegistry.getAll();
      if (!allBundles || allBundles.length === 0) {
        return res.status(503).json({ error: "Plugin not started" });
      }

      const instances = allBundles.map((bundle) => {
        const status = bundle.state.instanceStatus || "unknown";
        const healthy = typeof status === "string" ? !/error|fail|stopped/i.test(status) : false;
        const metrics =
          bundle.metricsApi && bundle.metricsApi.metrics ? bundle.metricsApi.metrics : {};
        return {
          id: bundle.id,
          name: bundle.name,
          healthy,
          status,
          lastError: metrics.lastError || null,
          lastErrorTime: metrics.lastErrorTime || null,
          errorCounts: { ...(metrics.errorCounts || {}) },
          recentErrors: Array.isArray(metrics.recentErrors) ? metrics.recentErrors.slice(-5) : []
        };
      });

      const healthyInstances = instances.filter((item) => item.healthy).length;
      res.json({
        healthyInstances,
        totalInstances: instances.length,
        instances
      });
    });

    // Register route groups
    metricsRoutes.register(router, ctx);
    monitoringRoutes.register(router, ctx);
    controlRoutes.register(router, ctx);
    configRoutes.register(router, ctx);
    connectionsRoutes.register(router, ctx);
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
