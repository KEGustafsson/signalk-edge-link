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

const { readFile, writeFile, mkdir } = require("fs").promises;
const { watch } = require("fs");
const { join } = require("path");
const crypto = require("crypto");
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
  FILE_WATCH_DEBOUNCE_DELAY,
  CONTENT_HASH_ALGORITHM,
  WATCHER_RECOVERY_DELAY,
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} = require("./constants");

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

const { loadConfigFile, saveConfigFile } = require("./config-io");

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

  // v1 pipeline is created once at construction; v2 pipelines are created lazily
  // inside start() because they depend on state.options being set.
  const v1Pipeline = createPipeline(app, state, metricsApi);

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

  function _setStatus(msg) {
    state.instanceStatus = msg;
    const lower = msg ? msg.toLowerCase() : "";
    state.isHealthy = msg
      ? !lower.includes("error") && !lower.includes("fail") && !lower.includes("stopped")
      : false;
    if (typeof onStatusChange === "function") {
      onStatusChange(instanceId, msg);
    }
  }

  // ── Publish RTT to Signal K (v1 client only) ──────────────────────────────
  function publishRtt(rttMs) {
    if (options.protocolVersion === 1) {
      app.handleMessage(pluginId, {
        context: "vessels.self",
        updates: [{
          timestamp: new Date().toISOString(),
          values: [{ path: "networking.modem.rtt", value: rttMs / 1000 }]
        }]
      });
    }
  }

  function handlePingSuccess(res, eventName, pingIntervalMinutes) {
    state.readyToSend = true;
    state.isHealthy = true;
    clearTimeout(state.pingTimeout);
    state.pingTimeout = setTimeout(
      () => { state.readyToSend = false; },
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
  function createDebouncedConfigHandler(name, getFilePath, processConfig, handlerOpts = {}) {
    return function handleChange() {
      clearTimeout(state.configDebounceTimers[name]);
      state.configDebounceTimers[name] = setTimeout(async () => {
        try {
          let content;
          if (handlerOpts.readFallback !== undefined) {
            content = await readFile(getFilePath(), "utf-8").catch(() => null);
          } else {
            content = await readFile(getFilePath(), "utf-8");
          }

          const hashSource = content || JSON.stringify(handlerOpts.readFallback) || "";
          const contentHash = crypto.createHash(CONTENT_HASH_ALGORITHM).update(hashSource).digest("hex");

          if (contentHash === state.configContentHashes[name]) {
            app.debug(`[${instanceId}] ${name} file unchanged, skipping`);
            return;
          }
          state.configContentHashes[name] = contentHash;

          const parsed = content ? JSON.parse(content) : handlerOpts.readFallback;
          await processConfig(parsed);
        } catch (err) {
          app.error(`[${instanceId}] Error handling ${name} change: ${err.message}`);
        }
      }, FILE_WATCH_DEBOUNCE_DELAY);
    };
  }

  const handleDeltaTimerChange = createDebouncedConfigHandler(
    "Delta timer",
    () => state.deltaTimerFile,
    (config) => {
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
    }
  );

  /**
   * Filter outbound deltas to prevent feedback loops of plugin-local metrics.
   */
  function filterOutboundDelta(delta) {
    if (!delta || !Array.isArray(delta.updates)) {
      return delta;
    }

    let changed = false;
    const filteredUpdates = [];

    for (const update of delta.updates) {
      if (!update) { changed = true; continue; }

      const sourceLabel = update.source && update.source.label;
      if (sourceLabel === pluginId) { changed = true; continue; }

      if (!Array.isArray(update.values)) {
        filteredUpdates.push(update);
        continue;
      }

      const filteredValues = update.values.filter((entry) => {
        const path = entry && entry.path;
        if (typeof path !== "string") { return true; }
        if (path === "networking.modem.rtt") { return false; }
        // Only suppress feedback for this instance's own metrics.
        // Paths belonging to other instances (e.g. a co-running server) must
        // not be filtered out, otherwise their telemetry can never be forwarded.
        const ownPrefix = `networking.edgeLink.${state.instanceId}`;
        if (path === "networking.edgeLink") { return false; }
        if (path === ownPrefix || path.startsWith(ownPrefix + ".")) { return false; }
        if (
          path === "notifications.signalk-edge-link" ||
          path.startsWith("notifications.signalk-edge-link.")
        ) { return false; }
        return true;
      });

      if (filteredValues.length === 0) { changed = true; continue; }
      if (filteredValues.length !== update.values.length) {
        changed = true;
        filteredUpdates.push({ ...update, values: filteredValues });
      } else {
        filteredUpdates.push(update);
      }
    }

    if (filteredUpdates.length === 0) { return null; }
    return changed ? { ...delta, updates: filteredUpdates } : delta;
  }

  // Subscription change handler (also wires up the main delta subscription)
  const handleSubscriptionChange = createDebouncedConfigHandler(
    "Subscription",
    () => state.subscriptionFile,
    (config) => {
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
            _setStatus("Subscription error - data transmission paused");
            recordError("subscription", `Subscription error: ${subscriptionError}`);
          },
          (delta) => {
            if (!state.readyToSend) { return; }

            let filteredDelta = filterOutboundDelta(delta);
            if (!filteredDelta) { return; }

            // Apply sentence exclusion filter
            if (state.excludedSentences.length > 0 && filteredDelta.updates) {
              const kept = filteredDelta.updates.filter((u) => {
                const sentence = u?.source?.sentence;
                return !(sentence && state.excludedSentences.includes(sentence));
              });
              if (kept.length === 0) { return; }
              if (kept.length !== filteredDelta.updates.length) {
                filteredDelta = { ...filteredDelta, updates: kept };
              }
            }

            if (state.deltas.length >= MAX_DELTAS_BUFFER_SIZE) {
              // Drop the oldest half to make room while preserving recent data
              const dropCount = Math.floor(MAX_DELTAS_BUFFER_SIZE / 2);
              state.deltas.splice(0, dropCount);
              app.debug(`[${instanceId}] Delta buffer overflow, dropped ${dropCount} oldest items`);
            }

            state.deltas.push(filteredDelta);
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
                v1Pipeline.packCrypt(state.deltas, options.secretKey, options.udpAddress, options.udpPort)
                  .catch((err) => app.debug(`[${instanceId}] packCrypt error: ${err.message}`));
              }
              state.deltas = [];
              state.timer = false;
            }
          }
        );
      } catch (subscribeError) {
        app.error(`[${instanceId}] Failed to subscribe: ${subscribeError.message}`);
        state.readyToSend = false;
        _setStatus("Failed to subscribe - data transmission paused");
        recordError("subscription", `Failed to subscribe: ${subscribeError.message}`);
      }
    },
    { readFallback: { context: "*", subscribe: [{ path: "*" }] } }
  );

  const handleSentenceFilterChange = createDebouncedConfigHandler(
    "Sentence filter",
    () => state.sentenceFilterFile,
    (config) => {
      if (config && Array.isArray(config.excludedSentences)) {
        state.excludedSentences = config.excludedSentences
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => s.length > 0);
        app.debug(`[${instanceId}] Sentence filter updated: [${state.excludedSentences.join(", ")}]`);
      } else {
        app.error(`[${instanceId}] Invalid sentence filter configuration`);
      }
    }
  );

  // ── File-system watcher with auto-recovery ────────────────────────────────
  function createWatcherWithRecovery(filePath, onChange, name) {
    const watcherObj = { watcher: null };

    function createWatcher() {
      try {
        watcherObj.watcher = watch(filePath, (eventType) => {
          if (eventType === "change") {
            app.debug(`[${instanceId}] ${name} file changed`);
            onChange();
          }
        });

        watcherObj.watcher.on("error", (error) => {
          app.error(`[${instanceId}] ${name} watcher error: ${error.message}`);
          if (watcherObj.watcher) { watcherObj.watcher.close(); watcherObj.watcher = null; }
          watcherObj.recoveryTimer = setTimeout(() => {
            watcherObj.recoveryTimer = null;
            if (state.stopped) { return; }
            app.debug(`[${instanceId}] Recreating ${name} watcher...`);
            createWatcher();
          }, WATCHER_RECOVERY_DELAY);
        });

        return true;
      } catch (err) {
        app.error(`[${instanceId}] Failed to create ${name} watcher: ${err.message}`);
        return false;
      }
    }

    createWatcher();

    return {
      get watcher() { return watcherObj.watcher; },
      close() {
        if (watcherObj.recoveryTimer) { clearTimeout(watcherObj.recoveryTimer); watcherObj.recoveryTimer = null; }
        if (watcherObj.watcher) { watcherObj.watcher.close(); watcherObj.watcher = null; }
      }
    };
  }

  function setupConfigWatchers() {
    try {
      const watcherConfigs = [
        { path: state.deltaTimerFile, handler: handleDeltaTimerChange, name: "Delta timer" },
        { path: state.subscriptionFile, handler: handleSubscriptionChange, name: "Subscription" },
        { path: state.sentenceFilterFile, handler: handleSentenceFilterChange, name: "Sentence filter" }
      ];

      state.configWatcherObjects = watcherConfigs.map(({ path, handler, name }) =>
        createWatcherWithRecovery(path, handler, name)
      );

      // Trigger initial subscription load
      handleSubscriptionChange();
      app.debug(`[${instanceId}] Configuration file watchers initialized`);
    } catch (err) {
      app.error(`[${instanceId}] Error setting up config watchers: ${err.message}`);
    }
  }

  // ── Persistent storage (namespaced per instance) ──────────────────────────

  /**
   * Migrate legacy root-level config files to the instance-namespaced directory
   * when upgrading from single-instance to multi-instance mode.
   * Only runs for the "default" instance.
   */
  async function migrateLegacyConfigFiles(instanceDir) {
    if (instanceId !== "default") { return; }
    const legacyFiles = ["delta_timer.json", "subscription.json", "sentence_filter.json"];
    for (const file of legacyFiles) {
      const legacy = join(app.getDataDirPath(), file);
      const target = join(instanceDir, file);
      const legacyExists = await readFile(legacy, "utf-8").then(() => true).catch(() => false);
      const targetExists = await readFile(target, "utf-8").then(() => true).catch(() => false);
      if (legacyExists && !targetExists) {
        try {
          const data = await readFile(legacy, "utf-8");
          await writeFile(target, data, "utf-8");
          app.debug(`[${instanceId}] Migrated legacy ${file} → instances/default/${file}`);
        } catch (err) {
          app.error(`[${instanceId}] Migration failed for ${file}: ${err.message}`);
        }
      }
    }
  }

  async function initializePersistentStorage() {
    // Each instance stores its config files under {dataDir}/instances/{instanceId}/
    const instanceDir = join(app.getDataDirPath(), "instances", instanceId);
    await mkdir(instanceDir, { recursive: true });

    // Migrate legacy root-level files for the default instance
    await migrateLegacyConfigFiles(instanceDir);

    state.deltaTimerFile = join(instanceDir, "delta_timer.json");
    state.subscriptionFile = join(instanceDir, "subscription.json");
    state.sentenceFilterFile = join(instanceDir, "sentence_filter.json");

    const defaults = [
      { file: state.deltaTimerFile, data: { deltaTimer: DEFAULT_DELTA_TIMER }, name: "delta_timer.json" },
      { file: state.subscriptionFile, data: { context: "*", subscribe: [{ path: "*" }] }, name: "subscription.json" },
      { file: state.sentenceFilterFile, data: { excludedSentences: ["GSV"] }, name: "sentence_filter.json" }
    ];

    for (const { file, data, name } of defaults) {
      const existing = await loadConfigFile(file);
      if (!existing) {
        await saveConfigFile(file, data);
        app.debug(`[${instanceId}] Initialized ${name} with defaults`);
      } else if (name === "sentence_filter.json") {
        state.excludedSentences = existing.excludedSentences || ["GSV"];
      }
    }
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

  async function start() {
    state.stopped = false;
    state.options = options;

    // Validate secret key
    try {
      validateSecretKey(options.secretKey);
    } catch (error) {
      app.error(`[${instanceId}] Secret key validation failed: ${error.message}`);
      _setStatus(`Secret key validation failed: ${error.message}`);
      return;
    }

    if (!Number.isInteger(options.udpPort) || options.udpPort < 1024 || options.udpPort > 65535) {
      app.error(`[${instanceId}] UDP port must be between 1024 and 65535`);
      _setStatus("UDP port validation failed");
      return;
    }

    if (options.serverType === true || options.serverType === "server") {
      // ── Server mode ──
      state.isServerMode = true;
      app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err) => {
        app.error(`[${instanceId}] UDP socket error: ${err.message}`);
        state.readyToSend = false;
        if (err.code === "EADDRINUSE") {
          _setStatus(`Failed to start – port ${options.udpPort} already in use`);
        } else if (err.code === "EACCES") {
          _setStatus(`Failed to start – permission denied for port ${options.udpPort}`);
        } else {
          _setStatus(`UDP socket error: ${err.code || err.message}`);
        }
        if (state.socketUdp) { state.socketUdp.close(); state.socketUdp = null; }
      });

      state.socketUdp.on("listening", () => {
        if (!state.socketUdp) { return; }
        const address = state.socketUdp.address();
        app.debug(`[${instanceId}] UDP server listening on ${address.address}:${address.port}`);
        _setStatus(`Server listening on port ${address.port}`);
        state.readyToSend = true;
        state.isHealthy = true;
      });

      const useV2Server = options.protocolVersion === 2;
      if (useV2Server) {
        const v2Server = createPipelineV2Server(appProxy, state, metricsApi);
        state.pipelineServer = v2Server;

        state.socketUdp.on("message", (packet, rinfo) => {
          v2Server.receivePacket(packet, options.secretKey, rinfo);
        });

        state.socketUdp.on("listening", () => {
          if (!state.socketUdp) { return; }
          v2Server.startACKTimer();
          v2Server.startMetricsPublishing();
          app.debug(`[${instanceId}] [v2] Server pipeline with ACK/NAK initialized`);
        });
      } else {
        state.socketUdp.on("message", (delta) => {
          v1Pipeline.unpackDecrypt(delta, options.secretKey);
        });
        app.debug(`[${instanceId}] [v1] Server pipeline initialized`);
      }

      state.socketUdp.bind(options.udpPort, (err) => {
        if (err) {
          app.error(`[${instanceId}] Failed to bind to port ${options.udpPort}: ${err.message}`);
          _setStatus(`Failed to start – ${err.message}`);
        }
      });

    } else {
      // ── Client mode ──
      state.isServerMode = false;
      await initializePersistentStorage();

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
              await v1Pipeline.packCrypt([fixedDelta], options.secretKey, options.udpAddress, options.udpPort);
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
        _setStatus(`UDP socket error: ${err.code || err.message}`);
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
          app.debug(`[${instanceId}] ${msg}`);
        }
      });

      state.pingTimeout = setTimeout(
        () => { state.readyToSend = false; },
        pingIntervalMinutes * MILLISECONDS_PER_MINUTE + PING_TIMEOUT_BUFFER
      );

      // v2 client pipeline
      const useV2 = options.protocolVersion === 2;
      if (useV2) {
        state.monitoring = {
          packetLossTracker: new PacketLossTracker(),
          pathLatencyTracker: new PathLatencyTracker(),
          retransmissionTracker: new RetransmissionTracker(),
          alertManager: new AlertManager(appProxy, { thresholds: options.alertThresholds || {}, instanceId: state.instanceId }),
          packetCapture: new PacketCapture(),
          packetInspector: new PacketInspector()
        };
        app.debug(`[${instanceId}] [v2] Enhanced monitoring initialized`);

        const v2Pipeline = createPipelineV2Client(appProxy, state, metricsApi);
        state.pipeline = v2Pipeline;

        v2Pipeline.setMonitoring(state.monitoring);
        v2Pipeline.startMetricsPublishing();

        if (options.congestionControl && options.congestionControl.enabled) {
          v2Pipeline.startCongestionControl();
        }

        state.heartbeatHandle = v2Pipeline.startHeartbeat(options.udpAddress, options.udpPort);

        state.socketUdp.on("message", (msg, rinfo) => {
          v2Pipeline.handleControlPacket(msg, rinfo);
        });

        if (options.bonding && options.bonding.enabled) {
          const bondingConfig = {
            mode: options.bonding.mode || "main-backup",
            primary: options.bonding.primary || { address: options.udpAddress, port: options.udpPort },
            backup: options.bonding.backup || { address: options.udpAddress, port: options.udpPort + 1 },
            failover: options.bonding.failover || {},
            instanceId: state.instanceId
          };
          try {
            await v2Pipeline.initBonding(bondingConfig);
            app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
          } catch (err) {
            app.error(`[${instanceId}] [Bonding] Failed to initialize: ${err.message}`);
          }
        }

        app.debug(`[${instanceId}] [v2] Protocol v2 client pipeline initialized`);
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

    _setStatus("Stopped");
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
