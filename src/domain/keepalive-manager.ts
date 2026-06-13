"use strict";

/**
 * Keepalive manager (L3 domain service).
 *
 * Owns the periodic "hello" / NAT-keepalive interval. When the link has been
 * idle for at least one hello interval it emits a keepalive so the path
 * through any intervening NAT/firewall stays open and the server keeps this
 * session identified:
 *
 *  - v2/v3: a real HELLO packet (`pipeline.sendHello`), which re-populates the
 *    server-side `session.clientId` that the telemetry-admission gate needs.
 *  - v1: the legacy empty-delta NAT keepalive, since v1 has no HELLO frame.
 *
 * Extracted from the `instance.ts` God Object. The interval handle lives on
 * the shared `state.helloMessageSender` so the connection's `stop()` can
 * cancel it; everything else is injected.
 *
 * @module domain/keepalive-manager
 */

import type { SignalKApp, ConnectionConfig, InstanceState, Delta } from "../types";

/** Default hello interval (seconds) when none is configured. */
const DEFAULT_HELLO_INTERVAL_SECONDS = 60;

/** Minimal v1-pipeline surface the keepalive falls back to (no v2/v3 HELLO). */
interface V1PipelineLike {
  packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
}

export interface KeepaliveManagerDeps {
  state: InstanceState;
  options: ConnectionConfig;
  app: SignalKApp;
  instanceId: string;
  getV1Pipeline: () => V1PipelineLike;
}

export interface KeepaliveManager {
  /** (Re)start the periodic hello/keepalive interval. */
  start(): void;
  /** Cancel the keepalive interval (safe no-op if not running). */
  stop(): void;
}

export function createKeepaliveManager(deps: KeepaliveManagerDeps): KeepaliveManager {
  const { state, options, app, instanceId, getV1Pipeline } = deps;

  function start(): void {
    const helloIntervalSeconds =
      typeof options.helloMessageSender === "number" && Number.isFinite(options.helloMessageSender)
        ? options.helloMessageSender
        : DEFAULT_HELLO_INTERVAL_SECONDS;
    const helloInterval = helloIntervalSeconds * 1000;

    // Clear any existing interval before creating a new one — prevents
    // duplicate hello intervals if start() is ever called more than once.
    // clearInterval(null | undefined) is a safe no-op, so no conditional needed.
    clearInterval(state.helloMessageSender ?? undefined);
    state.helloMessageSender = setInterval(async () => {
      try {
        const timeSinceLastPacket = Date.now() - state.lastPacketTime;
        if (!state.readyToSend) {
          app.debug(`[${instanceId}] Skipping hello (not ready)`);
        } else if (timeSinceLastPacket >= helloInterval) {
          // For v2/v3, send a real HELLO packet so the server can keep this
          // session identified across long idle periods or NAT rebinds.
          // sendHello populates `session.clientId` on the server, which the
          // `peerIdentified` gate in `_ingestRemoteTelemetry` requires before
          // telemetry is admitted. For v1 there is no HELLO frame, so we
          // fall back to the legacy empty-delta NAT keepalive.
          if (state.pipeline && typeof state.pipeline.sendHello === "function") {
            app.debug(`[${instanceId}] Sending periodic v2 HELLO`);
            await state.pipeline.sendHello(options.udpAddress ?? "", options.udpPort);
          } else {
            const mmsi = app.getSelfPath("mmsi") || "000000000";
            const fixedDelta = {
              context: "vessels.urn:mrn:imo:mmsi:" + mmsi,
              updates: [{ timestamp: new Date().toISOString(), values: [] }]
            };
            app.debug(`[${instanceId}] Sending hello message`);
            if (state.pipeline) {
              await state.pipeline.sendDelta(
                [fixedDelta],
                options.secretKey,
                options.udpAddress ?? "",
                options.udpPort
              );
            } else {
              await getV1Pipeline().packCrypt(
                [fixedDelta],
                options.secretKey,
                options.udpAddress ?? "",
                options.udpPort
              );
            }
          }
        } else {
          app.debug(`[${instanceId}] Skipping hello (last packet ${timeSinceLastPacket}ms ago)`);
        }
      } catch (err: unknown) {
        app.error(
          `[${instanceId}] Hello message send error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, helloInterval);
  }

  function stop(): void {
    clearInterval(state.helloMessageSender ?? undefined);
    state.helloMessageSender = null;
  }

  return { start, stop };
}
