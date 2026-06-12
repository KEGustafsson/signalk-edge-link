"use strict";

/**
 * Signal K Edge Link - UDP Socket Manager (L2 transport)
 *
 * Owns the lifecycle of a single UDP (`dgram`) socket: create, bind, send and
 * close. It consolidates the three near-identical socket-setup sites that used
 * to live inline in the `instance.ts` God Object and absorbs the shared
 * `udpSendAsync` retry/timeout helper (previously in `pipeline-utils.ts`).
 *
 * The created socket is returned to the caller so existing consumers (the v1
 * and reliable pipelines) can keep reading `state.socketUdp` directly. Event
 * wiring (message/error/listening) and the higher-level recovery orchestration
 * remain with the caller for now; fuller lifecycle ownership (event forwarding
 * and a combined recover step) lands with the Phase 4 `connection.ts` rewrite.
 *
 * @module transport/udp-socket-manager
 */

import * as dgram from "dgram";
import { UDP_RETRY_MAX, UDP_RETRY_DELAY, UDP_SEND_TIMEOUT_MS } from "../foundation/constants";

interface UdpSendCallbacks {
  onRetry?: (retryCount: number, error: NodeJS.ErrnoException) => void;
  onError?: (error: NodeJS.ErrnoException, retryCount: number) => void;
}

/**
 * Sends a message via UDP with retry logic for transient errors.
 *
 * @param socket - dgram UDP socket
 * @param message - Message to send
 * @param host - Destination host address
 * @param port - Destination port number
 * @param callbacks - Optional callbacks for metrics/logging
 * @param retryCount - Current retry count (internal)
 * @returns Promise resolving when message is sent
 */
export function udpSendAsync(
  socket: dgram.Socket | null,
  message: Buffer,
  host: string,
  port: number,
  callbacks: UdpSendCallbacks = {},
  retryCount = 0
): Promise<void> {
  if (!socket) {
    throw new Error("UDP socket not initialized, cannot send message");
  }
  // The cancellation flag is retry-control state internal to the module, so it
  // is kept out of the public signature: each top-level send starts a fresh one
  // and shares it across the retry chain via sendWithRetry.
  return sendWithRetry(socket, message, host, port, callbacks, retryCount, { aborted: false });
}

/**
 * Internal retry/timeout engine for {@link udpSendAsync}. The `cancellation`
 * flag is shared across the retry chain; the hard timeout sets it so any
 * pending back-off stops retrying and callbacks are suppressed once the caller
 * has given up.
 */
function sendWithRetry(
  socket: dgram.Socket,
  message: Buffer,
  host: string,
  port: number,
  callbacks: UdpSendCallbacks,
  retryCount: number,
  cancellation: { aborted: boolean }
): Promise<void> {
  // Race the real send against a hard timeout so a blocked or saturated OS
  // send buffer doesn't stall the pipeline indefinitely.
  const sendPromise = new Promise<void>((resolve, reject) => {
    socket.send(message, port, host, async (error) => {
      if (error) {
        const err = error as NodeJS.ErrnoException;
        // If the caller already timed out, stop here: no retry, no callbacks.
        if (cancellation.aborted) {
          reject(err);
          return;
        }
        if (retryCount < UDP_RETRY_MAX && (err.code === "EAGAIN" || err.code === "ENOBUFS")) {
          if (callbacks.onRetry) {
            callbacks.onRetry(retryCount + 1, err);
          }
          // Exponential back-off: 100ms, 200ms, 400ms for attempts 0, 1, 2.
          await new Promise((res) => setTimeout(res, UDP_RETRY_DELAY * Math.pow(2, retryCount)));
          // Re-check after the back-off — the timeout may have fired meanwhile.
          if (cancellation.aborted) {
            reject(err);
            return;
          }
          try {
            await sendWithRetry(
              socket,
              message,
              host,
              port,
              callbacks,
              retryCount + 1,
              cancellation
            );
            resolve();
          } catch (retryError) {
            reject(retryError);
          }
        } else {
          if (callbacks.onError) {
            callbacks.onError(err, retryCount);
          }
          reject(err);
        }
      } else {
        resolve();
      }
    });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      cancellation.aborted = true;
      reject(new Error(`UDP send timed out after ${UDP_SEND_TIMEOUT_MS}ms`));
    }, UDP_SEND_TIMEOUT_MS);
  });

  return Promise.race([sendPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

/**
 * Manages a single UDP socket's create/bind/send/close lifecycle.
 *
 * Every socket is created with the same options the plugin has always used
 * (`{ type: "udp4", reuseAddr: true }`), centralising what were three separate
 * inline `dgram.createSocket` calls (server start, client start, client
 * recovery) into one place.
 */
export class UdpSocketManager {
  socket: dgram.Socket | null = null;

  /**
   * Create a fresh udp4 socket and retain it as the managed socket. Any
   * previously managed socket reference is replaced (callers close the old
   * one explicitly via {@link close} as part of their recovery flow).
   */
  create(): dgram.Socket {
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    return this.socket;
  }

  /** Bind the managed socket to a local port (server listen). */
  bind(port: number): void {
    if (!this.socket) {
      throw new Error("UDP socket not initialized, cannot bind");
    }
    this.socket.bind(port);
  }

  /** Send a message over the managed socket with retry/timeout handling. */
  send(
    message: Buffer,
    host: string,
    port: number,
    callbacks: UdpSendCallbacks = {}
  ): Promise<void> {
    return udpSendAsync(this.socket, message, host, port, callbacks);
  }

  /** Return the bound socket address, or undefined when no socket exists. */
  address(): ReturnType<dgram.Socket["address"]> | undefined {
    return this.socket ? this.socket.address() : undefined;
  }

  /** Close the managed socket (safe no-op if already closed) and drop it. */
  close(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_e) {
        /* already closed */
      }
      this.socket = null;
    }
  }
}
