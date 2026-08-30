"use strict";

/**
 * L1 codec — delta-sanitizer shared primitives:
 * the DeltaPayload shape and the small type guards used across the
 * quantize/throttle/filter/sanitize concerns. Imported by the sibling modules
 * to keep the dependency graph acyclic.
 */

import type { Delta } from "../../foundation/types";

export type DeltaPayload = Delta | Delta[] | Record<string, Delta>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDeltaLike(value: unknown): value is Delta {
  return isObject(value) && Array.isArray(value.updates);
}

/**
 * Apply a per-delta transform across a Delta, Delta[], or
 * Record<string, Delta> payload — the shared fan-out that the
 * sanitize/filter/quantize/throttle/dedup stages each used to re-implement.
 *
 * `perDelta` returns the (possibly new) delta, or null to drop it. Returns
 * null when every delta is dropped, and preserves the input reference (no
 * allocation) when nothing changed.
 */
export function mapDeltaPayload(
  payload: DeltaPayload,
  perDelta: (delta: Delta) => Delta | null
): DeltaPayload | null {
  if (Array.isArray(payload)) {
    return mapDeltaArray(payload, perDelta);
  }

  if (isDeltaLike(payload)) {
    return perDelta(payload);
  }

  const out: Record<string, Delta> = {};
  let anyKept = false;
  let anyChanged = false;
  for (const [key, value] of Object.entries(payload)) {
    const result = perDelta(value);
    if (result === null) {
      anyChanged = true;
      continue;
    }
    if (result !== value) anyChanged = true;
    out[key] = result;
    anyKept = true;
  }
  if (!anyKept) return null;
  return anyChanged ? out : payload;
}

/** Array variant of {@link mapDeltaPayload}; null when every delta drops. */
function mapDeltaArray(payload: Delta[], perDelta: (delta: Delta) => Delta | null): Delta[] | null {
  // `out` is allocated lazily on the first drop or change, so an untouched
  // batch passes through by reference.
  let out: Delta[] | null = null;
  let kept = 0;
  for (let i = 0; i < payload.length; i++) {
    const result = perDelta(payload[i]);
    if (result === null) {
      if (out === null) out = payload.slice(0, i);
      continue;
    }
    if (result !== payload[i] && out === null) {
      out = payload.slice(0, i);
    }
    kept++;
    if (out !== null) out.push(result);
  }
  if (kept === 0) return null;
  return out ?? payload;
}
