"use strict";

/**
 * Client-mode UDP socket recovery (L4 application layer).
 *
 * Recreates the client socket after an error with exponential backoff and
 * re-arms the reliable pipeline (control-packet handler, metrics, congestion
 * control, heartbeat, HELLO) on success. Extracted from `createConnection`.
 *
 * @module app/connection/socket-recovery
 */

import type dgram from "dgram";
import { SOCKET_RECOVERY_BASE_MS, SOCKET_RECOVERY_MAX_MS, type ConnectionContext } from "./context";

/** Re-attach the control-packet message handler and restart pipeline subsystems. */
function rearmPipeline(ctx: ConnectionContext): void {
  const { state, options, app, instanceId, recordError } = ctx;
  if (!state.pipeline || !state.socketUdp) return;

  state.socketUdp.removeAllListeners("message");
  state.socketUdp.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    state.pipeline?.handleControlPacket(msg, rinfo).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] Control packet error: ${m}`);
      recordError("general", `Control packet error: ${m}`);
    });
  });
  state.pipeline.startMetricsPublishing?.();
  if (options.congestionControl?.enabled) state.pipeline.startCongestionControl?.();
  if (state.pipeline.startHeartbeat) {
    state.heartbeatHandle = state.pipeline.startHeartbeat(
      options.udpAddress ?? "",
      options.udpPort,
      { heartbeatInterval: options.heartbeatInterval }
    );
  }
  state.pipeline.sendHello?.(options.udpAddress ?? "", options.udpPort);
}

/** Re-run the post-recovery snapshot/replay steps once the socket is back up. */
function resumeAfterRecovery(ctx: ConnectionContext): void {
  const { state, app, instanceId, services } = ctx;
  services.sendSourceSnapshot().catch((err: unknown) => {
    app.debug(
      `[${instanceId}] recovery source snapshot failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
  if (state.metaConfig?.enabled) services.scheduleMetadataSnapshot(1000);
  services.replayValuesSnapshot("socket recovery");
}

/** Drop a partially-created socket before retrying recovery. */
function dropSocket(ctx: ConnectionContext): void {
  if (!ctx.state.socketUdp) return;
  try {
    ctx.socketManager.close();
  } catch {
    /* already closed */
  }
  ctx.state.socketUdp = null;
}

/** Schedule the next recovery attempt with exponential backoff. */
function scheduleRetry(ctx: ConnectionContext, msg: string): void {
  const delay = ctx.socketRecoveryBackoffMs;
  ctx.socketRecoveryBackoffMs = Math.min(ctx.socketRecoveryBackoffMs * 2, SOCKET_RECOVERY_MAX_MS);
  ctx.setStatus(
    `UDP socket recovery failed: ${msg} — retrying in ${Math.round(delay / 1000)}s`,
    false
  );
  ctx.state.socketRecoveryTimer = setTimeout(() => {
    ctx.state.socketRecoveryTimer = null;
    if (ctx.lifecycle.isShuttingDown()) {
      ctx.state.socketRecoveryInProgress = false;
      return;
    }
    recoverClientSocket(ctx);
  }, delay);
}

/** Attempt to recreate and re-arm the client UDP socket. */
export function recoverClientSocket(ctx: ConnectionContext): void {
  const { state, app, instanceId, socketManager, lifecycle } = ctx;
  app.debug(`[${instanceId}] Attempting UDP socket recovery`);
  try {
    state.socketUdp = socketManager.create();
    state.socketUdp.on("error", ctx.handleClientSocketError);

    rearmPipeline(ctx);

    state.socketRecoveryInProgress = false;
    ctx.socketRecoveryBackoffMs = SOCKET_RECOVERY_BASE_MS;
    state.readyToSend = true;
    lifecycle.transition("Ready", (m) => app.error(m));
    ctx.setStatus("UDP socket recovered", true);
    app.debug(`[${instanceId}] UDP socket recovered`);
    resumeAfterRecovery(ctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    app.error(`[${instanceId}] UDP socket recovery failed: ${msg}`);
    dropSocket(ctx);
    if (lifecycle.isShuttingDown()) {
      state.socketRecoveryInProgress = false;
      return;
    }
    scheduleRetry(ctx, msg);
  }
}

/** Handle a client UDP socket error: tear down and schedule recovery. */
export function handleClientSocketError(ctx: ConnectionContext, err: NodeJS.ErrnoException): void {
  const { state, app, instanceId, socketManager, lifecycle } = ctx;
  if (state.socketRecoveryInProgress || lifecycle.isShuttingDown()) return;
  app.error(`[${instanceId}] Client UDP socket error: ${err.message}`);
  state.readyToSend = false;
  state.socketRecoveryInProgress = true;
  state.pipeline?.stopMetricsPublishing?.();
  state.pipeline?.stopCongestionControl?.();
  if (state.heartbeatHandle) {
    state.heartbeatHandle.stop();
    state.heartbeatHandle = null;
  }
  lifecycle.transition("Recovering", (m) => app.error(m));
  ctx.setStatus(`UDP socket error: ${err.code || err.message} — recovering`, false);
  if (state.socketUdp) {
    try {
      socketManager.close();
    } catch {
      /* already closed */
    }
    state.socketUdp = null;
  }
  if (!lifecycle.isShuttingDown()) {
    state.socketRecoveryTimer = setTimeout(() => {
      state.socketRecoveryTimer = null;
      if (lifecycle.isShuttingDown()) {
        state.socketRecoveryInProgress = false;
        return;
      }
      recoverClientSocket(ctx);
    }, 5000);
  }
}
