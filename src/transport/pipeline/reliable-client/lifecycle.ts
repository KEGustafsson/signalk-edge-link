"use strict";

/**
 * Signal K Edge Link - reliable client lifecycle + transport.
 *
 * Extracted from the reliable client factory: UDP send (bonding-aware),
 * congestion control timers, HELLO / heartbeat emission, and bonding
 * init/teardown.
 *
 * @module transport/pipeline/reliable-client/lifecycle
 */

import { BondingManager } from "../../bonding";
import { udpSendAsync as _udpSendAsyncShared } from "../../udp-socket-manager";
import type * as dgram from "dgram";
import type { ClientContext } from "./context";
import { handleControlPacket } from "./control-packets";

/**
 * Send a message via UDP with retry logic (delegates to shared utility).
 * When bonding is active, uses the bonding manager's active socket+address.
 */
export function udpSendAsync(
  ctx: ClientContext,
  message: Buffer,
  host: string,
  port: number
): Promise<void> {
  const { app, state, metricsApi, setStatus, mut } = ctx;
  const { metrics, recordError } = metricsApi;
  let socket: dgram.Socket | undefined;
  let sendHost = host;
  let sendPort = port;

  if (mut.bondingManager) {
    // getActiveDestination() reads socket + address atomically so a failover
    // between two separate getActive*() calls cannot produce a mismatched
    // socket/destination pair.
    const dest = mut.bondingManager.getActiveDestination();
    socket = dest.socket ?? undefined;
    sendHost = dest.address;
    sendPort = dest.port;
  } else {
    socket = state.socketUdp ?? undefined;
  }

  if (!socket) {
    const error = new Error("UDP socket not initialized, cannot send message");
    app.error(error.message);
    setStatus("UDP socket not initialized - cannot send data");
    throw error;
  }

  return _udpSendAsyncShared(socket, message, sendHost, sendPort, {
    onRetry(retryCount: number, err: NodeJS.ErrnoException) {
      metrics.udpRetries++;
      app.debug(`UDP send error (${err.code}), retry ${retryCount}/${3}`);
    },
    onError(err: NodeJS.ErrnoException, retryCount: number) {
      metrics.udpSendErrors++;
      app.error(`UDP send error to ${sendHost}:${sendPort} - ${err.message} (code: ${err.code})`);
      recordError("udpSend", `UDP send error: ${err.message} (${err.code})`);
      if (retryCount >= 3) {
        app.error("Max retries reached, packet dropped");
      }
    }
  });
}

export function startCongestionControl(ctx: ClientContext): void {
  const { app, state, congestionControl, mut } = ctx;
  if (mut.congestionAdjustInterval) {
    return;
  }

  mut.congestionAdjustInterval = setInterval(() => {
    const oldTimer = congestionControl.getCurrentDeltaTimer();
    const newTimer = congestionControl.adjust();
    if (newTimer !== oldTimer) {
      app.debug(
        `Congestion control: delta timer ${oldTimer} -> ${newTimer}ms (avgRTT=${Math.round(congestionControl.getAvgRTT())}ms, avgLoss=${(congestionControl.getAvgLoss() * 100).toFixed(2)}%)`
      );
      state.deltaTimerTime = newTimer;
    }
  }, 1000);
}

export function stopCongestionControl(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.congestionAdjustInterval) {
    clearInterval(mut.congestionAdjustInterval);
    mut.congestionAdjustInterval = null;
  }
}

/**
 * Send a HELLO packet to identify this client to the server. Callers MUST
 * invoke this once after socket creation and again after every socket
 * recovery, otherwise the server drops every client-published telemetry delta.
 */
export async function sendHello(
  ctx: ClientContext,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, state, packetBuilder, protocolVersion } = ctx;
  try {
    const helloPacket = packetBuilder.buildHelloPacket({
      protocolVersion,
      clientId: state.instanceId || "",
      instanceId: state.instanceId || ""
    });
    await udpSendAsync(ctx, helloPacket, udpAddress, udpPort);
    state.lastPacketTime = Date.now();
    app.debug("v3 HELLO sent");
  } catch (err: unknown) {
    app.debug(`v3 HELLO send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startHeartbeat(
  ctx: ClientContext,
  udpAddress: string,
  udpPort: number,
  options?: { heartbeatInterval?: number }
): { stop: () => void } {
  const { app, state, packetBuilder } = ctx;
  const HEARTBEAT_INTERVAL = (options && options.heartbeatInterval) || 25000; // default 25 seconds
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  heartbeatTimer = setInterval(async () => {
    try {
      const heartbeatPacket = packetBuilder.buildHeartbeatPacket();
      await udpSendAsync(ctx, heartbeatPacket, udpAddress, udpPort);
      state.lastPacketTime = Date.now();
      app.debug("v3 heartbeat sent (NAT keepalive)");
    } catch (err: unknown) {
      app.debug(`v3 heartbeat send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, HEARTBEAT_INTERVAL);

  return {
    stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  };
}

export async function initBonding(
  ctx: ClientContext,
  bondingConfig: Record<string, unknown>
): Promise<BondingManager> {
  const { app, metricsPublisher, mut } = ctx;
  const bondingManager = new BondingManager(
    bondingConfig as unknown as {
      mode?: string;
      primary: { address: string; port: number; interface?: string };
      backup: { address: string; port: number; interface?: string };
      failover?: Record<string, unknown>;
      instanceId?: string;
      notificationsEnabled?: boolean;
    },
    app
  );
  mut.bondingManager = bondingManager;
  bondingManager.setMetricsPublisher(metricsPublisher);

  bondingManager.onControlPacket((linkName: string, msg: Buffer) => {
    if (!mut.bondingManager) {
      return;
    }
    const linkHealth = mut.bondingManager.getLinkHealth();
    const link = linkHealth[linkName];
    handleControlPacket(ctx, msg, {
      address: link?.address ?? "127.0.0.1",
      port: link?.port ?? 0,
      family: "IPv4",
      size: msg.length
    });
  });

  try {
    await bondingManager.initialize();
    return bondingManager;
  } catch (error: unknown) {
    // Initialization may throw after partially opening sockets. Clear the
    // shared reference so later sends cannot route through a half-built
    // manager, and best-effort stop the failed instance to release resources.
    if (mut.bondingManager === bondingManager) {
      mut.bondingManager = null;
    }
    try {
      bondingManager.stop();
    } catch (stopError: unknown) {
      app.debug(
        `Bonding cleanup after failed initialize failed: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`
      );
    }
    throw error;
  }
}

export function stopBonding(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.bondingManager) {
    mut.bondingManager.stop();
    mut.bondingManager = null;
  }
}
