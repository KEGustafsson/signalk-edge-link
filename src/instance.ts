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
  OUTBOUND_DEDUPE_MAX_ENTRIES,
  SOURCE_SNAPSHOT_INTERVAL_MS,
  DELTA_SEND_MAX_RETRIES,
  DELTA_SEND_RETRY_BACKOFF_MS,
  SNAPSHOT_REPLAY_CHUNK_SIZE
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
  MetaEntry,
  MetaConfig
} from "./types";
import {
  MetaCache,
  collectSnapshot,
  extractLiveMeta,
  parseMetaConfig as parseMetaConfigShared,
  resolveSelfContext
} from "./metadata";
import { sanitizeDeltaForSignalK, stripOwnDataFromDelta } from "./delta-sanitizer";
import { collectSourceSnapshot } from "./source-snapshot";
import { collectValuesSnapshot } from "./values-snapshot";

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
  let activeSubscriptionGeneration = 0;
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

  // ── Delta timer ───────────────────────────────────────────────────────────
  function scheduleDeltaTimer(): void {
    clearTimeout(state.deltaTimer ?? undefined);
    state.deltaTimer = setTimeout(() => {
      if (state.stopped) {
        return;
      }
      state.timer = true;
      scheduleDeltaTimer();
    }, state.deltaTimerTime);
  }

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

  /** Debounce window for coalescing live meta entries observed in the delta
   *  stream before they are transmitted as a single `diff` packet. */
  const META_DIFF_DEBOUNCE_MS = 500;

  /** Minimum gap between receiver-initiated snapshot sends. Prevents a noisy
   *  or malicious receiver from forcing snapshots on every delta. */
  const META_REQUEST_RATE_LIMIT_MS = 5000;

  /** Dispatches `entries` through the active pipeline. Returns true on a
   *  successful send so callers (e.g. `enqueueMetaDiff`) can decide whether
   *  to commit the MetaCache. Any failure is logged and returns false. */
  async function sendMetaEntries(
    entries: MetaEntry[],
    kind: "snapshot" | "diff"
  ): Promise<boolean> {
    if (!options.udpAddress || !options.secretKey) {
      return false;
    }
    if (entries.length === 0) {
      return false;
    }
    try {
      if (state.pipeline && typeof state.pipeline.sendMetadata === "function") {
        await state.pipeline.sendMetadata(
          entries,
          kind,
          options.secretKey,
          options.udpAddress,
          options.udpPort
        );
      } else {
        app.debug(
          `[${instanceId}] Meta skipped: pipeline not ready or does not support sendMetadata`
        );
        return false;
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] sendMetaEntries failed: ${msg}`);
      recordError("general", `sendMetaEntries failed: ${msg}`);
      return false;
    }
  }

  /**
   * Build and transmit a full metadata snapshot from the current Signal K
   * state tree. Resets the internal diff cache afterwards so the next diff is
   * measured against what was just sent.
   */
  async function sendMetadataSnapshot(): Promise<void> {
    if (!state.metaConfig?.enabled || state.stopped || !state.readyToSend) {
      return;
    }
    const entries = collectSnapshot(appProxy, state.metaConfig);
    const sent = await sendMetaEntries(entries, "snapshot");
    // Only prime the diff cache on a successful send; on failure the next
    // snapshot (periodic or META_REQUEST-triggered) will still cover every
    // path rather than the cache showing stale "already sent" state.
    if (sent) {
      metaCache.replaceAll(entries);
    }
  }

  /** Coalesces live meta diffs extracted from deltas; flushes after a short
   *  debounce window so a burst of meta changes becomes one packet. */
  function enqueueMetaDiff(entries: MetaEntry[]): void {
    // Buffer raw entries; the actual change-detection (and cache commit)
    // happens in the flush handler so a failed send doesn't leave the
    // MetaCache thinking it transmitted something it never did.
    if (entries.length === 0) {
      return;
    }
    state.metaDiffBuffer.push(...entries);
    if (state.metaDiffFlushTimer) {
      return;
    }
    state.metaDiffFlushTimer = setTimeout(() => {
      state.metaDiffFlushTimer = null;
      const pending = state.metaDiffBuffer;
      state.metaDiffBuffer = [];
      const changed = metaCache.computeDiff(pending);
      if (changed.length === 0) {
        return;
      }
      // Snapshot cache generation before the async send; if a resubscribe
      // clears the cache while the send is in flight, the post-send commit
      // must NOT repopulate stale entries into the new generation.
      const generationAtSend = metaCache.generation();
      sendMetaEntries(changed, "diff")
        .then((sent) => {
          if (sent && metaCache.generation() === generationAtSend) {
            metaCache.commit(changed);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          app.debug(`[${instanceId}] meta diff flush failed: ${msg}`);
        });
    }, META_DIFF_DEBOUNCE_MS);
  }

  function restartMetadataTimer(): void {
    if (state.metaTimer) {
      clearInterval(state.metaTimer);
      state.metaTimer = null;
    }
    if (!state.metaConfig?.enabled) {
      return;
    }
    const intervalMs = Math.max(30, state.metaConfig.intervalSec) * 1000;
    state.metaTimer = setInterval(() => {
      sendMetadataSnapshot().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.debug(`[${instanceId}] periodic snapshot failed: ${msg}`);
      });
    }, intervalMs);
  }

  /** Schedules a meta snapshot send after `delayMs`. Cancels any prior
   *  pending snapshot timer first — back-to-back (re)subscribes or socket
   *  recoveries should coalesce into a single pending snapshot rather than
   *  queue up multiple sends. The returned timer is tracked on
   *  state.metaSnapshotTimers so stop() can cancel it. */
  function scheduleMetadataSnapshot(delayMs: number): void {
    for (const existing of state.metaSnapshotTimers) {
      clearTimeout(existing);
    }
    state.metaSnapshotTimers.length = 0;
    const handle = setTimeout(() => {
      const idx = state.metaSnapshotTimers.indexOf(handle);
      if (idx !== -1) {
        state.metaSnapshotTimers.splice(idx, 1);
      }
      if (state.stopped) {
        return;
      }
      sendMetadataSnapshot().catch(() => {
        /* errors already logged inside sendMetadataSnapshot */
      });
    }, delayMs);
    state.metaSnapshotTimers.push(handle);
  }

  /** Receiver asked for a fresh meta snapshot (META_REQUEST control packet).
   *  Rate-limited so a malformed or buggy receiver cannot force continuous
   *  snapshot work on the edge-link. */
  function handleMetaRequest(): void {
    if (!state.metaConfig?.enabled) {
      return;
    }
    const now = Date.now();
    if (now - state.lastMetaRequestAt < META_REQUEST_RATE_LIMIT_MS) {
      return;
    }
    state.lastMetaRequestAt = now;
    sendMetadataSnapshot().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] META_REQUEST snapshot failed: ${msg}`);
    });
  }

  /** Minimum gap between server-initiated full-status replays. Prevents a
   *  restarting or misconfigured server from flooding the link. */
  const FULL_STATUS_REQUEST_RATE_LIMIT_MS = 10000;

  /**
   * Optional callback invoked after this (client-mode) instance handles a
   * FULL_STATUS_REQUEST. Used in multi-hop chains to cascade the request to
   * any downstream clients connected to a co-located server-mode instance.
   */
  let fullStatusCascadeHandler: (() => void) | null = null;

  /** Server asked for a full values snapshot (FULL_STATUS_REQUEST control
   *  packet). Replays the entire current Signal K tree to the server.
   *  Rate-limited to prevent replay floods across rapid server restarts. */
  function handleFullStatusRequest(): void {
    const now = Date.now();
    if (now - state.lastFullStatusRequestAt < FULL_STATUS_REQUEST_RATE_LIMIT_MS) {
      app.debug(`[${instanceId}] FULL_STATUS_REQUEST rate-limited, skipping`);
      return;
    }
    state.lastFullStatusRequestAt = now;
    app.debug(`[${instanceId}] FULL_STATUS_REQUEST received — replaying values snapshot`);
    replayValuesSnapshot("full-status-request");
    if (fullStatusCascadeHandler) {
      app.debug(`[${instanceId}] FULL_STATUS_REQUEST cascading to downstream clients`);
      metrics.fullStatusCascadeFired = (metrics.fullStatusCascadeFired || 0) + 1;
      fullStatusCascadeHandler();
    }
  }

  async function sendSourceSnapshot(): Promise<void> {
    if (
      state.stopped ||
      !state.readyToSend ||
      !state.pipeline ||
      typeof state.pipeline.sendSourceSnapshot !== "function" ||
      !options.secretKey ||
      !options.udpAddress
    ) {
      return;
    }

    const sources = collectSourceSnapshot(appProxy);
    if (!sources || Object.keys(sources).length === 0) {
      return;
    }

    try {
      await state.pipeline.sendSourceSnapshot(
        sources,
        options.secretKey,
        options.udpAddress,
        options.udpPort
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] source snapshot send failed: ${msg}`);
    }
  }

  /**
   * Replay every value currently in the local Signal K tree by feeding
   * synthetic deltas through `processDelta`. The subscription manager only
   * delivers *future* deltas, so values published into the tree before
   * `subscribe()` ran (one-shot startup deltas, or deltas published by a
   * co-located edge-link server-mode instance via `app.handleMessage`) would
   * otherwise never reach the receiver. Triggered on initial subscribe
   * success, on subscribe-retry success, and on UDP socket recovery so the
   * receiver gets re-primed if it restarted.
   *
   * Returns silently if the SignalK app object doesn't expose `signalk`
   * (older signalk-server versions or test mocks), or while the instance is
   * not yet ready to send.
   */
  function replayValuesSnapshot(reason: string): void {
    if (state.stopped || !state.readyToSend || !state.processDelta) {
      return;
    }
    let snapshot: Delta[];
    try {
      snapshot = collectValuesSnapshot(appProxy);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] values snapshot collect failed (${reason}): ${msg}`);
      return;
    }
    if (snapshot.length === 0) {
      return;
    }
    app.debug(`[${instanceId}] Replaying ${snapshot.length} value-snapshot delta(s) (${reason})`);
    recordSnapshotReplay(reason, snapshot.length);
    // Chunk via setImmediate so a hundred-leaf snapshot can't fill
    // MAX_DELTAS_BUFFER_SIZE in a single tick and force-drop concurrent
    // live deltas. Each chunk yields to a later event-loop turn.
    let i = 0;
    function pumpChunk(): void {
      if (state.stopped || !state.readyToSend || !state.processDelta) {
        return;
      }
      const end = Math.min(i + SNAPSHOT_REPLAY_CHUNK_SIZE, snapshot.length);
      try {
        for (; i < end; i++) {
          state.processDelta(snapshot[i]);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.debug(`[${instanceId}] values snapshot replay failed (${reason}): ${msg}`);
        return;
      }
      if (i < snapshot.length) {
        setImmediate(pumpChunk);
      }
    }
    pumpChunk();
  }

  function recordSnapshotReplay(reason: string, count: number): void {
    metrics.snapshotsReplayed = metrics.snapshotsReplayed || {
      initialSubscribe: 0,
      subscriptionRetry: 0,
      socketRecovery: 0,
      fullStatusRequest: 0
    };
    if (reason === "initial subscribe") {
      metrics.snapshotsReplayed.initialSubscribe++;
    } else if (reason === "subscription retry") {
      metrics.snapshotsReplayed.subscriptionRetry++;
    } else if (reason === "socket recovery") {
      metrics.snapshotsReplayed.socketRecovery++;
    } else if (reason === "full-status-request") {
      metrics.snapshotsReplayed.fullStatusRequest++;
    }
    metrics.snapshotReplayDeltas = (metrics.snapshotReplayDeltas || 0) + count;
  }

  function restartSourceSnapshotTimer(): void {
    clearInterval(state.sourceSnapshotTimer ?? undefined);
    state.sourceSnapshotTimer = null;
    if ((options.protocolVersion ?? 0) < 2) {
      return;
    }
    state.sourceSnapshotTimer = setInterval(() => {
      sendSourceSnapshot().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.debug(`[${instanceId}] periodic source snapshot failed: ${msg}`);
      });
    }, SOURCE_SNAPSHOT_INTERVAL_MS);
  }

  /** Thin wrapper around the parser in `metadata.ts` so the instance log
   *  line is tagged with this connection's instanceId. Errors from the
   *  shared parser already have the `[meta-config]` prefix. */
  function parseMetaConfig(raw: unknown): MetaConfig | null {
    return parseMetaConfigShared(raw, (msg) => app.error(msg), instanceId);
  }

  function normalizeSubscriptionConfig(config: unknown): unknown {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return config;
    }
    const record = config as Record<string, unknown>;
    if (!Array.isArray(record.subscribe)) {
      return config;
    }

    const rows = record.subscribe as unknown[];
    const wildcardRow = rows.find(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        (row as Record<string, unknown>).path === "*"
    );
    if (wildcardRow) {
      if (rows.length > 1) {
        app.debug(
          `[${instanceId}] Subscription contains path="*"; ignoring ${rows.length - 1} overlapping row(s)`
        );
      }
      return { ...record, subscribe: [wildcardRow] };
    }

    const seenPaths = new Set<string>();
    const deduped: unknown[] = [];
    let dropped = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        deduped.push(row);
        continue;
      }
      const path = (row as Record<string, unknown>).path;
      if (typeof path !== "string") {
        deduped.push(row);
        continue;
      }
      if (seenPaths.has(path)) {
        dropped++;
        continue;
      }
      seenPaths.add(path);
      deduped.push(row);
    }

    if (dropped > 0) {
      app.debug(`[${instanceId}] Removed ${dropped} duplicate subscription row(s)`);
      return { ...record, subscribe: deduped };
    }
    return config;
  }

  /**
   * Processes an incoming delta from the subscription manager.
   * Buffers and dispatches deltas to the send pipeline.
   *
   * @param batch - Array of SignalK delta messages
   */
  async function sendDeltaBatch(batch: Delta[]): Promise<void> {
    if (state.pipeline) {
      await state.pipeline.sendDelta(
        batch,
        options.secretKey,
        options.udpAddress ?? "",
        options.udpPort
      );
    } else {
      await getV1Pipeline().packCrypt(
        batch,
        options.secretKey,
        options.udpAddress ?? "",
        options.udpPort
      );
    }
  }

  function scheduleBatchRetry(batchSize: number, retryCount: number): void {
    if (state.pendingRetry || state.stopped) {
      return;
    }

    state.pendingRetry = setTimeout(() => {
      state.pendingRetry = null;
      flushDeltaBatch(batchSize, retryCount);
    }, DELTA_SEND_RETRY_BACKOFF_MS);
  }

  async function flushDeltaBatch(
    batchSize: number = state.deltas.length,
    retryCount: number = 0
  ): Promise<void> {
    if (
      state.batchSendInFlight ||
      state.pendingRetry ||
      state.stopped ||
      !state.readyToSend ||
      state.socketRecoveryInProgress
    ) {
      return;
    }

    if (!Number.isInteger(batchSize) || batchSize <= 0 || state.deltas.length === 0) {
      state.timer = false;
      return;
    }

    const actualBatchSize = Math.min(batchSize, state.deltas.length, state.maxDeltasPerBatch);
    const batch = state.deltas.slice(0, actualBatchSize);
    state.batchSendInFlight = true;

    try {
      await sendDeltaBatch(batch);
      state.deltas.splice(0, actualBatchSize);
      state.timer = false;
      state.lastPacketTime = Date.now(); // suppress hello sends right after real data
    } catch (err: unknown) {
      const nextRetryCount = retryCount + 1;
      app.debug(
        `[${instanceId}] Batch send failed (attempt ${nextRetryCount}/${DELTA_SEND_MAX_RETRIES + 1}): ${err instanceof Error ? err.message : String(err)}`
      );

      if (nextRetryCount <= DELTA_SEND_MAX_RETRIES) {
        scheduleBatchRetry(actualBatchSize, nextRetryCount);
      } else {
        state.deltas.splice(0, actualBatchSize);
        state.timer = false;
        state.droppedDeltaBatches++;
        state.droppedDeltaCount += actualBatchSize;
        metrics.droppedDeltaBatches = (metrics.droppedDeltaBatches || 0) + 1;
        metrics.droppedDeltaCount = (metrics.droppedDeltaCount || 0) + actualBatchSize;
        const dropMessage = `[${instanceId}] Dropped delta batch after ${nextRetryCount} failed attempts (${actualBatchSize} deltas)`;
        app.error(dropMessage);
        recordError("sendFailure", dropMessage);
      }
    } finally {
      state.batchSendInFlight = false;
      if (state.deltas.length > 0 && !state.pendingRetry && !state.stopped) {
        setImmediate(() => {
          flushDeltaBatch();
        });
      }
    }
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

  function createSubscriptionDeltaHandler(subscriptionGeneration: number): (delta: Delta) => void {
    return (delta: Delta) => {
      if (subscriptionGeneration !== activeSubscriptionGeneration) {
        return;
      }
      processDelta(delta);
    };
  }

  const SUBSCRIPTION_RETRY_BASE_DELAY = 5000;
  const SUBSCRIPTION_RETRY_MAX_DELAY = 300000;
  const SUBSCRIPTION_RETRY_MAX_ATTEMPTS = 10;
  // After the fast-retry window, keep trying at this interval indefinitely.
  const SUBSCRIPTION_RETRY_SLOW_DELAY = 5 * 60 * 1000; // 5 minutes

  /**
   * Schedule a subscription retry with exponential backoff.
   * After SUBSCRIPTION_RETRY_MAX_ATTEMPTS consecutive failures the backoff
   * saturates at SUBSCRIPTION_RETRY_SLOW_DELAY and retries continue
   * indefinitely so that a transient Signal K startup race does not leave
   * the instance silently dead for the lifetime of the process.
   */
  function scheduleSubscriptionRetry(attempt: number): void {
    // Beyond the fast-retry window, switch to a slow keep-alive retry.
    const isSlow = attempt > SUBSCRIPTION_RETRY_MAX_ATTEMPTS;
    if (isSlow && attempt === SUBSCRIPTION_RETRY_MAX_ATTEMPTS + 1) {
      app.error(
        `[${instanceId}] Subscription failed after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts — ` +
          `switching to slow retry every ${SUBSCRIPTION_RETRY_SLOW_DELAY / 1000}s`
      );
      recordError(
        "subscription",
        `Subscription entering slow-retry mode after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts`
      );
    }

    const delay = isSlow
      ? SUBSCRIPTION_RETRY_SLOW_DELAY
      : Math.min(
          SUBSCRIPTION_RETRY_BASE_DELAY * Math.pow(2, attempt - 1),
          SUBSCRIPTION_RETRY_MAX_DELAY
        );

    app.debug(
      `[${instanceId}] Scheduling subscription retry (attempt ${attempt}/${SUBSCRIPTION_RETRY_MAX_ATTEMPTS}) in ${delay}ms`
    );

    // Clear any pending retry timer before scheduling a new one to prevent
    // duplicate timers leaking when called multiple times before the first fires.
    if (state.subscriptionRetryTimer) {
      clearTimeout(state.subscriptionRetryTimer);
    }
    state.subscriptionRetryTimer = setTimeout(() => {
      state.subscriptionRetryTimer = null;
      if (state.stopped) {
        return;
      }
      app.debug(`[${instanceId}] Retrying subscription (attempt ${attempt})...`);
      // Tear down any partial listeners left behind by a previous failed
      // subscribe attempt before adding new ones — same reason as the main
      // handleSubscriptionChange path: keeping stale partial listeners in
      // state.unsubscribes alongside a fresh subscribe() causes them to fire
      // for every push, doubling processDelta delivery for affected paths.
      const partialUnsubscribes = state.unsubscribes.splice(0);
      partialUnsubscribes.forEach((f: () => void) => f());

      try {
        const subscriptionGeneration = ++activeSubscriptionGeneration;
        state.subscribing = true;
        try {
          app.subscriptionmanager.subscribe(
            state.localSubscription,
            state.unsubscribes,
            (retrySubError: unknown) => {
              app.error(
                `[${instanceId}] Subscription error (attempt ${attempt}): ${retrySubError}`
              );
              state.readyToSend = false;
              _setStatus("Subscription error - data transmission paused", false);
              recordError("subscription", `Subscription error: ${retrySubError}`);
            },
            createSubscriptionDeltaHandler(subscriptionGeneration)
          );
        } finally {
          state.subscribing = false;
        }
        // Retry succeeded — perform the staged commit that the original
        // processConfig catch block skipped. Without this, the operator's
        // new meta block (stashed on state.pendingMetaConfig) would remain
        // inactive even though subscribe() is now working.
        if (state.pendingMetaConfig !== undefined) {
          state.metaConfig = state.pendingMetaConfig;
          state.pendingMetaConfig = undefined;
          restartMetadataTimer();
          metaCache.clear();
          if (state.metaConfig?.enabled) {
            scheduleMetadataSnapshot(2000);
          }
        }
        state.readyToSend = true;
        _setStatus("Subscription restored", true);
        // Replay current tree state so any value that arrived in the tree
        // while we were retrying isn't permanently lost.
        replayValuesSnapshot("subscription retry");
      } catch (retryError: unknown) {
        const msg = retryError instanceof Error ? retryError.message : String(retryError);
        app.error(`[${instanceId}] Subscription retry ${attempt} failed: ${msg}`);
        recordError("subscription", `Subscription retry ${attempt} failed: ${msg}`);
        scheduleSubscriptionRetry(attempt + 1);
      }
    }, delay);
  }

  // Subscription change handler (also wires up the main delta subscription)
  const handleSubscriptionChange = createDebouncedConfigHandler({
    name: "Subscription",
    getFilePath: () => state.subscriptionFile,
    processConfig: (config: unknown) => {
      state.localSubscription = normalizeSubscriptionConfig(config);
      app.debug(`[${instanceId}] Subscription configuration updated`);

      // Stage the new metadata config — do NOT yet touch state.metaConfig,
      // the periodic timer, or metaCache. If subscribe() throws, the old
      // subscription remains active until the retry succeeds, so its
      // previous metadata behaviour must remain intact.
      const previousMetaConfig = state.metaConfig;
      const pendingMetaConfig = parseMetaConfig(state.localSubscription);

      // Tear down the old subscription FIRST, then establish the new one.
      // The previous "subscribe-then-unsubscribe" ordering tried to avoid
      // dropping any delta during the handover, but it leaves a window
      // where BOTH the old and new subscriptions are simultaneously
      // attached to every per-path bus in signalk-server's
      // `streambundle.buses`. Any push that lands in that window — or any
      // listener that the new subscribe() registers asynchronously via
      // streambundle.keys.onValue for a path whose bus is created during
      // the window — fires both callbacks, doubling processDelta delivery
      // for the rest of the process lifetime.
      //
      // Replaying via `replayValuesSnapshot("initial subscribe")` below
      // recovers any value that was already in the SK tree, and any
      // genuinely live delta that lands in the brief teardown→subscribe
      // gap will be re-emitted by its publisher within the subscription's
      // throttle period.
      const previousUnsubscribes = state.unsubscribes.splice(0);
      previousUnsubscribes.forEach((f: () => void) => f());

      try {
        const subscriptionGeneration = ++activeSubscriptionGeneration;
        state.subscribing = true;
        try {
          app.subscriptionmanager.subscribe(
            state.localSubscription,
            state.unsubscribes,
            (subscriptionError: unknown) => {
              app.error(`[${instanceId}] Subscription error: ${subscriptionError}`);
              state.readyToSend = false;
              _setStatus("Subscription error - data transmission paused", false);
              recordError("subscription", `Subscription error: ${subscriptionError}`);
            },
            createSubscriptionDeltaHandler(subscriptionGeneration)
          );
        } finally {
          state.subscribing = false;
        }
        // Commit the new metadata config AFTER a successful subscribe: swap
        // state.metaConfig, (re)start the periodic timer, and reset the diff
        // cache so the next snapshot represents the live state in full. We
        // reset the cache unconditionally here because even "meta unchanged"
        // still needs an empty cache for the new subscription's path set.
        state.metaConfig = pendingMetaConfig;
        restartMetadataTimer();
        metaCache.clear();
        // Prime the receiver's meta cache with a full snapshot once the
        // Signal K state tree has had a moment to settle after (re)subscribe.
        if (state.metaConfig?.enabled) {
          scheduleMetadataSnapshot(2000);
        }
        // Replay every value already present in the tree. Without this,
        // one-shot startup deltas published before subscribe() ran (e.g. by
        // a co-located edge-link server-mode instance) never reach the
        // receiver, since the subscription manager only delivers future
        // events.
        replayValuesSnapshot("initial subscribe");
      } catch (subscribeError: unknown) {
        // Re-subscribe failed. The old subscription was already torn down
        // before we attempted the new subscribe(), so we cannot restore it —
        // any partial subscriptions registered by the failed subscribe() are
        // already in state.unsubscribes and stop() can clean them up.
        // The retry path (scheduleSubscriptionRetry) will attempt a fresh
        // subscribe() against state.unsubscribes; if any partial listeners
        // exist they get added to alongside, but that's no worse than the
        // pre-fix behaviour and avoids the more serious 2× delivery race.
        // Leave state.metaConfig / metaCache / metaTimer untouched so the
        // previous subscription's metadata behaviour rules are preserved
        // pending retry.
        void previousMetaConfig; // explicit: intentionally unchanged
        void previousUnsubscribes; // intentionally not restored — see above
        // Stash the new meta config on state so the scheduled retry can
        // promote it when subscribe() finally succeeds. Otherwise the
        // operator's new meta settings would silently sit unused until the
        // user re-saved subscription.json.
        state.pendingMetaConfig = pendingMetaConfig;
        const subErrMsg =
          subscribeError instanceof Error ? subscribeError.message : String(subscribeError);
        app.error(`[${instanceId}] Failed to subscribe: ${subErrMsg}`);
        state.readyToSend = false;
        _setStatus("Failed to subscribe - data transmission paused", false);
        recordError("subscription", `Failed to subscribe: ${subErrMsg}`);

        // Retry with exponential backoff (5s, 10s, 20s, 40s … up to 300s max).
        // Store the handle so stop() can cancel it before it fires.
        scheduleSubscriptionRetry(1);
      }
    },
    state,
    instanceId,
    app,
    readFallback: { context: "*", subscribe: [{ path: "*" }] }
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
      const reliableServerLabel = options.protocolVersion === 3 ? "v3" : "v2";
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

      const helloIntervalSeconds =
        typeof options.helloMessageSender === "number" &&
        Number.isFinite(options.helloMessageSender)
          ? options.helloMessageSender
          : 60;
      const pingIntervalMinutes =
        typeof options.pingIntervalTime === "number" && Number.isFinite(options.pingIntervalTime)
          ? options.pingIntervalTime
          : 1;
      const helloInterval = helloIntervalSeconds * 1000;

      // Clear any existing interval before creating a new one — prevents
      // duplicate hello intervals if start() is ever called more than once.
      // clearInterval(null | undefined) is a safe no-op, so no conditional needed.
      clearInterval(state.helloMessageSender ?? undefined);
      state.helloMessageSender = setInterval(async () => {
        try {
          const timeSinceLastPacket = Date.now() - state.lastPacketTime;
          if (!state.readyToSend) {
            app.debug(`[${instanceId}] Skipping hello (not ready)`);
          } else if (timeSinceLastPacket >= helloInterval) {
            // For v2/v3, send a real HELLO packet so the server can keep this
            // session identified across long idle periods or NAT rebinds.
            // sendHello populates `session.clientId` on the server, which the
            // `peerIdentified` gate in `_ingestRemoteTelemetry` requires before
            // telemetry is admitted. For v1 there is no HELLO frame, so we
            // fall back to the legacy empty-delta NAT keepalive.
            if (state.pipeline && typeof state.pipeline.sendHello === "function") {
              app.debug(`[${instanceId}] Sending periodic v2 HELLO`);
              await state.pipeline.sendHello(options.udpAddress ?? "", options.udpPort);
            } else {
              const mmsi = app.getSelfPath("mmsi") || "000000000";
              const fixedDelta = {
                context: "vessels.urn:mrn:imo:mmsi:" + mmsi,
                updates: [{ timestamp: new Date().toISOString(), values: [] }]
              };
              app.debug(`[${instanceId}] Sending hello message`);
              if (state.pipeline) {
                await state.pipeline.sendDelta(
                  [fixedDelta],
                  options.secretKey,
                  options.udpAddress ?? "",
                  options.udpPort
                );
              } else {
                await getV1Pipeline().packCrypt(
                  [fixedDelta],
                  options.secretKey,
                  options.udpAddress ?? "",
                  options.udpPort
                );
              }
            }
          } else {
            app.debug(`[${instanceId}] Skipping hello (last packet ${timeSinceLastPacket}ms ago)`);
          }
        } catch (err: unknown) {
          app.error(
            `[${instanceId}] Hello message send error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }, helloInterval);

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
      const reliableProtocolLabel = options.protocolVersion === 3 ? "v3" : "v2";
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
    activeSubscriptionGeneration++;

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
    clearInterval(state.helloMessageSender ?? undefined);
    state.helloMessageSender = null;
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
