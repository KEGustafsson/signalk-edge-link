"use strict";

/**
 * Shared pipeline utilities used by both v1 and v2 client pipelines.
 *
 * @module lib/pipeline-utils
 */

import { promisify } from "util";
import * as zlib from "zlib";
import * as msgpack from "@msgpack/msgpack";
import {
  BROTLI_QUALITY_HIGH,
  UDP_RETRY_MAX,
  UDP_RETRY_DELAY,
  UDP_SEND_TIMEOUT_MS
} from "./constants";
import type * as dgram from "dgram";

export const brotliCompressAsync = promisify(zlib.brotliCompress);
export const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Converts delta object to buffer (JSON or MessagePack)
 * @param delta - Delta object or array to convert
 * @param useMsgpack - Whether to use MessagePack serialization
 * @returns Encoded buffer
 */
export function deltaBuffer(delta: unknown, useMsgpack = false): Buffer {
  if (useMsgpack) {
    return Buffer.from(msgpack.encode(delta));
  }
  return Buffer.from(JSON.stringify(delta), "utf8");
}

/**
 * Compress data using Brotli with mode-appropriate settings.
 * @param data - Data to compress
 * @param useMsgpack - Whether the data is MessagePack (generic) or JSON (text)
 * @returns Compressed data
 */
export function compressPayload(data: Buffer, useMsgpack: boolean): Promise<Buffer> {
  return brotliCompressAsync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: useMsgpack
        ? zlib.constants.BROTLI_MODE_GENERIC
        : zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_HIGH,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    }
  }) as Promise<Buffer>;
}

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

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(
      () => reject(new Error(`UDP send timed out after ${UDP_SEND_TIMEOUT_MS}ms`)),
      UDP_SEND_TIMEOUT_MS
    )
  );

  return Promise.race([sendPromise, timeoutPromise]);
}
