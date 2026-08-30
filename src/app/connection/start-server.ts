"use strict";

/**
 * Server-mode startup (L4 application layer).
 *
 * Binds the UDP listener, wires the reliable (v2/v3) or legacy (v1) server
 * pipeline, and resolves once the socket is listening (or rejects on bind
 * failure). Extracted from `createConnection`.
 *
 * @module app/connection/start-server
 */

import type dgram from "dgram";
import { SOCKET_RECOVERY_BASE_MS, SOCKET_RECOVERY_MAX_MS, type ConnectionContext } from "./context";

/**
 * Errors that are configuration problems, not transient link faults. Retrying
 * these forever would spam the log and never succeed — the operator has to
 * change the port or the permissions.
 */
const FATAL_BIND_CODES = new Set(["EADDRINUSE", "EACCES"]);

/** Install the UDP "error" handler for the server socket. */
function attachServerErrorHandler(ctx: ConnectionContext): void {
  const { state, app, instanceId, options, socketManager } = ctx;
  state.socketUdp?.on("error", (err: NodeJS.ErrnoException) => {
    app.error(`[${instanceId}] UDP socket error: ${err.message}`);
    state.readyToSend = false;
    state.pipelineServer?.stopACKTimer?.();
    state.pipelineServer?.stopMetricsPublishing?.();
    const msg =
      err.code === "EADDRINUSE"
        ? `Failed to start – port ${options.udpPort} already in use`
        : err.code === "EACCES"
          ? `Failed to start – permission denied for port ${options.udpPort}`
          : `UDP socket error: ${err.code || err.message}`;
    ctx.setStatus(msg, false);
    if (state.socketUdp) {
      socketManager.close();
      state.socketUdp = null;
    }

    // Client mode recovers from socket errors with backoff; server mode used to
    // simply stop, so a transient interface flap (ENETDOWN/EADDRNOTAVAIL on a
    // switching cellular/Wi-Fi uplink) killed the listener for the lifetime of
    // the process and required a manual plugin restart.
    if (!FATAL_BIND_CODES.has(err.code ?? "") && !ctx.lifecycle.isShuttingDown()) {
      scheduleServerRecovery(ctx);
    }
  });
}

/** Recreate and re-bind the server listener with exponential backoff. */
function scheduleServerRecovery(ctx: ConnectionContext): void {
  const { state, app, instanceId } = ctx;
  if (state.socketRecoveryInProgress) return;
  state.socketRecoveryInProgress = true;

  const attempt = (): void => {
    state.socketRecoveryTimer = null;
    if (ctx.lifecycle.isShuttingDown()) {
      state.socketRecoveryInProgress = false;
      return;
    }
    const delay = ctx.socketRecoveryBackoffMs;
    ctx.socketRecoveryBackoffMs = Math.min(ctx.socketRecoveryBackoffMs * 2, SOCKET_RECOVERY_MAX_MS);

    /** Re-arm the next attempt at the backoff already computed for this round. */
    const retry = (msg: string): void => {
      if (ctx.lifecycle.isShuttingDown()) {
        state.socketRecoveryInProgress = false;
        return;
      }
      ctx.setStatus(
        `UDP socket recovery failed: ${msg} — retrying in ${Math.round(delay / 1000)}s`,
        false
      );
      state.socketRecoveryTimer = setTimeout(attempt, delay);
    };

    try {
      app.debug(`[${instanceId}] Attempting server UDP socket recovery`);
      const socket = ctx.socketManager.create();
      state.socketUdp = socket;
      attachServerPipeline(ctx);

      // Exactly one "error" listener is live per socket, and ownership hands
      // over at "listening".
      //
      // Until the socket binds, this attempt owns errors: it retries, or stops
      // on a code that will not fix itself. Once it is listening the persistent
      // handler takes over and starts a fresh recovery on a later interface
      // fault. Attaching both at once ran two independent reactions to the same
      // event — and the persistent one's call back into scheduleServerRecovery
      // is a no-op while a recovery is already in progress, so it could not have
      // re-armed the retry anyway.
      const onBindError = (err: NodeJS.ErrnoException): void => {
        if (state.socketUdp === socket) {
          try {
            ctx.socketManager.close();
          } catch {
            /* already closed */
          }
          state.socketUdp = null;
        }
        state.readyToSend = false;
        app.error(`[${instanceId}] Server UDP socket recovery failed: ${err.message}`);
        if (FATAL_BIND_CODES.has(err.code ?? "")) {
          // A port conflict or a permissions problem needs an operator, not a
          // retry loop.
          ctx.setStatus(`Failed to start – ${err.message}`, false);
          state.socketRecoveryInProgress = false;
          return;
        }
        retry(err.message);
      };
      socket.once("error", onBindError);

      // Success is declared on "listening", never straight after bind().
      // `bind()` is asynchronous and reports failure as an "error" event rather
      // than a throw, so doing this bookkeeping inline marked a socket that had
      // not bound — and might never bind — as recovered, and reset the backoff
      // with it, degrading exponential retry to a fixed-interval hot loop.
      socket.once("listening", () => {
        if (state.socketUdp !== socket) return;
        socket.removeListener("error", onBindError);
        attachServerErrorHandler(ctx);
        state.socketRecoveryInProgress = false;
        ctx.socketRecoveryBackoffMs = SOCKET_RECOVERY_BASE_MS;
        state.readyToSend = true;
        ctx.setStatus("UDP socket recovered", true);
      });

      ctx.socketManager.bind(ctx.options.udpPort);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] Server UDP socket recovery failed: ${msg}`);
      if (state.socketUdp) {
        try {
          ctx.socketManager.close();
        } catch {
          /* already closed */
        }
        state.socketUdp = null;
      }
      retry(msg);
    }
  };

  state.socketRecoveryTimer = setTimeout(attempt, ctx.socketRecoveryBackoffMs);
}

/**
 * Wire the reliable (v2/v3) or legacy (v1) server pipeline message handlers.
 *
 * Called both on first start and on every socket recovery. Recovery replaces
 * the *socket*, not the pipeline: sessions are keyed on `address:port`, so the
 * existing pipeline is still the right one for every peer that was talking to
 * us before the interface flapped. Building a second one would strand the
 * first — its per-session NAK timers stay armed and keep flushing NAKs through
 * whatever socket `state` now points at, while the replacement starts with no
 * sessions, no epochs and no replay guards, silently dropping every peer back
 * to the un-enforced anti-replay path until it happens to re-HELLO.
 */
function attachServerPipeline(ctx: ConnectionContext): void {
  const { state, app, instanceId, options, appProxy, metricsApi } = ctx;
  const useReliable = (options.protocolVersion ?? 0) >= 2;
  if (useReliable) {
    const { createPipelineV2Server } = require("../../transport/pipeline/reliable-server");
    const srv = state.pipelineServer ?? createPipelineV2Server(appProxy, state, metricsApi);
    state.pipelineServer = srv;
    state.socketUdp?.on("message", (pkt: Buffer, rinfo: dgram.RemoteInfo) => {
      // receivePacket catches internally today, but a floating promise here
      // would turn any future throw in its error reporting into an unhandled
      // rejection that takes down the server process.
      Promise.resolve(srv.receivePacket(pkt, options.secretKey, rinfo)).catch((err: unknown) => {
        app.error(
          `[${instanceId}] v3 receivePacket failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
    state.socketUdp?.on("listening", () => {
      if (!state.socketUdp) return;
      srv.startACKTimer();
      srv.startMetricsPublishing();
      app.debug(`[${instanceId}] [v3] Server pipeline with ACK/NAK initialized`);
    });
  } else {
    state.socketUdp?.on("message", (delta: Buffer) => {
      ctx.getV1Pipeline().unpackDecrypt(delta, options.secretKey);
    });
    app.debug(`[${instanceId}] [v1] Server pipeline initialized`);
  }
}

/** Bind the socket and resolve once listening (or reject on error). */
function bindAndAwaitListening(ctx: ConnectionContext): Promise<void> {
  const { state, instanceId, options, socketManager } = ctx;
  const startupSocket = state.socketUdp;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      startupSocket?.removeListener("listening", onListen);
      startupSocket?.removeListener("error", onError);
      startupSocket?.removeListener("close", onClose);
    };
    const onListen = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = (e: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(`[${instanceId}] Failed to bind to port ${options.udpPort}: ${e.message}`)
        );
      }
    };
    // A stop() landing between bind() and "listening" closes the socket,
    // which emits only "close" — without this the promise never settles and
    // the caller's rollback bookkeeping is skipped for the attempt.
    const onClose = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`[${instanceId}] Socket closed before bind to port ${options.udpPort}`));
      }
    };
    startupSocket?.once("listening", onListen);
    startupSocket?.once("error", onError);
    startupSocket?.once("close", onClose);
    socketManager.bind(options.udpPort);
  });
}

/** Start the UDP server listener and its pipeline. */
export async function startServer(ctx: ConnectionContext): Promise<void> {
  const { state, app, instanceId, options, socketManager } = ctx;
  app.debug(`[${instanceId}] Starting server on port ${options.udpPort}`);
  state.socketUdp = socketManager.create();

  attachServerErrorHandler(ctx);

  state.socketUdp.on("listening", () => {
    if (!state.socketUdp) return;
    const addr = state.socketUdp.address();
    app.debug(`[${instanceId}] UDP server listening on ${addr.address}:${addr.port}`);
    state.readyToSend = true;
    ctx.setStatus(`Server listening on port ${addr.port}`, true);
  });

  attachServerPipeline(ctx);
  await bindAndAwaitListening(ctx);
}
