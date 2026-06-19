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
  const { metrics } = ctx;
  switch (entry.path) {
    case "networking.edgeLink.rtt": {
      const rtt = toFiniteNumber(entry.value);
      if (rtt !== null && rtt >= 0) {
        remote.rtt = rtt;
        metrics.rtt = rtt;
        return true;
      }
      return false;
    }
    case "networking.edgeLink.jitter": {
      const jitter = toFiniteNumber(entry.value);
      if (jitter !== null && jitter >= 0) {
        remote.jitter = jitter;
        metrics.jitter = jitter;
        return true;
      }
      return false;
    }
    case "networking.edgeLink.packetLoss": {
      const loss = toFiniteNumber(entry.value);
      if (loss !== null) {
        remote.packetLoss = Math.max(0, Math.min(1, loss));
        return true;
      }
      return false;
    }
    case "networking.edgeLink.retransmissions": {
      const retransmissions = toFiniteNumber(entry.value);
      if (retransmissions !== null && retransmissions >= 0) {
        const rounded = Math.round(retransmissions);
        remote.retransmissions = rounded;
        metrics.retransmissions = rounded;
        return true;
      }
      return false;
    }
    case "networking.edgeLink.queueDepth": {
      const queueDepth = toFiniteNumber(entry.value);
      if (queueDepth !== null && queueDepth >= 0) {
        const rounded = Math.round(queueDepth);
        remote.queueDepth = rounded;
        metrics.queueDepth = rounded;
        return true;
      }
      return false;
    }
    case "networking.edgeLink.retransmitRate": {
      const retransmitRate = toFiniteNumber(entry.value);
      if (retransmitRate !== null) {
        remote.retransmitRate = Math.max(0, Math.min(1, retransmitRate));
        return true;
      }
      return false;
    }
    case "networking.edgeLink.activeLink":
      if (typeof entry.value === "string" && entry.value.length > 0) {
        remote.activeLink = entry.value;
        return true;
      }
      return false;
    default:
      return false;
  }
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

export function ingestRemoteTelemetry(
  ctx: ServerContext,
  deltaMessage: Delta,
  session?: ClientSession | null
): void {
  const { metrics, mut, CLIENT_TELEMETRY_SOURCE, REMOTE_TELEMETRY_TTL_MS } = ctx;
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
    if (!update || !Array.isArray(update.values)) {
      filteredUpdates.push(update);
      continue;
    }

    const sourceLabel = update.source && update.source.label;
    if (sourceLabel !== CLIENT_TELEMETRY_SOURCE) {
      filteredUpdates.push(update);
      continue;
    }

    const now = Date.now();
    const ttl =
      mut.telemetryOwnerLastSeen > 0 && now - mut.telemetryOwnerLastSeen <= REMOTE_TELEMETRY_TTL_MS;
    if (!peerIdentified) {
      // Drop telemetry values silently from unidentified peers; do not
      // forward as regular SK tree updates either.
      continue;
    }
    if (mut.telemetryOwnerSessionKey && ttl && mut.telemetryOwnerSessionKey !== session!.key) {
      // Another peer holds the telemetry slot; drop these values.
      continue;
    }
    mut.telemetryOwnerSessionKey = session!.key;
    mut.telemetryOwnerLastSeen = now;

    const result = processTelemetryUpdateValues(ctx, remote, update.values);
    if (result.changed) {
      changed = true;
    }
    if (result.remainingValues.length > 0) {
      filteredUpdates.push({ ...update, values: result.remainingValues });
    }
  }

  if (changed) {
    remote.lastUpdate = Date.now();
    metrics.remoteNetworkQuality = remote;
  }

  deltaMessage.updates = filteredUpdates;
}
