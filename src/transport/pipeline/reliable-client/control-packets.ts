"use strict";

/**
 * Signal K Edge Link - reliable client control-packet dispatch.
 *
 * Extracted from the v2 client factory: `handleControlPacket` and the
 * request-handler invocation guards (META_REQUEST / FULL_STATUS_REQUEST).
 *
 * @module transport/pipeline/reliable-client/control-packets
 */

import { isIP } from "net";
import { lookup } from "dns";
import { PacketType } from "../../../codec/packet-codec";
import type * as dgram from "dgram";
import type { ClientContext } from "./context";
import { receiveACK, receiveNAK } from "./reliability";
import { confirmHelloAcknowledged } from "./lifecycle";

/**
 * Hostname -> the addresses it resolves to.
 *
 * A configured `udpAddress` may be a hostname, but `rinfo.address` is always a
 * literal address, so the two can never compare equal as strings. Resolving
 * closes that gap. Module-level because DNS results are not instance-specific.
 */
const resolvedPeerHosts = new Map<string, Set<string>>();
/** Hostnames with a lookup in flight, so the packet path issues one at a time. */
const pendingHostLookups = new Set<string>();

/**
 * Canonical form for comparing two addresses.
 *
 * A socket bound to IPv6 reports an IPv4 peer as `::ffff:192.0.2.1`, which does
 * not equal the `192.0.2.1` an operator configured.
 */
function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
}

/** Resolve a configured hostname in the background and cache every address. */
function ensureHostResolved(ctx: ClientContext, host: string): void {
  if (resolvedPeerHosts.has(host) || pendingHostLookups.has(host)) {
    return;
  }
  pendingHostLookups.add(host);
  lookup(host, { all: true }, (err, addresses) => {
    pendingHostLookups.delete(host);
    if (err || !Array.isArray(addresses)) {
      ctx.app.debug(
        `Could not resolve configured peer ${host}: ${err ? err.message : "no result"}`
      );
      return;
    }
    resolvedPeerHosts.set(host, new Set(addresses.map((a) => normalizeAddress(a.address))));
  });
}

/**
 * Invoke a request handler (META_REQUEST / FULL_STATUS_REQUEST) defensively:
 * any thenable rejection or synchronous throw is logged at debug level so it
 * never bubbles into the control-packet parse error path.
 */
function invokeRequestHandler(
  ctx: ClientContext,
  handler: (() => void | PromiseLike<unknown>) | null,
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
/**
 * Addresses this client is configured to talk to: the primary destination plus
 * any bonding link destinations.
 */
function configuredPeerAddresses(ctx: ClientContext): Set<string> {
  const options = ctx.state.options;
  const addresses = new Set<string>();
  if (!options) return addresses;
  if (typeof options.udpAddress === "string" && options.udpAddress) {
    addresses.add(options.udpAddress);
  }
  const bonding = options.bonding;
  if (bonding?.enabled) {
    for (const link of [bonding.primary, bonding.backup]) {
      if (link && typeof link.address === "string" && link.address) {
        addresses.add(link.address);
      }
    }
  }
  return addresses;
}

/**
 * Reject control packets that did not come from a configured peer.
 *
 * Control packets are HMAC-authenticated but carry no freshness, so a captured
 * ACK/NAK stays replayable forever. Because the NAK source used to double as
 * the retransmit destination, an attacker could spoof the source address and
 * have this client flood an arbitrary victim with retransmits (a NAK naming 256
 * sequences yields up to 256 full-size packets). Constraining the source to the
 * configured peer set removes the off-path victim entirely.
 */
function isExpectedPeer(ctx: ClientContext, rinfo: dgram.RemoteInfo): boolean {
  const configured = configuredPeerAddresses(ctx);
  // No configured address (unit fixtures / not yet resolved): accept, since
  // there is nothing to compare against.
  if (configured.size === 0) return true;

  const source = normalizeAddress(rinfo.address);
  let sawUnresolvedHost = false;

  for (const entry of configured) {
    const candidate = normalizeAddress(entry);
    if (isIP(candidate)) {
      if (candidate === source) return true;
      continue;
    }
    // A hostname cannot be compared to a literal address directly.
    const resolved = resolvedPeerHosts.get(candidate);
    if (!resolved) {
      ensureHostResolved(ctx, candidate);
      sawUnresolvedHost = true;
      continue;
    }
    if (resolved.has(source)) return true;
  }

  // Accept while a hostname is still unresolved rather than dropping. Comparing
  // a hostname to `rinfo.address` as raw strings never matches, so failing
  // closed here silently discarded every ACK and NAK from a correctly
  // configured peer — which stalls RTT measurement, freezes the cumulative ACK
  // and lets the retransmit queue grow without bound. The check exists to deny
  // an off-path attacker a reflection target, and that property is not worth
  // breaking the link for.
  if (sawUnresolvedHost) return true;
  return false;
}

export async function handleControlPacket(
  ctx: ClientContext,
  msg: Buffer,
  rinfo: dgram.RemoteInfo
): Promise<void> {
  const { app, metricsApi, packetParser, mut, state } = ctx;
  const { metrics } = metricsApi;
  try {
    if (!packetParser.isV2Packet(msg)) {
      return;
    }

    if (!isExpectedPeer(ctx, rinfo)) {
      metrics.rejectedControlPackets = (metrics.rejectedControlPackets || 0) + 1;
      app.debug(`Dropped control packet from unexpected source ${rinfo.address}:${rinfo.port}`);
      return;
    }

    // The server binds control-packet auth tags to THIS client's epoch (it
    // learned it from our HELLO), so verification uses our own epoch.
    const parsed = packetParser.parseHeader(msg, { epoch: ctx.connectionEpoch });

    // Any authenticated control packet proves the server has a session bound to
    // this source port, which is what HELLO establishes.
    confirmHelloAcknowledged(ctx);

    // Never derive a send destination from the packet source: retransmits and
    // recovery drains go to the configured peer (or the active bonding link),
    // which `udpSendAsync` resolves.
    const peerAddress = state.options?.udpAddress ?? rinfo.address;
    const peerPort = state.options?.udpPort ?? rinfo.port;

    if (parsed.type === PacketType.ACK) {
      receiveACK(ctx, parsed, { address: peerAddress, port: peerPort } as dgram.RemoteInfo);
    } else if (parsed.type === PacketType.NAK) {
      await receiveNAK(ctx, parsed, peerAddress, peerPort);
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
