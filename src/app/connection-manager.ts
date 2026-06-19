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

import type { ConnectionApi } from "./connection";
import type { SignalKApp } from "../foundation/types";
import type { InstanceRegistry } from "../foundation/types/instance";
import { start as startManager, type ManagerContext } from "./connection-manager/start";

export type { ConnectionApi };

/** Constructor arguments for `createConnectionManager`. */
export interface ConnectionManagerOptions {
  /** SignalK application handle (logging, subscriptions, delta emission). */
  app: SignalKApp;
  /** Plugin identifier, used when emitting deltas via `app.handleMessage`. */
  pluginId: string;
  /** Callback to update the plugin status bar message. */
  setStatus: (msg: string) => void;
}

/** Manages the full set of running connections for the plugin lifetime. */
export interface ConnectionManager {
  /** Start all connections from the given options payload. */
  start(options: Record<string, unknown>): Promise<void>;
  /** Stop all running connections. */
  stop(): void;
  /** The instance registry (for route handlers). */
  readonly registry: InstanceRegistry;
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

  const toView = (inst: ConnectionApi) => ({
    id: inst.getId(),
    name: inst.getName(),
    state: inst.getState(),
    metricsApi: inst.getMetricsApi()
  });

  // ── Registry ──────────────────────────────────────────────────────────────
  const registry: InstanceRegistry = {
    get(id: string) {
      const inst = instances.get(id);
      return inst ? toView(inst) : null;
    },
    getFirst() {
      const first = instances.values().next().value;
      return first ? toView(first) : null;
    },
    getAll() {
      return [...instances.values()].map(toView);
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

  const ctx: ManagerContext = {
    app,
    pluginId,
    setStatus,
    instances,
    updateAggregatedStatus
  };

  // ── stop ──────────────────────────────────────────────────────────────────
  function stop(): void {
    for (const inst of instances.values()) inst.stop();
    instances.clear();
    setStatus("Stopped");
  }

  return {
    start: (options: Record<string, unknown>) => startManager(ctx, options),
    stop,
    registry
  };
}
