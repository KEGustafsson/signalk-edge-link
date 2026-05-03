"use strict";

import createRoutes = require("./routes");
import { createInstance, slugify } from "./instance";
import { validateConnectionConfig, sanitizeConnectionConfig } from "./connection-config";
import { buildConnectionItemSchema } from "./shared/connection-schema";
import type { ConnectionConfig, SignalKApp, InstanceState, MetricsApi } from "./types";
import type { Router } from "./routes/types";

/** API surface returned by createInstance, used locally in the registry. */
interface InstanceApi {
  start(): Promise<void>;
  stop(): void;
  getId(): string;
  getName(): string;
  getStatus(): { text: string; healthy: boolean };
  getState(): InstanceState;
  getMetricsApi(): MetricsApi;
}

const pkg = require("../package.json");

module.exports = function createPlugin(app: SignalKApp) {
  const plugin: Record<string, unknown> = {};
  plugin.id = pkg.name;
  plugin.name = "Signal K Edge Link";
  plugin.description = pkg.description;

  // ── Instance registry ────────────────────────────────────────────────────
  // Map<instanceId, instanceObject> — populated in plugin.start()
  const instances = new Map<string, InstanceApi>();

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
    const healthy = all.filter((inst) => inst.getStatus().healthy).length;
    if (healthy === all.length) {
      setStatus(all.length === 1 ? all[0].getStatus().text : `${all.length} connections active`);
    } else {
      const details = all
        .filter((inst) => !inst.getStatus().healthy)
        .map((inst) => `${inst.getName()}: ${inst.getStatus().text}`)
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

  plugin.registerWithRouter = (router: Router) => {
    routes.registerWithRouter(router);
  };

  plugin.start = async function start(
    options: Record<string, unknown> = {},
    restartPlugin?: (config: unknown) => Promise<void>
  ) {
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
      connectionList = [
        { ...options, name: String(options.name || "default") } as ConnectionConfig
      ];
    } else {
      app.error("No connections configured. Add at least one connection.");
      setStatus("No connections configured");
      return;
    }

    // ── Port collision detection (server mode) ────────────────────────────
    const serverPorts = connectionList
      .filter((c) => c.serverType === "server" || (c.serverType as unknown) === true)
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

    // ── Sanitize + deep-validate all connections before creating any instances ─
    // Sanitize first so persisted configs from older versions (which may have
    // now-forbidden fields like testAddress on v2/v3 clients) are cleaned up
    // before validation, avoiding spurious upgrade-time failures.
    connectionList = connectionList.map((c) => sanitizeConnectionConfig(c) as ConnectionConfig);
    for (let i = 0; i < connectionList.length; i++) {
      const validationError = validateConnectionConfig(connectionList[i], `connections[${i}].`);
      if (validationError) {
        app.error(`Connection ${i + 1} validation failed: ${validationError}`);
        setStatus(`Configuration error in connection ${i + 1}: ${validationError}`);
        return;
      }
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
        String(plugin.id),
        (_id: string, _msg: string) => {
          // Per-instance status change → re-aggregate global status
          updateAggregatedStatus();
        }
      );

      instances.set(instanceId, instance);
    }

    // Start all instances concurrently.
    // Track which ones started successfully so that, on partial failure,
    // only the started instances are stopped — avoiding double-cleanup of
    // instances that never completed start() and the dangling timer / socket
    // leaks that would follow.
    const startedInstances: Array<{ stop: () => void }> = [];
    let startError: unknown = null;

    await Promise.all(
      [...instances.values()].map(async (inst) => {
        try {
          await inst.start();
          startedInstances.push(inst);
        } catch (err: unknown) {
          if (!startError) {
            startError = err;
          }
          app.error(
            `Failed to start connection: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );

    if (startError) {
      app.error(`Failed to start one or more connections — stopping all started instances`);
      for (const inst of startedInstances) {
        inst.stop();
      }
      instances.clear();
      setStatus(
        `Startup failed: ${startError instanceof Error ? startError.message : String(startError)}`
      );
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
  // The field definitions live in `src/shared/connection-schema.ts` and are
  // consumed unchanged here and by the webapp RJSF form in
  // `src/webapp/components/PluginConfigurationPanel.tsx` — there is a single
  // schema source.

  const connectionItemSchema = buildConnectionItemSchema();

  plugin.schema = {
    type: "object",
    title: "SignalK Edge Link",
    description:
      "Configure encrypted UDP data transmission between SignalK units. Add one connection per server listener or client sender.",
    properties: {
      schemaVersion: {
        type: "number",
        title: "Schema Version",
        description: "Internal schema version for forward-compatibility migrations. Do not edit.",
        default: 1,
        readOnly: true
      },
      managementApiToken: {
        type: "string",
        title: "Management API Token",
        description:
          "Shared secret to protect management API endpoints. Strongly recommended for production. Can also be set via SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN environment variable."
      },
      requireManagementApiToken: {
        type: "boolean",
        title: "Require Management API Token",
        description:
          "If true, all management API requests are rejected when no managementApiToken is configured. Enables a fail-closed security posture. Default: false (open access when no token is set).",
        default: false
      },
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
            protocolVersion: 1
          }
        ]
      }
    },
    required: ["connections"]
  };

  return plugin;
};
