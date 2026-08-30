"use strict";

import crypto from "node:crypto";

import { PATH_CATEGORIES } from "./codec/path-dictionary";
import {
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_MAX_KEYS
} from "./foundation/constants";
import {
  loadConfigFile as loadConfigFileShared,
  saveConfigFile as saveConfigFileShared
} from "./foundation/config-io";
import type {
  SignalKApp,
  InstanceRegistry,
  InstanceBundle,
  InstanceState,
  Metrics,
  PluginRef,
  EffectiveNetworkQuality,
  PathStatEntry
} from "./foundation/types";
import type {
  RouteRequest,
  RouteResponse,
  NextFn,
  RouteHandler,
  Router,
  ManagementAuthSnapshot
} from "./routes/types";

type ManagementAuthDecision = "allowed" | "denied";
type ManagementAuthReason =
  | "open_access"
  | "valid_token"
  | "missing_token"
  | "invalid_token"
  | "token_required_unconfigured"
  | "config_read_error";

interface ManagementAuthActionCounters {
  total: number;
  allowed: number;
  denied: number;
  reasons: Record<string, number>;
  byDecision: { allowed: Record<string, number>; denied: Record<string, number> };
}

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
const ALLOWED_MANAGEMENT_ACTIONS = new Set([
  "paths.read",
  "config.read",
  "config.update",
  "plugin-schema.read",
  "config-file.read",
  "config-file.update",
  "connections.list",
  "connection-monitoring.read",
  "connection-bonding.read",
  "connection-config.read",
  "connection-config.update",
  "connection-bonding.failover",
  "congestion.read",
  "delta-timer.update",
  "bonding.read",
  "bonding.update",
  "bonding.failover",
  "metrics.read",
  "network-metrics.read",
  "prometheus.read",
  "sources.read",
  "monitoring.read",
  "monitoring.alerts.read",
  "monitoring.alerts.update",
  "capture.read",
  "capture.update",
  "capture.export",
  "monitoring.inspector.read",
  "monitoring.simulation.read",
  "status.read",
  "instances.list",
  "instances.show",
  "instances.create",
  "instances.update",
  "instances.delete"
]);

/**
 * Interpret a boolean-ish configuration or environment value as a tri-state.
 *
 * The plugin schema produces a real boolean, but the same flags are also set by
 * hand in JSON config files and by shell exports, where `"true"`/`"1"`/`"yes"`/
 * `"on"` (and their negatives) are all natural spellings. Accepting only
 * `true`/`"true"`/`"1"` made every other spelling read as "off".
 *
 * `"invalid"` is returned rather than folded into `false`, because for a
 * fail-closed security flag those two mean very different things: absent means
 * "the operator never set this, keep the compatibility default", whereas an
 * unparseable explicit value means "the operator intended something and we
 * cannot tell what" — which must not silently grant access.
 */
type FlagState = "absent" | "true" | "false" | "invalid";

const TRUTHY_FLAGS = new Set(["true", "1", "yes", "on"]);
const FALSY_FLAGS = new Set(["false", "0", "no", "off"]);

function parseFlag(value: unknown): FlagState {
  if (value === undefined || value === null || value === "") return "absent";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return "absent";
    if (TRUTHY_FLAGS.has(normalized)) return "true";
    if (FALSY_FLAGS.has(normalized)) return "false";
  }
  return "invalid";
}

function createRoutes(app: SignalKApp, instanceRegistry: InstanceRegistry, pluginRef: PluginRef) {
  const REMOTE_TELEMETRY_TTL_MS = 15000;
  const managementAuthTelemetry = {
    total: 0,
    allowed: 0,
    denied: 0,
    byReason: new Map<ManagementAuthReason, number>(),
    byAction: new Map<string, ManagementAuthActionCounters>()
  };

  function getFirstBundle() {
    return instanceRegistry.getFirst() || null;
  }

  function getFirstHeaderValue(value: string | string[] | null | undefined): string | null {
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

  function hasJsonContentType(value: string | string[] | null | undefined): boolean {
    const isApplicationJsonMediaType = (headerValue: string): boolean => {
      const mediaType = headerValue.split(";")[0].trim().toLowerCase();
      return mediaType === "application/json";
    };

    if (Array.isArray(value)) {
      return value.some(
        (entry: unknown) => typeof entry === "string" && isApplicationJsonMediaType(entry)
      );
    }
    return typeof value === "string" && isApplicationJsonMediaType(value);
  }

  /**
   * Resolve the effective plugin options for auth decisions. Prefer the live
   * `_currentOptions`, but fall back to the PERSISTED configuration when the
   * plugin is stopped (`stop()` clears `_currentOptions`). Without this fallback
   * the management API would silently degrade to OPEN ACCESS after a stop if the
   * routes stay mounted and no env token is set — and `/plugin-config` can still
   * read and mutate persisted configuration even while stopped.
   * @private
   */
  function resolveAuthOptions(): {
    options: Record<string, unknown> | null;
    readError: boolean;
  } {
    if (pluginRef && pluginRef._currentOptions) {
      return { options: pluginRef._currentOptions as Record<string, unknown>, readError: false };
    }
    try {
      const opts = typeof app.readPluginOptions === "function" ? app.readPluginOptions() : null;
      const configuration = opts && opts.configuration;
      return {
        options:
          configuration && typeof configuration === "object"
            ? (configuration as Record<string, unknown>)
            : null,
        readError: false
      };
    } catch (err) {
      // A failed persisted-config read leaves the auth state UNDETERMINED.
      // Returning null here would let auth decisions silently degrade to open
      // access, so the read failure is surfaced and callers fail closed.
      if (app && typeof app.error === "function") {
        app.error(
          "[management-api] failed to read persisted plugin options for auth decision: " +
            (err instanceof Error ? err.message : String(err))
        );
      }
      return { options: null, readError: true };
    }
  }

  function getAuthOptions(): Record<string, unknown> | null {
    return resolveAuthOptions().options;
  }

  /**
   * The token a request must present, or null when none is configured.
   *
   * The environment variable wins over the stored plugin option. That is the
   * order `docs/web-ui.md` and the configuration panel have always described,
   * and it is the order that makes the documented rotation procedure work: an
   * operator who exports a new token and restarts must end up enforcing the
   * new one. With the option taking precedence, a stale value left in the
   * plugin config kept a leaked token live while rejecting the replacement.
   *
   * @param authOptions - Already-resolved options, so a caller that has to
   *   fail closed on a read error resolves once and reuses the result rather
   *   than re-reading (and possibly getting a different answer) per lookup.
   */
  function getManagementToken(authOptions = getAuthOptions()): string | null {
    const fromEnv = process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN;
    if (typeof fromEnv === "string" && fromEnv.trim()) {
      return fromEnv.trim();
    }

    const fromOptions = authOptions && authOptions.managementApiToken;
    if (typeof fromOptions === "string" && fromOptions.trim()) {
      return fromOptions.trim();
    }

    return null;
  }

  function warnIfOpenAccess(): void {
    // Retained as a no-op for compatibility with older route consumers.
  }

  /**
   * Whether a token must be presented even if none is configured yet.
   *
   * Accepts the boolean `true` from the schema, plus the common truthy string
   * spellings an operator may hand-write into a config file or an env var.
   * Anything unrecognised is treated as "not required" — the pre-existing
   * default — so a typo cannot silently lock an operator out.
   */
  function isTokenRequired(authOptions = getAuthOptions()): boolean {
    // Explicit opt-in to enforce token-based auth even when no token is set yet
    // (allows admins to lock the API before the token is provisioned).
    //
    // An unparseable explicit value fails CLOSED. The compatibility default
    // (open access when no token is configured) is only for the case where the
    // operator never expressed an intent at all; a typo like "treu" is an
    // expressed intent we cannot read, and resolving that to "no protection"
    // would hand out access on a spelling mistake.
    for (const [source, raw] of [
      ["requireManagementApiToken", authOptions && authOptions.requireManagementApiToken],
      [
        "SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN",
        process.env.SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN
      ]
    ] as Array<[string, unknown]>) {
      const state = parseFlag(raw);
      if (state === "true") {
        return true;
      }
      if (state === "invalid") {
        if (app && typeof app.error === "function") {
          app.error(
            `[management-api] ${source} has an unrecognised value; treating it as enabled ` +
              "(fail-closed). Set it to true or false."
          );
        }
        return true;
      }
    }
    return false;
  }

  function normalizeManagementAuthAction(action?: string): string {
    if (typeof action !== "string" || !action.trim()) {
      return "unknown";
    }
    const trimmed = action.trim();
    return ALLOWED_MANAGEMENT_ACTIONS.has(trimmed) ? trimmed : "unknown";
  }

  function recordManagementAuthDecision(
    decision: ManagementAuthDecision,
    reason: ManagementAuthReason,
    action?: string
  ): void {
    const normalizedAction = normalizeManagementAuthAction(action);
    managementAuthTelemetry.total++;
    managementAuthTelemetry[decision]++;
    managementAuthTelemetry.byReason.set(
      reason,
      (managementAuthTelemetry.byReason.get(reason) || 0) + 1
    );

    const actionCounters = managementAuthTelemetry.byAction.get(normalizedAction) || {
      total: 0,
      allowed: 0,
      denied: 0,
      reasons: {},
      byDecision: { allowed: {} as Record<string, number>, denied: {} as Record<string, number> }
    };
    actionCounters.total++;
    actionCounters[decision]++;
    actionCounters.reasons[reason] = (actionCounters.reasons[reason] || 0) + 1;
    actionCounters.byDecision[decision][reason] =
      (actionCounters.byDecision[decision][reason] || 0) + 1;
    managementAuthTelemetry.byAction.set(normalizedAction, actionCounters);
  }

  function getManagementAuthSnapshot(): ManagementAuthSnapshot {
    const byReason: Record<string, number> = {};
    for (const [reason, count] of managementAuthTelemetry.byReason.entries()) {
      byReason[reason] = count;
    }

    const byAction: Record<string, ManagementAuthActionCounters> = {};
    for (const [action, counters] of managementAuthTelemetry.byAction.entries()) {
      byAction[action] = {
        total: counters.total,
        allowed: counters.allowed,
        denied: counters.denied,
        reasons: { ...counters.reasons },
        byDecision: {
          allowed: { ...counters.byDecision.allowed },
          denied: { ...counters.byDecision.denied }
        }
      };
    }

    return {
      total: managementAuthTelemetry.total,
      allowed: managementAuthTelemetry.allowed,
      denied: managementAuthTelemetry.denied,
      byReason,
      byAction
    };
  }

  function authorizeManagement(req: RouteRequest, res: RouteResponse, action?: string): boolean {
    // Resolve once and thread the result through both lookups below.
    //
    // Reading three times meant the `readError` gate and the decisions it
    // guards could disagree: a read that succeeded for the probe and then
    // failed — which is exactly what happens while `savePluginOptions` is
    // rewriting the file — yielded `options: null` for the token and the
    // require-flag, and the request was served as `open_access` despite the
    // fail-closed rule above.
    const resolved = resolveAuthOptions();

    // Fail closed when the auth configuration cannot be read: an undetermined
    // config must never silently degrade to open access.
    if (resolved.readError) {
      recordManagementAuthDecision("denied", "config_read_error", action);
      res
        .status(503)
        .json({ error: "Management API temporarily unavailable: unable to read configuration" });
      return false;
    }

    const expectedToken = getManagementToken(resolved.options);
    if (!expectedToken) {
      // No token configured → allow open access unless the admin explicitly
      // requires one.  This preserves backwards-compatible behaviour for
      // existing deployments.
      if (!isTokenRequired(resolved.options)) {
        recordManagementAuthDecision("allowed", "open_access", action);
        return true;
      }
      // Token required but not yet configured → deny with a helpful message.
      recordManagementAuthDecision("denied", "token_required_unconfigured", action);
      if (app && typeof app.error === "function") {
        app.error(
          `[management-api] blocked unauthenticated request action=${normalizeManagementAuthAction(action)} — ` +
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
      const reason = providedCandidates.length === 0 ? "missing_token" : "invalid_token";
      recordManagementAuthDecision("denied", reason, action);
      if (app && typeof app.debug === "function") {
        app.debug(
          `[management-api] denied action=${normalizeManagementAuthAction(action)} reason=${reason}`
        );
      }
      res.status(401).json({ error: "Unauthorized management API request" });
      return false;
    }

    recordManagementAuthDecision("allowed", "valid_token", action);
    if (app && typeof app.debug === "function") {
      app.debug(`[management-api] authorized action=${normalizeManagementAuthAction(action)}`);
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
  /** Emit the unbounded-`trust proxy` warning once, not per request. */
  let warnedUnboundedTrustProxy = false;
  let rateLimitCleanupInterval: ReturnType<typeof setInterval> | null = null;
  let stopMonitoringTimers: (() => void) | null = null;

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
      // Bound the map even when the periodic cleanup is not running (the
      // routes keep serving while the plugin is stopped): drop expired
      // entries first, then the oldest, before admitting a new key.
      if (!clientData && rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
        for (const [k, data] of rateLimitMap.entries()) {
          if (now >= data.resetTime) {
            rateLimitMap.delete(k);
            break;
          }
        }
        while (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
          const oldest = rateLimitMap.keys().next();
          if (oldest.done) break;
          rateLimitMap.delete(oldest.value);
        }
      }
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
    if (stopMonitoringTimers) {
      stopMonitoringTimers();
      stopMonitoringTimers = null;
    }
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

    /**
     * Select a metric value based on data availability:
     * - hasFreshRemote → use client-reported telemetry
     * - server with no fresh remote → nothing to report (undefined)
     * - client mode → use the locally-measured value
     *
     * Absence stays absent. This used to coalesce every branch to 0, and fresh
     * telemetry does not imply every field arrived in it: a client that
     * reported RTT but not jitter rendered as a hard "0 ms jitter" beside a
     * real round trip — the peer's silence turned into a confident measurement
     * of zero, and it looked exactly like a healthy link. Reporting undefined
     * lets the UI say N/A instead.
     */
    function selectOptionalMetric(
      remoteVal: number | undefined,
      localVal: number | undefined
    ): number | undefined {
      if (hasFreshRemote) {
        return remoteVal;
      }
      if (hasOnlyLocalServerValues) {
        return undefined;
      }
      return localVal;
    }

    const bondingManager =
      state.pipeline && state.pipeline.getBondingManager
        ? state.pipeline.getBondingManager()
        : null;
    const localActiveLink = bondingManager
      ? bondingManager.getActiveLinkName() || "primary"
      : "primary";

    return {
      // Every remote-sourced field is optional, for the same reason jitter is:
      // fresh telemetry does not imply every field arrived in it. A peer that
      // reports some fields and not others — an older build, or a value the
      // ingest validator rejected — must not have its silence rendered as a
      // measured 0 (or a guessed "primary" link).
      rtt: selectOptionalMetric(remote.rtt, metrics.rtt),
      jitter: selectOptionalMetric(remote.jitter, metrics.jitter),
      packetLoss: selectOptionalMetric(remote.packetLoss, metrics.packetLoss),
      retransmissions: selectOptionalMetric(remote.retransmissions, metrics.retransmissions),
      queueDepth: selectOptionalMetric(remote.queueDepth, metrics.queueDepth),
      retransmitRate: selectOptionalMetric(remote.retransmitRate, clientRetransmitRate),
      activeLink: hasFreshRemote ? remote.activeLink : localActiveLink,
      dataSource: hasFreshRemote ? "remote-client" : "local",
      lastUpdate: hasFreshRemote ? remote.lastUpdate : 0,
      // A server measures no latency itself, so its basis is telemetry that
      // actually CARRIES a measurement — fresh telemetry alone is not enough,
      // since a client with no samples still reports everything else. A client's
      // basis is its first timed ACK; until one arrives `rtt` and `jitter` are
      // seed zeros, not measurements.
      hasQualityBasis: hasFreshRemote
        ? typeof remote.rtt === "number"
        : !state.isServerMode && (metrics.rttSamples ?? 0) > 0
    };
  }

  /**
   * The single eligibility rule for a link-quality score, shared by /metrics,
   * /network-metrics and /prometheus.
   *
   * All four scoring inputs must be real. A peer can report RTT without
   * jitter, or loss without a retransmit rate; every missing input would be
   * substituted with 0, and 0 can only push the score up — the same false
   * green the measurement-basis gate exists to prevent.
   *
   * It lives here, in one place, because these three surfaces have already
   * disagreed with each other once: a scrape and the dashboard reported
   * different figures for the same link at the same moment. Three copies of
   * the rule means the next change to the required inputs has to be made
   * three times, and the surface that gets missed is the one that reports an
   * inflated score.
   */
  function computeLinkQuality(
    state: InstanceState,
    effectiveNetwork: EffectiveNetworkQuality
  ): number | undefined {
    const publisher = getActiveMetricsPublisher(state);
    const { rtt, jitter, packetLoss, retransmitRate } = effectiveNetwork;
    if (
      !publisher ||
      !effectiveNetwork.hasQualityBasis ||
      rtt === undefined ||
      jitter === undefined ||
      packetLoss === undefined ||
      retransmitRate === undefined
    ) {
      return undefined;
    }
    return publisher.calculateLinkQuality({ rtt, jitter, packetLoss, retransmitRate });
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

    const rawPathStats = getTopNPaths(50, uptimeSeconds);

    const totalPathBytes = rawPathStats.reduce((sum: number, p: PathStatEntry) => sum + p.bytes, 0);
    // Build a fresh array rather than mutating entries returned by getTopNPaths
    // — those objects are owned by the metrics layer and may be reused.
    const pathStatsArray = rawPathStats.map((p: PathStatEntry) => ({
      ...p,
      percentage: totalPathBytes > 0 ? Math.round((p.bytes / totalPathBytes) * 100) : 0
    }));

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
        dataPacketsReceived: metrics.dataPacketsReceived || 0,
        rateLimitedPackets: metrics.rateLimitedPackets || 0,
        droppedDeltaBatches: metrics.droppedDeltaBatches || 0,
        droppedDeltaCount: metrics.droppedDeltaCount || 0,
        abandonedSequences: metrics.abandonedSequences || 0,
        packetsAbandoned: metrics.packetsAbandoned || 0,
        rejectedControlPackets: metrics.rejectedControlPackets || 0,
        // Counted since the beginning and read by nothing until now. Each is
        // the only evidence of the condition it records, so leaving them
        // unreadable made those conditions undiagnosable from outside the
        // process — the same defect that hid rejectedControlPackets.
        //
        // replayedPackets is the sharpest of them: it counts datagrams the
        // anti-replay guard refused, i.e. the security mechanism this release
        // hardened actually doing something. A non-zero value is either an
        // attack or a peer bug, and neither was visible.
        replayedPackets: metrics.replayedPackets || 0,
        // Non-zero means the peers disagree about `epochBoundAuth`: this side
        // requires it and the sender is not using it, so every packet is
        // refused. Its own counter because the failure is a configuration
        // mismatch, not the tampering the generic auth error implies.
        epochAuthMismatches: metrics.epochAuthMismatches || 0,
        // Distinct from the mismatch above: the sender IS binding, but no
        // HELLO has established its epoch yet. A brief burst at startup is
        // normal; a number that keeps climbing means HELLO is not arriving.
        epochAuthPending: metrics.epochAuthPending || 0,
        // Fires when a client-mode instance forwards FULL_STATUS_REQUEST to the
        // server instances beside it — the proxy cascade. In a chain this is
        // how you tell a mid-node is relaying rather than terminating.
        fullStatusCascadeFired: metrics.fullStatusCascadeFired || 0,
        snapshotReplayDeltas: metrics.snapshotReplayDeltas || 0,
        processDeltaCalls: metrics.processDeltaCalls || 0,
        // Peak outbound buffer depth: the backpressure signal that precedes
        // droppedDeltaBatches, and the one that could warn before loss starts.
        deltasBufferHighWaterMark: metrics.deltasBufferHighWaterMark || 0,
        suppressedOutboundDuplicates: metrics.suppressedOutboundDuplicates || 0,
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
        const metaBytesOut = metrics.bandwidth.metaBytesOut || 0;
        const metaBytesIn = metrics.bandwidth.metaBytesIn || 0;

        return {
          bytesOut: metrics.bandwidth.bytesOut,
          bytesIn: metrics.bandwidth.bytesIn,
          bytesOutRaw: metrics.bandwidth.bytesOutRaw,
          bytesInRaw: metrics.bandwidth.bytesInRaw,
          bytesOutFormatted: formatBytes(metrics.bandwidth.bytesOut),
          bytesInFormatted: formatBytes(metrics.bandwidth.bytesIn),
          bytesOutRawFormatted: formatBytes(metrics.bandwidth.bytesOutRaw),
          bytesInRawFormatted: formatBytes(metrics.bandwidth.bytesInRaw),
          packetsOut: metrics.bandwidth.packetsOut,
          packetsIn: metrics.bandwidth.packetsIn,
          rateOut: metrics.bandwidth.rateOut,
          rateIn: metrics.bandwidth.rateIn,
          rateOutFormatted: formatBytes(metrics.bandwidth.rateOut) + "/s",
          rateInFormatted: formatBytes(metrics.bandwidth.rateIn) + "/s",
          compressionRatio: metrics.bandwidth.compressionRatio,
          avgPacketSize,
          avgPacketSizeFormatted: avgPacketSize > 0 ? formatBytes(avgPacketSize) : "0 B",
          metaBytesOut,
          metaBytesIn,
          metaBytesOutFormatted: formatBytes(metaBytesOut),
          metaBytesInFormatted: formatBytes(metaBytesIn),
          metaPacketsOut: metrics.bandwidth.metaPacketsOut || 0,
          metaPacketsIn: metrics.bandwidth.metaPacketsIn || 0,
          metaSnapshotsSent: metrics.bandwidth.metaSnapshotsSent || 0,
          metaDiffsSent: metrics.bandwidth.metaDiffsSent || 0,
          metaRateLimitedPackets: metrics.bandwidth.metaRateLimitedPackets || 0,
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
          // Omitted rather than reported as 0 when nothing has been measured, so
          // the UI can say "N/A" instead of claiming a 0 ms round trip.
          rtt: effectiveNetwork.hasQualityBasis ? effectiveNetwork.rtt : undefined,
          jitter: effectiveNetwork.hasQualityBasis ? effectiveNetwork.jitter : undefined,
          packetLoss: effectiveNetwork.packetLoss,
          retransmissions: effectiveNetwork.retransmissions,
          queueDepth: effectiveNetwork.queueDepth,
          retransmitRate: effectiveNetwork.retransmitRate,
          acksSent: metrics.acksSent || 0,
          naksSent: metrics.naksSent || 0,
          activeLink: effectiveNetwork.activeLink,
          dataSource: effectiveNetwork.dataSource
        };
        if (state.isServerMode && effectiveNetwork.lastUpdate > 0) {
          networkData.lastRemoteUpdate = effectiveNetwork.lastUpdate;
        }

        const linkQuality = computeLinkQuality(state, effectiveNetwork);
        if (linkQuality !== undefined) {
          networkData.linkQuality = linkQuality;
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
        : null,
      sourceReplication: state.sourceRegistry
        ? {
            metrics: state.sourceRegistry.getMetrics(),
            registry: null
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
      if (!hasJsonContentType(req.headers["content-type"])) {
        return res.status(415).json({ error: "Content-Type must be application/json" });
      }
      if (next) next();
    };

    /**
     * Reject requests that look like a cross-site form submission.
     *
     * `requireJson` implicitly protects most mutating routes: an
     * `application/json` body forces a CORS preflight, which a cross-site
     * `<form>` cannot perform. Bodyless POSTs (capture start/stop, bonding
     * failover) cannot use it — the CLI sends no Content-Type when there is no
     * body, so requiring JSON there would break it. Combined with the
     * documented open-access default, that left those routes reachable from any
     * page an operator happens to visit on the same network.
     *
     * A cross-site form POST is identifiable two ways, and both are checked:
     * modern browsers send `Sec-Fetch-Site: cross-site`, and a form can only
     * ever produce one of the three "simple" content types.
     */
    const SIMPLE_FORM_CONTENT_TYPES = [
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "text/plain"
    ];
    const blockCrossSiteForm: RouteHandler = (req, res, next) => {
      const headers = req.headers || {};
      const fetchSite = getFirstHeaderValue(headers["sec-fetch-site"]);
      if (
        fetchSite &&
        fetchSite !== "same-origin" &&
        fetchSite !== "same-site" &&
        fetchSite !== "none"
      ) {
        return res.status(403).json({ error: "Cross-site requests are not allowed" });
      }
      const contentType = getFirstHeaderValue(headers["content-type"]);
      if (contentType) {
        const base = contentType.split(";")[0].trim().toLowerCase();
        if (SIMPLE_FORM_CONTENT_TYPES.includes(base)) {
          return res.status(415).json({ error: "Unsupported Content-Type for this endpoint" });
        }
      }
      if (next) next();
    };

    /**
     * Rate limiting middleware for API endpoints
     */
    const rateLimitMiddleware: RouteHandler = (req, res, next) => {
      const headers = req.headers || {};
      const remoteAddress =
        req.socket && typeof req.socket.remoteAddress === "string"
          ? req.socket.remoteAddress
          : null;

      // Choosing the rate-limit bucket key is security-relevant: whoever can
      // pick their own key can request without limit, which lifts the only
      // brake on management-token guessing and grows `rateLimitMap` by an entry
      // per distinct value.
      //
      // Never read `X-Forwarded-For` leftmost-first. That entry is supplied by
      // the *client* — proxies only append — so it is attacker-chosen.
      //
      // `req.ip` is only trustworthy when `trust proxy` is BOUNDED (a hop
      // count, a CIDR/named subnet, an array or a predicate). In that case
      // Express walks the header right-to-left, stops at the first untrusted
      // hop, and that address really does identify the peer.
      //
      // With `trust proxy: true` Express takes the leftmost entry verbatim, so
      // `req.ip` is exactly the attacker-controlled value. There is no way to
      // recover a trustworthy per-client identity in that configuration, so
      // fall back to the transport-level peer address: behind a real proxy that
      // collapses every client into one shared bucket, which throttles more
      // aggressively than intended but cannot be bypassed.
      const trustSetting =
        req.app && typeof req.app.get === "function" ? req.app.get("trust proxy") : undefined;
      const trustProxyEnabled = !!trustSetting;
      const trustProxyUnbounded = trustSetting === true || trustSetting === "true";

      if (trustProxyUnbounded && !warnedUnboundedTrustProxy) {
        warnedUnboundedTrustProxy = true;
        if (app && typeof app.error === "function") {
          app.error(
            "[management-api] 'trust proxy' is set to true (unbounded). X-Forwarded-For cannot be " +
              "trusted to identify a client, so rate limiting falls back to the connecting address " +
              "and may be shared across clients. Configure a hop count or trusted proxy list instead."
          );
        }
      }

      const clientIp =
        trustProxyEnabled && !trustProxyUnbounded
          ? req.ip || remoteAddress || null
          : remoteAddress || req.ip || null;

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

    // Shared context passed to all route sub-modules
    const ctx = {
      app,
      instanceRegistry,
      pluginRef,
      rateLimitMiddleware,
      requireJson,
      blockCrossSiteForm,
      getFirstBundle,
      getBundleById,
      getFirstClientBundle,
      getConfigFilePath,
      loadConfigFile,
      saveConfigFile,
      getActiveMetricsPublisher,
      getEffectiveNetworkQuality,
      computeLinkQuality,
      buildFullMetricsResponse,
      getManagementAuthSnapshot,
      isManagementAuthEnabled: () => getManagementToken() !== null,
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
        instances: statusInstances,
        // Only surface auth telemetry when a token is configured; in open-access
        // mode it would expose attempt history to unauthenticated callers.
        ...(getManagementToken() ? { managementAuth: getManagementAuthSnapshot() } : {})
      });
    });

    // Register route groups
    metricsRoutes.register(router, ctx);
    stopMonitoringTimers = monitoringRoutes.register(router, ctx);
    controlRoutes.register(router, ctx);
    configRoutes.register(router, ctx);
    connectionsRoutes.register(router, ctx);
  }

  return {
    registerWithRouter,
    loadConfigFile,
    saveConfigFile,
    startRateLimitCleanup,
    stopRateLimitCleanup,
    warnIfOpenAccess
  };
}

export = createRoutes;
