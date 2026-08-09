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
import { resetValueDedupState } from "../../../codec/value-dedup";
import { resetPathThrottleState } from "../../../codec/delta-sanitizer";

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
 * When each hostname was last looked up, successfully or not.
 *
 * Without this, a name that fails to resolve is in neither the resolved nor the
 * pending set, so every inbound control packet would start another lookup — a
 * DNS flood at packet rate, triggered precisely by a misconfiguration. It also
 * bounds how long a stale success is trusted after the peer's address changes.
 */
const hostLookupAttemptedAt = new Map<string, number>();
/** When each hostname was FIRST asked for, to bound the startup grace below. */
const hostFirstSeenAt = new Map<string, number>();
/** Re-resolve at most this often per hostname. */
const HOST_LOOKUP_INTERVAL_MS = 60_000;
/**
 * How long a not-yet-resolved hostname is given the benefit of the doubt.
 *
 * DNS is asynchronous, so the first control packets can arrive before the very
 * first lookup returns; rejecting those would drop the ACKs that start the
 * reliability layer. That grace must be bounded, though — an open-ended one
 * means a name that never resolves accepts control packets from ANY source
 * forever, which is the validation switched off rather than relaxed.
 *
 * Failing closed after the grace costs nothing real: `dgram.send` resolves the
 * same name, so a peer whose hostname cannot be resolved is unreachable in the
 * send direction too. The link is already down; refusing spoofed control
 * packets does not make it more so.
 */
const HOST_RESOLVE_GRACE_MS = 30_000;

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
  if (pendingHostLookups.has(host)) {
    return;
  }
  const lastAttempt = hostLookupAttemptedAt.get(host);
  if (lastAttempt !== undefined && Date.now() - lastAttempt < HOST_LOOKUP_INTERVAL_MS) {
    return;
  }
  pendingHostLookups.add(host);
  hostLookupAttemptedAt.set(host, Date.now());
  lookup(host, { all: true }, (err, addresses) => {
    pendingHostLookups.delete(host);
    if (err || !Array.isArray(addresses) || addresses.length === 0) {
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
  const now = Date.now();
  let withinResolveGrace = false;

  for (const entry of configured) {
    const candidate = normalizeAddress(entry);
    if (isIP(candidate)) {
      if (candidate === source) return true;
      continue;
    }
    // A hostname cannot be compared to a literal address directly.
    if (!hostFirstSeenAt.has(candidate)) {
      hostFirstSeenAt.set(candidate, now);
    }
    // Called even when a result is already cached: it self-rate-limits, and
    // refreshing is what lets a peer whose address changes — dynamic DNS, a
    // failover to a standby host — be recognised again. Resolving once and
    // never re-checking would reject the new address permanently, silently
    // dropping every ACK exactly as the original string comparison did.
    ensureHostResolved(ctx, candidate);

    const resolved = resolvedPeerHosts.get(candidate);
    if (!resolved) {
      if (now - (hostFirstSeenAt.get(candidate) ?? now) < HOST_RESOLVE_GRACE_MS) {
        withinResolveGrace = true;
      }
      continue;
    }
    if (resolved.has(source)) return true;
  }

  // Briefly accept while a configured hostname is still being resolved for the
  // first time, so the ACKs that start the reliability layer are not dropped in
  // the DNS round-trip window. Comparing a hostname to `rinfo.address` as raw
  // strings never matches, and failing closed on that discarded every ACK and
  // NAK from a correctly configured peer — stalling RTT measurement, freezing
  // the cumulative ACK and letting the retransmit queue grow without bound.
  //
  // Bounded, because an unbounded grace is the check switched off: a name that
  // never resolves would accept spoofed control packets from any source
  // forever.
  return withinResolveGrace;
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
      //
      // Clear the dedup and throttle baselines first. A server that asks for a
      // full replay has lost its own state, so every path it wants back looks
      // "unchanged" to us: dedup would encode the whole snapshot as sentinels
      // the server cannot expand (it drops them), and pathThrottle would
      // discard values it had already let through this interval. Both turn the
      // replay into a no-op for exactly the stable paths it exists to restore.
      resetValueDedupState(ctx.dedupState);
      resetPathThrottleState(ctx.throttleState);
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
