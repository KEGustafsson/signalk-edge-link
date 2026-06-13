"use strict";

/**
 * Connection orchestrator (L4 application layer).
 *
 * Thin compositor: constructs and wires the L3 domain services and the L2
 * transport layer, and owns the lifecycle FSM. Contains no protocol or
 * transport logic — those live in the layers below. Replaces instance.ts.
 *
 * @module app/connection
 */

import dgram from "dgram";
import { UdpSocketManager } from "../transport/udp-socket-manager";
import { validateSecretKey } from "../codec/crypto";
import Monitor from "ping-monitor";
import createMetrics from "../domain/metrics/registry";
import { createSourceRegistry } from "../domain/source-registry";
import { createDeltaBatcher } from "../domain/delta-batcher";
import { createMetadataStreamer } from "../domain/metadata-streamer";
import { createSourceSnapshotService } from "../domain/source-snapshot-service";
import { createKeepaliveManager } from "../domain/keepalive-manager";
import { createSubscriptionManager } from "../domain/subscription-manager";
import {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
} from "../domain/monitoring";
import { PacketCapture, PacketInspector } from "../domain/monitoring/packet-capture";
import {
  DEFAULT_DELTA_TIMER,
  MAX_DELTAS_BUFFER_SIZE,
  DELTA_BUFFER_DROP_RATIO,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch,
  OUTBOUND_DUPLICATE_SUPPRESS_MS,
  SUPPRESSED_DUPLICATE_STATS_MAX_SIZE,
  OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS,
  OUTBOUND_DEDUPE_MAX_ENTRIES
} from "../constants";
import { loadConfigFileSafe } from "../config-io";
import {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  initializePersistentStorage
} from "../config-watcher";
import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  MetricsApi,
  Delta,
  MetaConfig
} from "../foundation/types";
import {
  MetaCache,
  extractLiveMeta,
  parseMetaConfig as parseMetaConfigShared,
  resolveSelfContext
} from "../codec/metadata-codec";
import { sanitizeDeltaForSignalK, stripOwnDataFromDelta } from "../codec/delta-sanitizer";
import { Lifecycle } from "./lifecycle";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive a URL-safe identifier from a human-readable name. */
export function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

/** Derive server mode from options (supports legacy boolean and string forms). */
function isServer(options: ConnectionConfig): boolean {
  return (options.serverType as unknown) === true || options.serverType === "server";
}

/**
 * Build a deterministic deduplication key for an outbound delta.
 * Replaces JSON.stringify on the per-delta hot path.
 */
export function buildOutboundDedupeKey(delta: Delta): string {
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

/** Public API surface of a single server or client connection instance. */
export interface ConnectionApi {
  /** Start the connection (bind socket, begin handshake, transition to Ready). */
  start(): Promise<void>;
  /** Tear down the connection, cancel all timers, and release the socket. */
  stop(): void;
  /** True when this instance was configured as a UDP server listener. */
  isServerMode(): boolean;
  /** Unique slug identifier for this instance within the plugin. */
  getId(): string;
  /** Human-readable name from config, used in status messages. */
  getName(): string;
  /** Current health summary for the plugin status bar. */
  getStatus(): { text: string; healthy: boolean };
  /** Raw mutable state (exposed for tests and route handlers; treat as read-only outside connection.ts). */
  getState(): InstanceState;
  /** Access to per-instance counters and error records. */
  getMetricsApi(): MetricsApi;
  /** Install a handler invoked when the upstream server requests a full-status re-push. */
  setFullStatusCascadeHandler(handler: (() => void) | null): void;
  /** Ask all connected downstream clients to re-send their full state (server-mode only; no-op on clients). */
  requestFullStatusFromAllClients(): void;
}

/**
 * Create a single server or client connection instance.
 *
 * @param app - SignalK app handle (logging, subscriptions, data).
 * @param options - Validated connection configuration.
 * @param instanceId - Unique slug for this instance (collision-free, from connection manager).
 * @param pluginId - Plugin ID used when emitting deltas via `app.handleMessage`.
 * @param onStatusChange - Callback invoked whenever the instance health/status changes.
 */
export function createConnection(
  app: SignalKApp,
  options: ConnectionConfig,
  instanceId: string,
  pluginId: string,
  onStatusChange: (instanceId: string, message: string) => void
): ConnectionApi {
  const lifecycle = new Lifecycle();
  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;
  const socketManager = new UdpSocketManager();

  // ── Per-instance state ─────────────────────────────────────────────────────
  const state: InstanceState = {
    instanceId,
    instanceName: options.name || instanceId,
    instanceStatus: "",
    isHealthy: false,
    options,
    socketUdp: null,
    readyToSend: false,
    stopped: false,
    isServerMode: isServer(options),
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

  // ── Status helpers ─────────────────────────────────────────────────────────
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
    state.isHealthy =
      typeof healthyOverride === "boolean"
        ? healthyOverride
        : Boolean(msg && !msg.toLowerCase().match(/error|fail|stopped/));
    if (typeof onStatusChange === "function") {
      onStatusChange(instanceId, msg);
    }
  }

  // ── Outbound dedupe ────────────────────────────────────────────────────────
  const recentOutboundDeltas = new Map<string, number>();
  let dedupeCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let lastDupLogAt = 0;

  function cleanupDedupeMap(now: number): void {
    for (const [key, seenAt] of recentOutboundDeltas) {
      if (now - seenAt > OUTBOUND_DUPLICATE_SUPPRESS_MS) recentOutboundDeltas.delete(key);
    }
    while (recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) {
      const oldest = recentOutboundDeltas.keys().next();
      if (!oldest.done) recentOutboundDeltas.delete(oldest.value);
    }
  }

  // ── Scheduled output-messages coalescer ───────────────────────────────────
  let reportPending = false;
  function scheduleReportOutputMessages(): void {
    if (reportPending) return;
    reportPending = true;
    setImmediate(() => {
      reportPending = false;
      try {
        app.reportOutputMessages();
      } catch {
        /* best-effort */
      }
    });
  }

  // ── RTT publish + ping helpers ─────────────────────────────────────────────
  function publishRtt(rttMs: number): void {
    if (options.protocolVersion === 1) {
      const path = instanceId ? `networking.modem.${instanceId}.rtt` : "networking.modem.rtt";
      app.handleMessage(pluginId, {
        context: "vessels.self",
        updates: [{ timestamp: new Date().toISOString(), values: [{ path, value: rttMs / 1000 }] }]
      });
    }
  }

  function handlePingSuccess(res: { time?: number } | null, event: string): void {
    if (res?.time !== undefined) {
      publishRtt(res.time);
      app.debug(`[${instanceId}] Connection monitor: ${event} (RTT: ${res.time}ms)`);
    } else {
      app.debug(`[${instanceId}] Connection monitor: ${event}`);
    }
  }

  // ── V1 pipeline (lazy) ─────────────────────────────────────────────────────
  type V1PipelineLike = {
    packCrypt(
      delta: Delta | Delta[],
      secretKey: string,
      address: string,
      port: number
    ): Promise<void>;
    unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
  };
  let v1Pipeline: V1PipelineLike | null = null;
  function getV1Pipeline(): V1PipelineLike {
    if (!v1Pipeline) {
      const createPipelineV1 = require("../transport/pipeline/v1");
      v1Pipeline = createPipelineV1(app, state, metricsApi) as V1PipelineLike;
    }
    return v1Pipeline;
  }

  // ── Domain services ────────────────────────────────────────────────────────
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

  const keepaliveManager = createKeepaliveManager({
    state,
    options,
    app,
    instanceId,
    getV1Pipeline
  });

  const metaCache = new MetaCache();

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

  let fullStatusCascadeHandler: (() => void) | null = null;
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

  function parseMetaConfig(raw: unknown): MetaConfig | null {
    return parseMetaConfigShared(raw, (msg) => app.error(msg), instanceId);
  }

  // ── processDelta ───────────────────────────────────────────────────────────
  function processDelta(delta: Delta): void {
    metrics.processDeltaCalls = (metrics.processDeltaCalls || 0) + 1;
    // readyToSend is kept in sync with the lifecycle FSM (set true on Ready,
    // false on stop). Tests may also set it directly without going through start().
    if (!state.readyToSend || state.subscribing) return;

    if (state.metaConfig?.enabled) {
      const liveMeta = extractLiveMeta(delta, state.metaConfig, resolveSelfContext(appProxy));
      if (liveMeta.length > 0) enqueueMetaDiff(liveMeta);
    }

    const sanitized = sanitizeDeltaForSignalK(delta);
    if (!sanitized) return;
    const outboundDelta = options.skipOwnData ? stripOwnDataFromDelta(sanitized) : sanitized;
    if (!outboundDelta) return;

    const now = Date.now();
    const key = buildOutboundDedupeKey(outboundDelta);
    const seenAt = recentOutboundDeltas.get(key);
    if (seenAt !== undefined && now - seenAt <= OUTBOUND_DUPLICATE_SUPPRESS_MS) {
      metrics.suppressedOutboundDuplicates = (metrics.suppressedOutboundDuplicates || 0) + 1;
      if (now - lastDupLogAt >= 1000) {
        lastDupLogAt = now;
        const upd = Array.isArray(outboundDelta.updates) ? outboundDelta.updates[0] : null;
        const val = Array.isArray(upd?.values) ? upd.values[0] : null;
        app.debug(
          `[${instanceId}] Suppressed duplicate outbound delta ` +
            `(context=${outboundDelta.context || "?"}, path=${val?.path || "?"}, ` +
            `source=${upd?.$source || upd?.source?.label || "?"}, timestamp=${upd?.timestamp || "?"}, ` +
            `updates=${Array.isArray(outboundDelta.updates) ? outboundDelta.updates.length : 0}, ` +
            `values=${Array.isArray(upd?.values) ? upd.values.length : 0}, ` +
            `suppressed=${metrics.suppressedOutboundDuplicates || 0})`
        );
      }
      return;
    }
    recentOutboundDeltas.set(key, now);
    if (recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) cleanupDedupeMap(now);

    if (state.deltas.length >= MAX_DELTAS_BUFFER_SIZE) {
      const drop = Math.floor(MAX_DELTAS_BUFFER_SIZE * DELTA_BUFFER_DROP_RATIO);
      state.deltas.splice(0, drop);
      app.debug(`[${instanceId}] Delta buffer overflow, dropped ${drop} oldest items`);
      metrics.droppedDeltaCount = (metrics.droppedDeltaCount || 0) + drop;
      metrics.droppedDeltaBatches = (metrics.droppedDeltaBatches || 0) + 1;
      state.droppedDeltaCount += drop;
      state.droppedDeltaBatches++;
      recordError(
        "sendFailure",
        `[${instanceId}] Delta buffer overflow, dropped ${drop} oldest items`
      );
    }

    state.deltas.push(outboundDelta);
    if (state.deltas.length > (metrics.deltasBufferHighWaterMark || 0)) {
      metrics.deltasBufferHighWaterMark = state.deltas.length;
    }
    scheduleReportOutputMessages();

    const batchReady = state.deltas.length >= state.maxDeltasPerBatch;
    if ((batchReady || state.timer) && !state.pendingRetry) {
      if (batchReady) metrics.smartBatching.earlySends++;
      else metrics.smartBatching.timerSends++;
      flushDeltaBatch().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.error(`[${instanceId}] flushDeltaBatch error: ${msg}`);
        recordError("sendFailure", `flushDeltaBatch error: ${msg}`);
      });
    }
  }

  state.processDelta = processDelta;

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

  // ── Config file watchers ───────────────────────────────────────────────────
  const handleDeltaTimerChange = createDebouncedConfigHandler({
    name: "Delta timer",
    getFilePath: () => state.deltaTimerFile,
    processConfig: (config: unknown) => {
      const c = config as Record<string, unknown>;
      if (c?.deltaTimer) {
        const val = Number(c.deltaTimer);
        if (Number.isFinite(val) && val >= 100 && val <= 10000 && state.deltaTimerTime !== val) {
          state.deltaTimerTime = val;
          clearTimeout(state.deltaTimer ?? undefined);
          scheduleDeltaTimer();
          app.debug(`[${instanceId}] Delta timer updated to ${val}ms`);
        } else if (!Number.isFinite(val)) {
          app.error(`[${instanceId}] Invalid delta timer value: ${c.deltaTimer}`);
        }
      }
    },
    state,
    instanceId,
    app
  });

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

  async function setupConfigWatchers(): Promise<void> {
    try {
      const watchers = [
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
      state.configWatcherObjects = watchers.map((cfg) =>
        createWatcherWithRecovery({ ...cfg, instanceId, app, state })
      );
      await handleSubscriptionChange.flush();
      app.debug(`[${instanceId}] Configuration file watchers initialized`);
    } catch (err: unknown) {
      app.error(
        `[${instanceId}] Error setting up config watchers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Socket recovery (client mode) ─────────────────────────────────────────
  function recoverClientSocket(): void {
    app.debug(`[${instanceId}] Attempting UDP socket recovery`);
    try {
      state.socketUdp = socketManager.create();
      state.socketUdp.on("error", handleClientSocketError);

      if (state.pipeline) {
        state.socketUdp.removeAllListeners("message");
        state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          state.pipeline?.handleControlPacket(msg, rinfo).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            app.error(`[${instanceId}] Control packet error: ${m}`);
            recordError("general", `Control packet error: ${m}`);
          });
        });
        state.pipeline.startMetricsPublishing?.();
        if (options.congestionControl?.enabled) state.pipeline.startCongestionControl?.();
        if (state.pipeline.startHeartbeat) {
          state.heartbeatHandle = state.pipeline.startHeartbeat(
            options.udpAddress ?? "",
            options.udpPort,
            { heartbeatInterval: options.heartbeatInterval }
          );
        }
        state.pipeline.sendHello?.(options.udpAddress ?? "", options.udpPort);
      }

      state.socketRecoveryInProgress = false;
      state.readyToSend = true;
      lifecycle.transition("Ready", (msg) => app.error(msg));
      _setStatus("UDP socket recovered", true);
      app.debug(`[${instanceId}] UDP socket recovered`);
      sendSourceSnapshot().catch((err: unknown) => {
        app.debug(
          `[${instanceId}] recovery source snapshot failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      if (state.metaConfig?.enabled) scheduleMetadataSnapshot(1000);
      replayValuesSnapshot("socket recovery");
    } catch (err: unknown) {
      state.socketRecoveryInProgress = false;
      const msg = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] UDP socket recovery failed: ${msg}`);
      lifecycle.transition("Stopped", (m) => app.error(m));
      _setStatus(`UDP socket recovery failed: ${msg}`, false);
    }
  }

  function handleClientSocketError(err: NodeJS.ErrnoException): void {
    if (state.socketRecoveryInProgress || lifecycle.isShuttingDown()) return;
    app.error(`[${instanceId}] Client UDP socket error: ${err.message}`);
    state.readyToSend = false;
    state.socketRecoveryInProgress = true;
    state.pipeline?.stopMetricsPublishing?.();
    state.pipeline?.stopCongestionControl?.();
    if (state.heartbeatHandle) {
      state.heartbeatHandle.stop();
      state.heartbeatHandle = null;
    }
    lifecycle.transition("Recovering", (msg) => app.error(msg));
    _setStatus(`UDP socket error: ${err.code || err.message} — recovering`, false);
    if (state.socketUdp) {
      try {
        socketManager.close();
      } catch {
        /* already closed */
      }
      state.socketUdp = null;
    }
    if (!lifecycle.isShuttingDown()) {
      state.socketRecoveryTimer = setTimeout(() => {
        state.socketRecoveryTimer = null;
        if (lifecycle.isShuttingDown()) {
          state.socketRecoveryInProgress = false;
          return;
        }
        recoverClientSocket();
      }, 5000);
    }
  }

  // ── Server start ───────────────────────────────────────────────────────────
  async function startServer(): Promise<void> {
    app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
    state.socketUdp = socketManager.create();

    state.socketUdp.on("error", (err: NodeJS.ErrnoException) => {
      app.error(`[${instanceId}] UDP socket error: ${err.message}`);
      state.readyToSend = false;
      state.pipelineServer?.stopACKTimer?.();
      state.pipelineServer?.stopMetricsPublishing?.();
      const msg =
        err.code === "EADDRINUSE"
          ? `Failed to start – port ${options.udpPort} already in use`
          : err.code === "EACCES"
            ? `Failed to start – permission denied for port ${options.udpPort}`
            : `UDP socket error: ${err.code || err.message}`;
      _setStatus(msg, false);
      if (state.socketUdp) {
        socketManager.close();
        state.socketUdp = null;
      }
    });

    state.socketUdp.on("listening", () => {
      if (!state.socketUdp) return;
      const addr = state.socketUdp.address();
      app.debug(`[${instanceId}] UDP server listening on ${addr.address}:${addr.port}`);
      state.readyToSend = true;
      _setStatus(`Server listening on port ${addr.port}`, true);
    });

    const useReliable = (options.protocolVersion ?? 0) >= 2;
    if (useReliable) {
      const { createPipelineV2Server } = require("../transport/pipeline/reliable-server");
      const srv = createPipelineV2Server(appProxy, state, metricsApi);
      state.pipelineServer = srv;
      state.socketUdp.on("message", (pkt: Buffer, rinfo: dgram.RemoteInfo) => {
        srv.receivePacket(pkt, options.secretKey, rinfo);
      });
      state.socketUdp.on("listening", () => {
        if (!state.socketUdp) return;
        srv.startACKTimer();
        srv.startMetricsPublishing();
        app.debug(`[${instanceId}] [v3] Server pipeline with ACK/NAK initialized`);
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
        startupSocket?.removeListener("listening", onListen);
        startupSocket?.removeListener("error", onError);
      };
      const onListen = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onError = (e: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            new Error(`[${instanceId}] Failed to bind to port ${options.udpPort}: ${e.message}`)
          );
        }
      };
      startupSocket.once("listening", onListen);
      startupSocket.once("error", onError);
      socketManager.bind(options.udpPort);
    });
  }

  // ── Client start ───────────────────────────────────────────────────────────
  async function startClient(): Promise<void> {
    await initializePersistentStorage({ instanceId, app, state });
    if (lifecycle.isShuttingDown()) return;

    const dtResult = await loadConfigFileSafe(state.deltaTimerFile ?? "", app);
    if (dtResult.status === "parse_error" || dtResult.status === "read_error") {
      app.error(
        `[${instanceId}] Delta timer config load failed (${dtResult.status}): ${dtResult.message} — using default`
      );
    }
    const dtData = dtResult.status === "ok" ? (dtResult.data as Record<string, unknown>) : null;
    const rawDt = typeof dtData?.deltaTimer === "number" ? dtData.deltaTimer : NaN;
    state.deltaTimerTime = Number.isFinite(rawDt) && rawDt >= 100 ? rawDt : DEFAULT_DELTA_TIMER;

    const pingIntervalMinutes =
      typeof options.pingIntervalTime === "number" && Number.isFinite(options.pingIntervalTime)
        ? options.pingIntervalTime
        : 1;

    keepaliveManager.start();
    state.socketUdp = socketManager.create();
    state.readyToSend = true;
    _setStatus("Connected", true);
    state.socketUdp.on("error", handleClientSocketError);
    scheduleDeltaTimer();

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
      for (const e of ["down", "stop", "timeout"]) {
        state.pingMonitor.on(e, () => app.debug(`[${instanceId}] Connection monitor: ${e}`));
      }
      state.pingMonitor.on("error", (error: NodeJS.ErrnoException | null) => {
        if (!error) {
          app.debug(`[${instanceId}] Connection monitor error`);
          return;
        }
        const msg =
          error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
            ? `Could not resolve address ${options.testAddress}.`
            : `Connection monitor error: ${error.message || String(error)}`;
        app.debug(`[${instanceId}] ${msg}`);
      });
    }

    const useReliable = (options.protocolVersion ?? 0) >= 2;
    if (useReliable) {
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
      app.debug(`[${instanceId}] [v3] Enhanced monitoring initialized`);

      const { createPipelineV2Client } = require("../transport/pipeline/reliable-client");
      const v2 = createPipelineV2Client(appProxy, state, metricsApi);
      state.pipeline = v2;
      v2.setMonitoring(state.monitoring);
      if (typeof v2.setMetaRequestHandler === "function")
        v2.setMetaRequestHandler(handleMetaRequest);
      if (typeof v2.setFullStatusRequestHandler === "function")
        v2.setFullStatusRequestHandler(handleFullStatusRequest);
      v2.startMetricsPublishing();
      if (options.congestionControl?.enabled) v2.startCongestionControl();
      state.heartbeatHandle = v2.startHeartbeat(options.udpAddress ?? "", options.udpPort, {
        heartbeatInterval: options.heartbeatInterval
      });
      await v2.sendHello(options.udpAddress ?? "", options.udpPort);
      restartSourceSnapshotTimer();
      sendSourceSnapshot().catch((err: unknown) => {
        app.debug(
          `[${instanceId}] initial source snapshot failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      state.socketUdp!.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        v2.handleControlPacket(msg, rinfo).catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          app.error(`[${instanceId}] Control packet error: ${m}`);
          recordError("general", `Control packet error: ${m}`);
        });
      });

      if (options.bonding?.enabled) {
        const bondCfg = {
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
          await v2.initBonding(bondCfg);
          app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
        } catch (err: unknown) {
          app.error(
            `[${instanceId}] [Bonding] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      app.debug(`[${instanceId}] [v3] Reliable client pipeline initialized`);
    } else {
      if (options.congestionControl?.enabled)
        app.error(`[${instanceId}] [v1] Congestion control requires Protocol v2 – ignoring`);
      if (options.bonding?.enabled)
        app.error(`[${instanceId}] [v1] Connection bonding requires Protocol v2 – ignoring`);
      app.debug(`[${instanceId}] [v1] Client pipeline initialized`);
    }

    if (lifecycle.isShuttingDown()) return;
    await setupConfigWatchers();
  }

  // ── Lifecycle: start / stop ────────────────────────────────────────────────
  async function start(): Promise<void> {
    lifecycle.transition("Starting", (msg) => app.error(msg));
    state.stopped = false;
    state.options = options;
    state.isServerMode = isServer(options);

    try {
      validateSecretKey(options.secretKey);
    } catch (error: unknown) {
      const msg = `Secret key validation failed: ${error instanceof Error ? error.message : String(error)}`;
      app.error(`[${instanceId}] ${msg}`);
      _setStatus(msg, false);
      lifecycle.forceStop();
      state.stopped = true;
      throw new Error(`[${instanceId}] ${msg}`);
    }

    if (!Number.isInteger(options.udpPort) || options.udpPort < 1024 || options.udpPort > 65535) {
      const msg = "UDP port must be between 1024 and 65535";
      app.error(`[${instanceId}] ${msg}`);
      _setStatus(msg, false);
      lifecycle.forceStop();
      state.stopped = true;
      throw new Error(`[${instanceId}] ${msg}`);
    }

    if (lifecycle.isShuttingDown()) return;

    dedupeCleanupTimer = setInterval(
      () => cleanupDedupeMap(Date.now()),
      OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS
    );

    try {
      if (isServer(options)) {
        await startServer();
      } else {
        await startClient();
      }
      if (!lifecycle.isShuttingDown()) {
        lifecycle.transition("Ready", (msg) => app.error(msg));
        state.readyToSend = true;
      }
    } catch (err) {
      if (dedupeCleanupTimer) {
        clearInterval(dedupeCleanupTimer);
        dedupeCleanupTimer = null;
      }
      lifecycle.forceStop();
      state.stopped = true;
      throw err;
    }
  }

  function stop(): void {
    if (state.batchSendInFlight) {
      app.debug(
        `[${instanceId}] stop() called while batch send in flight — last delta batch may be lost`
      );
    }

    const wasShuttingDown = lifecycle.isShuttingDown();
    lifecycle.forceStop();
    state.stopped = true;
    state.readyToSend = false;
    state.isHealthy = false;

    state.unsubscribes.forEach((f: () => void) => f());
    state.unsubscribes = [];
    state.localSubscription = null;
    subscriptionManager.invalidateGeneration();

    state.deltas = [];
    recentOutboundDeltas.clear();
    if (dedupeCleanupTimer) {
      clearInterval(dedupeCleanupTimer);
      dedupeCleanupTimer = null;
    }
    state.timer = false;
    state.batchSendInFlight = false;
    state.socketRecoveryInProgress = false;
    state.droppedDeltaBatches = 0;
    state.droppedDeltaCount = 0;
    Object.keys(state.configContentHashes).forEach((k) => delete state.configContentHashes[k]);
    state.excludedSentences = ["GSV"];
    state.lastPacketTime = 0;
    state.lastFullStatusRequestAt = 0;

    resetMetrics();
    keepaliveManager.stop();

    clearInterval(state.metaTimer ?? undefined);
    state.metaTimer = null;
    clearInterval(state.sourceSnapshotTimer ?? undefined);
    state.sourceSnapshotTimer = null;
    clearTimeout(state.metaDiffFlushTimer ?? undefined);
    state.metaDiffFlushTimer = null;
    for (const h of state.metaSnapshotTimers) clearTimeout(h);
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
    Object.keys(state.configDebounceTimers).forEach((k) => {
      clearTimeout(state.configDebounceTimers[k]);
      delete state.configDebounceTimers[k];
    });

    state.configWatcherObjects.forEach((w) => w.close());
    state.configWatcherObjects = [];

    state.pipeline?.stopBonding?.();
    state.pipeline?.stopMetricsPublishing?.();
    state.pipeline?.stopCongestionControl?.();
    state.pipeline = null;
    if (state.heartbeatHandle) {
      state.heartbeatHandle.stop();
      state.heartbeatHandle = null;
    }

    state.pipelineServer?.stopACKTimer?.();
    state.pipelineServer?.stopMetricsPublishing?.();
    state.pipelineServer?.getSequenceTracker?.()?.reset();
    state.pipelineServer = null;

    if (state.monitoring) {
      state.monitoring.packetLossTracker?.reset();
      state.monitoring.pathLatencyTracker?.reset();
      state.monitoring.retransmissionTracker?.reset();
      state.monitoring.packetCapture?.reset();
      state.monitoring.packetInspector?.reset();
      state.monitoring.alertManager?.reset();
      state.monitoring = null;
    }
    if (state.pingMonitor) {
      state.pingMonitor.stop();
      state.pingMonitor = null;
    }
    if (state.socketUdp) {
      socketManager.close();
      state.socketUdp = null;
      app.debug(`[${instanceId}] Stopped`);
    }

    _setStatus("Stopped", false);
    void wasShuttingDown; // satisfies linter if unused
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    start,
    stop,
    isServerMode: () => state.isServerMode,
    getId: () => instanceId,
    getName: () => state.instanceName,
    getStatus: () => ({ text: state.instanceStatus, healthy: state.isHealthy }),
    getState: () => state,
    getMetricsApi: () => metricsApi,
    setFullStatusCascadeHandler(handler: (() => void) | null) {
      fullStatusCascadeHandler = handler;
    },
    requestFullStatusFromAllClients() {
      state.pipelineServer?.requestFullStatusFromAllClients?.();
    }
  };
}
