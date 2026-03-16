"use strict";

import crypto from "node:crypto";

import { PATH_CATEGORIES } from "./pathDictionary";
import { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS } from "./constants";
import {
  loadConfigFile as loadConfigFileShared,
  saveConfigFile as saveConfigFileShared
} from "./config-io";
import type {
  SignalKApp,
  InstanceRegistry,
  InstanceBundle,
  InstanceState,
  Metrics,
  PluginRef,
  EffectiveNetworkQuality,
  PathStatEntry
} from "./types";
import type { RouteRequest, RouteResponse, NextFn, RouteHandler, Router } from "./routes/types";

// Route sub-modules
import * as metricsRoutes from "./routes/metrics";
import * as monitoringRoutes from "./routes/monitoring";
import * as controlRoutes from "./routes/control";
import * as configRoutes from "./routes/config";
import * as connectionsRoutes from "./routes/connections";

/**
 * Creates the HTTP route handlers for the plugin's REST API.
 * @param app - SignalK app object
 * @param instanceRegistry - Registry providing access to active plugin instances
 * @param pluginRef - Reference to plugin object (for schema access)
 * @returns Routes API
 */
function createRoutes(app: SignalKApp, instanceRegistry: InstanceRegistry, pluginRef: PluginRef) {
  const REMOTE_TELEMETRY_TTL_MS = 15000;

  function getFirstBundle() {
    return instanceRegistry.getFirst() || null;
  }

  function getFirstHeaderValue(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
      return (
        value.find((entry: unknown) => typeof entry === "string" && (entry as string).trim()) ||
        null
      );
    }
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    return null;
  }

  function getManagementToken(): string | null {
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

  function isTokenRequired(): boolean {
    // Explicit opt-in to enforce token-based auth even when no token is set yet
    // (allows admins to lock the API before the token is provisioned).
    const fromOptions =
      pluginRef && pluginRef._currentOptions && pluginRef._currentOptions.requireManagementApiToken;
    if (fromOptions === true) {
      return true;
    }
    const fromEnv = process.env.SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN;
    return fromEnv === "true" || fromEnv === "1";
  }

  function authorizeManagement(req: RouteRequest, res: RouteResponse, action?: string): boolean {
    const expectedToken = getManagementToken();
    if (!expectedToken) {
      // No token configured → allow open access unless the admin explicitly
      // requires one.  This preserves backwards-compatible behaviour for
      // existing deployments.  A startup warning is logged to encourage
      // operators to configure a token (see registerWithRouter below).
      if (!isTokenRequired()) {
        return true;
      }
      // Token required but not yet configured → deny with a helpful message.
      if (app && typeof app.error === "function") {
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
        app.error(
          `[management-api] blocked unauthenticated request action=${action || "unknown"} ip=${ip} — ` +
            "requireManagementApiToken is set but no token is configured. " +
            "Set managementApiToken or SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN."
        );
      }
      res.status(403).json({
        error:
          "Management API token required. " +
          "Configure managementApiToken in plugin settings or set SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN env var."
      });
      return false;
    }

    const headerToken = req.headers
      ? getFirstHeaderValue(req.headers["x-edge-link-token"]) ||
        getFirstHeaderValue(req.headers["x-management-token"])
      : null;

    const authorization = req.headers ? getFirstHeaderValue(req.headers.authorization) : null;
    const bearerMatch =
      typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
    const bearerToken = bearerMatch ? bearerMatch[1].trim() : null;

    const providedCandidates: string[] = [];
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
      res.status(401).json({ error: "Unauthorized management API request" });
      return false;
    }

    if (app && typeof app.debug === "function") {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
      app.debug(`[management-api] authorized action=${action || "unknown"} ip=${ip}`);
    }

    return true;
  }

  function managementAuthMiddleware(action: string) {
    return function managementAuth(req: RouteRequest, res: RouteResponse, next?: NextFn) {
      if (!authorizeManagement(req, res, action)) {
        return;
      }
      if (next) next();
    };
  }

  function safeTokenEquals(expected: string, provided: string): boolean {
    if (typeof expected !== "string" || typeof provided !== "string") {
      return false;
    }

    // Compare fixed-length digests to avoid length-dependent timing differences.
    const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
    const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();

    return crypto.timingSafeEqual(expectedDigest, providedDigest);
  }

  function getBundleById(id: string) {
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
  const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
  let rateLimitCleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Simple rate limiting check
   * @param key - Rate-limit identity key
   * @returns True if request should be allowed
   */
  function checkRateLimit(key: string): boolean {
    const now = Date.now();
    const clientData = rateLimitMap.get(key);

    // Compare against the stored resetTime (an absolute timestamp) rather than
    // relying on interval alignment.  This prevents a 2× burst that would
    // otherwise be possible when two requests straddle the cleanup boundary.
    if (!clientData || now >= clientData.resetTime) {
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
    if (rateLimitCleanupInterval) {
      clearInterval(rateLimitCleanupInterval);
    }
    rateLimitCleanupInterval = null;
    rateLimitMap.clear();
  }

  /**
   * Resolves a config filename to its full file path
   * @param state - Instance state
   * @param filename - Config filename
   * @returns Full file path or null if invalid
   */
  function getConfigFilePath(state: InstanceState, filename: string): string | null {
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

  function loadConfigFile(filePath: string) {
    return loadConfigFileShared(filePath, app);
  }

  function saveConfigFile(filePath: string, data: unknown) {
    return saveConfigFileShared(filePath, data, app);
  }

  /**
   * Returns the active metrics publisher from the v2 client or server pipeline
   * @param state - Instance state
   * @returns MetricsPublisher instance or null
   */
  function getActiveMetricsPublisher(state: InstanceState) {
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
   */
  function getEffectiveNetworkQuality(
    state: InstanceState,
    metrics: Metrics,
    now: number = Date.now()
  ): EffectiveNetworkQuality {
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

    // Select a metric value based on data availability:
    // - hasFreshRemote  → use client-reported telemetry
    // - server with no fresh remote → no meaningful value (return 0)
    // - client mode → use locally-measured value
    function selectMetric(remoteVal: number | undefined, localVal: number | undefined): number {
      if (hasFreshRemote) {
        return remoteVal ?? 0;
      }
      if (hasOnlyLocalServerValues) {
        return 0;
      }
      return localVal ?? 0;
    }

    return {
      rtt: selectMetric(remote.rtt, metrics.rtt),
      jitter: selectMetric(remote.jitter, metrics.jitter),
      packetLoss: hasFreshRemote ? (remote.packetLoss ?? 0) : (metrics.packetLoss ?? 0),
      retransmissions: selectMetric(remote.retransmissions, metrics.retransmissions),
      queueDepth: selectMetric(remote.queueDepth, metrics.queueDepth),
      retransmitRate: selectMetric(remote.retransmitRate, clientRetransmitRate),
      activeLink: hasFreshRemote ? (remote.activeLink ?? "primary") : "primary",
      dataSource: hasFreshRemote ? "remote-client" : "local",
      lastUpdate: hasFreshRemote ? remote.lastUpdate : 0
    };
  }

  /**
   * Build the full metrics response object for a given bundle.
   * Shared by GET /metrics and GET /connections/:id/metrics.
   */
  function buildFullMetricsResponse(bundle: InstanceBundle): Record<string, unknown> {
    const { state } = bundle;
    const { metrics, updateBandwidthRates, formatBytes, getTopNPaths } = bundle.metricsApi;
    updateBandwidthRates(state.isServerMode);

    const uptime = Date.now() - metrics.startTime;
    const uptimeSeconds = Math.floor(uptime / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);

    const pathStatsArray = getTopNPaths(50, uptimeSeconds);

    const totalPathBytes = pathStatsArray.reduce(
      (sum: number, p: PathStatEntry) => sum + p.bytes,
      0
    );
    pathStatsArray.forEach((p: PathStatEntry) => {
      p.percentage = totalPathBytes > 0 ? Math.round((p.bytes / totalPathBytes) * 100) : 0;
    });

    const metricsData: Record<string, unknown> = {
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
        malformedPackets: metrics.malformedPackets || 0,
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
        const networkData: Record<string, unknown> = {
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
   */
  function registerWithRouter(router: Router) {
    /**
     * Content-Type validation middleware for JSON POST endpoints
     */
    const requireJson: RouteHandler = (req, res, next) => {
      const contentType = req.headers["content-type"];
      if (!contentType || !contentType.includes("application/json")) {
        return res.status(415).json({ error: "Content-Type must be application/json" });
      }
      if (next) next();
    };

    /**
     * Rate limiting middleware for API endpoints
     */
    const rateLimitMiddleware: RouteHandler = (req, res, next) => {
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
      if (next) next();
    };

    // Warn at startup when the management API is running without a token (open access).
    // This is the default for backwards compatibility; operators should configure a
    // token for production deployments.
    if (!getManagementToken() && !isTokenRequired() && app && typeof app.error === "function") {
      app.error(
        "[edge-link] WARNING: Management API is open — no managementApiToken configured. " +
          "Anyone with network access can read metrics and modify connection settings. " +
          "Set managementApiToken in plugin settings or SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN env var " +
          "to restrict access. Set requireManagementApiToken: true to deny access until a token is configured."
      );
    }

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

    router.get("/status", rateLimitMiddleware, (req: RouteRequest, res: RouteResponse) => {
      if (!authorizeManagement(req, res, "status.read")) {
        return;
      }

      const allBundles = instanceRegistry.getAll();
      if (!allBundles || allBundles.length === 0) {
        return res.status(503).json({ error: "Plugin not started" });
      }

      const statusInstances = allBundles.map((bundle: InstanceBundle) => {
        const status = bundle.state.instanceStatus || "unknown";
        const healthy = typeof status === "string" ? !/error|fail|stopped/i.test(status) : false;
        const bundleMetrics: Partial<Metrics> =
          bundle.metricsApi && bundle.metricsApi.metrics ? bundle.metricsApi.metrics : {};
        return {
          id: bundle.id,
          name: bundle.name,
          healthy,
          status,
          lastError: bundleMetrics.lastError || null,
          lastErrorTime: bundleMetrics.lastErrorTime || null,
          errorCounts: { ...(bundleMetrics.errorCounts || {}) },
          recentErrors: Array.isArray(bundleMetrics.recentErrors)
            ? bundleMetrics.recentErrors.slice(-5)
            : []
        };
      });

      const healthyInstances = statusInstances.filter((item) => item.healthy).length;
      res.json({
        healthyInstances,
        totalInstances: statusInstances.length,
        instances: statusInstances
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

export = createRoutes;
