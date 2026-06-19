"use strict";

/**
 * Connection orchestrator (L4 application layer).
 *
 * Thin compositor: builds the shared {@link ConnectionContext} (which wires the
 * L3 domain services and the L2 transport layer) and delegates the lifecycle FSM
 * and hot-path logic to the module-level helpers in `./connection/*`. Contains
 * no protocol or transport logic — those live in the layers below. Replaces
 * instance.ts.
 *
 * @module app/connection
 */

import type { SignalKApp, ConnectionConfig, InstanceState, MetricsApi } from "../foundation/types";
import { buildConnectionContext } from "./connection/build-context";
import { buildOutboundDedupeKey } from "./connection/process-delta";
import { start as lifecycleStart, stop as lifecycleStop } from "./connection/lifecycle-ops";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive a URL-safe identifier from a human-readable name. */
export function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

// Re-exported for back-compat: `buildOutboundDedupeKey` now lives in the
// `process-delta` helper module but is still part of this module's public API
// (consumed by the dedupe-key unit test via `lib/app/connection`).
export { buildOutboundDedupeKey };

// ── Factory ───────────────────────────────────────────────────────────────────

/** Public API surface of a single server or client connection instance. */
export interface ConnectionApi {
  /** Start the connection (bind socket, begin handshake, transition to Ready). */
  start(): Promise<void>;
  /** Tear down the connection, cancel all timers, and release the socket. */
  stop(): void;
  /** True when this instance was configured as a UDP server listener. */
  isServerMode(): boolean;
  /** Unique slug identifier for this instance within the plugin. */
  getId(): string;
  /** Human-readable name from config, used in status messages. */
  getName(): string;
  /** Current health summary for the plugin status bar. */
  getStatus(): { text: string; healthy: boolean };
  /** Raw mutable state (exposed for tests and route handlers; treat as read-only outside connection.ts). */
  getState(): InstanceState;
  /** Access to per-instance counters and error records. */
  getMetricsApi(): MetricsApi;
  /** Install a handler invoked when the upstream server requests a full-status re-push. */
  setFullStatusCascadeHandler(handler: (() => void) | null): void;
  /** Ask all connected downstream clients to re-send their full state (server-mode only; no-op on clients). */
  requestFullStatusFromAllClients(): void;
}

/**
 * Create a single server or client connection instance.
 *
 * @param app - SignalK app handle (logging, subscriptions, data).
 * @param options - Validated connection configuration.
 * @param instanceId - Unique slug for this instance (collision-free, from connection manager).
 * @param pluginId - Plugin ID used when emitting deltas via `app.handleMessage`.
 * @param onStatusChange - Callback invoked whenever the instance health/status changes.
 */
export function createConnection(
  app: SignalKApp,
  options: ConnectionConfig,
  instanceId: string,
  pluginId: string,
  onStatusChange: (instanceId: string, message: string) => void
): ConnectionApi {
  const ctx = buildConnectionContext({ app, options, instanceId, pluginId, onStatusChange });
  const { state, metricsApi } = ctx;

  return {
    start: () => lifecycleStart(ctx),
    stop: () => lifecycleStop(ctx),
    isServerMode: () => state.isServerMode,
    getId: () => instanceId,
    getName: () => state.instanceName,
    getStatus: () => ({ text: state.instanceStatus, healthy: state.isHealthy }),
    getState: () => state,
    getMetricsApi: () => metricsApi,
    setFullStatusCascadeHandler(handler: (() => void) | null) {
      ctx.fullStatusCascadeHandler = handler;
    },
    requestFullStatusFromAllClients() {
      state.pipelineServer?.requestFullStatusFromAllClients?.();
    }
  };
}
