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
function applyTelemetryValue(
  ctx: ServerContext,
  remote: RemoteQuality,
  entry: DeltaValue
): boolean {
  const applier = typeof entry.path === "string" ? TELEMETRY_APPLIERS[entry.path] : undefined;
  return applier ? applier(remote, ctx.metrics, entry.value) : false;
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
  const { CLIENT_TELEMETRY_PATHS } = ctx;
  const remainingValues: DeltaValue[] = [];
  let changed = false;
  for (const entry of values) {
    if (!entry || typeof entry.path !== "string" || !CLIENT_TELEMETRY_PATHS.has(entry.path)) {
      remainingValues.push(entry);
      continue;
    }
    // A recognised telemetry path: applied when valid, otherwise dropped
    // silently. Either way it is never forwarded as a regular SK update
    // (it carries the telemetry source label and would confuse consumers).
    if (applyTelemetryValue(ctx, remote, entry)) {
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
  const forward =
    result.remainingValues.length > 0 ? { ...update, values: result.remainingValues } : null;
  return { changed: result.changed, forward };
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
