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

const dgram = require("dgram");
const { validateSecretKey } = require("./crypto");
const Monitor = require("ping-monitor");
const createMetrics = require("./metrics");
const createPipeline = require("./pipeline");
const { createPipelineV2Client } = require("./pipeline-v2-client");
const { createPipelineV2Server } = require("./pipeline-v2-server");
const {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
} = require("./monitoring");
const { PacketCapture, PacketInspector } = require("./packet-capture");
const {
  DEFAULT_DELTA_TIMER,
  PING_TIMEOUT_BUFFER,
  MILLISECONDS_PER_MINUTE,
  MAX_DELTAS_BUFFER_SIZE,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} = require("./constants");
const {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  initializePersistentStorage
} = require("./config-watcher");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a URL-safe identifier from a human-readable name.
 * "Shore Server" → "shore-server"
 */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "connection";
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a connection instance.
 *
 * @param {Object}   app             - Signal K app object
 * @param {Object}   options         - Connection configuration (serverType, udpPort, …)
 * @param {string}   instanceId      - URL-safe unique identifier for this connection
 * @param {string}   pluginId        - Plugin ID (used as source label in SK messages)
 * @param {Function} onStatusChange  - Called as (instanceId, message) whenever status changes
 * @returns {Object} Instance API: { start, stop, getId, getName, getStatus, getState, getMetricsApi }
 */
function createInstance(app, options, instanceId, pluginId, onStatusChange) {
  // ── Per-instance state ────────────────────────────────────────────────────
  const state = {
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
    pipeline: null,
    pipelineServer: null,
    heartbeatHandle: null,
    monitoring: null,
    networkSimulator: null,
    configDebounceTimers: {},
    configContentHashes: {},
    configWatcherObjects: []
  };

  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;

  // v1 pipeline is created lazily on first use (only needed in client v1 mode)
  let v1Pipeline = null;
  function getV1Pipeline() {
    if (!v1Pipeline) {
      v1Pipeline = createPipeline(app, state, metricsApi);
    }
    return v1Pipeline;
  }

  // ── App proxy: redirects setPluginStatus to per-instance status ───────────
  // This prevents individual instances from overwriting the global status bar.
  const appProxy = new Proxy(app, {
    get(target, prop) {
      if (prop === "setPluginStatus" || prop === "setProviderStatus") {
        return (msg) => _setStatus(msg);
      }
      return target[prop];
    }
  });

  function _setStatus(msg, healthyOverride) {
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
  function publishRtt(rttMs) {
    if (options.protocolVersion === 1) {
      const modemRttPath = state.instanceId
        ? `networking.modem.${state.instanceId}.rtt`
        : "networking.modem.rtt";
      app.handleMessage(pluginId, {
        context: "vessels.self",
        updates: [{
          timestamp: new Date().toISOString(),
          values: [{ path: modemRttPath, value: rttMs / 1000 }]
        }]
      });
    }
  }

  function handlePingSuccess(res, eventName, pingIntervalMinutes) {
    state.readyToSend = true;
    _setStatus("Connected", true);
    clearTimeout(state.pingTimeout);
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
  function scheduleDeltaTimer() {
    clearTimeout(state.deltaTimer);
    state.deltaTimer = setTimeout(() => {
      if (state.stopped) { return; }
      state.timer = true;
      scheduleDeltaTimer();
    }, state.deltaTimerTime);
  }

  // ── Config file debounced watchers ────────────────────────────────────────
  const handleDeltaTimerChange = createDebouncedConfigHandler({
    name: "Delta timer",
    getFilePath: () => state.deltaTimerFile,
    processConfig: (config) => {
      if (config && config.deltaTimer) {
        const newVal = config.deltaTimer;
        if (newVal >= 100 && newVal <= 10000) {
          if (state.deltaTimerTime !== newVal) {
            state.deltaTimerTime = newVal;
            clearTimeout(state.deltaTimer);
            scheduleDeltaTimer();
            app.debug(`[${instanceId}] Delta timer updated to ${newVal}ms`);
          }
        } else {
          app.error(`[${instanceId}] Invalid delta timer value: ${newVal}`);
        }
      }
    },
    state, instanceId, app
  });

  /**
   * Outbound filtering is intentionally disabled:
   * forward all subscribed deltas as-is.
   */
  function filterOutboundDelta(delta) {
    if (!delta || !Array.isArray(delta.updates) || delta.updates.length === 0) {
      return null;
    }
    return delta;
  }

  /**
   * Processes an incoming delta from the subscription manager.
   * Buffers and dispatches deltas to the send pipeline.
   *
   * @param {Object} delta - SignalK delta message
   */
  function processDelta(delta) {
    if (!state.readyToSend) { return; }

    const outboundDelta = filterOutboundDelta(delta);
    if (!outboundDelta) { return; }

    if (state.deltas.length >= MAX_DELTAS_BUFFER_SIZE) {
      const dropCount = Math.floor(MAX_DELTAS_BUFFER_SIZE / 2);
      state.deltas.splice(0, dropCount);
      app.debug(`[${instanceId}] Delta buffer overflow, dropped ${dropCount} oldest items`);
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
      if (state.pipeline) {
        state.pipeline.sendDelta(state.deltas, options.secretKey, options.udpAddress, options.udpPort)
          .catch((err) => app.debug(`[${instanceId}] sendDelta error: ${err.message}`));
      } else {
        getV1Pipeline().packCrypt(state.deltas, options.secretKey, options.udpAddress, options.udpPort)
          .catch((err) => app.debug(`[${instanceId}] packCrypt error: ${err.message}`));
      }
      state.deltas = [];
      state.timer = false;
    }
  }

  // Subscription change handler (also wires up the main delta subscription)
  const handleSubscriptionChange = createDebouncedConfigHandler({
    name: "Subscription",
    getFilePath: () => state.subscriptionFile,
    processConfig: (config) => {
      state.localSubscription = config;
      app.debug(`[${instanceId}] Subscription configuration updated`);

      state.unsubscribes.forEach((f) => f());
      state.unsubscribes = [];

      try {
        app.subscriptionmanager.subscribe(
          state.localSubscription,
          state.unsubscribes,
          (subscriptionError) => {
            app.error(`[${instanceId}] Subscription error: ${subscriptionError}`);
            state.readyToSend = false;
            _setStatus("Subscription error - data transmission paused", false);
            recordError("subscription", `Subscription error: ${subscriptionError}`);
          },
          processDelta
        );
      } catch (subscribeError) {
        app.error(`[${instanceId}] Failed to subscribe: ${subscribeError.message}`);
        state.readyToSend = false;
        _setStatus("Failed to subscribe - data transmission paused", false);
        recordError("subscription", `Failed to subscribe: ${subscribeError.message}`);
      }
    },
    state, instanceId, app,
    readFallback: { context: "*", subscribe: [{ path: "*" }] }
  });

  const handleSentenceFilterChange = createDebouncedConfigHandler({
    name: "Sentence filter",
    getFilePath: () => state.sentenceFilterFile,
    processConfig: (config) => {
      if (config && Array.isArray(config.excludedSentences)) {
        state.excludedSentences = config.excludedSentences
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => s.length > 0);
        app.debug(`[${instanceId}] Sentence filter updated: [${state.excludedSentences.join(", ")}]`);
      } else {
        app.error(`[${instanceId}] Invalid sentence filter configuration`);
      }
    },
    state, instanceId, app
  });

  // ── File-system watchers (delegated to config-watcher module) ────────────
  function setupConfigWatchers() {
    try {
      const watcherConfigs = [
        { filePath: state.deltaTimerFile, onChange: handleDeltaTimerChange, name: "Delta timer" },
        { filePath: state.subscriptionFile, onChange: handleSubscriptionChange, name: "Subscription" },
        { filePath: state.sentenceFilterFile, onChange: handleSentenceFilterChange, name: "Sentence filter" }
      ];

      state.configWatcherObjects = watcherConfigs.map((cfg) =>
        createWatcherWithRecovery({ ...cfg, instanceId, app, state })
      );

      // Trigger initial subscription load
      handleSubscriptionChange();
      app.debug(`[${instanceId}] Configuration file watchers initialized`);
    } catch (err) {
      app.error(`[${instanceId}] Error setting up config watchers: ${err.message}`);
    }
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

  async function start() {
    state.stopped = false;
    state.options = options;

    // Validate secret key — throw so Promise.all in index.js can detect startup failure
    try {
      validateSecretKey(options.secretKey);
    } catch (error) {
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

    if (options.serverType === true || options.serverType === "server") {
      // ── Server mode ──
      state.isServerMode = true;
      app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err) => {
        app.error(`[${instanceId}] UDP socket error: ${err.message}`);
        state.readyToSend = false;
        // Stop v2 periodic workers if the server socket is no longer usable.
        if (state.pipelineServer) {
          if (state.pipelineServer.stopACKTimer) { state.pipelineServer.stopACKTimer(); }
          if (state.pipelineServer.stopMetricsPublishing) { state.pipelineServer.stopMetricsPublishing(); }
        }
        if (err.code === "EADDRINUSE") {
          _setStatus(`Failed to start – port ${options.udpPort} already in use`, false);
        } else if (err.code === "EACCES") {
          _setStatus(`Failed to start – permission denied for port ${options.udpPort}`, false);
        } else {
          _setStatus(`UDP socket error: ${err.code || err.message}`, false);
        }
        if (state.socketUdp) { state.socketUdp.close(); state.socketUdp = null; }
      });

      state.socketUdp.on("listening", () => {
        if (!state.socketUdp) { return; }
        const address = state.socketUdp.address();
        app.debug(`[${instanceId}] UDP server listening on ${address.address}:${address.port}`);
        _setStatus(`Server listening on port ${address.port}`, true);
        state.readyToSend = true;
      });

      const useReliableProtocolServer = options.protocolVersion >= 2;
      const reliableServerLabel = options.protocolVersion === 3 ? "v3" : "v2";
      if (useReliableProtocolServer) {
        const v2Server = createPipelineV2Server(appProxy, state, metricsApi);
        state.pipelineServer = v2Server;

        state.socketUdp.on("message", (packet, rinfo) => {
          v2Server.receivePacket(packet, options.secretKey, rinfo);
        });

        state.socketUdp.on("listening", () => {
          if (!state.socketUdp) { return; }
          v2Server.startACKTimer();
          v2Server.startMetricsPublishing();
          app.debug(`[${instanceId}] [${reliableServerLabel}] Server pipeline with ACK/NAK initialized`);
        });
      } else {
        state.socketUdp.on("message", (delta) => {
          getV1Pipeline().unpackDecrypt(delta, options.secretKey);
        });
        app.debug(`[${instanceId}] [v1] Server pipeline initialized`);
      }

      const startupSocket = state.socketUdp;
      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          if (!startupSocket) { return; }
          startupSocket.removeListener("listening", onStartupListening);
          startupSocket.removeListener("error", onStartupError);
        };

        const onStartupListening = () => {
          if (settled) { return; }
          settled = true;
          cleanup();
          resolve();
        };

        const onStartupError = (err) => {
          if (settled) { return; }
          settled = true;
          cleanup();
          reject(new Error(`[${instanceId}] Failed to bind to port ${options.udpPort}: ${err.message}`));
        };

        startupSocket.once("listening", onStartupListening);
        startupSocket.once("error", onStartupError);
        startupSocket.bind(options.udpPort);
      });

    } else {
      // ── Client mode ──
      state.isServerMode = false;
      await initializePersistentStorage({ instanceId, app, state });

      const { loadConfigFile } = require("./config-io");
      const deltaTimerTimeFile = await loadConfigFile(state.deltaTimerFile);
      state.deltaTimerTime = (
        deltaTimerTimeFile &&
        Number.isFinite(deltaTimerTimeFile.deltaTimer) &&
        deltaTimerTimeFile.deltaTimer >= 100
      ) ? deltaTimerTimeFile.deltaTimer : DEFAULT_DELTA_TIMER;

      const helloIntervalSeconds = Number.isFinite(options.helloMessageSender) ? options.helloMessageSender : 60;
      const pingIntervalMinutes = Number.isFinite(options.pingIntervalTime) ? options.pingIntervalTime : 1;
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
              await state.pipeline.sendDelta([fixedDelta], options.secretKey, options.udpAddress, options.udpPort);
            } else {
              await getV1Pipeline().packCrypt([fixedDelta], options.secretKey, options.udpAddress, options.udpPort);
            }
          } else {
            app.debug(`[${instanceId}] Skipping hello (last packet ${timeSinceLastPacket}ms ago)`);
          }
        } catch (err) {
          app.error(`[${instanceId}] Hello message send error: ${err.message}`);
        }
      }, helloInterval);

      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err) => {
        app.error(`[${instanceId}] Client UDP socket error: ${err.message}`);
        state.readyToSend = false;
        _setStatus(`UDP socket error: ${err.code || err.message}`, false);
      });

      scheduleDeltaTimer();
      setupConfigWatchers();

      // Ping / connectivity monitor
      state.pingMonitor = new Monitor({
        address: options.testAddress,
        port: options.testPort,
        interval: pingIntervalMinutes,
        protocol: "tcp"
      });

      state.pingMonitor.on("up", (res) => handlePingSuccess(res, "up", pingIntervalMinutes));
      state.pingMonitor.on("restored", (res) => handlePingSuccess(res, "restored", pingIntervalMinutes));

      for (const event of ["down", "stop", "timeout"]) {
        state.pingMonitor.on(event, () => {
          state.readyToSend = false;
          _setStatus(`Connection monitor: ${event}`, false);
          app.debug(`[${instanceId}] Connection monitor: ${event}`);
        });
      }

      state.pingMonitor.on("error", (error) => {
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
      const useReliableProtocol = options.protocolVersion >= 2;
      const reliableProtocolLabel = options.protocolVersion === 3 ? "v3" : "v2";
      if (useReliableProtocol) {
        state.monitoring = {
          packetLossTracker: new PacketLossTracker(),
          pathLatencyTracker: new PathLatencyTracker(),
          retransmissionTracker: new RetransmissionTracker(),
          alertManager: new AlertManager(appProxy, { thresholds: options.alertThresholds || {}, instanceId: state.instanceId, enabled: options.enableNotifications === true }),
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

        state.heartbeatHandle = v2Pipeline.startHeartbeat(options.udpAddress, options.udpPort);

        state.socketUdp.on("message", (msg, rinfo) => {
          v2Pipeline.handleControlPacket(msg, rinfo).catch((err) => {
            app.error(`[${instanceId}] Control packet error: ${err.message}`);
            recordError("general", `Control packet error: ${err.message}`);
          });
        });

        if (options.bonding && options.bonding.enabled) {
          const bondingConfig = {
            mode: options.bonding.mode || "main-backup",
            primary: options.bonding.primary || { address: options.udpAddress, port: options.udpPort },
            backup: options.bonding.backup || { address: options.udpAddress, port: options.udpPort + 1 },
            failover: options.bonding.failover || {},
            instanceId: state.instanceId,
            notificationsEnabled: options.enableNotifications === true
          };
          try {
            await v2Pipeline.initBonding(bondingConfig);
            app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
          } catch (err) {
            app.error(`[${instanceId}] [Bonding] Failed to initialize: ${err.message}`);
          }
        }

        app.debug(`[${instanceId}] [${reliableProtocolLabel}] Reliable client pipeline initialized`);
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

  function stop() {
    state.stopped = true;
    state.readyToSend = false;
    state.isHealthy = false;

    // Unsubscribe from Signal K
    state.unsubscribes.forEach((f) => f());
    state.unsubscribes = [];
    state.localSubscription = null;

    // Reset runtime state
    state.deltas = [];
    state.timer = false;
    Object.keys(state.configContentHashes).forEach((k) => delete state.configContentHashes[k]);
    state.excludedSentences = ["GSV"];
    state.lastPacketTime = 0;

    // Reset metrics
    resetMetrics();

    // Clear timers
    clearInterval(state.helloMessageSender); state.helloMessageSender = null;
    clearTimeout(state.pingTimeout); state.pingTimeout = null;
    clearTimeout(state.deltaTimer); state.deltaTimer = null;
    Object.keys(state.configDebounceTimers).forEach((k) => {
      clearTimeout(state.configDebounceTimers[k]);
      delete state.configDebounceTimers[k];
    });

    // Stop file-system watchers
    state.configWatcherObjects.forEach((w) => w.close());
    state.configWatcherObjects = [];

    // Stop v2 client pipeline
    if (state.pipeline) {
      if (state.pipeline.stopBonding) { state.pipeline.stopBonding(); }
      if (state.pipeline.stopMetricsPublishing) { state.pipeline.stopMetricsPublishing(); }
      if (state.pipeline.stopCongestionControl) { state.pipeline.stopCongestionControl(); }
      state.pipeline = null;
    }
    if (state.heartbeatHandle) { state.heartbeatHandle.stop(); state.heartbeatHandle = null; }

    // Stop v2 server pipeline
    if (state.pipelineServer) {
      if (state.pipelineServer.stopACKTimer) { state.pipelineServer.stopACKTimer(); }
      if (state.pipelineServer.stopMetricsPublishing) { state.pipelineServer.stopMetricsPublishing(); }
      if (state.pipelineServer.getSequenceTracker) {
        state.pipelineServer.getSequenceTracker().reset();
      }
      state.pipelineServer = null;
    }

    // Clean up enhanced monitoring
    if (state.monitoring) {
      if (state.monitoring.packetLossTracker) { state.monitoring.packetLossTracker.reset(); }
      if (state.monitoring.pathLatencyTracker) { state.monitoring.pathLatencyTracker.reset(); }
      if (state.monitoring.retransmissionTracker) { state.monitoring.retransmissionTracker.reset(); }
      if (state.monitoring.packetCapture) { state.monitoring.packetCapture.reset(); }
      if (state.monitoring.packetInspector) { state.monitoring.packetInspector.reset(); }
      if (state.monitoring.alertManager) { state.monitoring.alertManager.reset(); }
      state.monitoring = null;
    }
    state.networkSimulator = null;

    // Stop ping monitor
    if (state.pingMonitor) { state.pingMonitor.stop(); state.pingMonitor = null; }

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

module.exports = { createInstance, slugify };
