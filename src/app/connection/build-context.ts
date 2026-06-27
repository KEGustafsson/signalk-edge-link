"use strict";

/**
 * Connection context assembly (L4 application layer).
 *
 * Constructs the shared {@link ConnectionContext}: per-instance state, the
 * status helper and `appProxy`, the outbound-dedupe map, the lazy v1 pipeline,
 * the L3 domain services, and the config-file change handlers. Extracted from
 * `createConnection` so the factory stays a thin wrapper.
 *
 * @module app/connection/build-context
 */

import { UdpSocketManager } from "../../transport/udp-socket-manager";
import createMetrics from "../../domain/metrics/registry";
import { createSourceRegistry } from "../../domain/source-registry";
import { createDeltaBatcher } from "../../domain/delta-batcher";
import { createMetadataStreamer } from "../../domain/metadata-streamer";
import { createSourceSnapshotService } from "../../domain/source-snapshot-service";
import { createKeepaliveManager } from "../../domain/keepalive-manager";
import { createSubscriptionManager } from "../../domain/subscription-manager";
import {
  DEFAULT_DELTA_TIMER,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch,
  OUTBOUND_DUPLICATE_SUPPRESS_MS,
  OUTBOUND_DEDUPE_MAX_ENTRIES
} from "../../foundation/constants";
import { createDebouncedConfigHandler } from "../config/watcher";
import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  Delta,
  MetaConfig
} from "../../foundation/types";
import { MetaCache, parseMetaConfig as parseMetaConfigShared } from "../../codec/metadata-codec";
import { Lifecycle } from "../lifecycle";
import {
  SOCKET_RECOVERY_BASE_MS,
  type ConnectionContext,
  type ConnectionServices,
  type ConnectionConfigHandlers,
  type V1PipelineLike
} from "./context";
import { processDelta } from "./process-delta";
import { handleClientSocketError } from "./socket-recovery";

/** Constructor arguments for {@link buildConnectionContext}. */
export interface BuildContextArgs {
  app: SignalKApp;
  options: ConnectionConfig;
  instanceId: string;
  pluginId: string;
  onStatusChange: (instanceId: string, message: string) => void;
}

/** Derive server mode from options (supports legacy boolean and string forms). */
function isServer(options: ConnectionConfig): boolean {
  return (options.serverType as unknown) === true || options.serverType === "server";
}

/** Build the initial per-instance mutable state object. */
function createInitialState(
  app: SignalKApp,
  options: ConnectionConfig,
  instanceId: string
): InstanceState {
  return {
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
}

/** Create the delta-timer and sentence-filter config-file change handlers. */
function createConfigHandlers(
  ctx: ConnectionContext,
  scheduleDeltaTimer: () => void
): ConnectionConfigHandlers {
  const { app, instanceId, state } = ctx;
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

  return { handleDeltaTimerChange, handleSentenceFilterChange };
}

/** Build the per-instance status helper and the status-rebinding `appProxy`. */
function createStatusHelper(
  args: BuildContextArgs,
  state: InstanceState
): {
  setStatus: ConnectionContext["setStatus"];
  appProxy: SignalKApp;
} {
  const { app, instanceId, onStatusChange } = args;
  function setStatus(msg: string, healthyOverride?: boolean): void {
    state.instanceStatus = msg;
    state.isHealthy =
      typeof healthyOverride === "boolean"
        ? healthyOverride
        : Boolean(msg && !msg.toLowerCase().match(/error|fail|stopped/));
    if (typeof onStatusChange === "function") {
      onStatusChange(instanceId, msg);
    }
  }
  const appProxy = new Proxy(app, {
    get(target: SignalKApp, prop: string) {
      if (prop === "setPluginStatus" || prop === "setProviderStatus") {
        return (msg: string) => setStatus(msg);
      }
      return (target as unknown as Record<string, unknown>)[prop];
    }
  });
  return { setStatus, appProxy };
}

/** Attach the dedupe/coalescer/ping/v1-pipeline helpers onto `ctx`. */
function attachCoreHelpers(ctx: ConnectionContext): void {
  const { app, options, instanceId, pluginId, state, metricsApi, recentOutboundDeltas } = ctx;

  ctx.cleanupDedupeMap = (now: number): void => {
    for (const [key, seenAt] of recentOutboundDeltas) {
      if (now - seenAt > OUTBOUND_DUPLICATE_SUPPRESS_MS) recentOutboundDeltas.delete(key);
    }
    while (recentOutboundDeltas.size > OUTBOUND_DEDUPE_MAX_ENTRIES) {
      const oldest = recentOutboundDeltas.keys().next();
      if (!oldest.done) recentOutboundDeltas.delete(oldest.value);
    }
  };

  ctx.scheduleReportOutputMessages = (): void => {
    if (ctx.reportPending) return;
    ctx.reportPending = true;
    setImmediate(() => {
      ctx.reportPending = false;
      try {
        app.reportOutputMessages();
      } catch {
        /* best-effort */
      }
    });
  };

  const publishRtt = (rttMs: number): void => {
    if (options.protocolVersion === 1) {
      const path = instanceId ? `networking.modem.${instanceId}.rtt` : "networking.modem.rtt";
      app.handleMessage(pluginId, {
        context: "vessels.self",
        updates: [{ timestamp: new Date().toISOString(), values: [{ path, value: rttMs / 1000 }] }]
      });
    }
  };

  ctx.handlePingSuccess = (res: { time?: number } | null, event: string): void => {
    if (res?.time !== undefined) {
      publishRtt(res.time);
      app.debug(`[${instanceId}] Connection monitor: ${event} (RTT: ${res.time}ms)`);
    } else {
      app.debug(`[${instanceId}] Connection monitor: ${event}`);
    }
  };

  ctx.getV1Pipeline = (): V1PipelineLike => {
    if (!ctx.v1Pipeline) {
      const createPipelineV1 = require("../../transport/pipeline/v1");
      ctx.v1Pipeline = createPipelineV1(app, state, metricsApi) as V1PipelineLike;
    }
    return ctx.v1Pipeline;
  };
}

/** Construct and wire the L3 domain services for the connection. */
function buildServices(ctx: ConnectionContext, metaCache: MetaCache): ConnectionServices {
  const { app, options, instanceId, appProxy, state, metrics, recordError, getV1Pipeline } = ctx;

  const { scheduleDeltaTimer, flushDeltaBatch } = createDeltaBatcher({
    state,
    metrics,
    app,
    options,
    instanceId,
    recordError,
    getV1Pipeline
  });

  const keepaliveManager = createKeepaliveManager({
    state,
    options,
    app,
    instanceId,
    getV1Pipeline
  });

  const {
    sendMetadataSnapshot,
    enqueueMetaDiff,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    handleMetaRequest
  } = createMetadataStreamer({ state, options, app, appProxy, instanceId, recordError, metaCache });

  const {
    handleFullStatusRequest,
    sendSourceSnapshot,
    replayValuesSnapshot,
    restartSourceSnapshotTimer
  } = createSourceSnapshotService({
    state,
    options,
    app,
    appProxy,
    instanceId,
    metrics,
    getFullStatusCascadeHandler: () => ctx.fullStatusCascadeHandler
  });

  const parseMetaConfig = (raw: unknown): MetaConfig | null =>
    parseMetaConfigShared(raw, (msg) => app.error(msg), instanceId);

  const boundProcessDelta = (delta: Delta): void => processDelta(ctx, delta);
  state.processDelta = boundProcessDelta;

  const { handleSubscriptionChange, invalidateGeneration } = createSubscriptionManager({
    state,
    app,
    instanceId,
    recordError,
    processDelta: boundProcessDelta,
    setStatus: ctx.setStatus,
    metaCache,
    parseMetaConfig,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    replayValuesSnapshot
  });

  return {
    scheduleDeltaTimer,
    flushDeltaBatch,
    keepaliveManager,
    metaCache,
    sendMetadataSnapshot,
    enqueueMetaDiff,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    handleMetaRequest,
    handleFullStatusRequest,
    sendSourceSnapshot,
    replayValuesSnapshot,
    restartSourceSnapshotTimer,
    handleSubscriptionChange,
    parseMetaConfig,
    invalidateSubscriptionGeneration: invalidateGeneration
  };
}

/**
 * Construct the shared connection context and wire all domain services.
 *
 * The returned context is the single object threaded through every connection
 * helper (lifecycle, hot path, socket recovery). Object identity is stable for
 * the connection's lifetime; helpers mutate its scalar fields in place.
 */
export function buildConnectionContext(args: BuildContextArgs): ConnectionContext {
  const { app, options, instanceId, pluginId, onStatusChange } = args;

  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;
  const state = createInitialState(app, options, instanceId);
  const { setStatus, appProxy } = createStatusHelper(args, state);

  // Placeholders for the helpers/services attached after `ctx` exists; helpers
  // close over `ctx` so they read the populated fields lazily at call time.
  const noopVoid = (): void => {};
  const ctx: ConnectionContext = {
    app,
    appProxy,
    options,
    instanceId,
    pluginId,
    onStatusChange,
    lifecycle: new Lifecycle(),
    metricsApi,
    metrics,
    recordError,
    resetMetrics,
    socketManager: new UdpSocketManager(),
    state,
    services: undefined as unknown as ConnectionServices,
    configHandlers: undefined as unknown as ConnectionConfigHandlers,
    setStatus,
    recentOutboundDeltas: new Map<string, number>(),
    cleanupDedupeMap: noopVoid,
    getV1Pipeline: undefined as unknown as ConnectionContext["getV1Pipeline"],
    scheduleReportOutputMessages: noopVoid,
    handlePingSuccess: noopVoid,
    handleClientSocketError: (err: NodeJS.ErrnoException) => handleClientSocketError(ctx, err),
    dedupeCleanupTimer: null,
    lastDupLogAt: 0,
    reportPending: false,
    v1Pipeline: null,
    socketRecoveryBackoffMs: SOCKET_RECOVERY_BASE_MS,
    fullStatusCascadeHandler: null
  };

  attachCoreHelpers(ctx);
  ctx.services = buildServices(ctx, new MetaCache());
  ctx.configHandlers = createConfigHandlers(ctx, ctx.services.scheduleDeltaTimer);

  return ctx;
}
