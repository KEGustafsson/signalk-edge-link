"use strict";

/**
 * Connection manager (L4 application layer).
 *
 * Owns the instance registry, validation, port-collision detection, ordered
 * server-then-client startup, cascade-stop on failure, and plugin-level status
 * aggregation. Extracted from the index.ts plugin entry-point.
 *
 * @module app/connection-manager
 */

import { createConnection, slugify } from "./connection";
import type { ConnectionApi } from "./connection";
import { validateConnectionConfig, sanitizeConnectionConfig } from "../connection-config";
import type { SignalKApp, ConnectionConfig, InstanceState, MetricsApi } from "../types";
import type { InstanceRegistry } from "../foundation/types/instance";

export type { ConnectionApi };

export interface ConnectionManagerOptions {
  app: SignalKApp;
  pluginId: string;
  setStatus: (msg: string) => void;
}

export interface ConnectionManager {
  /** Start all connections from the given options payload. */
  start(options: Record<string, unknown>): Promise<void>;
  /** Stop all running connections. */
  stop(): void;
  /** The instance registry (for route handlers). */
  readonly registry: InstanceRegistry;
}

// ── Instance ID generation ────────────────────────────────────────────────────

function generateInstanceId(name: string | undefined, usedIds: Set<string>): string {
  const base = slugify(name || "connection");
  if (!usedIds.has(base)) return base;
  let n = 1;
  while (usedIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── Port collision detection ──────────────────────────────────────────────────

function findDuplicateServerPorts(connections: ConnectionConfig[]): number[] {
  const ports = connections
    .filter((c) => c.serverType === "server" || (c.serverType as unknown) === true)
    .map((c) => c.udpPort);
  return ports.filter((p, i) => ports.indexOf(p) !== i);
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the plugin-level connection manager.
 *
 * Parses options, validates configurations, starts connections in
 * server-before-client order, and exposes an `InstanceRegistry` for
 * route handlers. Call `start()` on each plugin start and `stop()` on
 * plugin stop.
 */
export function createConnectionManager({
  app,
  pluginId,
  setStatus
}: ConnectionManagerOptions): ConnectionManager {
  const instances = new Map<string, ConnectionApi>();

  // ── Registry ──────────────────────────────────────────────────────────────
  const registry: InstanceRegistry = {
    get(id: string) {
      const inst = instances.get(id);
      if (!inst) return null;
      return {
        id: inst.getId(),
        name: inst.getName(),
        state: inst.getState(),
        metricsApi: inst.getMetricsApi()
      };
    },
    getFirst() {
      const first = instances.values().next().value;
      if (!first) return null;
      return {
        id: first.getId(),
        name: first.getName(),
        state: first.getState(),
        metricsApi: first.getMetricsApi()
      };
    },
    getAll() {
      return [...instances.values()].map((inst) => ({
        id: inst.getId(),
        name: inst.getName(),
        state: inst.getState(),
        metricsApi: inst.getMetricsApi()
      }));
    }
  };

  // ── Status aggregation ────────────────────────────────────────────────────
  function updateAggregatedStatus(): void {
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

  // ── start ─────────────────────────────────────────────────────────────────
  async function start(options: Record<string, unknown>): Promise<void> {
    // Tear down any existing instances (restart case).
    if (instances.size > 0) {
      for (const inst of instances.values()) inst.stop();
      instances.clear();
    }

    // ── Parse connections array (supports flat legacy and new array format)
    let connectionList: ConnectionConfig[];
    if (Array.isArray(options.connections) && options.connections.length > 0) {
      connectionList = options.connections as ConnectionConfig[];
    } else if (options.serverType) {
      connectionList = [
        { ...options, name: String(options.name || "default") } as ConnectionConfig
      ];
    } else {
      app.error("No connections configured. Add at least one connection.");
      setStatus("No connections configured");
      return;
    }

    // ── Port collision check
    const dupes = findDuplicateServerPorts(connectionList);
    if (dupes.length > 0) {
      app.error(
        `Duplicate server ports detected: ${[...new Set(dupes)].join(", ")}. ` +
          "Each server instance must use a unique UDP port."
      );
      setStatus("Configuration error: duplicate server ports");
      return;
    }

    // ── Sanitize then validate all connections before creating any instances
    connectionList = connectionList.map((c) => sanitizeConnectionConfig(c) as ConnectionConfig);

    for (let i = 0; i < connectionList.length; i++) {
      const err = validateConnectionConfig(connectionList[i], `connections[${i}].`);
      if (err) {
        app.error(`Connection ${i + 1} validation failed: ${err}`);
        setStatus(`Configuration error in connection ${i + 1}: ${err}`);
        return;
      }
    }

    // ── Log legacy-protocol usage
    for (const cfg of connectionList) {
      const proto = (cfg.protocolVersion ?? 1) as number;
      if (proto < 2) {
        app.debug(
          `[security] Connection "${cfg.name}" uses legacy protocol v${proto}; consider protocolVersion: 3 for authenticated, reliable transport.`
        );
      }
    }

    // ── Create instances
    const usedIds = new Set<string>();
    for (const cfg of connectionList) {
      const instanceId = generateInstanceId(cfg.name, usedIds);
      usedIds.add(instanceId);
      const conn = createConnection(app, cfg, instanceId, pluginId, (_id, _msg) =>
        updateAggregatedStatus()
      );
      instances.set(instanceId, conn);
    }

    // ── Start servers before clients (ordered startup)
    const all = [...instances.values()];
    const servers = all.filter((inst) => inst.isServerMode());
    const clients = all.filter((inst) => !inst.isServerMode());

    const startedInstances: ConnectionApi[] = [];
    let startError: unknown = null;

    async function startGroup(group: ConnectionApi[]): Promise<void> {
      await Promise.all(
        group.map(async (inst) => {
          try {
            await inst.start();
            startedInstances.push(inst);
          } catch (err: unknown) {
            if (!startError) startError = err;
            app.error(
              `Failed to start connection: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );
    }

    await startGroup(servers);
    await startGroup(clients);

    if (startError) {
      app.error("Failed to start one or more connections — stopping all started instances");
      for (const inst of startedInstances) inst.stop();
      instances.clear();
      setStatus(
        `Startup failed: ${startError instanceof Error ? startError.message : String(startError)}`
      );
      return;
    }

    // ── Wire FULL_STATUS_REQUEST cascade (proxy chain: Cloud → Proxy → Boat)
    const runningServers = [...instances.values()].filter((inst) => inst.isServerMode());
    const runningClients = [...instances.values()].filter((inst) => !inst.isServerMode());
    if (runningServers.length > 0 && runningClients.length > 0) {
      for (const client of runningClients) {
        client.setFullStatusCascadeHandler(() => {
          for (const server of runningServers) server.requestFullStatusFromAllClients();
        });
      }
    }

    updateAggregatedStatus();
  }

  // ── stop ──────────────────────────────────────────────────────────────────
  function stop(): void {
    for (const inst of instances.values()) inst.stop();
    instances.clear();
    setStatus("Stopped");
  }

  return { start, stop, registry };
}
