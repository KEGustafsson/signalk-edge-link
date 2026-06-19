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
import type { ConnectionContext } from "./context";

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
  });
}

/** Wire the reliable (v2/v3) or legacy (v1) server pipeline message handlers. */
function attachServerPipeline(ctx: ConnectionContext): void {
  const { state, app, instanceId, options, appProxy, metricsApi } = ctx;
  const useReliable = (options.protocolVersion ?? 0) >= 2;
  if (useReliable) {
    const { createPipelineV2Server } = require("../../transport/pipeline/reliable-server");
    const srv = createPipelineV2Server(appProxy, state, metricsApi);
    state.pipelineServer = srv;
    state.socketUdp?.on("message", (pkt: Buffer, rinfo: dgram.RemoteInfo) => {
      srv.receivePacket(pkt, options.secretKey, rinfo);
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
    startupSocket?.once("listening", onListen);
    startupSocket?.once("error", onError);
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
