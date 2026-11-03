"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet rate control
 *
 * Per-session token bucket and loss-adaptive rate factor for FLEET_DATA
 * (protocol-v3-spec §15.9).
 *
 * @module transport/pipeline/reliable-server/fleet-rate
 */

import {
  MAX_SAFE_UDP_PAYLOAD,
  FLEET_MIN_MAX_BYTES_PER_SEC,
  FLEET_RATE_BACKOFF_FACTOR,
  FLEET_RATE_MIN_FACTOR,
  FLEET_RATE_BACKOFF_INTERVAL_MS,
  FLEET_RATE_RECOVERY_DELAY_MS,
  FLEET_RATE_RECOVERY_PER_SEC
} from "../../../foundation/constants";
import { ensureFleetMetrics } from "../../fleet/common";
import type { ServerContext } from "./context";
import type { FleetSessionState } from "./fleet";

/** Current byte rate: the session ceiling scaled by its loss-adaptive factor. */
export function effectiveRate(fleetSession: FleetSessionState): number {
  return Math.max(FLEET_MIN_MAX_BYTES_PER_SEC, fleetSession.bytesPerSec * fleetSession.rateFactor);
}

/** Bucket depth: one second of rate, never less than one full packet. */
export function bucketDepth(fleetSession: FleetSessionState): number {
  return Math.max(effectiveRate(fleetSession), MAX_SAFE_UDP_PAYLOAD);
}

export function refillTokens(fleetSession: FleetSessionState, now: number): void {
  const elapsed = Math.max(0, now - fleetSession.lastRefillAt);
  fleetSession.lastRefillAt = now;
  const rate = effectiveRate(fleetSession);
  fleetSession.tokens = Math.min(
    bucketDepth(fleetSession),
    fleetSession.tokens + (rate * elapsed) / 1000
  );
}

/**
 * True when the byte budget covers a packet of `length` bytes. A packet larger
 * than the bucket can never be covered, so it waits for a full bucket and then
 * spends ahead; later packets wait until that debt is repaid.
 */
export function budgetCovers(fleetSession: FleetSessionState, length: number): boolean {
  return fleetSession.tokens >= Math.min(length, bucketDepth(fleetSession));
}

/**
 * Loss seen on this session's downlink (a NAK, or a packet that went
 * unacknowledged): cut the rate multiplicatively, at most once per interval
 * so one burst of loss counts once. The vessel's link — usually the
 * bottleneck — sets the pace without any configuration.
 */
export function backOff(ctx: ServerContext, fleetSession: FleetSessionState, now: number): void {
  if (now - fleetSession.lastBackoffAt < FLEET_RATE_BACKOFF_INTERVAL_MS) {
    return;
  }
  fleetSession.lastBackoffAt = now;
  fleetSession.lastRateIncreaseAt = now;
  fleetSession.rateFactor = Math.max(
    FLEET_RATE_MIN_FACTOR,
    fleetSession.rateFactor * FLEET_RATE_BACKOFF_FACTOR
  );
  ensureFleetMetrics(ctx.metrics).rateBackoffs++;
}

/** Recover additively once the session has been loss-free for a while. */
export function recoverRate(fleetSession: FleetSessionState, now: number): void {
  if (
    fleetSession.rateFactor >= 1 ||
    now - fleetSession.lastBackoffAt < FLEET_RATE_RECOVERY_DELAY_MS
  ) {
    fleetSession.lastRateIncreaseAt = now;
    return;
  }
  const seconds = Math.max(0, now - fleetSession.lastRateIncreaseAt) / 1000;
  fleetSession.lastRateIncreaseAt = now;
  fleetSession.rateFactor = Math.min(
    1,
    fleetSession.rateFactor + FLEET_RATE_RECOVERY_PER_SEC * seconds
  );
}
