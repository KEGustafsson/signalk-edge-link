"use strict";

/** L1 codec — per-path throttling / deadband. */

import type { Delta, DeltaUpdate, DeltaValue } from "../../foundation/types";
import { PATH_THROTTLE_STATE_MAX } from "../../foundation/constants";
import type { DeltaPayload } from "./internal";
import { mapDeltaPayload } from "./internal";

// ── Per-path throttle / deadband filtering ──────────────────────────────────

/**
 * Per-path throttle rule.
 *
 * `minIntervalMs`: drop the value if it was last sent less than this many
 * milliseconds ago.
 *
 * `deadband`: drop the value if its absolute change vs the last sent value
 * is less than this threshold. Only applies to numeric values; ignored for
 * strings/objects.
 *
 * Both filters apply independently — a value passes only if BOTH allow it
 * (i.e. enough time has elapsed AND the change exceeds the deadband, when
 * each is configured).
 */
export interface PathThrottleRule {
  minIntervalMs?: number;
  deadband?: number;
}

/**
 * Per-path throttle state. Holds the last sent timestamp and value for each
 * path so the next throttle decision can be made. Pass the same state
 * object across successive throttleDelta() calls on a given connection.
 */
export interface PathThrottleState {
  lastSent: Map<string, { atMs: number; value: number | undefined }>;
}

export function createPathThrottleState(): PathThrottleState {
  return { lastSent: new Map() };
}

/**
 * Forget every last-sent record so the next value on each path is sent
 * regardless of its throttle interval or deadband.
 *
 * Used at link resync points — notably a full-status replay, where the peer
 * has lost its state and needs values that this side would otherwise consider
 * "already sent recently".
 */
export function resetPathThrottleState(state: PathThrottleState): void {
  state.lastSent.clear();
}

/**
 * Decide whether a value should be dropped under its throttle rule, given the
 * last-sent record (or undefined when none exists yet).
 */
function shouldDropValue(
  v: DeltaValue,
  rule: PathThrottleRule,
  last: { atMs: number; value: number | undefined } | undefined,
  nowMs: number
): boolean {
  if (last === undefined) {
    return false;
  }
  if (rule.minIntervalMs !== undefined && nowMs - last.atMs < rule.minIntervalMs) {
    return true;
  }
  if (
    rule.deadband !== undefined &&
    typeof v.value === "number" &&
    typeof last.value === "number" &&
    Math.abs(v.value - last.value) < rule.deadband
  ) {
    return true;
  }
  return false;
}

/**
 * Record a just-sent value into the LRU-bounded throttle state. delete-then-set
 * moves the key to the tail so the least-recently-sent (context,path) is
 * evicted first when the map is full. Caps memory under high cardinality.
 */
function recordSentValue(
  state: PathThrottleState,
  stateKey: string,
  v: DeltaValue,
  nowMs: number
): void {
  if (state.lastSent.has(stateKey)) {
    state.lastSent.delete(stateKey);
  } else if (state.lastSent.size >= PATH_THROTTLE_STATE_MAX) {
    const oldest = state.lastSent.keys().next();
    if (!oldest.done) state.lastSent.delete(oldest.value);
  }
  state.lastSent.set(stateKey, {
    atMs: nowMs,
    value: typeof v.value === "number" ? v.value : undefined
  });
}

/** Result of throttling a single update. */
type ThrottleUpdateResult =
  | { kind: "unchanged"; update: DeltaUpdate }
  | { kind: "replaced"; update: DeltaUpdate }
  | { kind: "dropped" };

/** Apply throttle/deadband filtering to a single update's values. */
function throttleUpdate(
  delta: Delta,
  update: DeltaUpdate,
  throttleMap: Record<string, PathThrottleRule>,
  state: PathThrottleState,
  nowMs: number
): ThrottleUpdateResult {
  if (!Array.isArray(update.values)) {
    return { kind: "unchanged", update };
  }
  // Key throttle/deadband state per source so two sources publishing the same
  // (context, path) — e.g. two GPS units on navigation.position — are rate-
  // limited and dead-banded independently instead of suppressing each other.
  const sourceRef = typeof update.$source === "string" ? update.$source : "";
  let valuesChanged = false;
  const kept: DeltaValue[] = [];
  for (const entry of update.values) {
    const v = entry as DeltaValue;
    // Own-property check — see the note in quantize.ts. A prototype member
    // here would be treated as a throttle rule for a path that has none.
    const rule = Object.prototype.hasOwnProperty.call(throttleMap, v.path)
      ? throttleMap[v.path]
      : undefined;
    if (!rule) {
      kept.push(v);
      continue;
    }
    const stateKey = `${delta.context} ${sourceRef} ${v.path}`;
    if (shouldDropValue(v, rule, state.lastSent.get(stateKey), nowMs)) {
      valuesChanged = true;
      continue;
    }
    kept.push(v);
    recordSentValue(state, stateKey, v, nowMs);
  }
  if (!valuesChanged) {
    return { kind: "unchanged", update };
  }
  if (kept.length === 0) {
    return { kind: "dropped" };
  }
  return { kind: "replaced", update: { ...update, values: kept } };
}

/**
 * Apply per-path throttle/deadband filtering to a delta. Values that fail
 * the rule for their path are dropped; updates whose values all drop are
 * removed; the whole delta is dropped (returned as null) if nothing remains.
 *
 * Returns the same delta reference unchanged when no rules apply or no
 * filtering occurred (no allocation).
 */
export function throttleDelta(
  delta: Delta,
  throttleMap: Record<string, PathThrottleRule> | undefined,
  state: PathThrottleState,
  nowMs: number = Date.now()
): Delta | null {
  if (!throttleMap || Object.keys(throttleMap).length === 0) return delta;
  if (!Array.isArray(delta.updates)) return delta;

  let deltaChanged = false;
  const updates: DeltaUpdate[] = [];

  for (const update of delta.updates) {
    const result = throttleUpdate(delta, update, throttleMap, state, nowMs);
    if (result.kind === "unchanged") {
      updates.push(result.update);
    } else if (result.kind === "replaced") {
      deltaChanged = true;
      updates.push(result.update);
    } else {
      deltaChanged = true;
    }
  }

  if (!deltaChanged) return delta;
  if (updates.length === 0) return null;
  return { ...delta, updates };
}

/**
 * Apply per-path throttle to a Delta, Delta[], or Record<string, Delta>.
 * Returns null if the entire payload is filtered out.
 */
export function throttleDeltaPayload(
  payload: DeltaPayload,
  throttleMap: Record<string, PathThrottleRule> | undefined,
  state: PathThrottleState,
  nowMs: number = Date.now()
): DeltaPayload | null {
  if (!throttleMap || Object.keys(throttleMap).length === 0) return payload;
  return mapDeltaPayload(payload, (d) => throttleDelta(d, throttleMap, state, nowMs));
}
