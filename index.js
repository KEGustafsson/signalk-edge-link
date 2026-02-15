"use strict";

const { readFile } = require("fs").promises;
const { watch } = require("fs");
const { join } = require("path");
const crypto = require("crypto");
const dgram = require("dgram");
const { validateSecretKey } = require("./lib/crypto");
const Monitor = require("ping-monitor");
const createMetrics = require("./lib/metrics");
const createPipeline = require("./lib/pipeline");
const { createPipelineV2Client } = require("./lib/pipeline-v2-client");
const { createPipelineV2Server } = require("./lib/pipeline-v2-server");
const createRoutes = require("./lib/routes");
const { PacketLossTracker, PathLatencyTracker, RetransmissionTracker, AlertManager } = require("./lib/monitoring");
const { PacketCapture, PacketInspector } = require("./lib/packet-capture");
const pkg = require("./package.json");
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
} = require("./lib/constants");

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = pkg.name;
  plugin.name = "Signal K Edge Link";
  plugin.description = pkg.description;

  // eslint-disable-next-line no-unused-vars
  const setStatus = app.setPluginStatus || app.setProviderStatus;

  // ── Shared mutable state (passed by reference to sub-modules) ──
  const state = {
    options: null,
    socketUdp: null,
    readyToSend: false,
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

  // ── Initialize sub-modules ──
  const metricsApi = createMetrics();
  const { metrics, recordError, resetMetrics } = metricsApi;
  const pipeline = createPipeline(app, state, metricsApi);
  const routes = createRoutes(app, state, metricsApi, plugin);

  // ── Ping monitor helpers ──

  /**
   * Publishes RTT (Round Trip Time) to local SignalK
   * @param {number} rttMs - RTT in milliseconds
   */
  function publishRtt(rttMs) {
    app.handleMessage(plugin.id, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date(),
          values: [{ path: "networking.modem.rtt", value: rttMs / 1000 }]
        }
      ]
    });
  }

  /**
   * Handles successful ping response (used by 'up' and 'restored' events)
   */
  function handlePingSuccess(res, eventName, pingIntervalTime) {
    state.readyToSend = true;
    clearTimeout(state.pingTimeout);
    state.pingTimeout = setTimeout(
      () => { state.readyToSend = false; },
      pingIntervalTime * MILLISECONDS_PER_MINUTE + PING_TIMEOUT_BUFFER
    );
    if (res && res.time !== undefined) {
      publishRtt(res.time);
      app.debug(`Connection monitor: ${eventName} (RTT: ${res.time}ms)`);
    } else {
      app.debug(`Connection monitor: ${eventName}`);
    }
  }

  // ── Delta timer ──

  const scheduleDeltaTimer = () => {
    clearTimeout(state.deltaTimer);
    state.deltaTimer = setTimeout(() => {
      state.timer = true;
      scheduleDeltaTimer();
    }, state.deltaTimerTime);
  };

  // ── Configuration file watchers ──

  /**
   * Creates a debounced file change handler with content hash deduplication
   */
  function createDebouncedConfigHandler(name, getFilePath, processConfig, options = {}) {
    return function handleChange() {
      clearTimeout(state.configDebounceTimers[name]);
      state.configDebounceTimers[name] = setTimeout(async () => {
        try {
          let content;
          if (options.readFallback !== undefined) {
            content = await readFile(getFilePath(), "utf-8").catch(() => null);
          } else {
            content = await readFile(getFilePath(), "utf-8");
          }

          const hashSource = content || JSON.stringify(options.readFallback);
          const contentHash = crypto.createHash(CONTENT_HASH_ALGORITHM).update(hashSource).digest("hex");

          if (contentHash === state.configContentHashes[name]) {
            app.debug(`${name} file change detected but content unchanged, skipping`);
            return;
          }
          state.configContentHashes[name] = contentHash;

          const parsed = content ? JSON.parse(content) : options.readFallback;
          await processConfig(parsed);
        } catch (err) {
          app.error(`Error handling ${name.toLowerCase()} change: ${err.message}`);
        }
      }, FILE_WATCH_DEBOUNCE_DELAY);
    };
  }

  // Delta timer change handler
  const handleDeltaTimerChange = createDebouncedConfigHandler(
    "Delta timer",
    () => state.deltaTimerFile,
    (config) => {
      if (config && config.deltaTimer) {
        const newTimerValue = config.deltaTimer;
        if (newTimerValue >= 100 && newTimerValue <= 10000) {
          if (state.deltaTimerTime !== newTimerValue) {
            state.deltaTimerTime = newTimerValue;
            clearTimeout(state.deltaTimer);
            scheduleDeltaTimer();
            app.debug(`Delta timer updated to ${state.deltaTimerTime}ms`);
          }
        } else {
          app.error(`Invalid delta timer value: ${newTimerValue}. Must be between 100 and 10000ms`);
        }
      }
    }
  );

  // Subscription change handler
  const handleSubscriptionChange = createDebouncedConfigHandler(
    "Subscription",
    () => state.subscriptionFile,
    (config) => {
      state.localSubscription = config;
      app.debug("Subscription configuration updated");
      app.debug(state.localSubscription);

      state.unsubscribes.forEach((f) => f());
      state.unsubscribes = [];

      try {
        app.subscriptionmanager.subscribe(
          state.localSubscription,
          state.unsubscribes,
          (subscriptionError) => {
            app.error("Subscription error: " + subscriptionError);
            state.readyToSend = false;
            setStatus("Subscription error - data transmission paused");
            recordError("subscription", `Subscription error: ${subscriptionError}`);
          },
          (delta) => {
            if (state.readyToSend) {
              const sentence = delta?.updates?.[0]?.source?.sentence;
              if (sentence && state.excludedSentences.includes(sentence)) {
                return;
              }

              if (state.deltas.length >= MAX_DELTAS_BUFFER_SIZE) {
                app.error(`Delta buffer overflow (${state.deltas.length} items), clearing buffer`);
                state.deltas = [];
              }

              state.deltas.push(delta);
              setImmediate(() => app.reportOutputMessages());

              const batchReady = state.deltas.length >= state.maxDeltasPerBatch;
              if (batchReady || state.timer) {
                if (batchReady) {
                  app.debug(
                    `Smart batch: sending ${state.deltas.length} deltas (reached predicted limit of ${state.maxDeltasPerBatch})`
                  );
                  metrics.smartBatching.earlySends++;
                } else {
                  metrics.smartBatching.timerSends++;
                }
                if (state.pipeline) {
                  state.pipeline.sendDelta(state.deltas, state.options.secretKey, state.options.udpAddress, state.options.udpPort);
                } else {
                  pipeline.packCrypt(state.deltas, state.options.secretKey, state.options.udpAddress, state.options.udpPort);
                }
                state.deltas = [];
                state.timer = false;
              }
            }
          }
        );
      } catch (subscribeError) {
        app.error(`Failed to subscribe: ${subscribeError.message}`);
        state.readyToSend = false;
        setStatus("Failed to subscribe - data transmission paused");
        recordError("subscription", `Failed to subscribe: ${subscribeError.message}`);
      }
    },
    { readFallback: { context: "*", subscribe: [{ path: "*" }] } }
  );

  // Sentence filter change handler
  const handleSentenceFilterChange = createDebouncedConfigHandler(
    "Sentence filter",
    () => state.sentenceFilterFile,
    (config) => {
      if (config && Array.isArray(config.excludedSentences)) {
        state.excludedSentences = config.excludedSentences
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => s.length > 0);
        app.debug(`Sentence filter updated: excluding [${state.excludedSentences.join(", ")}]`);
      } else {
        app.error("Invalid sentence filter configuration: excludedSentences must be an array");
      }
    }
  );

  /**
   * Creates a file watcher with automatic recovery on error
   */
  function createWatcherWithRecovery(filePath, onChange, name) {
    const watcherObj = { watcher: null };

    function createWatcher() {
      try {
        watcherObj.watcher = watch(filePath, (eventType) => {
          if (eventType === "change") {
            app.debug(`${name} configuration file changed`);
            onChange();
          }
        });

        watcherObj.watcher.on("error", (error) => {
          app.error(`${name} watcher error: ${error.message}`);
          if (watcherObj.watcher) {
            watcherObj.watcher.close();
            watcherObj.watcher = null;
          }
          watcherObj.recoveryTimer = setTimeout(() => {
            watcherObj.recoveryTimer = null;
            app.debug(`Attempting to recreate ${name} watcher...`);
            createWatcher();
            if (watcherObj.watcher) {
              app.debug(`${name} watcher recreated successfully`);
            }
          }, WATCHER_RECOVERY_DELAY);
        });

        return true;
      } catch (err) {
        app.error(`Failed to create ${name} watcher: ${err.message}`);
        return false;
      }
    }

    createWatcher();

    return {
      get watcher() { return watcherObj.watcher; },
      close() {
        if (watcherObj.recoveryTimer) {
          clearTimeout(watcherObj.recoveryTimer);
          watcherObj.recoveryTimer = null;
        }
        if (watcherObj.watcher) {
          watcherObj.watcher.close();
          watcherObj.watcher = null;
        }
      }
    };
  }

  /**
   * Sets up file system watchers for configuration files
   */
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

      handleSubscriptionChange();
      app.debug("Configuration file watchers initialized");
    } catch (err) {
      app.error(`Error setting up config watchers: ${err.message}`);
      app.error("Falling back to polling mode would require manual intervention");
    }
  }

  // ── Persistent storage initialization ──

  async function initializePersistentStorage() {
    state.deltaTimerFile = join(app.getDataDirPath(), "delta_timer.json");
    state.subscriptionFile = join(app.getDataDirPath(), "subscription.json");
    state.sentenceFilterFile = join(app.getDataDirPath(), "sentence_filter.json");

    const defaults = [
      { file: state.deltaTimerFile, data: { deltaTimer: DEFAULT_DELTA_TIMER }, name: "delta_timer.json" },
      { file: state.subscriptionFile, data: { context: "*", subscribe: [{ path: "*" }] }, name: "subscription.json" },
      { file: state.sentenceFilterFile, data: { excludedSentences: ["GSV"] }, name: "sentence_filter.json" }
    ];

    for (const { file, data, name } of defaults) {
      const existing = await routes.loadConfigFile(file);
      if (!existing) {
        await routes.saveConfigFile(file, data);
        app.debug(`Initialized ${name} with default values`);
      } else if (name === "sentence_filter.json") {
        state.excludedSentences = existing.excludedSentences || ["GSV"];
      }
    }
  }

  // ── Router registration (called before start) ──

  plugin.registerWithRouter = (router) => {
    routes.registerWithRouter(router);
  };

  // ── Plugin lifecycle ──

  plugin.start = async function (options, restartPlugin) {
    state.options = options;
    state.restartPlugin = restartPlugin;

    // Start rate limit cleanup
    routes.startRateLimitCleanup();

    // Validate required options
    try {
      validateSecretKey(options.secretKey);
    } catch (error) {
      app.error(`Secret key validation failed: ${error.message}`);
      setStatus(`Secret key validation failed: ${error.message}`);
      return;
    }

    if (!options.udpPort || options.udpPort < 1024 || options.udpPort > 65535) {
      app.error("UDP port must be between 1024 and 65535");
      setStatus("UDP port validation failed");
      return;
    }

    if (options.serverType === true || options.serverType === "server") {
      // ── Server mode ──
      state.isServerMode = true;
      app.debug("SignalK data connector server started");
      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err) => {
        app.error(`UDP socket error: ${err.message}`);
        state.readyToSend = false;
        if (err.code === "EADDRINUSE") {
          setStatus(`Failed to start - port ${options.udpPort} already in use`);
        } else if (err.code === "EACCES") {
          setStatus(`Failed to start - permission denied for port ${options.udpPort}`);
        } else {
          setStatus(`UDP socket error: ${err.code || err.message}`);
        }
        if (state.socketUdp) {
          state.socketUdp.close();
          state.socketUdp = null;
        }
      });

      state.socketUdp.on("listening", () => {
        const address = state.socketUdp.address();
        app.debug(`UDP server listening on ${address.address}:${address.port}`);
        setStatus(`Server listening on port ${address.port}`);
        state.readyToSend = true;
      });

      const useV2Server = options.protocolVersion === 2;
      if (useV2Server) {
        const v2Server = createPipelineV2Server(app, state, metricsApi);
        state.pipelineServer = v2Server;

        state.socketUdp.on("message", (packet, rinfo) => {
          v2Server.receivePacket(packet, options.secretKey, rinfo);
        });

        // Start ACK timer and metrics publishing after binding
        state.socketUdp.on("listening", () => {
          v2Server.startACKTimer();
          v2Server.startMetricsPublishing();
          app.debug("[v2] Server pipeline with ACK/NAK initialized");
        });
      } else {
        state.socketUdp.on("message", (delta) => {
          pipeline.unpackDecrypt(delta, options.secretKey);
        });
        app.debug("[v1] Server pipeline initialized (standard encrypted UDP)");
      }

      state.socketUdp.bind(options.udpPort, (err) => {
        if (err) {
          app.error(`Failed to bind to port ${options.udpPort}: ${err.message}`);
          setStatus(`Failed to start - ${err.message}`);
        }
      });
    } else {
      // ── Client mode ──
      state.isServerMode = false;
      await initializePersistentStorage();

      const deltaTimerTimeFile = await routes.loadConfigFile(state.deltaTimerFile);
      state.deltaTimerTime = deltaTimerTimeFile ? deltaTimerTimeFile.deltaTimer : DEFAULT_DELTA_TIMER;

      // Hello message sender with smart suppression
      const helloInterval = options.helloMessageSender * 1000;
      state.helloMessageSender = setInterval(async () => {
        const timeSinceLastPacket = Date.now() - state.lastPacketTime;

        if (!state.readyToSend) {
          app.debug("Skipping hello message (not ready to send)");
        } else if (timeSinceLastPacket >= helloInterval) {
          const fixedDelta = {
            context: "vessels.urn:mrn:imo:mmsi:" + app.getSelfPath("mmsi"),
            updates: [{ timestamp: new Date(), values: [] }]
          };
          app.debug("Sending hello message (no recent data transmission)");
          if (state.pipeline) {
            await state.pipeline.sendDelta([fixedDelta], options.secretKey, options.udpAddress, options.udpPort);
          } else {
            await pipeline.packCrypt([fixedDelta], options.secretKey, options.udpAddress, options.udpPort);
          }
        } else {
          app.debug(`Skipping hello message (last packet ${timeSinceLastPacket}ms ago)`);
        }
      }, helloInterval);

      state.socketUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

      state.socketUdp.on("error", (err) => {
        app.error(`Client UDP socket error: ${err.message}`);
        setStatus(`UDP socket error: ${err.code || err.message}`);
      });

      scheduleDeltaTimer();
      setupConfigWatchers();

      // Ping monitor
      state.pingMonitor = new Monitor({
        address: options.testAddress,
        port: options.testPort,
        interval: options.pingIntervalTime,
        protocol: "tcp"
      });

      state.pingMonitor.on("up", function (res) {
        handlePingSuccess(res, "up", options.pingIntervalTime);
      });

      state.pingMonitor.on("restored", function (res) {
        handlePingSuccess(res, "restored", options.pingIntervalTime);
      });

      for (const event of ["down", "stop", "timeout"]) {
        state.pingMonitor.on(event, function () {
          state.readyToSend = false;
          app.debug(`Connection monitor: ${event === "stop" ? "stopped" : event}`);
        });
      }

      state.pingMonitor.on("error", function (error) {
        state.readyToSend = false;
        if (error) {
          const errorMessage =
            error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
              ? `Could not resolve address ${options.testAddress}. Check hostname.`
              : `Connection monitor error: ${error.message || error}`;
          app.debug(errorMessage);
        }
      });

      state.pingTimeout = setTimeout(
        () => { state.readyToSend = false; },
        options.pingIntervalTime * MILLISECONDS_PER_MINUTE + PING_TIMEOUT_BUFFER
      );

      // Initialize v2 client pipeline when protocolVersion is 2
      const useV2 = options.protocolVersion === 2;

      if (useV2) {
        // Initialize enhanced monitoring (v2 only)
        state.monitoring = {
          packetLossTracker: new PacketLossTracker(),
          pathLatencyTracker: new PathLatencyTracker(),
          retransmissionTracker: new RetransmissionTracker(),
          alertManager: new AlertManager(app, options.alertThresholds || {}),
          packetCapture: new PacketCapture(),
          packetInspector: new PacketInspector()
        };
        app.debug("[v2] Enhanced monitoring initialized");

        const v2Pipeline = createPipelineV2Client(app, state, metricsApi);
        state.pipeline = v2Pipeline;

        // Connect monitoring hooks to pipeline
        v2Pipeline.setMonitoring(state.monitoring);

        // Start metrics publishing
        v2Pipeline.startMetricsPublishing();

        // Start congestion control if enabled
        if (options.congestionControl && options.congestionControl.enabled) {
          v2Pipeline.startCongestionControl();
        }

        // Start NAT keepalive heartbeat
        state.heartbeatHandle = v2Pipeline.startHeartbeat(options.udpAddress, options.udpPort);

        // Listen for ACK/NAK control packets from server
        state.socketUdp.on("message", (msg, rinfo) => {
          v2Pipeline.handleControlPacket(msg, rinfo);
        });

        // Initialize bonding if enabled
        if (options.bonding && options.bonding.enabled) {
          const bondingConfig = {
            mode: options.bonding.mode || "main-backup",
            primary: options.bonding.primary || { address: options.udpAddress, port: options.udpPort },
            backup: options.bonding.backup || { address: options.udpAddress, port: options.udpPort + 1 },
            failover: options.bonding.failover || {}
          };

          try {
            await v2Pipeline.initBonding(bondingConfig);
            app.debug("[Bonding] Connection bonding initialized");
          } catch (err) {
            app.error(`[Bonding] Failed to initialize: ${err.message}`);
          }
        }

        app.debug("[v2] Protocol v2 client pipeline initialized");
      } else {
        // v1 mode - warn if v2-only features are configured
        if (options.congestionControl && options.congestionControl.enabled) {
          app.error("[v1] Congestion control requires Protocol v2 - ignoring congestionControl setting");
        }
        if (options.bonding && options.bonding.enabled) {
          app.error("[v1] Connection bonding requires Protocol v2 - ignoring bonding setting");
        }
        app.debug("[v1] Client pipeline initialized (standard encrypted UDP)");
      }
    }
  };

  plugin.stop = function stop() {
    // Unsubscribe from SignalK subscriptions
    state.unsubscribes.forEach((f) => f());
    state.unsubscribes = [];
    state.localSubscription = null;
    state.options = null;

    // Reset state variables for clean restart
    state.isServerMode = false;
    state.readyToSend = false;
    state.deltas = [];
    Object.keys(state.configContentHashes).forEach((k) => delete state.configContentHashes[k]);
    state.excludedSentences = ["GSV"];
    state.lastPacketTime = 0;

    // Reset metrics for fresh start
    resetMetrics();

    // Stop rate limiting
    routes.stopRateLimitCleanup();

    // Clear intervals and timeouts
    clearInterval(state.helloMessageSender);
    clearTimeout(state.pingTimeout);
    clearTimeout(state.deltaTimer);
    Object.keys(state.configDebounceTimers).forEach((k) => {
      clearTimeout(state.configDebounceTimers[k]);
      delete state.configDebounceTimers[k];
    });

    // Stop file system watchers
    state.configWatcherObjects.forEach((w) => w.close());
    state.configWatcherObjects = [];
    app.debug("Configuration file watchers closed");

    // Stop v2 client pipeline (bonding, metrics, congestion, heartbeat)
    if (state.pipeline) {
      if (state.pipeline.stopBonding) { state.pipeline.stopBonding(); }
      if (state.pipeline.stopMetricsPublishing) { state.pipeline.stopMetricsPublishing(); }
      if (state.pipeline.stopCongestionControl) { state.pipeline.stopCongestionControl(); }
      state.pipeline = null;
    }
    if (state.heartbeatHandle) {
      state.heartbeatHandle.stop();
      state.heartbeatHandle = null;
    }

    // Stop v2 server pipeline (ACK timer, metrics, sequence tracker)
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
      if (state.monitoring.packetCapture) {state.monitoring.packetCapture.reset();}
      if (state.monitoring.packetInspector) {state.monitoring.packetInspector.reset();}
      if (state.monitoring.alertManager) {state.monitoring.alertManager.reset();}
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
      app.debug("SignalK data connector stopped");
      state.socketUdp.close();
      state.socketUdp = null;
    }
  };

  // Schema using RJSF dependencies with oneOf for conditional field visibility
  // Client-only fields appear ONLY when serverType is "client"
  // Based on: https://rjsf-team.github.io/react-jsonschema-form/docs/json-schema/dependencies/
  plugin.schema = {
    type: "object",
    title: "SignalK Edge Link",
    description: "Configure encrypted UDP data transmission between SignalK units",
    required: ["serverType", "udpPort", "secretKey"],
    properties: {
      serverType: {
        type: "string",
        title: "Operation Mode",
        description: "Select Server to receive data, or Client to send data",
        default: "client",
        oneOf: [
          { const: "server", title: "Server Mode - Receive Data" },
          { const: "client", title: "Client Mode - Send Data" }
        ]
      },
      udpPort: {
        type: "number",
        title: "UDP Port",
        description: "UDP port for data transmission (must match on both ends)",
        default: 4446,
        minimum: 1024,
        maximum: 65535
      },
      secretKey: {
        type: "string",
        title: "Encryption Key",
        description: "32-character secret key (must match on both ends)",
        minLength: 32,
        maxLength: 32
      },
      useMsgpack: {
        type: "boolean",
        title: "Use MessagePack",
        description: "Binary serialization for smaller payloads (must match on both ends)",
        default: false
      },
      usePathDictionary: {
        type: "boolean",
        title: "Use Path Dictionary",
        description: "Encode paths as numeric IDs for bandwidth savings (must match on both ends)",
        default: false
      },
      protocolVersion: {
        type: "number",
        title: "Protocol Version",
        description: "v1: encrypted UDP transmission. v2 adds: packet reliability (sequence tracking, ACK/NAK, retransmission), congestion control, connection bonding with failover, metrics/monitoring, and NAT keepalive. Must match on both ends.",
        default: 1,
        oneOf: [
          { const: 1, title: "v1 - Standard encrypted UDP" },
          { const: 2, title: "v2 - Reliability, congestion control, bonding, metrics" }
        ]
      }
    },
    dependencies: {
      serverType: {
        oneOf: [
          {
            properties: {
              serverType: { enum: ["server"] }
            }
          },
          {
            properties: {
              serverType: { enum: ["client"] },
              udpAddress: {
                type: "string",
                title: "Server Address",
                description: "IP address or hostname of the SignalK server",
                default: "127.0.0.1"
              },
              helloMessageSender: {
                type: "integer",
                title: "Heartbeat Interval (seconds)",
                description: "How often to send heartbeat messages",
                default: 60,
                minimum: 10,
                maximum: 3600
              },
              testAddress: {
                type: "string",
                title: "Connectivity Test Address",
                description: "Address to ping for network testing (e.g., 8.8.8.8)",
                default: "127.0.0.1"
              },
              testPort: {
                type: "number",
                title: "Connectivity Test Port",
                description: "Port for connectivity test (80, 443, 53)",
                default: 80,
                minimum: 1,
                maximum: 65535
              },
              pingIntervalTime: {
                type: "number",
                title: "Check Interval (minutes)",
                description: "How often to test network connectivity",
                default: 1,
                minimum: 0.1,
                maximum: 60
              },
              congestionControl: {
                type: "object",
                title: "Dynamic Congestion Control (v2 only)",
                description: "Requires Protocol v2. AIMD algorithm to dynamically adjust send rate based on network conditions",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enable Congestion Control",
                    description: "Automatically adjust delta timer based on RTT and packet loss",
                    default: false
                  },
                  targetRTT: {
                    type: "number",
                    title: "Target RTT (ms)",
                    description: "RTT threshold above which send rate is reduced",
                    default: 200,
                    minimum: 50,
                    maximum: 2000
                  },
                  minDeltaTimer: {
                    type: "number",
                    title: "Minimum Delta Timer (ms)",
                    description: "Fastest allowed send interval",
                    default: 100,
                    minimum: 50,
                    maximum: 1000
                  },
                  maxDeltaTimer: {
                    type: "number",
                    title: "Maximum Delta Timer (ms)",
                    description: "Slowest allowed send interval",
                    default: 5000,
                    minimum: 1000,
                    maximum: 30000
                  }
                }
              },
              bonding: {
                type: "object",
                title: "Connection Bonding (v2 only)",
                description: "Requires Protocol v2. Dual-link bonding with automatic failover between primary and backup connections",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enable Connection Bonding",
                    description: "Enable dual-link bonding with automatic failover",
                    default: false
                  },
                  mode: {
                    type: "string",
                    title: "Bonding Mode",
                    description: "Bonding operating mode",
                    default: "main-backup",
                    oneOf: [
                      { const: "main-backup", title: "Main/Backup - Failover to backup when primary degrades" }
                    ]
                  },
                  primary: {
                    type: "object",
                    title: "Primary Link",
                    description: "Primary connection (e.g., LTE modem)",
                    properties: {
                      address: {
                        type: "string",
                        title: "Server Address",
                        description: "IP address or hostname of the server for primary link",
                        default: "127.0.0.1"
                      },
                      port: {
                        type: "number",
                        title: "UDP Port",
                        description: "UDP port for primary link",
                        default: 4446,
                        minimum: 1024,
                        maximum: 65535
                      },
                      interface: {
                        type: "string",
                        title: "Bind Interface (optional)",
                        description: "Network interface IP to bind to (e.g., 192.168.1.100)"
                      }
                    }
                  },
                  backup: {
                    type: "object",
                    title: "Backup Link",
                    description: "Backup connection (e.g., Starlink, satellite)",
                    properties: {
                      address: {
                        type: "string",
                        title: "Server Address",
                        description: "IP address or hostname of the server for backup link",
                        default: "127.0.0.1"
                      },
                      port: {
                        type: "number",
                        title: "UDP Port",
                        description: "UDP port for backup link",
                        default: 4447,
                        minimum: 1024,
                        maximum: 65535
                      },
                      interface: {
                        type: "string",
                        title: "Bind Interface (optional)",
                        description: "Network interface IP to bind to (e.g., 10.0.0.100)"
                      }
                    }
                  },
                  failover: {
                    type: "object",
                    title: "Failover Thresholds",
                    description: "Configure when failover is triggered",
                    properties: {
                      rttThreshold: {
                        type: "number",
                        title: "RTT Threshold (ms)",
                        description: "Failover when RTT exceeds this value",
                        default: 500,
                        minimum: 100,
                        maximum: 5000
                      },
                      lossThreshold: {
                        type: "number",
                        title: "Packet Loss Threshold",
                        description: "Failover when loss exceeds this ratio (0.0 - 1.0)",
                        default: 0.1,
                        minimum: 0.01,
                        maximum: 0.5
                      },
                      healthCheckInterval: {
                        type: "number",
                        title: "Health Check Interval (ms)",
                        description: "How often to check link health",
                        default: 1000,
                        minimum: 500,
                        maximum: 10000
                      },
                      failbackDelay: {
                        type: "number",
                        title: "Failback Delay (ms)",
                        description: "Wait time before switching back to primary after recovery",
                        default: 30000,
                        minimum: 5000,
                        maximum: 300000
                      }
                    }
                  }
                }
              }
            },
            required: ["udpAddress", "testAddress", "testPort"]
          }
        ]
      }
    }
  };

  return plugin;
};
