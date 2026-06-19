"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline
 *
 * Handles delta reception over the v3 reliable transport:
 * - Packet parsing and validation
 * - Sequence tracking with loss detection
 * - Decryption and decompression (reuses v1 pipeline logic)
 * - Signal K message handling
 * - Periodic ACK generation for reliability
 * - NAK generation on packet loss detection
 *
 * Thin wiring layer: the inbound packet dispatcher, per-packet-type handlers,
 * session management, telemetry ingestion and metrics publishing live in
 * ./reliable-server/* and take a shared `ServerContext` as an explicit
 * parameter. This factory constructs the context and returns the public
 * `ServerPipelineApi`.
 *
 * @module transport/pipeline/reliable-server
 */

import { METRICS_PUBLISH_INTERVAL } from "../../foundation/constants";
import type { SignalKApp, MetricsApi, InstanceState } from "../../foundation/types";
import { createServerContext, type ServerContext } from "./reliable-server/context";
import {
  getFirstSessionTracker,
  expireIdleSessions,
  sendPeriodicACKs,
  sendFullStatusRequest
} from "./reliable-server/sessions";
import { publishServerMetrics } from "./reliable-server/metrics-publish";
import { receivePacket } from "./reliable-server/receive";

/** Start the periodic ACK timer (also expires idle sessions each tick). */
function startACKTimer(ctx: ServerContext): void {
  if (ctx.mut.ackTimer) {
    return;
  }
  ctx.mut.ackTimer = setInterval(() => {
    expireIdleSessions(ctx);
    sendPeriodicACKs(ctx).catch((err: unknown) => {
      ctx.app.error(`Periodic ACK error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, ctx.ackInterval);
}

/** Stop the periodic ACK timer. */
function stopACKTimer(ctx: ServerContext): void {
  if (ctx.mut.ackTimer) {
    clearInterval(ctx.mut.ackTimer);
    ctx.mut.ackTimer = null;
  }
}

/** Start periodic metrics publishing (every METRICS_PUBLISH_INTERVAL ms). */
function startMetricsPublishing(ctx: ServerContext): void {
  if (ctx.mut.metricsInterval) {
    return;
  }
  ctx.mut.lastMetricsTime = Date.now();
  ctx.mut.lastBytesReceived = ctx.metrics.bandwidth.bytesIn;
  ctx.mut.lastPacketsReceived = ctx.metrics.bandwidth.packetsIn;

  ctx.mut.metricsInterval = setInterval(() => {
    publishServerMetrics(ctx);
  }, METRICS_PUBLISH_INTERVAL);
}

/** Stop periodic metrics publishing. */
function stopMetricsPublishing(ctx: ServerContext): void {
  if (ctx.mut.metricsInterval) {
    clearInterval(ctx.mut.metricsInterval);
    ctx.mut.metricsInterval = null;
  }
}

/** Get server pipeline metrics including per-session state. */
function getServerMetrics(ctx: ServerContext): Record<string, unknown> {
  const { clientSessions, metrics, state } = ctx;
  const sessions = [...clientSessions.values()].map((s) => ({
    address: s.key,
    expectedSeq: s.sequenceTracker.expectedSeq,
    receivedCount: s.sequenceTracker.receivedSeqs.size,
    pendingNAKs: s.sequenceTracker.nakTimers.size,
    lastAckSeq: s.lastAckSeq,
    hasReceivedData: s.hasReceivedData,
    lastPacketTime: s.lastPacketTime
  }));
  return {
    sessions,
    totalSessions: clientSessions.size,
    acksSent: metrics.acksSent,
    naksSent: metrics.naksSent,
    sourceReplication: state.sourceRegistry ? state.sourceRegistry.getMetrics() : null
  };
}

/**
 * Send FULL_STATUS_REQUEST to every currently-connected client session.
 * Called when this server instance itself receives a FULL_STATUS_REQUEST from
 * an upstream server, so the request cascades down the chain:
 * Cloud → Proxy (triggers this) → Boat.
 */
function requestFullStatusFromAllClients(ctx: ServerContext): void {
  const { app, state, clientSessions } = ctx;
  const secretKey = state.options?.secretKey ?? "";
  for (const session of clientSessions.values()) {
    sendFullStatusRequest(ctx, session, secretKey).catch((err: unknown) => {
      app.debug(
        `[v2-server] cascade FULL_STATUS_REQUEST to ${session.key} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}

/**
 * Full teardown for plugin stop/restart. Clears the periodic ACK and metrics
 * timers, then resets EVERY per-session SequenceTracker (each may hold pending
 * NAK setTimeout handles) and drops all sessions so their buffers can be GC'd.
 */
function stopServer(ctx: ServerContext): void {
  stopACKTimer(ctx);
  stopMetricsPublishing(ctx);
  for (const session of ctx.clientSessions.values()) {
    session.sequenceTracker.reset();
  }
  ctx.clientSessions.clear();
}

/**
 * Creates the v3 reliable server pipeline.
 * @param app        - SignalK app object (for logging)
 * @param state      - Shared mutable state
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API
 */
function createPipelineV2Server(app: SignalKApp, state: InstanceState, metricsApi: MetricsApi) {
  const ctx = createServerContext({ app, state, metricsApi });

  return {
    receivePacket: (packet: Buffer, secretKey: string, rinfo?: { address: string; port: number }) =>
      receivePacket(ctx, packet, secretKey, rinfo),
    getSequenceTracker: () => getFirstSessionTracker(ctx),
    getPacketBuilder: () => ctx.packetBuilder,
    getMetrics: () => getServerMetrics(ctx),
    getMetricsPublisher: () => ctx.metricsPublisher,
    startACKTimer: () => startACKTimer(ctx),
    stopACKTimer: () => stopACKTimer(ctx),
    startMetricsPublishing: () => startMetricsPublishing(ctx),
    stopMetricsPublishing: () => stopMetricsPublishing(ctx),
    requestFullStatusFromAllClients: () => requestFullStatusFromAllClients(ctx),
    stop: () => stopServer(ctx)
  };
}

export { createPipelineV2Server };
