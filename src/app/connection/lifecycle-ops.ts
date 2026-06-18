"use strict";

/**
 * Connection lifecycle operations (L4 application layer).
 *
 * The `start`/`stop` FSM transitions for a connection instance. `start` validates
 * the secret key and port, arms the dedupe-cleanup interval, then delegates to
 * the server/client startup helpers. `stop` performs the full idempotent
 * teardown of timers, sockets, pipelines, and monitoring. Extracted from
 * `createConnection`.
 *
 * @module app/connection/lifecycle-ops
 */

import { validateSecretKey } from "../../codec/crypto";
import { OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS } from "../../foundation/constants";
import { SOCKET_RECOVERY_BASE_MS, type ConnectionContext } from "./context";
import { startServer } from "./start-server";
import { startClient } from "./start-client";

/** Derive server mode from options (supports legacy boolean and string forms). */
function isServer(ctx: ConnectionContext): boolean {
  const { options } = ctx;
  return (options.serverType as unknown) === true || options.serverType === "server";
}

/**
 * Validate the secret key and UDP port. On failure, sets an error status, force
 * stops the lifecycle, marks the instance stopped, and throws. Returns true when
 * both are valid.
 */
function validateStartPreconditions(ctx: ConnectionContext): void {
  const { options, app, instanceId, lifecycle, state } = ctx;

  const fail = (msg: string): never => {
    app.error(`[${instanceId}] ${msg}`);
    ctx.setStatus(msg, false);
    lifecycle.forceStop();
    state.stopped = true;
    throw new Error(`[${instanceId}] ${msg}`);
  };

  try {
    validateSecretKey(options.secretKey);
  } catch (error: unknown) {
    fail(`Secret key validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Number.isInteger(options.udpPort) || options.udpPort < 1024 || options.udpPort > 65535) {
    fail("UDP port must be between 1024 and 65535");
  }
}

/** Start the connection (bind socket, begin handshake, transition to Ready). */
export async function start(ctx: ConnectionContext): Promise<void> {
  const { options, lifecycle, state } = ctx;
  lifecycle.transition("Starting", (msg) => ctx.app.error(msg));
  ctx.socketRecoveryBackoffMs = SOCKET_RECOVERY_BASE_MS;
  state.stopped = false;
  state.options = options;
  state.isServerMode = isServer(ctx);

  validateStartPreconditions(ctx);

  if (lifecycle.isShuttingDown()) return;

  ctx.dedupeCleanupTimer = setInterval(
    () => ctx.cleanupDedupeMap(Date.now()),
    OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS
  );

  try {
    if (isServer(ctx)) {
      await startServer(ctx);
    } else {
      await startClient(ctx);
    }
    if (!lifecycle.isShuttingDown()) {
      lifecycle.transition("Ready", (msg) => ctx.app.error(msg));
      state.readyToSend = true;
    }
  } catch (err) {
    // Full teardown before rethrowing: startServer()/startClient() may have
    // allocated sockets, timers, heartbeat, or pipeline state before failing.
    // stop() is idempotent, so it is safe even from a partial start and even
    // if the caller (ConnectionManager) also calls stop() afterwards.
    stop(ctx);
    throw err;
  }
}

/** Reset session/dedupe bookkeeping and unsubscribe from the SignalK bus. */
function teardownSession(ctx: ConnectionContext): void {
  const { state, services } = ctx;
  state.unsubscribes.forEach((f: () => void) => f());
  state.unsubscribes = [];
  state.localSubscription = null;
  services.invalidateSubscriptionGeneration();

  state.deltas = [];
  ctx.recentOutboundDeltas.clear();
  if (ctx.dedupeCleanupTimer) {
    clearInterval(ctx.dedupeCleanupTimer);
    ctx.dedupeCleanupTimer = null;
  }
  state.timer = false;
  state.batchSendInFlight = false;
  state.socketRecoveryInProgress = false;
  state.droppedDeltaBatches = 0;
  state.droppedDeltaCount = 0;
  Object.keys(state.configContentHashes).forEach((k) => delete state.configContentHashes[k]);
  state.excludedSentences = ["GSV"];
  state.lastPacketTime = 0;
  state.lastFullStatusRequestAt = 0;
}

/** Clear every per-instance timer and the metadata caches. */
function teardownTimers(ctx: ConnectionContext): void {
  const { state, services } = ctx;
  clearInterval(state.metaTimer ?? undefined);
  state.metaTimer = null;
  clearInterval(state.sourceSnapshotTimer ?? undefined);
  state.sourceSnapshotTimer = null;
  clearTimeout(state.metaDiffFlushTimer ?? undefined);
  state.metaDiffFlushTimer = null;
  for (const h of state.metaSnapshotTimers) clearTimeout(h);
  state.metaSnapshotTimers = [];
  state.metaDiffBuffer = [];
  state.metaConfig = null;
  state.pendingMetaConfig = undefined;
  services.metaCache.clear();
  clearTimeout(state.deltaTimer ?? undefined);
  state.deltaTimer = null;
  clearTimeout(state.pendingRetry ?? undefined);
  state.pendingRetry = null;
  clearTimeout(state.subscriptionRetryTimer ?? undefined);
  state.subscriptionRetryTimer = null;
  clearTimeout(state.socketRecoveryTimer ?? undefined);
  state.socketRecoveryTimer = null;
  Object.keys(state.configDebounceTimers).forEach((k) => {
    clearTimeout(state.configDebounceTimers[k]);
    delete state.configDebounceTimers[k];
  });

  state.configWatcherObjects.forEach((w) => w.close());
  state.configWatcherObjects = [];
}

/** Tear down the transport pipelines (client + server) and heartbeat. */
function teardownPipelines(ctx: ConnectionContext): void {
  const { state } = ctx;
  state.pipeline?.stopBonding?.();
  state.pipeline?.stopMetricsPublishing?.();
  state.pipeline?.stopCongestionControl?.();
  state.pipeline = null;
  if (state.heartbeatHandle) {
    state.heartbeatHandle.stop();
    state.heartbeatHandle = null;
  }

  // Prefer the full teardown (resets every per-session tracker, clears the
  // session map). Fall back to the legacy calls for pipelines without stop().
  if (state.pipelineServer?.stop) {
    state.pipelineServer.stop();
  } else {
    state.pipelineServer?.stopACKTimer?.();
    state.pipelineServer?.stopMetricsPublishing?.();
    state.pipelineServer?.getSequenceTracker?.()?.reset();
  }
  state.pipelineServer = null;
}

/** Reset enhanced monitoring, the ping monitor, and release the socket. */
function teardownMonitoringAndSocket(ctx: ConnectionContext): void {
  const { state, app, instanceId, socketManager } = ctx;
  if (state.monitoring) {
    state.monitoring.packetLossTracker?.reset();
    state.monitoring.pathLatencyTracker?.reset();
    state.monitoring.retransmissionTracker?.reset();
    state.monitoring.packetCapture?.reset();
    state.monitoring.packetInspector?.reset();
    state.monitoring.alertManager?.reset();
    state.monitoring = null;
  }
  if (state.pingMonitor) {
    state.pingMonitor.stop();
    state.pingMonitor = null;
  }
  if (state.socketUdp) {
    socketManager.close();
    state.socketUdp = null;
    app.debug(`[${instanceId}] Stopped`);
  }
}

/** Tear down the connection, cancel all timers, and release the socket. */
export function stop(ctx: ConnectionContext): void {
  const { state, app, instanceId, lifecycle, services, resetMetrics } = ctx;
  if (state.batchSendInFlight) {
    app.debug(
      `[${instanceId}] stop() called while batch send in flight — last delta batch may be lost`
    );
  }

  const wasShuttingDown = lifecycle.isShuttingDown();
  lifecycle.forceStop();
  state.stopped = true;
  state.readyToSend = false;
  state.isHealthy = false;

  teardownSession(ctx);

  resetMetrics();
  services.keepaliveManager.stop();

  teardownTimers(ctx);
  teardownPipelines(ctx);
  teardownMonitoringAndSocket(ctx);

  ctx.setStatus("Stopped", false);
  void wasShuttingDown; // satisfies linter if unused
}
