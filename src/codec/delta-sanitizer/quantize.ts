"use strict";

/** L1 codec — value quantization. */

import type { Delta, DeltaUpdate, DeltaValue } from "../../foundation/types";
import type { DeltaPayload } from "./internal";
import { isObject, isDeltaLike } from "./internal";

// ── Numeric precision quantization ───────────────────────────────────────────

/**
 * Round a numeric value to `decimals` decimal places. Returns the original
 * value if it is not a finite number.
 *
 * Uses the standard half-away-from-zero rounding rule (`Math.round` after
 * scaling). For `decimals = 2`: 7.234 → 7.23, 7.235 → 7.24, -7.235 → -7.24.
 */
function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const m = Math.pow(10, decimals);
  return Math.round(value * m) / m;
}

/**
 * Recursively quantize numeric leaves of a Signal K value according to
 * `precisionMap`. Object leaves are walked using dotted paths
 * (e.g. `navigation.position.latitude`) so per-field precision can be
 * configured for nested values.
 */
function quantizeValue(
  value: unknown,
  path: string,
  precisionMap: Record<string, number>
): unknown {
  if (typeof value === "number") {
    const decimals = precisionMap[path];
    return decimals === undefined ? value : roundTo(value, decimals);
  }
  if (isObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const nested = quantizeValue(v, `${path}.${k}`, precisionMap);
      if (nested !== v) changed = true;
      out[k] = nested;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Apply per-path numeric precision quantization to every value in a delta.
 *
 * Reduces wire bytes by rounding floats at the outbound boundary
 * (e.g. `7.234567890123456` → `7.23` for paths with precision = 2). The
 * Brotli compressor still further deduplicates these shorter strings, but
 * the shorter input itself saves bytes.
 *
 * If `precisionMap` is empty or undefined, the delta is returned unchanged
 * (no allocation).
 *
 * **This is a lossy transformation by design** — the receiver gets the
 * rounded value, not the original. Use per-path precision settings that
 * match each sensor's actual reportable precision.
 */
export function quantizeDelta(
  delta: Delta,
  precisionMap: Record<string, number> | undefined
): Delta {
  if (!precisionMap || Object.keys(precisionMap).length === 0) return delta;
  if (!Array.isArray(delta.updates)) return delta;

  let deltaChanged = false;
  const updates = delta.updates.map((update) => {
    if (!Array.isArray(update.values)) return update;
    let valuesChanged = false;
    const values = update.values.map((entry) => {
      const v = entry as DeltaValue;
      const quantized = quantizeValue(v.value, v.path, precisionMap);
      if (quantized === v.value) return entry;
      valuesChanged = true;
      return { ...v, value: quantized };
    });
    if (!valuesChanged) return update;
    deltaChanged = true;
    return { ...update, values };
  });

  return deltaChanged ? { ...delta, updates } : delta;
}

/**
 * Apply per-path quantization to a Delta, Delta[], or Record<string, Delta>
 * payload.
 */
export function quantizeDeltaPayload(
  payload: DeltaPayload,
  precisionMap: Record<string, number> | undefined
): DeltaPayload {
  if (!precisionMap || Object.keys(precisionMap).length === 0) return payload;
  if (Array.isArray(payload)) {
    return payload.map((d) => quantizeDelta(d, precisionMap));
  }
  if (isDeltaLike(payload)) {
    return quantizeDelta(payload, precisionMap);
  }
  const out: Record<string, Delta> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = quantizeDelta(v, precisionMap);
  }
  return out;
}
