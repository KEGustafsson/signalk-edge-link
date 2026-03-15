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
import { validateSecretKey } from "./crypto";
import Monitor from "ping-monitor";
import createMetrics from "./metrics";
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
  calculateMaxDeltasPerBatch
} from "./constants";
import { loadConfigFile } from "./config-io";
import {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  initializePersistentStorage
} from "./config-watcher";
import type { SignalKApp, ConnectionConfig, InstanceState, MetricsApi, Delta } from "./types";

const DELTA_SEND_MAX_RETRIES = 1;
const DELTA_SEND_RETRY_BACKOFF_MS = 100;

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

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a connection instance.
 *
 * @param app            - Signal K app object
 * @param options        - Connection configuration (serverType, udpPort, …)
 * @param instanceId     - URL-safe unique identifier for this connection
 * @param pluginId       - Plugin ID (used as source label in SK messages)
 * @param onStatusChange - Called as (instanceId, message) whenever status changes
 * @returns Instance API: { start, stop, getId, getName, getStatus, getState, getMetricsApi }
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
  getId: () => string;
  getName: () => string;
  getStatus: () => { text: string; healthy: boolean };
  getState: () => InstanceState;
  getMetricsApi: () => MetricsApi;
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
    isServerMode: false,
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
    pipeline: null,
    pipelineServer: null,
    heartbeatHandle: null,
    monitoring: null,
    networkSimulator: null,
    configDebounceTimers: {},
    configContentHashes: {},
    configWatcherObjects: [],
    processDelta: null
  };

  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;

  // v1 pipeline is created lazily on first use (only needed in client v1 mode)
  let v1Pipeline: {
    packCrypt(
      delta: Delta | Delta[],
      secretKey: string,
      address: string,
      port: number
    ): Promise<void>;
    unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
  } | null = null;
  function getV1Pipeline(): {
    packCrypt(
      delta: Delta | Delta[],
      secretKey: string,
      address: string,
      port: number
    ): Promise<void>;
    unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
  } {
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

  function handlePingSuccess(
    res: { time?: number } | null,
    eventName: string,
    pingIntervalMinutes: number
  ): void {
    state.readyToSend = true;
    _setStatus("Connected", true);
    clearTimeout(state.pingTimeout ?? undefined); // null is safe for clearTimeout
    state.pingTimeout = setTimeout(
      () => {
        state.readyToSend = false;
        _setStatus("Connection monitor timeout", false);
      },
      pingIntervalMinutes * MILLISECONDS_PER_MINUTE + PING_TIMEOUT_BUFFER
    );
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
   * Outbound filtering is intentionally disabled:
   * forward all subscribed deltas as-is.
   */
  function filterOutboundDelta(delta: Delta): Delta | null {
    if (!delta || !Array.isArray(delta.updates) || delta.updates.length === 0) {
      return null;
    }
    return delta;
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

  function scheduleBatchRetry(batch: Delta[], retryCount: number): void {
    if (state.pendingRetry || state.stopped) {
      return;
    }

    state.pendingRetry = setTimeout(() => {
      state.pendingRetry = null;
      flushDeltaBatch(batch.length, retryCount);
    }, DELTA_SEND_RETRY_BACKOFF_MS);
  }

  async function flushDeltaBatch(
    batchSize: number = state.deltas.length,
    retryCount: number = 0
  ): Promise<void> {
    if (
      state.batchSendInFlight ||
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

    const actualBatchSize = Math.min(batchSize, state.deltas.length);
    const batch = state.deltas.slice(0, actualBatchSize);
    state.batchSendInFlight = true;

    try {
      await sendDeltaBatch(batch);
      state.deltas.splice(0, actualBatchSize);
      state.timer = false;
    } catch (err: any) {
      const nextRetryCount = retryCount + 1;
      app.debug(
        `[${instanceId}] Batch send failed (attempt ${nextRetryCount}/${DELTA_SEND_MAX_RETRIES + 1}): ${err.message}`
      );

      if (nextRetryCount <= DELTA_SEND_MAX_RETRIES) {
        scheduleBatchRetry(batch, nextRetryCount);
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
      if (state.deltas.length > 0 && !state.pendingRetry) {
        setImmediate(() => {
          flushDeltaBatch();
        });
      }
    }
  }

  function processDelta(delta: Delta): void {
    if (!state.readyToSend) {
      return;
    }

    const outboundDelta = filterOutboundDelta(delta);
    if (!outboundDelta) {
      return;
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
    setImmediate(() => app.reportOutputMessages());

    const batchReady = state.deltas.length >= state.maxDeltasPerBatch;
    if (batchReady || state.timer) {
      if (batchReady) {
        app.debug(`[${instanceId}] Smart batch: sending ${state.deltas.length} deltas`);
        metrics.smartBatching.earlySends++;
      } else {
        metrics.smartBatching.timerSends++;
      }
      flushDeltaBatch().catch((err: any) => {
        app.error(`[${instanceId}] flushDeltaBatch error: ${err.message}`);
        recordError("sendFailure", `flushDeltaBatch error: ${err.message}`);
      });
    }
  }

  state.processDelta = processDelta;

  const SUBSCRIPTION_RETRY_BASE_DELAY = 5000;
  const SUBSCRIPTION_RETRY_MAX_DELAY = 300000;
  const SUBSCRIPTION_RETRY_MAX_ATTEMPTS = 10;

  /**
   * Schedule a subscription retry with exponential backoff.
   * Gives up after SUBSCRIPTION_RETRY_MAX_ATTEMPTS consecutive failures.
   */
  function scheduleSubscriptionRetry(attempt: number): void {
    if (attempt > SUBSCRIPTION_RETRY_MAX_ATTEMPTS) {
      app.error(
        `[${instanceId}] Subscription failed after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts — ` +
          "giving up. Restart the plugin to retry."
      );
      recordError(
        "subscription",
        `Subscription permanently failed after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts`
      );
      return;
    }

    const delay = Math.min(
      SUBSCRIPTION_RETRY_BASE_DELAY * Math.pow(2, attempt - 1),
      SUBSCRIPTION_RETRY_MAX_DELAY
    );

    app.debug(
      `[${instanceId}] Scheduling subscription retry (attempt ${attempt}/${SUBSCRIPTION_RETRY_MAX_ATTEMPTS}) in ${delay}ms`
    );

    state.subscriptionRetryTimer = setTimeout(() => {
      state.subscriptionRetryTimer = null;
      if (state.stopped) {
        return;
      }
      app.debug(`[${instanceId}] Retrying subscription (attempt ${attempt})...`);
      try {
        app.subscriptionmanager.subscribe(
          state.localSubscription,
          state.unsubscribes,
          (retrySubError: unknown) => {
            app.error(`[${instanceId}] Subscription error (attempt ${attempt}): ${retrySubError}`);
            state.readyToSend = false;
            _setStatus("Subscription error - data transmission paused", false);
            recordError("subscription", `Subscription error: ${retrySubError}`);
          },
          processDelta
        );
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
      state.localSubscription = config;
      app.debug(`[${instanceId}] Subscription configuration updated`);

      state.unsubscribes.forEach((f: () => void) => f());
      state.unsubscribes = [];

      try {
        app.subscriptionmanager.subscribe(
          state.localSubscription,
          state.unsubscribes,
          (subscriptionError: any) => {
            app.error(`[${instanceId}] Subscription error: ${subscriptionError}`);
            state.readyToSend = false;
            _setStatus("Subscription error - data transmission paused", false);
            recordError("subscription", `Subscription error: ${subscriptionError}`);
          },
          processDelta
        );
      } catch (subscribeError: unknown) {
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
  function setupConfigWatchers(): void {
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

      // Trigger initial subscription load
      handleSubscriptionChange();
      app.debug(`[${instanceId}] Configuration file watchers initialized`);
    } catch (err: any) {
      app.error(`[${instanceId}] Error setting up config watchers: ${err.message}`);
    }
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

  async function start(): Promise<void> {
    state.stopped = false;
    state.options = options;

    // Validate secret key — throw so Promise.all in index.js can detect startup failure
    try {
      validateSecretKey(options.secretKey);
    } catch (error: any) {
      const msg = `Secret key validation failed: ${error.message}`;
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

    if ((options.serverType as unknown) === true || options.serverType === "server") {
      // ── Server mode ──
      state.isServerMode = true;
      app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err: any) => {
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
          state.socketUdp.close();
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

        const onStartupError = (err: any) => {
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
        startupSocket.bind(options.udpPort);
      });
    } else {
      // ── Client mode ──
      state.isServerMode = false;
      await initializePersistentStorage({ instanceId, app, state });

      const deltaTimerTimeFile = (await loadConfigFile(state.deltaTimerFile ?? "")) as Record<
        string,
        unknown
      > | null;
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

      state.helloMessageSender = setInterval(async () => {
        try {
          const timeSinceLastPacket = Date.now() - state.lastPacketTime;
          if (!state.readyToSend) {
            app.debug(`[${instanceId}] Skipping hello (not ready)`);
          } else if (timeSinceLastPacket >= helloInterval) {
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
          } else {
            app.debug(`[${instanceId}] Skipping hello (last packet ${timeSinceLastPacket}ms ago)`);
          }
        } catch (err: any) {
          app.error(`[${instanceId}] Hello message send error: ${err.message}`);
        }
      }, helloInterval);

      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err: any) => {
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
            state.socketUdp.close();
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
              state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
              state.socketUdp.on("error", (recoverErr: any) => {
                app.error(`[${instanceId}] Recovered socket error: ${recoverErr.message}`);
                state.readyToSend = false;
                _setStatus(`UDP socket error: ${recoverErr.code || recoverErr.message}`, false);
              });

              // Re-attach v2 control packet listener if pipeline exists
              if (state.pipeline) {
                state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                  state.pipeline!.handleControlPacket(msg, rinfo).catch((cpErr: any) => {
                    app.error(`[${instanceId}] Control packet error: ${cpErr.message}`);
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
              }

              state.socketRecoveryInProgress = false;
              state.readyToSend = true;
              _setStatus("UDP socket recovered", true);
              app.debug(`[${instanceId}] UDP socket recovered`);
            } catch (recoveryErr: any) {
              state.socketRecoveryInProgress = false;
              app.error(`[${instanceId}] UDP socket recovery failed: ${recoveryErr.message}`);
              _setStatus(`UDP socket recovery failed: ${recoveryErr.message}`, false);
            }
          }, 5000);
        }
      });

      scheduleDeltaTimer();
      setupConfigWatchers();

      // Ping / connectivity monitor
      state.pingMonitor = new Monitor({
        address: options.testAddress ?? "",
        port: options.testPort,
        interval: pingIntervalMinutes,
        protocol: "tcp"
      });

      state.pingMonitor.on("up", (res: { time?: number } | null) =>
        handlePingSuccess(res, "up", pingIntervalMinutes)
      );
      state.pingMonitor.on("restored", (res: { time?: number } | null) =>
        handlePingSuccess(res, "restored", pingIntervalMinutes)
      );

      for (const event of ["down", "stop", "timeout"]) {
        state.pingMonitor.on(event, () => {
          state.readyToSend = false;
          _setStatus(`Connection monitor: ${event}`, false);
          app.debug(`[${instanceId}] Connection monitor: ${event}`);
        });
      }

      state.pingMonitor.on("error", (error: any) => {
        state.readyToSend = false;
        if (error) {
          const msg =
            error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
              ? `Could not resolve address ${options.testAddress}.`
              : `Connection monitor error: ${error.message || error}`;
          _setStatus(msg, false);
          app.debug(`[${instanceId}] ${msg}`);
        } else {
          _setStatus("Connection monitor error", false);
        }
      });

      state.pingTimeout = setTimeout(
        () => {
          state.readyToSend = false;
          _setStatus("Connection monitor timeout", false);
        },
        pingIntervalMinutes * MILLISECONDS_PER_MINUTE + PING_TIMEOUT_BUFFER
      );

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

        state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          v2Pipeline.handleControlPacket(msg, rinfo).catch((err: any) => {
            app.error(`[${instanceId}] Control packet error: ${err.message}`);
            recordError("general", `Control packet error: ${err.message}`);
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
            notificationsEnabled: options.enableNotifications === true
          };
          try {
            await v2Pipeline.initBonding(bondingConfig);
            app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
          } catch (err: any) {
            app.error(`[${instanceId}] [Bonding] Failed to initialize: ${err.message}`);
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
    }
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

    // Reset runtime state
    state.deltas = [];
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

    // Reset metrics
    resetMetrics();

    // Clear timers
    clearInterval(state.helloMessageSender ?? undefined);
    state.helloMessageSender = null;
    clearTimeout(state.pingTimeout ?? undefined); // null is safe for clearTimeout
    state.pingTimeout = null;
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
    state.networkSimulator = null;

    // Stop ping monitor
    if (state.pingMonitor) {
      state.pingMonitor.stop();
      state.pingMonitor = null;
    }

    // Close UDP socket
    if (state.socketUdp) {
      state.socketUdp.close();
      state.socketUdp = null;
      app.debug(`[${instanceId}] Stopped`);
    }

    _setStatus("Stopped", false);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    start,
    stop,
    getId: () => instanceId,
    getName: () => state.instanceName,
    getStatus: () => ({ text: state.instanceStatus, healthy: state.isHealthy }),
    getState: () => state,
    getMetricsApi: () => metricsApi
  };
}

export { createInstance, slugify };
