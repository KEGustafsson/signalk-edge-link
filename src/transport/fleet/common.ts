"use strict";

/**
 * Signal K Edge Link — fleet sharing helpers shared by the server sender and
 * the client receiver (protocol-v3-spec §15).
 *
 * @module transport/fleet/common
 */

import {
  FLEET_DEFAULT_MAX_BYTES_PER_SEC,
  FLEET_MIN_MAX_BYTES_PER_SEC,
  FLEET_MAX_MAX_BYTES_PER_SEC,
  FLEET_DEFAULT_BATCH_INTERVAL_MS,
  FLEET_MIN_BATCH_INTERVAL_MS,
  FLEET_MAX_BATCH_INTERVAL_MS,
  FLEET_EXCLUDED_PATH_PREFIX
} from "../../foundation/constants";
import { isPathAllowed } from "../../codec/delta-sanitizer";
import type {
  FleetMetrics,
  FleetSharingConfig,
  Metrics,
  PathFilterConfig
} from "../../foundation/types";

/** Fleet options after defaults and clamping. */
export interface ResolvedFleetConfig {
  scope: "fleet" | "all";
  includeServerVessel: boolean;
  pathFilter: PathFilterConfig | null;
  maxBytesPerSec: number;
  batchIntervalMs: number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizePathFilter(filter: PathFilterConfig | undefined): PathFilterConfig | null {
  if (!filter) {
    return null;
  }
  const allow = Array.isArray(filter.allow)
    ? filter.allow.filter((p) => typeof p === "string")
    : [];
  const deny = Array.isArray(filter.deny) ? filter.deny.filter((p) => typeof p === "string") : [];
  return allow.length || deny.length ? { allow, deny } : null;
}

export function resolveFleetConfig(config: FleetSharingConfig | undefined): ResolvedFleetConfig {
  return {
    scope: config?.scope === "all" ? "all" : "fleet",
    includeServerVessel: config?.includeServerVessel === true,
    pathFilter: normalizePathFilter(config?.pathFilter),
    maxBytesPerSec: clampInt(
      config?.maxBytesPerSec,
      FLEET_MIN_MAX_BYTES_PER_SEC,
      FLEET_MAX_MAX_BYTES_PER_SEC,
      FLEET_DEFAULT_MAX_BYTES_PER_SEC
    ),
    batchIntervalMs: clampInt(
      config?.batchIntervalMs,
      FLEET_MIN_BATCH_INTERVAL_MS,
      FLEET_MAX_BATCH_INTERVAL_MS,
      FLEET_DEFAULT_BATCH_INTERVAL_MS
    )
  };
}

/** The fleet counters for an instance, created with zeros on first use. */
export function ensureFleetMetrics(metrics: Metrics): FleetMetrics {
  if (!metrics.fleet) {
    metrics.fleet = {
      members: 0,
      packetsSent: 0,
      bytesSent: 0,
      valuesSent: 0,
      retransmits: 0,
      rateLimitedFlushes: 0,
      originDrops: 0,
      identityConflicts: 0,
      identityRejected: 0,
      replayedHellos: 0,
      keepalivesSent: 0,
      snapshotsSent: 0,
      staleStreamPackets: 0,
      packetsAbandoned: 0,
      rateBackoffs: 0,
      minRateFactor: 1,
      state: "disabled",
      packetsReceived: 0,
      valuesReceived: 0,
      metaReceived: 0,
      contextsKnown: 0,
      loopDrops: 0,
      duplicatePackets: 0,
      staleValues: 0,
      rejectedPackets: 0,
      acksSent: 0,
      naksSent: 0
    };
  }
  return metrics.fleet;
}

export function fleetPathAllowed(
  path: string,
  ...filters: Array<PathFilterConfig | null | undefined>
): boolean {
  if (path.startsWith(FLEET_EXCLUDED_PATH_PREFIX)) {
    return false;
  }
  for (const filter of filters) {
    if (filter && !isPathAllowed(path, filter)) {
      return false;
    }
  }
  return true;
}
