"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: packet dispatcher
 *
 * Thin entry point for inbound UDP packets: heartbeat-probe reflection,
 * version/auth gating, and per-packet-type dispatch (HELLO / METADATA / DATA /
 * control). Each packet type's logic lives in a focused handler.
 *
 * @module transport/pipeline/reliable-server/receive
 */

import { DecryptError } from "../../../foundation/result";
import { PacketType, ParsedPacket } from "../../../codec/packet-codec";
import { getOrCreateSession, sendUDP, sendMetaRequest, sendFullStatusRequest } from "./sessions";
import { handleMetadataPacket } from "./metadata";
import { handleDataPacket } from "./data-handler";
import { preAuthRateLimited, verifyHbProbe, applyHelloEpoch } from "./context";
import type { ServerContext, ClientSession } from "./context";

import {
  UDP_RATE_LIMIT_WINDOW,
  UDP_RATE_LIMIT_MAX_PACKETS,
  HELLO_PAYLOAD_MAX_BYTES
} from "../../../foundation/constants";

/**
 * Handle a verified bonding heartbeat probe (HBPROBE). Returns true when the
 * packet was a probe (and was handled/dropped), so the dispatcher can stop.
 */
async function handleHeartbeatProbe(
  ctx: ServerContext,
  packet: Buffer,
  rinfo?: { address: string; port: number }
): Promise<boolean> {
  const { app, metrics } = ctx;
  if (!(packet.length >= 12 && packet.toString("ascii", 0, 7) === "HBPROBE")) {
    return false;
  }
  if (rinfo) {
    if (preAuthRateLimited(ctx, rinfo.address)) {
      metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
      return true;
    }
    if (!verifyHbProbe(ctx, packet)) {
      metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
      app.debug(`[v2-server] dropping unverified HBPROBE from ${rinfo.address}:${rinfo.port}`);
      return true;
    }
    await sendUDP(ctx, packet, { address: rinfo.address, port: rinfo.port });
  }
  return true;
}

/**
 * Validate protocol version and authenticatedHeaders for a parsed packet.
 * Returns false (after recording the metric/warning) when the packet must be
 * dropped.
 */
function isPacketAccepted(ctx: ServerContext, parsed: ParsedPacket): boolean {
  const { app, metrics, protocolVersion, authenticatedHeaders, mut } = ctx;
  const { PROTOCOL_VERSION_MISMATCH_WARN_INTERVAL_MS } = ctx;

  // Pin protocol version per server so a MITM cannot inject forged v2 control
  // frames that lack HMAC authentication.
  if (parsed.version !== protocolVersion) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.debug(
      `v2 rejecting packet with mismatched protocol version: got=${parsed.version} expected=${protocolVersion}`
    );
    const now = Date.now();
    if (now - mut.lastProtocolVersionMismatchWarnAt >= PROTOCOL_VERSION_MISMATCH_WARN_INTERVAL_MS) {
      mut.lastProtocolVersionMismatchWarnAt = now;
      app.error(
        `v2 protocol version mismatch: got=${parsed.version} expected=${protocolVersion} (malformedPackets=${metrics.malformedPackets}); check peer configuration`
      );
    }
    return false;
  }

  // Diagnose an authenticatedHeaders mismatch early with the real cause.
  if (
    !authenticatedHeaders &&
    parsed.flags.authenticatedHeader &&
    (parsed.type === PacketType.DATA || parsed.type === PacketType.METADATA)
  ) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    const now = Date.now();
    if (now - mut.lastAuthHeaderMismatchWarnAt >= PROTOCOL_VERSION_MISMATCH_WARN_INTERVAL_MS) {
      mut.lastAuthHeaderMismatchWarnAt = now;
      app.error(
        "v2 authenticatedHeaders mismatch: peer is sending authenticated packet headers but " +
          "this connection has authenticatedHeaders disabled. Enable it on both ends (or disable on both)."
      );
    }
    return false;
  }
  return true;
}

/** Apply HELLO identity to the session (clientId / sourceClientInstanceId). */
function applyHelloIdentity(session: ClientSession, info: Record<string, unknown>): void {
  const helloClientId =
    typeof info.clientId === "string" && info.clientId.trim() ? info.clientId.trim() : null;
  const helloInstanceId =
    typeof info.instanceId === "string" && info.instanceId.trim() ? info.instanceId.trim() : null;
  session.clientId = helloClientId;
  // Bind sourceClientInstanceId to a verified address so a peer cannot claim
  // another peer's instance bucket in the source registry by faking instanceId.
  const peerSuffix = `${session.address}:${session.port}`;
  session.sourceClientInstanceId = helloInstanceId
    ? `${helloInstanceId}@${peerSuffix}`
    : helloClientId
      ? `${helloClientId}@${peerSuffix}`
      : peerSuffix;
}

/** Parse a HELLO payload and, on success, bind the session identity. */
function parseHelloInfo(
  ctx: ServerContext,
  parsed: ParsedPacket,
  session: ClientSession | null
): void {
  const { app } = ctx;
  try {
    const info = JSON.parse(parsed.payload.toString());
    app.debug(`v2 hello from client: ${JSON.stringify(info)}`);
    if (session && info && typeof info === "object") {
      applyHelloIdentity(session, info);
      // Advance the per-peer anti-replay epoch (resets the window on a strictly
      // higher epoch = legitimate restart; ignores replayed/stale HELLOs). The
      // guard key matches the DATA path: session address/port come from rinfo.
      applyHelloEpoch(ctx, `${session.address}:${session.port}`, info.epoch);
    }
  } catch (parseErr: unknown) {
    const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    // Truncate so an attacker-controlled JSON parse error can't bloat the log.
    const truncated = parseMsg.length > 256 ? parseMsg.slice(0, 256) + "…" : parseMsg;
    app.error(`v2 failed to parse HELLO payload: ${truncated}`);
  }
}

/**
 * Prime the one-per-session control requests off the back of a HELLO: demand a
 * fresh metadata snapshot, and (when enabled) a full values snapshot.
 */
function primeSessionRequests(ctx: ServerContext, session: ClientSession, secretKey: string): void {
  const { app, state } = ctx;
  // HELLO is the earliest reliable indication of a live peer, so use it to
  // demand a fresh metadata snapshot. Capped at one per session.
  if (!session.metaRequested) {
    session.metaRequested = true;
    sendMetaRequest(ctx, session, secretKey).catch((err: unknown) => {
      app.debug(
        `[v2-server] META_REQUEST send failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
  // If the operator enabled full-status-on-restart, also request a values
  // snapshot. Capped at one per session.
  if (!session.statusRequested && state.options?.requestFullStatusOnRestart) {
    session.statusRequested = true;
    sendFullStatusRequest(ctx, session, secretKey).catch((err: unknown) => {
      app.debug(
        `[v2-server] FULL_STATUS_REQUEST send failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}

/** Handle a HELLO (0x04) packet: bind identity and prime meta/status requests. */
function handleHelloPacket(
  ctx: ServerContext,
  parsed: ParsedPacket,
  secretKey: string,
  rinfo?: { address: string; port: number }
): void {
  const { app, metrics } = ctx;
  // HELLO is HMAC-authenticated by parseHeader, so it is safe to allocate a
  // long-lived session here (the handshake is the intended trigger).
  const session = rinfo ? getOrCreateSession(ctx, rinfo) : null;
  if (rinfo && !session) {
    // Over per-IP cap: drop without creating state.
    return;
  }
  if (parsed.payload.length > HELLO_PAYLOAD_MAX_BYTES) {
    app.debug(
      `[v2-server] HELLO payload ${parsed.payload.length}B exceeds cap ${HELLO_PAYLOAD_MAX_BYTES}B — rejecting`
    );
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    return;
  }
  parseHelloInfo(ctx, parsed, session);
  if (session) {
    primeSessionRequests(ctx, session, secretKey);
  }
}

/** Handle a METADATA (0x06) packet: rate-limit then decode/dispatch. */
async function handleMetadataDispatch(
  ctx: ServerContext,
  parsed: ParsedPacket,
  secretKey: string,
  rinfo?: { address: string; port: number }
): Promise<void> {
  const { metrics, clientSessions } = ctx;
  // METADATA is decrypted+authenticated inside handleMetadataPacket before any
  // envelope/session state is mutated, so only ever look up an EXISTING session.
  const session = rinfo ? (clientSessions.get(`${rinfo.address}:${rinfo.port}`) ?? null) : null;
  // Apply the same rate limit used for DATA. Per-session limiter when a session
  // exists, otherwise a per-IP pre-auth limiter.
  if (session) {
    const now = Date.now();
    if (now - session.rateLimitWindowStart >= UDP_RATE_LIMIT_WINDOW) {
      session.rateLimitCount = 0;
      session.rateLimitWindowStart = now;
    }
    session.rateLimitCount++;
    if (session.rateLimitCount > UDP_RATE_LIMIT_MAX_PACKETS) {
      metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
      metrics.bandwidth.metaRateLimitedPackets =
        (metrics.bandwidth.metaRateLimitedPackets || 0) + 1;
      ctx.app.debug(`[v2-server] rate limited META from ${session.key}`);
      return;
    }
  } else if (rinfo && preAuthRateLimited(ctx, rinfo.address)) {
    metrics.rateLimitedPackets = (metrics.rateLimitedPackets || 0) + 1;
    metrics.bandwidth.metaRateLimitedPackets = (metrics.bandwidth.metaRateLimitedPackets || 0) + 1;
    return;
  }
  await handleMetadataPacket(ctx, parsed, secretKey, session, rinfo);
}

/** Map a caught receivePacket error to the right log + recordError category. */
function reportReceiveError(ctx: ServerContext, error: unknown): void {
  const { app, metrics, recordError } = ctx;
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof DecryptError) {
    const hint = error.keyMismatchHint
      ? " (possible stretchAsciiKey or key-format mismatch between peers)"
      : "";
    app.error(`v2 decryption/authentication failed${hint}: ${msg}`);
    recordError("encryption", `v2 decryption/authentication failed${hint}`);
  } else if (msg.includes("Unsupported state") || msg.includes("auth")) {
    app.error("v2 authentication failed: packet tampered or wrong key");
    recordError("encryption", "v2 authentication failed");
  } else if (msg.includes("decrypt")) {
    app.error(`v2 decryption error: ${msg}`);
    recordError("encryption", `v2 decryption error: ${msg}`);
  } else if (msg.includes("decompress")) {
    app.error(`v2 decompression error: ${msg}`);
    recordError("compression", `v2 decompression error: ${msg}`);
  } else if (msg.includes("CRC") || msg.includes("magic") || msg.includes("Packet")) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.error(`v2 packet error: ${msg}`);
    recordError("general", `v2 packet error: ${msg}`);
  } else {
    app.error(`v2 receivePacket error: ${msg}`);
    recordError("general", `v2 receivePacket error: ${msg}`);
  }
}

/**
 * Receive and process a v2 packet.
 * Pipeline: PacketParse → SequenceTrack → Decrypt → Decompress → Parse → handleMessage
 */
export async function receivePacket(
  ctx: ServerContext,
  packet: Buffer,
  secretKey: string,
  rinfo?: { address: string; port: number }
): Promise<void> {
  const { app, metrics, packetParser } = ctx;
  try {
    if (!ctx.state.options) {
      app.debug("receivePacket called but plugin is stopped, ignoring");
      return;
    }

    // Bonding health probes: verify (HMAC) + rate-limit BEFORE reflecting.
    if (await handleHeartbeatProbe(ctx, packet, rinfo)) {
      return;
    }

    // Track incoming bandwidth (all inbound UDP, counted before authentication).
    metrics.bandwidth.bytesIn += packet.length;
    metrics.bandwidth.packetsIn++;

    // Check if this is a v2 packet
    if (!packetParser.isV2Packet(packet)) {
      metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
      app.debug("Received non-v2 packet, ignoring");
      return;
    }

    // Parse packet header
    const parsed = packetParser.parseHeader(packet, { secretKey });

    if (!isPacketAccepted(ctx, parsed)) {
      return;
    }

    // Handle by packet type
    if (parsed.type === PacketType.HEARTBEAT) {
      app.debug("v2 heartbeat received");
      return;
    }

    if (parsed.type === PacketType.HELLO) {
      await handleHelloPacket(ctx, parsed, secretKey, rinfo);
      return;
    }

    if (parsed.type === PacketType.METADATA) {
      await handleMetadataDispatch(ctx, parsed, secretKey, rinfo);
      return;
    }

    if (parsed.type !== PacketType.DATA) {
      app.debug(`v2 unhandled packet type: ${parsed.typeName}`);
      return;
    }

    await handleDataPacket(ctx, packet, parsed, secretKey, rinfo);
  } catch (error: unknown) {
    reportReceiveError(ctx, error);
  }
}
