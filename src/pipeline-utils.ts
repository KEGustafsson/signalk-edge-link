"use strict";

/**
 * Shared pipeline utilities used by both v1 and v2 client pipelines.
 *
 * The Brotli/serialization helpers were re-homed to the L1 codec layer
 * (`codec/compression.ts`) during the rewrite and are re-exported here so the
 * existing `./pipeline-utils` imports keep working. `udpSendAsync` is socket
 * I/O and stays here until it moves into the transport layer's
 * `UdpSocketManager` in Phase 2 (rewrite plan doc 05).
 *
 * @module lib/pipeline-utils
 */

import { UDP_RETRY_MAX, UDP_RETRY_DELAY, UDP_SEND_TIMEOUT_MS } from "./constants";
import type * as dgram from "dgram";

export {
  brotliCompressAsync,
  brotliDecompressAsync,
  deltaBuffer,
  compressPayload
} from "./codec/compression";

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

  // Race the real send against a hard timeout so a blocked or saturated OS
  // send buffer doesn't stall the pipeline indefinitely.
  const sendPromise = new Promise<void>((resolve, reject) => {
    socket.send(message, port, host, async (error) => {
      if (error) {
        const err = error as NodeJS.ErrnoException;
        if (retryCount < UDP_RETRY_MAX && (err.code === "EAGAIN" || err.code === "ENOBUFS")) {
          if (callbacks.onRetry) {
            callbacks.onRetry(retryCount + 1, err);
          }
          // Exponential back-off: 100ms, 200ms, 400ms for attempts 0, 1, 2.
          await new Promise((res) => setTimeout(res, UDP_RETRY_DELAY * Math.pow(2, retryCount)));
          try {
            await udpSendAsync(socket, message, host, port, callbacks, retryCount + 1);
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
    timeoutHandle = setTimeout(
      () => reject(new Error(`UDP send timed out after ${UDP_SEND_TIMEOUT_MS}ms`)),
      UDP_SEND_TIMEOUT_MS
    );
  });

  return Promise.race([sendPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}
