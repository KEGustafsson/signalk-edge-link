"use strict";

/**
 * Signal K Edge Link - Instance Factory
 *
 * Creates a fully isolated connection instance (either a server listener or
 * a client sender).  Each instance owns its own state, metrics, pipeline,
 * UDP socket, file-watchers, timers and subscription.
 *
 * Multiple instances can run concurrently inside a single plugin process –
 * they share the `app` reference for Signal K communication but are otherwise
 * independent of each other.
 *
 * @module lib/instance
 */

import dgram from "dgram";
import { UdpSocketManager } from "./transport/udp-socket-manager";
import { validateSecretKey } from "./crypto";
import Monitor from "ping-monitor";
import createMetrics from "./metrics";
import { createSourceRegistry } from "./source-replication";
import { createDeltaBatcher } from "./domain/delta-batcher";
import { createMetadataStreamer } from "./domain/metadata-streamer";
import { createSourceSnapshotService } from "./domain/source-snapshot-service";
import { createKeepaliveManager } from "./domain/keepalive-manager";
import { createSubscriptionManager } from "./domain/subscription-manager";
import createPipeline from "./pipeline";
import { createPipelineV2Client } from "./pipeline-v2-client";
import { createPipelineV2Server } from "./pipeline-v2-server";
import {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
} from "./monitoring";
import { PacketCapture, PacketInspector } from "./packet-capture";
import {
  DEFAULT_DELTA_TIMER,
  PING_TIMEOUT_BUFFER,
  MILLISECONDS_PER_MINUTE,
  MAX_DELTAS_BUFFER_SIZE,
  DELTA_BUFFER_DROP_RATIO,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch,
  OUTBOUND_DUPLICATE_SUPPRESS_MS,
  SUPPRESSED_DUPLICATE_STATS_MAX_SIZE,
  OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS,
  OUTBOUND_DEDUPE_MAX_ENTRIES
} from "./constants";
import { loadConfigFile, loadConfigFileSafe } from "./config-io";
import {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  initializePersistentStorage
} from "./config-watcher";
import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  MetricsApi,
  Delta,
  MetaConfig
} from "./types";
import {
  MetaCache,
  extractLiveMeta,
  parseMetaConfig as parseMetaConfigShared,
  resolveSelfContext
} from "./metadata";
import { sanitizeDeltaForSignalK, stripOwnDataFromDelta } from "./delta-sanitizer";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a URL-safe identifier from a human-readable name.
 * "Shore Server" → "shore-server"
 */
function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

/** Sole source of truth for "is this instance a server?" — derived from
 *  options.serverType. Accepts both the legacy boolean (`true` == server) and
 *  the current string form ("server"/"client"). */
function derivedIsServerMode(options: ConnectionConfig): boolean {
  return (options.serverType as unknown) === true || options.serverType === "server";
}

/**
 * Build a small, deterministic structural key from an outbound delta for
 * duplicate suppression. Replaces `JSON.stringify(delta)` in the per-delta
 * hot path: a deep stringify dominated processDelta CPU at >100 deltas/s.
 *
 * The key captures the fields that, taken together, identify a logical
 * publish event: context, source attribution, timestamp, and each value's
 * (path, value-hash) pair in insertion order. Two genuinely-distinct
 * publications with the same content will produce the same key — that's
 * the entire point of the suppression window. Two updates with even one
 * differing value or timestamp produce different keys and both forward.
 */
function buildOutboundDedupeKey(delta: Delta): string {
  // Length-prefix every field (`<len>:<data>`) so two structurally-distinct
  // deltas can never collapse to the same key just because one of their
  // strings happens to contain delimiter-like bytes. Without this, a
  // payload whose value text was `|v` would have collided with the
  // delimiter used to separate values.
  const parts: string[] = [];
  function push(tag: string, raw: unknown): void {
    const s = raw == null ? "" : String(raw);
    parts.push(tag, String(s.length), ":", s);
  }
  push("c", delta.context);
  const updates = Array.isArray(delta.updates) ? delta.updates : [];
  for (const update of updates) {
    parts.push("|u");
    push("s", update?.$source);
    const srcObj = update?.source as Record<string, unknown> | undefined;
    if (srcObj && typeof srcObj === "object") {
      push("sl", srcObj.label);
      push("st", srcObj.type);
      push("ss", srcObj.src);
    }
    push("t", update?.timestamp);
    const values = Array.isArray(update?.values) ? update.values : [];
    for (const v of values) {
      parts.push("|v");
      push("p", v?.path);
      const value = v?.value;
      if (value === null || value === undefined) {
        push("v", "");
      } else if (typeof value === "object") {
        push("v", JSON.stringify(value));
      } else {
        push("v", String(value));
      }
    }
  }
  return parts.join("");
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a connection instance.
 *
 * @param app            - Signal K app object
 * @param options        - Connection configuration (serverType, udpPort, …)
 * @param instanceId     - URL-safe unique identifier for this connection
 * @param pluginId       - Plugin ID (used as source label in SK messages)
 * @param onStatusChange - Called as (instanceId, message) whenever status changes
 * @returns Instance API: { start, stop, isServerMode, getId, getName, getStatus, getState, getMetricsApi }
 */
function createInstance(
  app: SignalKApp,
  options: ConnectionConfig,
  instanceId: string,
  pluginId: string,
  onStatusChange: (instanceId: string, message: string) => void
): {
  start: () => Promise<void>;
  stop: () => void;
  isServerMode: () => boolean;
  getId: () => string;
  getName: () => string;
  getStatus: () => { text: string; healthy: boolean };
  getState: () => InstanceState;
  getMetricsApi: () => MetricsApi;
  setFullStatusCascadeHandler: (handler: (() => void) | null) => void;
  requestFullStatusFromAllClients: () => void;
} {
  // ── Per-instance state ────────────────────────────────────────────────────
  const state: InstanceState = {
    instanceId,
    instanceName: options.name || instanceId,
    instanceStatus: "",
    isHealthy: false,
    options,
    socketUdp: null,
    readyToSend: false,
    stopped: false,
    // Derived from options (see derivedIsServerMode below) so isServerMode()
    // returns the correct value BEFORE start() runs. index.ts filters
    // instances into server and client groups (servers start first) using
    // inst.isServerMode(); if that read happened before start() had a chance
    // to set state.isServerMode, the server group ended up empty and every
    // instance started concurrently in the client group, defeating the
    // intended sequencing. The state field is kept as a mirror only so that
    // other modules typed against InstanceState.isServerMode keep working.
    isServerMode: derivedIsServerMode(options),
    deltas: [],
    timer: false,
    batchSendInFlight: false,
    pendingRetry: null,
    socketRecoveryTimer: null,
    socketRecoveryInProgress: false,
    droppedDeltaBatches: 0,
    droppedDeltaCount: 0,
    deltaTimerTime: DEFAULT_DELTA_TIMER,
    avgBytesPerDelta: SMART_BATCH_INITIAL_ESTIMATE,
    maxDeltasPerBatch: calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE),
    deltaTimerFile: null,
    subscriptionFile: null,
    sentenceFilterFile: null,
    excludedSentences: ["GSV"],
    lastPacketTime: 0,
    unsubscribes: [],
    localSubscription: null,
    helloMessageSender: null,
    pingTimeout: null,
    pingMonitor: null,
    deltaTimer: null,
    subscriptionRetryTimer: null,
    subscribing: false,
    pipeline: null,
    pipelineServer: null,
    heartbeatHandle: null,
    monitoring: null,
    configDebounceTimers: {},
    configContentHashes: {},
    configWatcherObjects: [],
    processDelta: null,
    metaConfig: null,
    metaTimer: null,
    sourceSnapshotTimer: null,
    metaDiffBuffer: [],
    metaDiffFlushTimer: null,
    metaSnapshotTimers: [],
    lastMetaRequestAt: 0,
    lastFullStatusRequestAt: 0,
    sourceRegistry: createSourceRegistry(app)
  };

  // Owns the udp4 socket lifecycle (create/bind/close), consolidating what
  // were three inline dgram.createSocket sites. The created socket is mirrored
  // into state.socketUdp so the pipelines keep sending over it directly.
  const socketManager = new UdpSocketManager();

  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;
  const recentOutboundDeltas = new Map<string, number>();
  let recentOutboundDeltasCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let lastOutboundDuplicateLogAt = 0;
  // Coalesce `app.reportOutputMessages()` calls so a burst of deltas in the
  // same event-loop tick produces one status nudge, not N. Without this, a
  // 200 delta/s stream produces 200 microtasks/s just for status reporting.
  let reportOutputMessagesPending = false;
  function scheduleReportOutputMessages(): void {
    if (reportOutputMessagesPending) {
      return;
    }
    reportOutputMessagesPending = true;
    setImmediate(() => {
      reportOutputMessagesPending = false;
      try {
        app.reportOutputMessages();
      } catch {
        /* ignore — status reporting is best-effort */
      }
    });
  }

  function cleanupRecentOutboundDeltas(now: number): void {
    for (const [key, seenAt] of recentOutboundDeltas) {
      if (now - seenAt > OUTBOUND_DUPLICATE_SUPPRESS_MS) {
        recentOutboundDeltas.delete(key);
      }
    }
    // Hard cap: if the map is still over the limit (a burst of unique
    // deltas inside the suppress window), drop oldest entries until under.
    while (recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) {
      const oldest = recentOutboundDeltas.keys().next();
      if (oldest.done) {
        break;
      }
      recentOutboundDeltas.delete(oldest.value);
    }
  }

  // v1 pipeline is created lazily on first use (only needed in client v1 mode)
  type V1Pipeline = {
    packCrypt(
      delta: Delta | Delta[],
      secretKey: string,
      address: string,
      port: number
    ): Promise<void>;
    unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
  };
  let v1Pipeline: V1Pipeline | null = null;
  function getV1Pipeline(): V1Pipeline {
    if (!v1Pipeline) {
      v1Pipeline = createPipeline(app, state, metricsApi);
    }
    return v1Pipeline;
  }

  // ── App proxy: redirects setPluginStatus to per-instance status ───────────
  // This prevents individual instances from overwriting the global status bar.
  const appProxy = new Proxy(app, {
    get(target: SignalKApp, prop: string) {
      if (prop === "setPluginStatus" || prop === "setProviderStatus") {
        return (msg: string) => _setStatus(msg);
      }
      return (target as unknown as Record<string, unknown>)[prop];
    }
  });

  function _setStatus(msg: string, healthyOverride?: boolean): void {
    state.instanceStatus = msg;
    if (typeof healthyOverride === "boolean") {
      state.isHealthy = healthyOverride;
    } else {
      const lower = msg ? msg.toLowerCase() : "";
      state.isHealthy = msg
        ? !lower.includes("error") && !lower.includes("fail") && !lower.includes("stopped")
        : false;
    }
    if (typeof onStatusChange === "function") {
      onStatusChange(instanceId, msg);
    }
  }

  // ── Publish RTT to Signal K (v1 client only) ──────────────────────────────
  function publishRtt(rttMs: number): void {
    if (options.protocolVersion === 1) {
      const modemRttPath = state.instanceId
        ? `networking.modem.${state.instanceId}.rtt`
        : "networking.modem.rtt";
      app.handleMessage(pluginId, {
        context: "vessels.self",
        updates: [
          {
            timestamp: new Date().toISOString(),
            values: [{ path: modemRttPath, value: rttMs / 1000 }]
          }
        ]
      });
    }
  }

  function handlePingSuccess(res: { time?: number } | null, eventName: string): void {
    if (res && res.time !== undefined) {
      publishRtt(res.time);
      app.debug(`[${instanceId}] Connection monitor: ${eventName} (RTT: ${res.time}ms)`);
    } else {
      app.debug(`[${instanceId}] Connection monitor: ${eventName}`);
    }
  }

  // ── Delta timer + outbound batch send loop ────────────────────────────────
  // The flush state machine and its timer live in the L3 delta-batcher service;
  // instance.ts is just the producer (processDelta enqueues, then flushes).
  const deltaBatcher = createDeltaBatcher({
    state,
    metrics,
    app,
    options,
    instanceId,
    recordError,
    getV1Pipeline
  });
  const { scheduleDeltaTimer, flushDeltaBatch } = deltaBatcher;

  // Periodic hello / NAT-keepalive (L3 service); handle tracked on state.
  const keepaliveManager = createKeepaliveManager({
    state,
    options,
    app,
    instanceId,
    getV1Pipeline
  });

  // ── Config file debounced watchers ────────────────────────────────────────
  const handleDeltaTimerChange = createDebouncedConfigHandler({
    name: "Delta timer",
    getFilePath: () => state.deltaTimerFile,
    processConfig: (config: unknown) => {
      const c = config as Record<string, unknown>;
      if (c && c.deltaTimer) {
        const newVal = Number(c.deltaTimer);
        if (Number.isFinite(newVal) && newVal >= 100 && newVal <= 10000) {
          if (state.deltaTimerTime !== newVal) {
            state.deltaTimerTime = newVal;
            clearTimeout(state.deltaTimer ?? undefined);
            scheduleDeltaTimer();
            app.debug(`[${instanceId}] Delta timer updated to ${newVal}ms`);
          }
        } else {
          app.error(`[${instanceId}] Invalid delta timer value: ${c.deltaTimer}`);
        }
      }
    },
    state,
    instanceId,
    app
  });

  /**
   * Forward subscribed deltas as-is except for malformed value entries that
   * Signal K would reject on the receiver side. When `skipOwnData` is set on
   * a client connection, also drop value/meta entries this plugin publishes
   * locally under the `networking.edgeLink.*` subtree, so the receiver's
   * Signal K tree is not polluted with the sender's own edge-link metrics.
   *
   * Exception: RTT paths are always forwarded regardless of skipOwnData so
   * the operator retains link-health visibility on both sides of the link.
   * The carve-out covers both v2 edge-link RTT
   * (`networking.edgeLink.rtt`, `networking.edgeLink.<instanceId>.rtt`) and
   * the v1 modem RTT paths historically published by `publishRtt`
   * (`networking.modem.rtt`, `networking.modem.<instanceId>.rtt`). See
   * `stripOwnDataFromDelta` in `delta-sanitizer.ts` for the implementation.
   */
  function filterOutboundDelta(delta: Delta): Delta | null {
    const sanitized = sanitizeDeltaForSignalK(delta);
    if (!sanitized || !options.skipOwnData) {
      return sanitized;
    }
    return stripOwnDataFromDelta(sanitized);
  }

  // ── Metadata streaming ────────────────────────────────────────────────────
  /** In-memory cache of last-sent meta (hashed) per context+path. Used to
   *  compute diffs and to skip no-op periodic resends. */
  const metaCache = new MetaCache();

  // The snapshot/diff send logic lives in the L3 metadata-streamer service;
  // metaCache is shared by reference (instance.ts clears it across resubscribe/
  // stop) and all timers live on `state` so stop() can cancel them.
  const metadataStreamer = createMetadataStreamer({
    state,
    options,
    app,
    appProxy,
    instanceId,
    recordError,
    metaCache
  });
  const {
    sendMetadataSnapshot,
    enqueueMetaDiff,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    handleMetaRequest
  } = metadataStreamer;

  /** Minimum gap between server-initiated full-status replays. Prevents a
   *  restarting or misconfigured server from flooding the link. */
  const FULL_STATUS_REQUEST_RATE_LIMIT_MS = 10000;

  /**
   * Optional callback invoked after this (client-mode) instance handles a
   * FULL_STATUS_REQUEST. Used in multi-hop chains to cascade the request to
   * any downstream clients connected to a co-located server-mode instance.
   */
  let fullStatusCascadeHandler: (() => void) | null = null;

  // Source/values snapshot re-priming (periodic source snapshot, values replay
  // on subscribe/retry/recovery, and FULL_STATUS_REQUEST) lives in the L3
  // source-snapshot service. The cascade handler is owned here (settable via
  // the public API) and read through a getter.
  const sourceSnapshotService = createSourceSnapshotService({
    state,
    options,
    app,
    appProxy,
    instanceId,
    metrics,
    getFullStatusCascadeHandler: () => fullStatusCascadeHandler
  });
  const {
    handleFullStatusRequest,
    sendSourceSnapshot,
    replayValuesSnapshot,
    restartSourceSnapshotTimer
  } = sourceSnapshotService;

  /** Thin wrapper around the parser in `metadata.ts` so the instance log
   *  line is tagged with this connection's instanceId. Errors from the
   *  shared parser already have the `[meta-config]` prefix. */
  function parseMetaConfig(raw: unknown): MetaConfig | null {
    return parseMetaConfigShared(raw, (msg) => app.error(msg), instanceId);
  }

  function processDelta(delta: Delta): void {
    metrics.processDeltaCalls = (metrics.processDeltaCalls || 0) + 1;
    if (!state.readyToSend) {
      return;
    }

    // Drop signalk-server's synchronous cache replay. handleSubscribeRow
    // calls `latest.forEach(callback)` after registering the live listener,
    // bypassing the bufferWithTime+uniqBy dedupe — so each path with a
    // cached value at subscribe time is delivered to us twice (once direct,
    // once through the live pipeline). `replayValuesSnapshot("initial
    // subscribe")` runs immediately after subscribe() returns and walks
    // the SK tree explicitly to ship initial state downstream, so dropping
    // the direct replay does not cost us any data.
    if (state.subscribing) {
      return;
    }

    // Capture live meta BEFORE the delta flows into the pipeline encoder,
    // because pathDictionary.transformDelta will strip `updates[].meta[]` when
    // rebuilding the update objects. `extractLiveMeta` returns [] when meta
    // streaming is disabled, so this is zero-cost in the default off state.
    if (state.metaConfig?.enabled) {
      const liveMeta = extractLiveMeta(delta, state.metaConfig, resolveSelfContext(appProxy));
      if (liveMeta.length > 0) {
        enqueueMetaDiff(liveMeta);
      }
    }

    const outboundDelta = filterOutboundDelta(delta);
    if (!outboundDelta) {
      return;
    }

    const now = Date.now();
    const dedupeKey = buildOutboundDedupeKey(outboundDelta);
    const lastSeenAt = recentOutboundDeltas.get(dedupeKey);
    if (lastSeenAt !== undefined && now - lastSeenAt <= OUTBOUND_DUPLICATE_SUPPRESS_MS) {
      metrics.suppressedOutboundDuplicates = (metrics.suppressedOutboundDuplicates || 0) + 1;
      recordSuppressedDuplicateStats(outboundDelta, now);
      if (now - lastOutboundDuplicateLogAt >= 1000) {
        lastOutboundDuplicateLogAt = now;
        app.debug(
          `[${instanceId}] Suppressed duplicate outbound delta (${summarizeDeltaForLog(outboundDelta)})`
        );
      }
      return;
    }
    recentOutboundDeltas.set(dedupeKey, now);
    // Cleanup is off the hot path (periodic interval); only enforce the hard
    // cap synchronously to bound memory if a burst of unique deltas lands.
    if (recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) {
      cleanupRecentOutboundDeltas(now);
    }

    if (state.deltas.length >= MAX_DELTAS_BUFFER_SIZE) {
      const dropCount = Math.floor(MAX_DELTAS_BUFFER_SIZE * DELTA_BUFFER_DROP_RATIO);
      state.deltas.splice(0, dropCount);
      app.debug(`[${instanceId}] Delta buffer overflow, dropped ${dropCount} oldest items`);
      metrics.droppedDeltaCount = (metrics.droppedDeltaCount || 0) + dropCount;
      metrics.droppedDeltaBatches = (metrics.droppedDeltaBatches || 0) + 1;
      state.droppedDeltaCount += dropCount;
      state.droppedDeltaBatches++;
      recordError(
        "sendFailure",
        `[${instanceId}] Delta buffer overflow, dropped ${dropCount} oldest items`
      );
    }

    state.deltas.push(outboundDelta);
    if (state.deltas.length > (metrics.deltasBufferHighWaterMark || 0)) {
      metrics.deltasBufferHighWaterMark = state.deltas.length;
    }
    scheduleReportOutputMessages();

    const batchReady = state.deltas.length >= state.maxDeltasPerBatch;
    if ((batchReady || state.timer) && !state.pendingRetry) {
      if (batchReady) {
        app.debug(`[${instanceId}] Smart batch: sending ${state.deltas.length} deltas`);
        metrics.smartBatching.earlySends++;
      } else {
        metrics.smartBatching.timerSends++;
      }
      flushDeltaBatch().catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        app.error(`[${instanceId}] flushDeltaBatch error: ${errMsg}`);
        recordError("sendFailure", `flushDeltaBatch error: ${errMsg}`);
      });
    }
  }

  state.processDelta = processDelta;

  // The subscription lifecycle (normalise + (re)subscribe choreography,
  // generation-guarded delivery, staged meta commit, and the retry loop)
  // lives in the L3 subscription-manager service. It re-primes the receiver
  // and (re)arms metadata streaming via injected callbacks; the active
  // generation is owned there and invalidated from stop().
  const subscriptionManager = createSubscriptionManager({
    state,
    app,
    instanceId,
    recordError,
    processDelta,
    setStatus: _setStatus,
    metaCache,
    parseMetaConfig,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    replayValuesSnapshot
  });
  const { handleSubscriptionChange } = subscriptionManager;

  const handleSentenceFilterChange = createDebouncedConfigHandler({
    name: "Sentence filter",
    getFilePath: () => state.sentenceFilterFile,
    processConfig: (config: unknown) => {
      const c = config as Record<string, unknown>;
      if (c && Array.isArray(c.excludedSentences)) {
        state.excludedSentences = c.excludedSentences
          .map((s: unknown) => String(s).trim().toUpperCase())
          .filter((s: string) => s.length > 0);
        app.debug(
          `[${instanceId}] Sentence filter updated: [${state.excludedSentences.join(", ")}]`
        );
      } else {
        app.error(`[${instanceId}] Invalid sentence filter configuration`);
      }
    },
    state,
    instanceId,
    app
  });

  // ── File-system watchers (delegated to config-watcher module) ────────────
  async function setupConfigWatchers(): Promise<void> {
    try {
      const watcherConfigs = [
        { filePath: state.deltaTimerFile, onChange: handleDeltaTimerChange, name: "Delta timer" },
        {
          filePath: state.subscriptionFile,
          onChange: handleSubscriptionChange,
          name: "Subscription"
        },
        {
          filePath: state.sentenceFilterFile,
          onChange: handleSentenceFilterChange,
          name: "Sentence filter"
        }
      ];

      state.configWatcherObjects = watcherConfigs.map((cfg) =>
        createWatcherWithRecovery({ ...cfg, instanceId, app, state })
      );

      // Trigger initial subscription load immediately (no debounce). The
      // debounce delay exists to coalesce file-system change events; for the
      // one-shot startup load it just widens the window during which deltas
      // produced by co-located plugins are emitted before our subscription
      // is registered with the subscriptionmanager — those deltas would be
      // silently dropped since the manager only delivers future events.
      await handleSubscriptionChange.flush();
      app.debug(`[${instanceId}] Configuration file watchers initialized`);
    } catch (err: unknown) {
      app.error(
        `[${instanceId}] Error setting up config watchers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

  async function start(): Promise<void> {
    state.stopped = false;
    state.options = options;
    state.isServerMode = derivedIsServerMode(options);

    // Validate secret key — throw so Promise.all in index.js can detect startup failure
    try {
      validateSecretKey(options.secretKey);
    } catch (error: unknown) {
      const msg = `Secret key validation failed: ${error instanceof Error ? error.message : String(error)}`;
      app.error(`[${instanceId}] ${msg}`);
      _setStatus(msg, false);
      throw new Error(`[${instanceId}] ${msg}`);
    }

    if (!Number.isInteger(options.udpPort) || options.udpPort < 1024 || options.udpPort > 65535) {
      const msg = "UDP port must be between 1024 and 65535";
      app.error(`[${instanceId}] ${msg}`);
      _setStatus(msg, false);
      throw new Error(`[${instanceId}] ${msg}`);
    }

    // Race guard: if stop() was called after we were invoked but before
    // validation finished, bail out before binding sockets / wiring watchers.
    if (state.stopped) {
      return;
    }

    // Arm the periodic dedupe GC only after validation succeeds — keeps an
    // early-throw start() from leaking a setInterval handle. The per-delta
    // hot path enforces a hard cap independently. Failures past this point
    // (socket bind, async pipeline init) clear the interval in catch below.
    if (recentOutboundDeltasCleanupTimer) {
      clearInterval(recentOutboundDeltasCleanupTimer);
    }
    recentOutboundDeltasCleanupTimer = setInterval(() => {
      cleanupRecentOutboundDeltas(Date.now());
    }, OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS);

    try {
      await startInner();
    } catch (err) {
      if (recentOutboundDeltasCleanupTimer) {
        clearInterval(recentOutboundDeltasCleanupTimer);
        recentOutboundDeltasCleanupTimer = null;
      }
      throw err;
    }
  }

  async function startInner(): Promise<void> {
    if (derivedIsServerMode(options)) {
      // ── Server mode ──
      app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
      state.socketUdp = socketManager.create();

      state.socketUdp.on("error", (err: NodeJS.ErrnoException) => {
        app.error(`[${instanceId}] UDP socket error: ${err.message}`);
        state.readyToSend = false;
        // Stop v2 periodic workers if the server socket is no longer usable.
        state.pipelineServer?.stopACKTimer?.();
        state.pipelineServer?.stopMetricsPublishing?.();
        if (err.code === "EADDRINUSE") {
          _setStatus(`Failed to start – port ${options.udpPort} already in use`, false);
        } else if (err.code === "EACCES") {
          _setStatus(`Failed to start – permission denied for port ${options.udpPort}`, false);
        } else {
          _setStatus(`UDP socket error: ${err.code || err.message}`, false);
        }
        if (state.socketUdp) {
          socketManager.close();
          state.socketUdp = null;
        }
      });

      state.socketUdp.on("listening", () => {
        if (!state.socketUdp) {
          return;
        }
        const address = state.socketUdp.address();
        app.debug(`[${instanceId}] UDP server listening on ${address.address}:${address.port}`);
        _setStatus(`Server listening on port ${address.port}`, true);
        state.readyToSend = true;
      });

      const useReliableProtocolServer = (options.protocolVersion ?? 0) >= 2;
      const reliableServerLabel = "v3";
      if (useReliableProtocolServer) {
        const v2Server = createPipelineV2Server(appProxy, state, metricsApi);
        state.pipelineServer = v2Server;

        state.socketUdp.on("message", (packet: Buffer, rinfo: dgram.RemoteInfo) => {
          v2Server.receivePacket(packet, options.secretKey, rinfo);
        });

        state.socketUdp.on("listening", () => {
          if (!state.socketUdp) {
            return;
          }
          v2Server.startACKTimer();
          v2Server.startMetricsPublishing();
          app.debug(
            `[${instanceId}] [${reliableServerLabel}] Server pipeline with ACK/NAK initialized`
          );
        });
      } else {
        state.socketUdp.on("message", (delta: Buffer) => {
          getV1Pipeline().unpackDecrypt(delta, options.secretKey);
        });
        app.debug(`[${instanceId}] [v1] Server pipeline initialized`);
      }

      const startupSocket = state.socketUdp;
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          if (!startupSocket) {
            return;
          }
          startupSocket.removeListener("listening", onStartupListening);
          startupSocket.removeListener("error", onStartupError);
        };

        const onStartupListening = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };

        const onStartupError = (err: NodeJS.ErrnoException) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(
            new Error(`[${instanceId}] Failed to bind to port ${options.udpPort}: ${err.message}`)
          );
        };

        startupSocket.once("listening", onStartupListening);
        startupSocket.once("error", onStartupError);
        socketManager.bind(options.udpPort);
      });
    } else {
      // ── Client mode ──
      await initializePersistentStorage({ instanceId, app, state });
      // Race guard: bail if stop() ran while awaiting persistent storage.
      if (state.stopped) {
        return;
      }

      // Load the delta-timer override file and distinguish not-found (first run,
      // use default) from a parse/read error (log prominently, use default).
      const dtResult = await loadConfigFileSafe(state.deltaTimerFile ?? "", app);
      if (dtResult.status === "parse_error" || dtResult.status === "read_error") {
        app.error(
          `[${instanceId}] Delta timer config load failed (${dtResult.status}): ${dtResult.message} — using default`
        );
      }
      const deltaTimerTimeFile =
        dtResult.status === "ok" ? (dtResult.data as Record<string, unknown>) : null;
      const rawDt =
        typeof deltaTimerTimeFile?.deltaTimer === "number" ? deltaTimerTimeFile.deltaTimer : NaN;
      state.deltaTimerTime = Number.isFinite(rawDt) && rawDt >= 100 ? rawDt : DEFAULT_DELTA_TIMER;

      const pingIntervalMinutes =
        typeof options.pingIntervalTime === "number" && Number.isFinite(options.pingIntervalTime)
          ? options.pingIntervalTime
          : 1;

      // The periodic hello / NAT-keepalive interval lives in the L3
      // keepalive-manager service; its handle is tracked on
      // state.helloMessageSender so stop() can cancel it.
      keepaliveManager.start();

      state.socketUdp = socketManager.create();
      state.readyToSend = true;
      _setStatus("Connected", true);

      // Named error handler reused for both the initial socket and any recovered
      // socket.  Using a shared reference ensures that errors on a recovered
      // socket also trigger the full recovery flow instead of only logging.
      function handleClientSocketError(err: NodeJS.ErrnoException): void {
        // Ignore errors that arrive after recovery has already started.
        if (state.socketRecoveryInProgress) {
          return;
        }
        app.error(`[${instanceId}] Client UDP socket error: ${err.message}`);
        state.readyToSend = false;
        state.socketRecoveryInProgress = true;
        // Stop v2 periodic workers if the client socket is no longer usable.
        state.pipeline?.stopMetricsPublishing?.();
        state.pipeline?.stopCongestionControl?.();
        if (state.heartbeatHandle) {
          state.heartbeatHandle.stop();
          state.heartbeatHandle = null;
        }
        _setStatus(`UDP socket error: ${err.code || err.message} — recovering`, false);
        if (state.socketUdp) {
          try {
            socketManager.close();
          } catch (_e) {
            /* already closed */
          }
          state.socketUdp = null;
        }

        // Attempt socket recovery after a short delay.
        // Store the handle so stop() can cancel it before it fires.
        if (!state.stopped) {
          state.socketRecoveryTimer = setTimeout(() => {
            state.socketRecoveryTimer = null;
            if (state.stopped) {
              state.socketRecoveryInProgress = false;
              return;
            }
            app.debug(`[${instanceId}] Attempting UDP socket recovery`);
            try {
              state.socketUdp = socketManager.create();
              // Reuse the same handler so errors on the recovered socket also
              // trigger recovery rather than only logging and staying broken.
              state.socketUdp.on("error", handleClientSocketError);

              // Re-attach v2 control packet listener if pipeline exists.
              // removeAllListeners("message") is called defensively before
              // attaching so that repeated recovery calls never accumulate
              // duplicate handlers on the same socket object.
              if (state.pipeline) {
                state.socketUdp.removeAllListeners("message");
                state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                  state.pipeline?.handleControlPacket(msg, rinfo).catch((cpErr: unknown) => {
                    const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
                    app.error(`[${instanceId}] Control packet error: ${cpMsg}`);
                    recordError("general", `Control packet error: ${cpMsg}`);
                  });
                });
              }

              // Restart v2 periodic workers
              if (state.pipeline) {
                if (state.pipeline.startMetricsPublishing) {
                  state.pipeline.startMetricsPublishing();
                }
                if (
                  options.congestionControl &&
                  options.congestionControl.enabled &&
                  state.pipeline.startCongestionControl
                ) {
                  state.pipeline.startCongestionControl();
                }
                if (state.pipeline.startHeartbeat) {
                  state.heartbeatHandle = state.pipeline.startHeartbeat(
                    options.udpAddress ?? "",
                    options.udpPort,
                    {
                      heartbeatInterval: options.heartbeatInterval
                    }
                  );
                }
                // Socket recovery creates a new ephemeral port, which the
                // server treats as a new session — so we must re-identify
                // ourselves with HELLO or telemetry is silently dropped.
                // sendHello swallows its own errors, so fire-and-forget is
                // safe here (the surrounding callback is not async).
                if (state.pipeline.sendHello) {
                  state.pipeline.sendHello(options.udpAddress ?? "", options.udpPort);
                }
              }

              state.socketRecoveryInProgress = false;
              state.readyToSend = true;
              _setStatus("UDP socket recovered", true);
              app.debug(`[${instanceId}] UDP socket recovered`);
              sendSourceSnapshot().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                app.debug(`[${instanceId}] recovery source snapshot failed: ${msg}`);
              });
              // A socket-level recovery is the strongest local signal that the
              // remote receiver may have restarted. Re-prime its meta cache
              // with a full snapshot so it doesn't have to wait a full
              // `intervalSec` for periodic resend.
              if (state.metaConfig?.enabled) {
                scheduleMetadataSnapshot(1000);
              }
              // Re-prime the receiver's value tree too — a restarted
              // receiver lost everything we sent before, and the
              // subscription manager won't replay past deltas.
              replayValuesSnapshot("socket recovery");
            } catch (recoveryErr: unknown) {
              state.socketRecoveryInProgress = false;
              const recoveryMsg =
                recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
              app.error(`[${instanceId}] UDP socket recovery failed: ${recoveryMsg}`);
              _setStatus(`UDP socket recovery failed: ${recoveryMsg}`, false);
            }
          }, 5000);
        }
      }

      state.socketUdp.on("error", handleClientSocketError);

      scheduleDeltaTimer();
      // Ping / connectivity monitor (v1 only, RTT measurement)
      if ((options.protocolVersion ?? 0) < 2) {
        state.pingMonitor = new Monitor({
          address: options.testAddress ?? "",
          port: options.testPort,
          interval: pingIntervalMinutes,
          protocol: "tcp"
        });

        state.pingMonitor.on("up", (res: { time?: number } | null) => handlePingSuccess(res, "up"));
        state.pingMonitor.on("restored", (res: { time?: number } | null) =>
          handlePingSuccess(res, "restored")
        );

        for (const event of ["down", "stop", "timeout"]) {
          state.pingMonitor.on(event, () => {
            app.debug(`[${instanceId}] Connection monitor: ${event}`);
          });
        }

        state.pingMonitor.on("error", (error: NodeJS.ErrnoException | null) => {
          if (error) {
            const msg =
              error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
                ? `Could not resolve address ${options.testAddress}.`
                : `Connection monitor error: ${error.message || String(error)}`;
            app.debug(`[${instanceId}] ${msg}`);
          } else {
            app.debug(`[${instanceId}] Connection monitor error`);
          }
        });
      }

      // Reliable client pipeline (v2/v3)
      const useReliableProtocol = (options.protocolVersion ?? 0) >= 2;
      const reliableProtocolLabel = "v3";
      if (useReliableProtocol) {
        state.monitoring = {
          packetLossTracker: new PacketLossTracker(),
          pathLatencyTracker: new PathLatencyTracker(),
          retransmissionTracker: new RetransmissionTracker(),
          alertManager: new AlertManager(appProxy, {
            thresholds: options.alertThresholds || {},
            instanceId: state.instanceId,
            enabled: options.enableNotifications === true
          }),
          packetCapture: new PacketCapture(),
          packetInspector: new PacketInspector()
        };
        app.debug(`[${instanceId}] [${reliableProtocolLabel}] Enhanced monitoring initialized`);

        const v2Pipeline = createPipelineV2Client(appProxy, state, metricsApi);
        state.pipeline = v2Pipeline;

        v2Pipeline.setMonitoring(state.monitoring);
        if (typeof v2Pipeline.setMetaRequestHandler === "function") {
          v2Pipeline.setMetaRequestHandler(handleMetaRequest);
        }
        if (typeof v2Pipeline.setFullStatusRequestHandler === "function") {
          v2Pipeline.setFullStatusRequestHandler(handleFullStatusRequest);
        }
        v2Pipeline.startMetricsPublishing();

        if (options.congestionControl && options.congestionControl.enabled) {
          v2Pipeline.startCongestionControl();
        }

        state.heartbeatHandle = v2Pipeline.startHeartbeat(
          options.udpAddress ?? "",
          options.udpPort,
          {
            heartbeatInterval: options.heartbeatInterval
          }
        );
        // Send HELLO immediately so the server can identify this client and
        // accept its telemetry into remoteNetworkQuality. Without this, the
        // server's Network Quality dashboard stays at 0/0/0 — every telemetry
        // delta is silently dropped at the peerIdentified gate.
        await v2Pipeline.sendHello(options.udpAddress ?? "", options.udpPort);
        restartSourceSnapshotTimer();
        sendSourceSnapshot().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          app.debug(`[${instanceId}] initial source snapshot failed: ${msg}`);
        });
        state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          v2Pipeline.handleControlPacket(msg, rinfo).catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            app.error(`[${instanceId}] Control packet error: ${errMsg}`);
            recordError("general", `Control packet error: ${errMsg}`);
          });
        });

        if (options.bonding && options.bonding.enabled) {
          const bondingConfig = {
            mode: options.bonding.mode || "main-backup",
            primary: options.bonding.primary || {
              address: options.udpAddress,
              port: options.udpPort
            },
            backup: options.bonding.backup || {
              address: options.udpAddress,
              port: options.udpPort + 1
            },
            failover: options.bonding.failover || {},
            instanceId: state.instanceId,
            notificationsEnabled: options.enableNotifications === true,
            secretKey: options.secretKey,
            stretchAsciiKey: !!options.stretchAsciiKey
          };
          try {
            await v2Pipeline.initBonding(bondingConfig);
            app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
          } catch (err: unknown) {
            app.error(
              `[${instanceId}] [Bonding] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        app.debug(
          `[${instanceId}] [${reliableProtocolLabel}] Reliable client pipeline initialized`
        );
      } else {
        if (options.congestionControl && options.congestionControl.enabled) {
          app.error(`[${instanceId}] [v1] Congestion control requires Protocol v2 – ignoring`);
        }
        if (options.bonding && options.bonding.enabled) {
          app.error(`[${instanceId}] [v1] Connection bonding requires Protocol v2 – ignoring`);
        }
        app.debug(`[${instanceId}] [v1] Client pipeline initialized`);
      }

      // Race guard: if stop() ran while we were configuring the pipeline,
      // do not attach fs watchers / register subscriptions.
      if (state.stopped) {
        return;
      }
      // Wire the Signal K subscription after the client send pipeline is ready.
      // The subscription handler performs one explicit values-snapshot replay;
      // doing it here prevents the v2 startup path from also sending a second
      // "initial connect" snapshot.
      await setupConfigWatchers();
    }
  }

  function summarizeDeltaForLog(delta: Delta): string {
    const fields = getDeltaSummaryFields(delta);
    return `context=${fields.context}, path=${fields.path}, source=${fields.source}, timestamp=${fields.timestamp}, updates=${fields.updateCount}, values=${fields.valueCount}, suppressed=${metrics.suppressedOutboundDuplicates || 0}`;
  }

  function getDeltaSummaryFields(delta: Delta): {
    context: string;
    path: string;
    source: string;
    timestamp: string;
    updateCount: number;
    valueCount: number;
  } {
    const update = Array.isArray(delta.updates) ? delta.updates[0] : null;
    const value = Array.isArray(update?.values) ? update.values[0] : null;
    const context = delta.context || "?";
    const path = value?.path || "?";
    const source = update?.$source || update?.source?.label || "?";
    const timestamp = update?.timestamp || "?";
    const updateCount = Array.isArray(delta.updates) ? delta.updates.length : 0;
    const valueCount = Array.isArray(delta.updates)
      ? delta.updates.reduce(
          (sum, item) => sum + (Array.isArray(item.values) ? item.values.length : 0),
          0
        )
      : 0;
    return { context, path, source, timestamp, updateCount, valueCount };
  }

  function recordSuppressedDuplicateStats(delta: Delta, now: number): void {
    if (!metrics.suppressedOutboundDuplicateStats) {
      metrics.suppressedOutboundDuplicateStats = new Map();
    }
    const fields = getDeltaSummaryFields(delta);
    const key = JSON.stringify({
      context: fields.context,
      path: fields.path,
      source: fields.source
    });
    const existing = metrics.suppressedOutboundDuplicateStats.get(key);
    if (existing) {
      existing.count++;
      existing.lastUpdate = now;
      return;
    }

    if (metrics.suppressedOutboundDuplicateStats.size >= SUPPRESSED_DUPLICATE_STATS_MAX_SIZE) {
      let stalestKey: string | null = null;
      let stalestTime = Infinity;
      for (const [candidateKey, item] of metrics.suppressedOutboundDuplicateStats) {
        if (item.lastUpdate < stalestTime) {
          stalestKey = candidateKey;
          stalestTime = item.lastUpdate;
        }
      }
      if (stalestKey) {
        metrics.suppressedOutboundDuplicateStats.delete(stalestKey);
      }
    }

    metrics.suppressedOutboundDuplicateStats.set(key, {
      context: fields.context,
      path: fields.path,
      source: fields.source,
      count: 1,
      lastUpdate: now
    });
  }

  function stop(): void {
    // If a batch send is in progress, log the warning. We cannot reliably
    // await it here because stop() must remain synchronous (called by the
    // Signal K lifecycle). The in-flight send will detect state.stopped and
    // skip any further action once it completes.
    if (state.batchSendInFlight) {
      app.debug(
        `[${instanceId}] stop() called while batch send in flight — last delta batch may be lost`
      );
    }

    state.stopped = true;
    state.readyToSend = false;
    state.isHealthy = false;

    // Unsubscribe from Signal K
    state.unsubscribes.forEach((f: () => void) => f());
    state.unsubscribes = [];
    state.localSubscription = null;
    subscriptionManager.invalidateGeneration();

    // Reset runtime state
    state.deltas = [];
    recentOutboundDeltas.clear();
    if (recentOutboundDeltasCleanupTimer) {
      clearInterval(recentOutboundDeltasCleanupTimer);
      recentOutboundDeltasCleanupTimer = null;
    }
    state.timer = false;
    state.batchSendInFlight = false;
    state.socketRecoveryInProgress = false;
    state.droppedDeltaBatches = 0;
    state.droppedDeltaCount = 0;
    Object.keys(state.configContentHashes).forEach(
      (k: string) => delete state.configContentHashes[k]
    );
    state.excludedSentences = ["GSV"];
    state.lastPacketTime = 0;
    state.lastFullStatusRequestAt = 0;

    // Reset metrics
    resetMetrics();

    // Clear timers
    keepaliveManager.stop();
    clearInterval(state.metaTimer ?? undefined);
    state.metaTimer = null;
    clearInterval(state.sourceSnapshotTimer ?? undefined);
    state.sourceSnapshotTimer = null;
    clearTimeout(state.metaDiffFlushTimer ?? undefined);
    state.metaDiffFlushTimer = null;
    for (const handle of state.metaSnapshotTimers) {
      clearTimeout(handle);
    }
    state.metaSnapshotTimers = [];
    state.metaDiffBuffer = [];
    state.metaConfig = null;
    state.pendingMetaConfig = undefined;
    metaCache.clear();
    clearTimeout(state.deltaTimer ?? undefined);
    state.deltaTimer = null;
    clearTimeout(state.pendingRetry ?? undefined);
    state.pendingRetry = null;
    clearTimeout(state.subscriptionRetryTimer ?? undefined);
    state.subscriptionRetryTimer = null;
    clearTimeout(state.socketRecoveryTimer ?? undefined);
    state.socketRecoveryTimer = null;
    Object.keys(state.configDebounceTimers).forEach((k: string) => {
      clearTimeout(state.configDebounceTimers[k]);
      delete state.configDebounceTimers[k];
    });

    // Stop file-system watchers
    state.configWatcherObjects.forEach((w) => w.close());
    state.configWatcherObjects = [];

    // Stop v2 client pipeline
    state.pipeline?.stopBonding?.();
    state.pipeline?.stopMetricsPublishing?.();
    state.pipeline?.stopCongestionControl?.();
    state.pipeline = null;
    if (state.heartbeatHandle) {
      state.heartbeatHandle.stop();
      state.heartbeatHandle = null;
    }

    // Stop v2 server pipeline
    state.pipelineServer?.stopACKTimer?.();
    state.pipelineServer?.stopMetricsPublishing?.();
    state.pipelineServer?.getSequenceTracker?.()?.reset();
    state.pipelineServer = null;

    // Clean up enhanced monitoring
    if (state.monitoring) {
      if (state.monitoring.packetLossTracker) {
        state.monitoring.packetLossTracker.reset();
      }
      if (state.monitoring.pathLatencyTracker) {
        state.monitoring.pathLatencyTracker.reset();
      }
      if (state.monitoring.retransmissionTracker) {
        state.monitoring.retransmissionTracker.reset();
      }
      if (state.monitoring.packetCapture) {
        state.monitoring.packetCapture.reset();
      }
      if (state.monitoring.packetInspector) {
        state.monitoring.packetInspector.reset();
      }
      if (state.monitoring.alertManager) {
        state.monitoring.alertManager.reset();
      }
      state.monitoring = null;
    }
    // Stop ping monitor
    if (state.pingMonitor) {
      state.pingMonitor.stop();
      state.pingMonitor = null;
    }

    // Close UDP socket(s)
    if (state.socketUdp) {
      socketManager.close();
      state.socketUdp = null;
      app.debug(`[${instanceId}] Stopped`);
    }
    _setStatus("Stopped", false);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    start,
    stop,
    isServerMode: () => state.isServerMode,
    getId: () => instanceId,
    getName: () => state.instanceName,
    getStatus: () => ({ text: state.instanceStatus, healthy: state.isHealthy }),
    getState: () => state,
    getMetricsApi: () => metricsApi,
    /** Register a callback to invoke when this client-mode instance handles
     *  a FULL_STATUS_REQUEST, so the request cascades to downstream clients. */
    setFullStatusCascadeHandler(handler: (() => void) | null) {
      fullStatusCascadeHandler = handler;
    },
    /** Forward a FULL_STATUS_REQUEST to all currently-connected clients
     *  (server-mode instances only; no-op on client-mode instances). */
    requestFullStatusFromAllClients() {
      state.pipelineServer?.requestFullStatusFromAllClients?.();
    }
  };
}

export { createInstance, slugify, buildOutboundDedupeKey };
