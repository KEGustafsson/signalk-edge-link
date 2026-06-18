"use strict";

/**
 * Signal K Edge Link - reliable client control-packet dispatch.
 *
 * Extracted from the v2 client factory: `handleControlPacket` and the
 * request-handler invocation guards (META_REQUEST / FULL_STATUS_REQUEST).
 *
 * @module transport/pipeline/reliable-client/control-packets
 */

import { PacketType } from "../../../codec/packet-codec";
import type * as dgram from "dgram";
import type { ClientContext } from "./context";
import { receiveACK, receiveNAK } from "./reliability";

/**
 * Invoke a request handler (META_REQUEST / FULL_STATUS_REQUEST) defensively:
 * any thenable rejection or synchronous throw is logged at debug level so it
 * never bubbles into the control-packet parse error path.
 */
function invokeRequestHandler(
  ctx: ClientContext,
  handler: (() => void) | null,
  label: string
): void {
  const { app } = ctx;
  if (!handler) {
    return;
  }
  try {
    // Wrap in Promise.resolve so any thenable returned by the handler — not
    // just real Promises — gets a .catch attached.
    Promise.resolve(handler() as unknown).catch((err: unknown) => {
      app.debug(`${label} handler rejected: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    app.debug(`${label} handler error: ${errMsg}`);
  }
}

/**
 * Handle incoming control packets (ACK/NAK/META_REQUEST/FULL_STATUS_REQUEST)
 * from the server. Called when data is received on the UDP socket.
 */
export async function handleControlPacket(
  ctx: ClientContext,
  msg: Buffer,
  rinfo: dgram.RemoteInfo
): Promise<void> {
  const { app, metricsApi, packetParser, mut } = ctx;
  const { metrics } = metricsApi;
  try {
    if (!packetParser.isV2Packet(msg)) {
      return;
    }

    const parsed = packetParser.parseHeader(msg);

    if (parsed.type === PacketType.ACK) {
      receiveACK(ctx, parsed, rinfo);
    } else if (parsed.type === PacketType.NAK) {
      await receiveNAK(ctx, parsed, rinfo.address, rinfo.port);
    } else if (parsed.type === PacketType.META_REQUEST) {
      // Receiver asks us to re-send the full meta snapshot. Rate-limited in
      // the handler (instance.ts).
      invokeRequestHandler(ctx, mut.metaRequestHandler, "META_REQUEST");
    } else if (parsed.type === PacketType.FULL_STATUS_REQUEST) {
      // Server asks us to replay our full values snapshot (e.g. after a server
      // restart). Rate-limited in instance.ts.
      invokeRequestHandler(ctx, mut.fullStatusRequestHandler, "FULL_STATUS_REQUEST");
    }
    // Ignore other packet types on client side
  } catch (err: unknown) {
    // Ignore parse errors (might be corrupted packet)
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.debug(
      `Failed to parse control packet: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
