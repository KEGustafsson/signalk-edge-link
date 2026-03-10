"use strict";

import createRoutes = require("./lib/routes");
import { createInstance, slugify } from "./lib/instance";
import type { ConnectionConfig } from "./lib/types";

const pkg = require("./package.json");

module.exports = function createPlugin(app: any) {
  const plugin: any = {};
  plugin.id = pkg.name;
  plugin.name = "Signal K Edge Link";
  plugin.description = pkg.description;

  // ── Instance registry ────────────────────────────────────────────────────
  // Map<instanceId, instanceObject> — populated in plugin.start()
  const instances = new Map<string, any>();

  /**
   * Instance registry object passed to routes so that route handlers can
   * look up per-instance state/metricsApi at request time (after start).
   */
  const instanceRegistry = {
    /** Get a bundle by instance ID. Returns null if not found. */
    get(id: string) {
      const inst = instances.get(id);
      if (!inst) {
        return null;
      }
      return {
        id: inst.getId(),
        name: inst.getName(),
        state: inst.getState(),
        metricsApi: inst.getMetricsApi()
      };
    },
    /** Get the first (or only) instance bundle, for backward-compat routes. */
    getFirst() {
      const first = instances.values().next().value;
      if (!first) {
        return null;
      }
      return {
        id: first.getId(),
        name: first.getName(),
        state: first.getState(),
        metricsApi: first.getMetricsApi()
      };
    },
    /** Get all instance bundles (for /connections listing). */
    getAll() {
      return [...instances.values()].map((inst) => ({
        id: inst.getId(),
        name: inst.getName(),
        state: inst.getState(),
        metricsApi: inst.getMetricsApi()
      }));
    }
  };

  // Routes are created once at module init (before start) because
  // registerWithRouter is called by Signal K before start().
  const routes = createRoutes(app, instanceRegistry, plugin);

  // ── Status aggregation ───────────────────────────────────────────────────
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});

  function updateAggregatedStatus() {
    const all = [...instances.values()];
    if (all.length === 0) {
      setStatus("No connections configured");
      return;
    }
    const healthy = all.filter((inst: any) => inst.getStatus().healthy).length;
    if (healthy === all.length) {
      setStatus(all.length === 1 ? all[0].getStatus().text : `${all.length} connections active`);
    } else {
      const details = all
        .filter((inst: any) => !inst.getStatus().healthy)
        .map((inst: any) => `${inst.getName()}: ${inst.getStatus().text}`)
        .join("; ");
      setStatus(`${healthy}/${all.length} active — ${details}`);
    }
  }

  // ── Instance ID generation (with collision disambiguation) ───────────────
  function generateInstanceId(name: string | undefined, usedIds: Set<string>): string {
    const base = slugify(name || "connection");
    if (!usedIds.has(base)) {
      return base;
    }
    let n = 1;
    while (usedIds.has(`${base}-${n}`)) {
      n++;
    }
    return `${base}-${n}`;
  }

  // ── Plugin lifecycle ─────────────────────────────────────────────────────

  plugin.registerWithRouter = (router: any) => {
    routes.registerWithRouter(router);
  };

  plugin.start = async function start(options: any = {}, restartPlugin?: Function) {
    plugin._currentOptions = options;
    // Store restartPlugin on the plugin itself so any route handler can access it
    // regardless of how many instances are running.
    plugin._restartPlugin = typeof restartPlugin === "function" ? restartPlugin : null;

    // If start() is called again without an explicit stop(), tear down existing
    // instances first to avoid orphaned sockets and stale pipelines.
    if (instances.size > 0) {
      for (const instance of instances.values()) {
        instance.stop();
      }
      instances.clear();
    }

    // ── Parse connections array (supports both legacy flat and new array format)
    let connectionList: ConnectionConfig[];
    if (Array.isArray(options.connections) && options.connections.length > 0) {
      connectionList = options.connections;
    } else if (options.serverType) {
      // Legacy flat config: wrap as single "default" connection
      connectionList = [{ ...options, name: options.name || "default" }];
    } else {
      app.error("No connections configured. Add at least one connection.");
      setStatus("No connections configured");
      return;
    }

    // ── Port collision detection (server mode) ────────────────────────────
    const serverPorts = connectionList
      .filter((c) => c.serverType === "server" || (c.serverType as any) === true)
      .map((c) => c.udpPort);
    const duplicatePorts = serverPorts.filter((p, i) => serverPorts.indexOf(p) !== i);
    if (duplicatePorts.length > 0) {
      app.error(
        `Duplicate server ports detected: ${[...new Set(duplicatePorts)].join(", ")}. ` +
          "Each server instance must use a unique UDP port."
      );
      setStatus("Configuration error: duplicate server ports");
      return;
    }

    // ── Start rate limiting ───────────────────────────────────────────────
    routes.startRateLimitCleanup();

    // ── Create and start instances ────────────────────────────────────────
    const usedIds = new Set<string>();
    for (const cfg of connectionList) {
      const instanceId = generateInstanceId(cfg.name, usedIds);
      usedIds.add(instanceId);

      const instance = createInstance(
        app,
        cfg,
        instanceId,
        plugin.id,
        (_id: string, _msg: string) => {
          // Per-instance status change → re-aggregate global status
          updateAggregatedStatus();
        }
      );

      instances.set(instanceId, instance);
    }

    // Start all instances concurrently.
    // On any failure, stop everything to avoid a half-started state.
    try {
      await Promise.all([...instances.values()].map((inst) => inst.start()));
    } catch (err: any) {
      app.error(`Failed to start one or more connections: ${err.message}`);
      plugin.stop();
      setStatus(`Startup failed: ${err.message}`);
      return;
    }

    // Initial status aggregation after all instances report their status
    updateAggregatedStatus();
  };

  plugin.stop = function stop() {
    plugin._restartPlugin = null; // Clear to prevent stale calls after stop
    plugin._currentOptions = null;
    routes.stopRateLimitCleanup();
    for (const instance of instances.values()) {
      instance.stop();
    }
    instances.clear();
    setStatus("Stopped");
  };

  // ── Schema (array-based) ─────────────────────────────────────────────────
  //
  // Each item in the `connections` array is a full connection configuration.
  // The schema retains complete backward-compat: Signal K's RJSF renderer
  // renders arrays as an add/remove list automatically.
  //
  // Client-only fields are shown via `dependencies` on `serverType`, matching
  // the original single-connection schema pattern.

  const connectionItemSchema = {
    type: "object",
    title: "Connection",
    required: ["serverType", "udpPort", "secretKey"],
    properties: {
      name: {
        type: "string",
        title: "Connection Name",
        description:
          "Human-readable label for this connection (e.g. 'Shore Server', 'Sat Client'). Used to namespace config files and Signal K metrics paths.",
        default: "connection",
        maxLength: 40
      },
      serverType: {
        type: "string",
        title: "Operation Mode",
        description: "Select Server to receive data, or Client to send data",
        default: "client",
        oneOf: [
          { const: "server", title: "Server Mode – Receive Data" },
          { const: "client", title: "Client Mode – Send Data" }
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
        description:
          "32-byte secret key: 32-character ASCII, 64-character hex, or 44-character base64",
        minLength: 32,
        maxLength: 64,
        pattern: "^(?:.{32}|[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$"
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
        description:
          "v1: encrypted UDP. v2 adds reliable delivery and metrics. v3 keeps the v2 data path and authenticates control packets (ACK/NAK/HEARTBEAT/HELLO). Must match on both ends.",
        default: 1,
        oneOf: [
          { const: 1, title: "v1 – Standard encrypted UDP" },
          { const: 2, title: "v2 – Reliability, congestion control, bonding, metrics" },
          { const: 3, title: "v3 - v2 features with authenticated control packets" }
        ]
      }
    },
    dependencies: {
      serverType: {
        oneOf: [
          {
            properties: {
              serverType: { enum: ["server"] },
              reliability: {
                type: "object",
                title: "Reliability Settings (v2/v3 only)",
                description:
                  "Requires Protocol v2 or v3. Controls ACK/NAK timing for reliable delivery",
                properties: {
                  ackInterval: {
                    type: "number",
                    title: "ACK Interval (ms)",
                    description: "How often server sends cumulative ACK updates",
                    default: 100,
                    minimum: 20,
                    maximum: 5000
                  },
                  ackResendInterval: {
                    type: "number",
                    title: "ACK Resend Interval (ms)",
                    description:
                      "Re-send duplicate ACK periodically to recover from lost ACK packets",
                    default: 1000,
                    minimum: 100,
                    maximum: 10000
                  },
                  nakTimeout: {
                    type: "number",
                    title: "NAK Timeout (ms)",
                    description:
                      "Delay before requesting retransmission for missing sequence numbers",
                    default: 100,
                    minimum: 20,
                    maximum: 5000
                  }
                }
              }
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
              reliability: {
                type: "object",
                title: "Reliability Settings (v2/v3 only)",
                description:
                  "Requires Protocol v2 or v3. Controls retransmit queue behavior and packet retry limits",
                properties: {
                  retransmitQueueSize: {
                    type: "number",
                    title: "Retransmit Queue Size",
                    description:
                      "Maximum number of sent packets stored for potential retransmission",
                    default: 5000,
                    minimum: 100,
                    maximum: 50000
                  },
                  maxRetransmits: {
                    type: "number",
                    title: "Max Retransmit Attempts",
                    description:
                      "Maximum resend attempts before a packet is dropped from the retransmit queue",
                    default: 3,
                    minimum: 1,
                    maximum: 20
                  },
                  retransmitMaxAge: {
                    type: "number",
                    title: "Retransmit Max Age (ms)",
                    description: "Expire stale unacknowledged packets older than this age",
                    default: 120000,
                    minimum: 1000,
                    maximum: 300000
                  },
                  retransmitMinAge: {
                    type: "number",
                    title: "Retransmit Min Age (ms)",
                    description: "Minimum packet age before expiration is allowed",
                    default: 10000,
                    minimum: 200,
                    maximum: 30000
                  },
                  retransmitRttMultiplier: {
                    type: "number",
                    title: "RTT Expiry Multiplier",
                    description: "Dynamic expiry age is adjusted to RTT x this multiplier",
                    default: 12,
                    minimum: 2,
                    maximum: 20
                  },
                  ackIdleDrainAge: {
                    type: "number",
                    title: "ACK Idle Drain Age (ms)",
                    description:
                      "If ACKs are idle longer than this, expiry becomes more aggressive",
                    default: 20000,
                    minimum: 500,
                    maximum: 30000
                  },
                  forceDrainAfterAckIdle: {
                    type: "boolean",
                    title: "Force Drain After ACK Idle",
                    description:
                      "When enabled, clear retransmit queue if no ACKs arrive for too long",
                    default: false
                  },
                  forceDrainAfterMs: {
                    type: "number",
                    title: "Force Drain Timeout (ms)",
                    description: "ACK idle duration before force-draining retransmit queue to zero",
                    default: 45000,
                    minimum: 2000,
                    maximum: 120000
                  },
                  recoveryBurstEnabled: {
                    type: "boolean",
                    title: "Recovery Burst Enabled",
                    description:
                      "When ACKs return after outage, rapidly retransmit queued packets to catch up",
                    default: true
                  },
                  recoveryBurstSize: {
                    type: "number",
                    title: "Recovery Burst Size",
                    description: "Max queued packets to retransmit per recovery burst cycle",
                    default: 100,
                    minimum: 10,
                    maximum: 1000
                  },
                  recoveryBurstIntervalMs: {
                    type: "number",
                    title: "Recovery Burst Interval (ms)",
                    description: "Interval between recovery burst cycles while backlog exists",
                    default: 200,
                    minimum: 50,
                    maximum: 5000
                  },
                  recoveryAckGapMs: {
                    type: "number",
                    title: "Recovery ACK Gap (ms)",
                    description: "Minimum ACK silence before triggering fast recovery bursts",
                    default: 4000,
                    minimum: 500,
                    maximum: 120000
                  }
                }
              },
              congestionControl: {
                type: "object",
                title: "Dynamic Congestion Control (v2/v3 only)",
                description:
                  "Requires Protocol v2 or v3. AIMD algorithm to dynamically adjust send rate based on network conditions",
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
                  nominalDeltaTimer: {
                    type: "number",
                    title: "Nominal Delta Timer (ms)",
                    description: "Preferred steady-state send interval",
                    default: 1000,
                    minimum: 100,
                    maximum: 10000
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
                title: "Connection Bonding (v2/v3 only)",
                description:
                  "Requires Protocol v2 or v3. Dual-link bonding with automatic failover between primary and backup connections",
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
                      {
                        const: "main-backup",
                        title: "Main/Backup – Failover to backup when primary degrades"
                      }
                    ]
                  },
                  primary: {
                    type: "object",
                    title: "Primary Link",
                    description: "Primary connection (e.g., LTE modem)",
                    properties: {
                      address: { type: "string", title: "Server Address", default: "127.0.0.1" },
                      port: {
                        type: "number",
                        title: "UDP Port",
                        default: 4446,
                        minimum: 1024,
                        maximum: 65535
                      },
                      interface: { type: "string", title: "Bind Interface (optional)" }
                    }
                  },
                  backup: {
                    type: "object",
                    title: "Backup Link",
                    description: "Backup connection (e.g., Starlink, satellite)",
                    properties: {
                      address: { type: "string", title: "Server Address", default: "127.0.0.1" },
                      port: {
                        type: "number",
                        title: "UDP Port",
                        default: 4447,
                        minimum: 1024,
                        maximum: 65535
                      },
                      interface: { type: "string", title: "Bind Interface (optional)" }
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
                        default: 500,
                        minimum: 100,
                        maximum: 5000
                      },
                      lossThreshold: {
                        type: "number",
                        title: "Packet Loss Threshold",
                        default: 0.1,
                        minimum: 0.01,
                        maximum: 0.5
                      },
                      healthCheckInterval: {
                        type: "number",
                        title: "Health Check Interval (ms)",
                        default: 1000,
                        minimum: 500,
                        maximum: 10000
                      },
                      failbackDelay: {
                        type: "number",
                        title: "Failback Delay (ms)",
                        default: 30000,
                        minimum: 5000,
                        maximum: 300000
                      },
                      heartbeatTimeout: {
                        type: "number",
                        title: "Heartbeat Timeout (ms)",
                        default: 5000,
                        minimum: 1000,
                        maximum: 30000
                      }
                    }
                  }
                }
              },
              alertThresholds: {
                type: "object",
                title: "Monitoring Alert Thresholds (v2/v3 only)",
                description: "Customize warning/critical thresholds for network monitoring alerts",
                properties: {
                  rtt: {
                    type: "object",
                    title: "RTT Thresholds",
                    properties: {
                      warning: { type: "number", title: "Warning RTT (ms)", default: 300 },
                      critical: { type: "number", title: "Critical RTT (ms)", default: 800 }
                    }
                  },
                  packetLoss: {
                    type: "object",
                    title: "Packet Loss Thresholds",
                    properties: {
                      warning: { type: "number", title: "Warning Loss Ratio", default: 0.03 },
                      critical: { type: "number", title: "Critical Loss Ratio", default: 0.1 }
                    }
                  },
                  retransmitRate: {
                    type: "object",
                    title: "Retransmit Rate Thresholds",
                    properties: {
                      warning: { type: "number", title: "Warning Retransmit Ratio", default: 0.05 },
                      critical: {
                        type: "number",
                        title: "Critical Retransmit Ratio",
                        default: 0.15
                      }
                    }
                  },
                  jitter: {
                    type: "object",
                    title: "Jitter Thresholds",
                    properties: {
                      warning: { type: "number", title: "Warning Jitter (ms)", default: 100 },
                      critical: { type: "number", title: "Critical Jitter (ms)", default: 300 }
                    }
                  },
                  queueDepth: {
                    type: "object",
                    title: "Queue Depth Thresholds",
                    properties: {
                      warning: { type: "number", title: "Warning Queue Depth", default: 100 },
                      critical: { type: "number", title: "Critical Queue Depth", default: 500 }
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

  plugin.schema = {
    type: "object",
    title: "SignalK Edge Link",
    description:
      "Configure encrypted UDP data transmission between SignalK units. Add one connection per server listener or client sender.",
    properties: {
      connections: {
        type: "array",
        title: "Connections",
        description:
          "Add one item per server or client connection. Multiple servers (on different ports) and multiple clients can run simultaneously.",
        minItems: 1,
        items: connectionItemSchema,
        default: [
          {
            name: "default",
            serverType: "client",
            udpPort: 4446,
            secretKey: "",
            protocolVersion: 1
          }
        ]
      }
    },
    required: ["connections"]
  };

  return plugin;
};
