"use strict";

/**
 * Connection-manager startup orchestration (L4 application layer).
 *
 * Extracted from `createConnectionManager` to keep the factory thin. These
 * module-level helpers operate on an explicit {@link ManagerContext} holding the
 * shared instance registry and dependencies, rather than closing over factory
 * locals.
 *
 * @module app/connection-manager/start
 */

import { createConnection, slugify } from "../connection";
import type { ConnectionApi } from "../connection";
import { validateConnectionConfig, sanitizeConnectionConfig } from "../../connection-config";
import type { SignalKApp, ConnectionConfig } from "../../foundation/types";

/** Shared state + dependencies for the connection-manager helpers. */
export interface ManagerContext {
  app: SignalKApp;
  pluginId: string;
  setStatus: (msg: string) => void;
  /** Reports a plugin-level error state (`setPluginError`). */
  setError: (msg: string) => void;
  instances: Map<string, ConnectionApi>;
  updateAggregatedStatus: () => void;
  /**
   * Monotonic counter identifying the current start attempt. `start()` captures
   * it and re-checks after every await; `stop()` and any newer `start()` bump
   * it. Without this, a `stop()` landing mid-start would let the remaining
   * instance group start *after* teardown — `Stopped -> Starting` is a legal
   * transition, so those instances would bind sockets and stream deltas while
   * holding no registry entry, unreachable by any later stop().
   */
  startGeneration: number;
}

/** True when a newer start(), or a stop(), superseded this start attempt. */
function superseded(ctx: ManagerContext, generation: number): boolean {
  return ctx.startGeneration !== generation;
}

function generateInstanceId(name: string | undefined, usedIds: Set<string>): string {
  const base = slugify(name || "connection");
  if (!usedIds.has(base)) return base;
  let n = 1;
  while (usedIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function findDuplicateServerPorts(connections: ConnectionConfig[]): number[] {
  const ports = connections
    .filter((c) => c.serverType === "server" || (c.serverType as unknown) === true)
    .map((c) => c.udpPort);
  return ports.filter((p, i) => ports.indexOf(p) !== i);
}

/**
 * Parse the options payload into a connection list, applying both the new
 * array format and the flat legacy single-connection form. Returns `null` (and
 * sets an error status) when no connections are configured.
 */
function parseConnectionList(
  ctx: ManagerContext,
  options: Record<string, unknown>
): ConnectionConfig[] | null {
  if (Array.isArray(options.connections) && options.connections.length > 0) {
    return options.connections as ConnectionConfig[];
  }
  if (options.serverType) {
    return [{ ...options, name: String(options.name || "default") } as ConnectionConfig];
  }
  ctx.app.error("No connections configured. Add at least one connection.");
  ctx.setError("No connections configured");
  return null;
}

/**
 * Sanitize, port-collision-check, and validate the connection list. Returns the
 * sanitized list, or `null` (with an error status set) on the first problem.
 */
function prepareConnectionList(
  ctx: ManagerContext,
  connectionList: ConnectionConfig[]
): ConnectionConfig[] | null {
  const dupes = findDuplicateServerPorts(connectionList);
  if (dupes.length > 0) {
    ctx.app.error(
      `Duplicate server ports detected: ${[...new Set(dupes)].join(", ")}. ` +
        "Each server instance must use a unique UDP port."
    );
    ctx.setError("Configuration error: duplicate server ports");
    return null;
  }

  const sanitized = connectionList.map((c) => sanitizeConnectionConfig(c) as ConnectionConfig);

  for (let i = 0; i < sanitized.length; i++) {
    const err = validateConnectionConfig(sanitized[i], `connections[${i}].`);
    if (err) {
      ctx.app.error(`Connection ${i + 1} validation failed: ${err}`);
      ctx.setError(`Configuration error in connection ${i + 1}: ${err}`);
      return null;
    }
  }
  return sanitized;
}

function logLegacyProtocolUsage(ctx: ManagerContext, connectionList: ConnectionConfig[]): void {
  for (const cfg of connectionList) {
    const proto = (cfg.protocolVersion ?? 1) as number;
    if (proto < 2) {
      ctx.app.debug(
        `[security] Connection "${cfg.name}" uses legacy protocol v${proto}; consider protocolVersion: 3 for authenticated, reliable transport.`
      );
    }
  }
}

/**
 * Create one instance per connection and register it. Returns the instances
 * this attempt owns, so a superseded attempt can roll back exactly what it
 * created rather than whatever happens to be in the shared registry.
 */
function createInstances(
  ctx: ManagerContext,
  connectionList: ConnectionConfig[]
): Map<string, ConnectionApi> {
  const usedIds = new Set<string>();
  const owned = new Map<string, ConnectionApi>();
  for (const cfg of connectionList) {
    const instanceId = generateInstanceId(cfg.name, usedIds);
    usedIds.add(instanceId);
    const conn = createConnection(ctx.app, cfg, instanceId, ctx.pluginId, (_id, _msg) =>
      ctx.updateAggregatedStatus()
    );
    owned.set(instanceId, conn);
    ctx.instances.set(instanceId, conn);
  }
  return owned;
}

/** Start every instance in a group, capturing the first error encountered. */
async function startGroup(
  ctx: ManagerContext,
  group: ConnectionApi[],
  onError: (err: unknown) => void
): Promise<void> {
  await Promise.all(
    group.map(async (inst) => {
      try {
        await inst.start();
      } catch (err: unknown) {
        onError(err);
        ctx.app.error(
          `Failed to start connection: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
}

/** Stop and clear every registered instance. */
function teardownAll(ctx: ManagerContext): void {
  for (const inst of ctx.instances.values()) inst.stop();
  ctx.instances.clear();
}

/**
 * Roll back only the instances a superseded start attempt created.
 *
 * `teardownAll` would be wrong here: by the time a superseded attempt resumes,
 * the newer start() has already cleared the registry and repopulated it with its
 * own live instances, so clearing again would stop connections that the current
 * owner believes are running — and leave them unreachable by any later stop().
 * Registry entries are only removed when they still point at our instance.
 */
function teardownOwned(ctx: ManagerContext, owned: Map<string, ConnectionApi>): void {
  for (const [id, inst] of owned) {
    inst.stop();
    if (ctx.instances.get(id) === inst) ctx.instances.delete(id);
  }
}

/**
 * Start servers (before clients), in ordered groups. Returns the first startup
 * error, or `null` if all instances started successfully.
 */
async function startAllInstances(
  ctx: ManagerContext,
  owned: Map<string, ConnectionApi>,
  generation: number
): Promise<unknown> {
  const all = [...owned.values()];
  const servers = all.filter((inst) => inst.isServerMode());
  const clients = all.filter((inst) => !inst.isServerMode());

  let startError: unknown = null;
  const onError = (err: unknown): void => {
    if (!startError) startError = err;
  };

  await startGroup(ctx, servers, onError);
  // A stop() (or a newer start()) during the server group must not go on to
  // start the client group against a registry that has already been cleared.
  if (superseded(ctx, generation)) return startError;
  await startGroup(ctx, clients, onError);
  return startError;
}

/**
 * Wire the FULL_STATUS_REQUEST cascade (proxy chain: Cloud → Proxy → Boat) when
 * both server-mode and client-mode instances are running.
 */
function wireFullStatusCascade(ctx: ManagerContext): void {
  const runningServers = [...ctx.instances.values()].filter((inst) => inst.isServerMode());
  const runningClients = [...ctx.instances.values()].filter((inst) => !inst.isServerMode());
  if (runningServers.length > 0 && runningClients.length > 0) {
    for (const client of runningClients) {
      client.setFullStatusCascadeHandler(() => {
        for (const server of runningServers) server.requestFullStatusFromAllClients();
      });
    }
  }
}

/** Start all connections from the given options payload. */
export async function start(ctx: ManagerContext, options: Record<string, unknown>): Promise<void> {
  // Claim this start attempt; any concurrent start() or stop() supersedes it.
  const generation = ++ctx.startGeneration;

  // Tear down any existing instances (restart case).
  if (ctx.instances.size > 0) teardownAll(ctx);

  const parsed = parseConnectionList(ctx, options);
  if (!parsed) return;

  const connectionList = prepareConnectionList(ctx, parsed);
  if (!connectionList) return;

  logLegacyProtocolUsage(ctx, connectionList);
  const owned = createInstances(ctx, connectionList);

  const startError = await startAllInstances(ctx, owned, generation);

  // Superseded mid-start: whatever did supersede us owns the registry now.
  // Stop anything this attempt managed to start and leave the rest alone.
  if (superseded(ctx, generation)) {
    ctx.app.debug("Connection start superseded by a newer start/stop — rolling back");
    teardownOwned(ctx, owned);
    return;
  }

  if (startError) {
    ctx.app.error("Failed to start one or more connections — stopping all instances");
    // Stop EVERY instance in the registry, not just the ones that started
    // successfully. An instance whose start() threw may have allocated
    // sockets/timers/heartbeat/pipeline state before failing; its full
    // teardown (stop()) is idempotent and safe to call even after a partial
    // start, so this releases resources that would otherwise leak.
    teardownAll(ctx);
    ctx.setError(
      `Startup failed: ${startError instanceof Error ? startError.message : String(startError)}`
    );
    return;
  }

  wireFullStatusCascade(ctx);
  ctx.updateAggregatedStatus();
}
