"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: remote telemetry ingest
 *
 * Extracts edge-link client telemetry values from inbound deltas into the
 * authoritative `remoteNetworkQuality` metrics, with per-session ownership so
 * one misbehaving peer cannot poison the network-quality dashboard.
 *
 * @module transport/pipeline/reliable-server/telemetry
 */

import type { ServerContext, ClientSession } from "./context";
import type { Delta, DeltaValue, MetricsApi } from "../../../foundation/types";

type RemoteQuality = NonNullable<MetricsApi["metrics"]["remoteNetworkQuality"]>;

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isFreshRemoteTelemetry(ctx: ServerContext, now: number = Date.now()): boolean {
  const last = ctx.metrics.remoteNetworkQuality && ctx.metrics.remoteNetworkQuality.lastUpdate;
  return Number.isFinite(last) && last! > 0 && now - last! <= ctx.REMOTE_TELEMETRY_TTL_MS;
}

type Metrics = MetricsApi["metrics"];
type TelemetryApplier = (remote: RemoteQuality, metrics: Metrics, value: unknown) => boolean;

/**
 * Path → applier table. Each applier validates the value and writes it to the
 * remote-quality accumulator (and, where applicable, the top-level metrics),
 * returning true when applied. Replaces a large switch so the dispatch itself
 * carries no branching cost.
 */
const TELEMETRY_APPLIERS: Record<string, TelemetryApplier> = {
  "networking.edgeLink.rtt": (remote, metrics, value) => {
    const rtt = toFiniteNumber(value);
    if (rtt === null || rtt < 0) {
      return false;
    }
    remote.rtt = rtt;
    metrics.rtt = rtt;
    return true;
  },
  "networking.edgeLink.jitter": (remote, metrics, value) => {
    const jitter = toFiniteNumber(value);
    if (jitter === null || jitter < 0) {
      return false;
    }
    remote.jitter = jitter;
    metrics.jitter = jitter;
    return true;
  },
  "networking.edgeLink.packetLoss": (remote, _metrics, value) => {
    const loss = toFiniteNumber(value);
    if (loss === null) {
      return false;
    }
    remote.packetLoss = Math.max(0, Math.min(1, loss));
    return true;
  },
  "networking.edgeLink.retransmissions": (remote, metrics, value) => {
    const retransmissions = toFiniteNumber(value);
    if (retransmissions === null || retransmissions < 0) {
      return false;
    }
    const rounded = Math.round(retransmissions);
    remote.retransmissions = rounded;
    metrics.retransmissions = rounded;
    return true;
  },
  "networking.edgeLink.queueDepth": (remote, metrics, value) => {
    const queueDepth = toFiniteNumber(value);
    if (queueDepth === null || queueDepth < 0) {
      return false;
    }
    const rounded = Math.round(queueDepth);
    remote.queueDepth = rounded;
    metrics.queueDepth = rounded;
    return true;
  },
  "networking.edgeLink.retransmitRate": (remote, _metrics, value) => {
    const retransmitRate = toFiniteNumber(value);
    if (retransmitRate === null) {
      return false;
    }
    remote.retransmitRate = Math.max(0, Math.min(1, retransmitRate));
    return true;
  },
  "networking.edgeLink.activeLink": (remote, _metrics, value) => {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
    remote.activeLink = value;
    return true;
  }
};

/**
 * Apply a single telemetry value to the remote-quality accumulator and (where
 * applicable) the top-level metrics. Returns true when the value was a
 * recognised telemetry path that was applied. Unrecognised/invalid paths return
 * false so the caller keeps the value as a regular SK tree update.
 */
const TELEMETRY_PREFIX = "networking.edgeLink.";

/**
 * Resolve a delta path to a telemetry applier.
 *
 * A client configured with more than one connection scopes its publications by
 * instance — `networking.edgeLink.<instanceId>.rtt` rather than
 * `networking.edgeLink.rtt` (see the pathPrefix in reliable-client.ts). The
 * lookup here was an exact match on the unscoped path, so every such client's
 * telemetry fell through as an ordinary tree update and `remoteNetworkQuality`
 * was never populated: the receiving server reported no RTT, no jitter and no
 * link quality forever. Single-connection deployments matched and worked,
 * which is why this only showed up in proxy setups.
 *
 * Exact match is tried first so a nested metric name (`bandwidth.upload`) is
 * never mistaken for an instance segment.
 */
function canonicalTelemetryPath(ctx: ServerContext, path: string): string | undefined {
  if (ctx.CLIENT_TELEMETRY_PATHS.has(path)) {
    return path;
  }
  if (!path.startsWith(TELEMETRY_PREFIX)) {
    return undefined;
  }
  const rest = path.slice(TELEMETRY_PREFIX.length);
  const firstDot = rest.indexOf(".");
  if (firstDot === -1) {
    return undefined;
  }
  // Drop the instance segment and retry against the canonical path.
  const unscoped = TELEMETRY_PREFIX + rest.slice(firstDot + 1);
  return ctx.CLIENT_TELEMETRY_PATHS.has(unscoped) ? unscoped : undefined;
}

function applyTelemetryValue(
  ctx: ServerContext,
  remote: RemoteQuality,
  canonicalPath: string,
  value: unknown
): boolean {
  const applier = TELEMETRY_APPLIERS[canonicalPath];
  return applier ? applier(remote, ctx.metrics, value) : false;
}

/**
 * Process one telemetry-bearing update's values. Returns the values that were
 * NOT consumed as telemetry (to be forwarded as a normal SK update) and whether
 * any telemetry value changed the accumulator.
 */
function processTelemetryUpdateValues(
  ctx: ServerContext,
  remote: RemoteQuality,
  values: DeltaValue[]
): { remainingValues: DeltaValue[]; changed: boolean } {
  const remainingValues: DeltaValue[] = [];
  let changed = false;
  for (const entry of values) {
    // Recognition and application must use the SAME normalisation. They did
    // not have to before, because both were exact matches on the unscoped
    // path; an instance-scoped client failed this membership test and never
    // reached the applier at all.
    const canonicalPath =
      entry && typeof entry.path === "string" ? canonicalTelemetryPath(ctx, entry.path) : undefined;
    if (!canonicalPath) {
      remainingValues.push(entry);
      continue;
    }
    // A recognised telemetry path: applied when valid, otherwise dropped
    // silently. Either way it is never forwarded as a regular SK update
    // (it carries the telemetry source label and would confuse consumers).
    if (applyTelemetryValue(ctx, remote, canonicalPath, entry.value)) {
      changed = true;
    }
  }
  return { remainingValues, changed };
}

type DeltaUpdate = Delta["updates"][number];

/**
 * Consume one update: pass through non-telemetry updates, drop telemetry from
 * unidentified peers or peers that don't own the telemetry slot, and otherwise
 * apply the telemetry values. Returns whether the accumulator changed and the
 * (possibly trimmed) update to forward into the SK tree, or null to drop it.
 */
function consumeTelemetryUpdate(
  ctx: ServerContext,
  remote: RemoteQuality,
  update: DeltaUpdate,
  session: ClientSession | null | undefined,
  peerIdentified: boolean
): { changed: boolean; forward: DeltaUpdate | null } {
  const { mut, CLIENT_TELEMETRY_SOURCE, REMOTE_TELEMETRY_TTL_MS } = ctx;
  if (!update || !Array.isArray(update.values)) {
    return { changed: false, forward: update };
  }
  const sourceLabel = update.source && update.source.label;
  if (sourceLabel !== CLIENT_TELEMETRY_SOURCE) {
    return { changed: false, forward: update };
  }

  // Telemetry from an unidentified peer is dropped (never forwarded as a
  // regular SK update either).
  if (!peerIdentified) {
    return { changed: false, forward: null };
  }
  const now = Date.now();
  const ttl =
    mut.telemetryOwnerLastSeen > 0 && now - mut.telemetryOwnerLastSeen <= REMOTE_TELEMETRY_TTL_MS;
  if (mut.telemetryOwnerSessionKey && ttl && mut.telemetryOwnerSessionKey !== session!.key) {
    // Another peer holds the telemetry slot; drop these values.
    return { changed: false, forward: null };
  }
  mut.telemetryOwnerSessionKey = session!.key;
  mut.telemetryOwnerLastSeen = now;

  const result = processTelemetryUpdateValues(ctx, remote, update.values);
  // This update carries the telemetry source label, so every value in it is the
  // peer's own link telemetry — including the ones with no applier
  // (`linkQuality`, `sequenceNumber`, `compressionRatio`). Forwarding those into
  // the receiver's Signal K tree put the peer's figures on the same paths this
  // node publishes for itself, separated only by `$source`: two `linkQuality`
  // values under `networking.edgeLink.*`, one locally computed and one measured
  // by the other end of the link. Dropping them keeps a node's own tree about
  // its own link; the peer's numbers remain available through the ingested
  // fields and the network-quality endpoints.
  return { changed: result.changed, forward: null };
}

export function ingestRemoteTelemetry(
  ctx: ServerContext,
  deltaMessage: Delta,
  session?: ClientSession | null
): void {
  const { metrics } = ctx;
  if (!deltaMessage || !Array.isArray(deltaMessage.updates)) {
    return;
  }
  // Telemetry attribution is only meaningful when the peer completed a
  // HELLO (clientId or sourceClientInstanceId set). Telemetry without a
  // session — or from a session that never identified itself — is
  // accepted into the SK tree but does not update authoritative metrics.
  const peerIdentified = !!(session && (session.clientId || session.sourceClientInstanceId));

  let changed = false;
  const remote = metrics.remoteNetworkQuality || {};
  const filteredUpdates: Delta["updates"] = [];

  for (const update of deltaMessage.updates) {
    const { changed: updateChanged, forward } = consumeTelemetryUpdate(
      ctx,
      remote,
      update,
      session,
      peerIdentified
    );
    if (updateChanged) {
      changed = true;
    }
    if (forward) {
      filteredUpdates.push(forward);
    }
  }

  if (changed) {
    remote.lastUpdate = Date.now();
    metrics.remoteNetworkQuality = remote;
  }

  deltaMessage.updates = filteredUpdates;
}
