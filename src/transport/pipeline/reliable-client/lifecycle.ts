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
import {
  HELLO_REFRESH_INTERVAL_MS,
  HELLO_REHANDSHAKE_ACK_IDLE_MS,
  HELLO_RETRY_BASE_MS,
  HELLO_RETRY_MAX_MS
} from "../../../foundation/constants";
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
    setStatus("UDP socket not initialized - cannot send data", false);
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
  const { app, state, packetBuilder, protocolVersion, connectionEpoch, mut } = ctx;

  // A new handshake attempt supersedes any in-flight retry schedule.
  stopHelloRetry(ctx);
  mut.helloAcknowledged = false;
  mut.helloRetryDelay = HELLO_RETRY_BASE_MS;
  mut.lastHelloSentAt = Date.now();

  try {
    const helloPacket = packetBuilder.buildHelloPacket({
      protocolVersion,
      clientId: state.instanceId || "",
      instanceId: state.instanceId || "",
      epoch: connectionEpoch
    });
    await udpSendAsync(ctx, helloPacket, udpAddress, udpPort);
    state.lastPacketTime = Date.now();
    app.debug("v3 HELLO sent");
  } catch (err: unknown) {
    app.debug(`v3 HELLO send failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // HELLO is unacknowledged at the packet level, so a single lost datagram
  // would otherwise leave the server with no epoch for this peer for the life
  // of the session — anti-replay stays disarmed and telemetry is dropped as
  // unidentified. Keep retrying until a control packet proves otherwise.
  scheduleHelloRetry(ctx, udpAddress, udpPort);
}

/** Cancel any pending HELLO retry. */
export function stopHelloRetry(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.helloRetryTimer) {
    clearTimeout(mut.helloRetryTimer);
    mut.helloRetryTimer = null;
  }
}

/**
 * Mark the HELLO handshake confirmed. Any control packet from the server proves
 * it has a session bound to this source port, which is exactly what HELLO
 * establishes.
 */
export function confirmHelloAcknowledged(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.helloAcknowledged) return;
  mut.helloAcknowledged = true;
  stopHelloRetry(ctx);
  ctx.app.debug("v3 HELLO handshake confirmed");
}

/**
 * Re-run the handshake when a previously confirmed session has gone silent.
 *
 * `confirmHelloAcknowledged` latches, which is right for the initial handshake
 * but leaves no way back if the *peer* loses the session afterwards — a server
 * restart drops its epoch and replay-guard state, and a NAT rebind moves us to
 * a source port it never handshaked. Either way the server refuses every DATA
 * packet and therefore never sends the ACK that would tell us something is
 * wrong, so silence is the only signal available.
 *
 * Called from the metrics tick. Sending a redundant HELLO is cheap and
 * idempotent server-side; staying silent is not recoverable.
 */
export function maybeRehandshake(ctx: ClientContext): void {
  const { state, mut } = ctx;
  if (state.stopped || !mut.helloAcknowledged) return;
  if (ctx.protocolVersion < 3) return;

  const options = state.options;
  if (!options || !options.udpAddress) return;

  // Only meaningful once we have actually sent something the peer owed an ACK
  // for. An idle client with an empty queue has nothing to diagnose.
  if (ctx.retransmitQueue.getSize() === 0) return;

  if (Date.now() - mut.lastAckAt < HELLO_REHANDSHAKE_ACK_IDLE_MS) return;

  ctx.app.debug(
    `v3 no ACK for ${HELLO_REHANDSHAKE_ACK_IDLE_MS}ms with packets outstanding — re-running HELLO handshake`
  );
  // Resets `helloAcknowledged` and restarts the retry chain.
  void sendHello(ctx, options.udpAddress, options.udpPort);
}

function scheduleHelloRetry(ctx: ClientContext, udpAddress: string, udpPort: number): void {
  const { app, state, packetBuilder, protocolVersion, connectionEpoch, mut } = ctx;
  if (mut.helloAcknowledged || state.stopped) return;

  mut.helloRetryTimer = setTimeout(() => {
    mut.helloRetryTimer = null;
    if (mut.helloAcknowledged || state.stopped) return;

    (async () => {
      try {
        const helloPacket = packetBuilder.buildHelloPacket({
          protocolVersion,
          clientId: state.instanceId || "",
          instanceId: state.instanceId || "",
          epoch: connectionEpoch
        });
        await udpSendAsync(ctx, helloPacket, udpAddress, udpPort);
        state.lastPacketTime = Date.now();
        mut.lastHelloSentAt = Date.now();
        app.debug(`v3 HELLO retried (backoff ${mut.helloRetryDelay}ms)`);
      } catch (err: unknown) {
        app.debug(`v3 HELLO retry failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      mut.helloRetryDelay = Math.min(mut.helloRetryDelay * 2, HELLO_RETRY_MAX_MS);
      scheduleHelloRetry(ctx, udpAddress, udpPort);
    })();
  }, mut.helloRetryDelay);

  // Never hold the event loop open for a retry.
  if (typeof mut.helloRetryTimer?.unref === "function") {
    mut.helloRetryTimer.unref();
  }
}

/**
 * Re-send HELLO on a fixed cadence so a server that lost its session state
 * without going silent regains this client's identity and anti-replay epoch.
 * `maybeRehandshake` only covers the silent case: a server restarted faster
 * than the ACK-idle threshold (or a session idle-expired and re-minted by
 * DATA) resumes ACKing immediately, so the idle triggers never fire and the
 * re-minted session keeps no client identity and epoch 0 — telemetry
 * unattributed, anti-replay disarmed — for the life of the connection.
 */
export function maybeRefreshHello(ctx: ClientContext, udpAddress: string, udpPort: number): void {
  const { state, mut } = ctx;
  if (state.stopped || ctx.protocolVersion < 3) return;
  if (Date.now() - mut.lastHelloSentAt < HELLO_REFRESH_INTERVAL_MS) return;
  ctx.app.debug("v3 periodic HELLO refresh");
  void sendHello(ctx, udpAddress, udpPort);
}

export function startHeartbeat(
  ctx: ClientContext,
  udpAddress: string,
  udpPort: number,
  options?: { heartbeatInterval?: number }
): { stop: () => void } {
  const { app, state, packetBuilder, mut } = ctx;
  const HEARTBEAT_INTERVAL = (options && options.heartbeatInterval) || 25000; // default 25 seconds

  // Idempotent, and owned by `mut` so pipeline.stop() clears it even when the
  // caller discards the returned handle.
  stopHeartbeat(ctx);
  const timer = setInterval(async () => {
    // A stop() that raced this interval's creation would otherwise leave it
    // sending real UDP traffic with no handle left to clear it.
    if (state.stopped) {
      stopHeartbeat(ctx);
      return;
    }
    try {
      const heartbeatPacket = packetBuilder.buildHeartbeatPacket();
      await udpSendAsync(ctx, heartbeatPacket, udpAddress, udpPort);
      state.lastPacketTime = Date.now();
      app.debug("v3 heartbeat sent (NAT keepalive)");
    } catch (err: unknown) {
      app.debug(`v3 heartbeat send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A stop can land while this tick was awaiting the send; a HELLO refresh
    // from a disowned tick would re-arm the retry chain after pipeline.stop().
    if (mut.heartbeatTimer !== timer) {
      return;
    }
    maybeRefreshHello(ctx, udpAddress, udpPort);
  }, HEARTBEAT_INTERVAL);
  mut.heartbeatTimer = timer;

  return {
    stop() {
      stopHeartbeat(ctx);
    }
  };
}

/** Clear the heartbeat interval (safe no-op when none is running). */
export function stopHeartbeat(ctx: ClientContext): void {
  const { mut } = ctx;
  if (mut.heartbeatTimer) {
    clearInterval(mut.heartbeatTimer);
    mut.heartbeatTimer = null;
  }
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

  bondingManager.onControlPacket((_linkName: string, msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (!mut.bondingManager) {
      return;
    }
    // Pass the datagram's actual source through. Deriving it from the link's
    // configured address instead made `isExpectedPeer` compare the peer against
    // itself, so it always matched and the off-path spoofing check silently did
    // nothing on bonded connections.
    handleControlPacket(ctx, msg, rinfo);
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
