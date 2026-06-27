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
  instances: Map<string, ConnectionApi>;
  updateAggregatedStatus: () => void;
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
  ctx.setStatus("No connections configured");
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
    ctx.setStatus("Configuration error: duplicate server ports");
    return null;
  }

  const sanitized = connectionList.map((c) => sanitizeConnectionConfig(c) as ConnectionConfig);

  for (let i = 0; i < sanitized.length; i++) {
    const err = validateConnectionConfig(sanitized[i], `connections[${i}].`);
    if (err) {
      ctx.app.error(`Connection ${i + 1} validation failed: ${err}`);
      ctx.setStatus(`Configuration error in connection ${i + 1}: ${err}`);
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

function createInstances(ctx: ManagerContext, connectionList: ConnectionConfig[]): void {
  const usedIds = new Set<string>();
  for (const cfg of connectionList) {
    const instanceId = generateInstanceId(cfg.name, usedIds);
    usedIds.add(instanceId);
    const conn = createConnection(ctx.app, cfg, instanceId, ctx.pluginId, (_id, _msg) =>
      ctx.updateAggregatedStatus()
    );
    ctx.instances.set(instanceId, conn);
  }
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
 * Start servers (before clients), in ordered groups. Returns the first startup
 * error, or `null` if all instances started successfully.
 */
async function startAllInstances(ctx: ManagerContext): Promise<unknown> {
  const all = [...ctx.instances.values()];
  const servers = all.filter((inst) => inst.isServerMode());
  const clients = all.filter((inst) => !inst.isServerMode());

  let startError: unknown = null;
  const onError = (err: unknown): void => {
    if (!startError) startError = err;
  };

  await startGroup(ctx, servers, onError);
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
  // Tear down any existing instances (restart case).
  if (ctx.instances.size > 0) teardownAll(ctx);

  const parsed = parseConnectionList(ctx, options);
  if (!parsed) return;

  const connectionList = prepareConnectionList(ctx, parsed);
  if (!connectionList) return;

  logLegacyProtocolUsage(ctx, connectionList);
  createInstances(ctx, connectionList);

  const startError = await startAllInstances(ctx);
  if (startError) {
    ctx.app.error("Failed to start one or more connections — stopping all instances");
    // Stop EVERY instance in the registry, not just the ones that started
    // successfully. An instance whose start() threw may have allocated
    // sockets/timers/heartbeat/pipeline state before failing; its full
    // teardown (stop()) is idempotent and safe to call even after a partial
    // start, so this releases resources that would otherwise leak.
    teardownAll(ctx);
    ctx.setStatus(
      `Startup failed: ${startError instanceof Error ? startError.message : String(startError)}`
    );
    return;
  }

  wireFullStatusCascade(ctx);
  ctx.updateAggregatedStatus();
}
