"use strict";

/** L1 codec — per-path throttling / deadband. */

import type { Delta, DeltaUpdate, DeltaValue } from "../../foundation/types";
import { PATH_THROTTLE_STATE_MAX } from "../../foundation/constants";
import type { DeltaPayload } from "./internal";
import { isDeltaLike } from "./internal";

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
    if (!Array.isArray(update.values)) {
      updates.push(update);
      continue;
    }
    let valuesChanged = false;
    const kept: DeltaValue[] = [];
    for (const entry of update.values) {
      const v = entry as DeltaValue;
      const rule = throttleMap[v.path];
      if (!rule) {
        kept.push(v);
        continue;
      }
      const stateKey = `${delta.context}\0${v.path}`;
      const last = state.lastSent.get(stateKey);
      let drop = false;
      if (last !== undefined) {
        if (rule.minIntervalMs !== undefined && nowMs - last.atMs < rule.minIntervalMs) {
          drop = true;
        }
        if (
          !drop &&
          rule.deadband !== undefined &&
          typeof v.value === "number" &&
          typeof last.value === "number" &&
          Math.abs(v.value - last.value) < rule.deadband
        ) {
          drop = true;
        }
      }
      if (drop) {
        valuesChanged = true;
        continue;
      }
      kept.push(v);
      // LRU-bounded insert: delete-then-set moves the key to the tail so the
      // least-recently-sent (context,path) is evicted first when the map is
      // full. Caps memory under high path/context cardinality.
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
    if (!valuesChanged) {
      updates.push(update);
      continue;
    }
    deltaChanged = true;
    if (kept.length === 0) continue;
    updates.push({ ...update, values: kept });
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
  if (Array.isArray(payload)) {
    const out: Delta[] = [];
    for (const d of payload) {
      const t = throttleDelta(d, throttleMap, state, nowMs);
      if (t !== null) out.push(t);
    }
    return out.length > 0 ? out : null;
  }
  if (isDeltaLike(payload)) {
    return throttleDelta(payload, throttleMap, state, nowMs);
  }
  const out: Record<string, Delta> = {};
  let anyKept = false;
  for (const [k, v] of Object.entries(payload)) {
    const t = throttleDelta(v, throttleMap, state, nowMs);
    if (t !== null) {
      out[k] = t;
      anyKept = true;
    }
  }
  return anyKept ? out : null;
}
