"use strict";

import type { Delta, DeltaUpdate, DeltaValue } from "./types";

export type DeltaPayload = Delta | Delta[] | Record<string, Delta>;

/**
 * Path prefixes for data this plugin publishes locally. When the
 * `skipOwnData` option is set on a client connection, value entries with
 * matching paths are stripped before the delta is forwarded over the link so
 * the receiver's Signal K tree is not polluted with the sender's own
 * edge-link metrics. The `networking.edgeLink.*` subtree is owned entirely
 * by this plugin so the whole prefix is matched.
 */
const OWN_DATA_PATH_PREFIXES = ["networking.edgeLink."];

/**
 * RTT paths the plugin publishes — kept by `stripOwnDataFromDelta` even when
 * `skipOwnData` is on, because operators rely on RTT for link-health
 * visibility on both sides of the link. Covers v1 modem RTT
 * (`networking.modem.rtt`, `networking.modem.<instanceId>.rtt`) and v2
 * edge-link RTT (`networking.edgeLink.rtt`,
 * `networking.edgeLink.<instanceId>.rtt`).
 */
const RTT_PATH_RE = /^networking\.(?:modem|edgeLink)(?:\.[^.]+)?\.rtt$/;

function isOwnDataPath(path: unknown): boolean {
  if (typeof path !== "string") {
    return false;
  }
  // RTT paths (modem + edgeLink, namespaced or not) are always forwarded so
  // the receiver retains link-health visibility regardless of skipOwnData.
  if (RTT_PATH_RE.test(path)) {
    return false;
  }
  for (const prefix of OWN_DATA_PATH_PREFIXES) {
    // prefix.slice(0, -1) drops the trailing ".", so a published path that
    // matches the prefix root exactly (e.g. just "networking.edgeLink") still
    // counts as own data; startsWith(prefix) covers everything underneath.
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Drop value/meta entries whose paths are owned by this plugin. Returns null
 * when nothing remains to forward. Updates that become empty are dropped; the
 * delta is dropped entirely when no updates survive.
 */
export function stripOwnDataFromDelta(delta: Delta | null | undefined): Delta | null {
  if (!delta || !Array.isArray(delta.updates)) {
    return null;
  }

  let changed = false;
  const surviving: DeltaUpdate[] = [];

  for (const update of delta.updates) {
    const rawValues = Array.isArray(update.values) ? update.values : [];
    const values = rawValues.filter((v) => !isOwnDataPath((v as DeltaValue)?.path));
    const valuesChanged = values.length !== rawValues.length;

    const rawMeta = Array.isArray(update.meta) ? update.meta : null;
    const meta = rawMeta
      ? rawMeta.filter((m) => !isOwnDataPath((m as { path?: unknown })?.path))
      : null;
    const metaChanged = rawMeta !== null && meta !== null && meta.length !== rawMeta.length;

    if (values.length === 0 && (!meta || meta.length === 0)) {
      changed = true;
      continue;
    }

    if (valuesChanged || metaChanged) {
      changed = true;
      const next: DeltaUpdate = { ...update, values };
      if (meta && meta.length > 0) {
        next.meta = meta;
      } else if (rawMeta) {
        delete next.meta;
      }
      surviving.push(next);
    } else {
      surviving.push(update);
    }
  }

  if (surviving.length === 0) {
    return null;
  }

  if (!changed) {
    return delta;
  }

  return { ...delta, updates: surviving };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidValuePath(path: unknown): path is string {
  return typeof path === "string" && path.trim().length > 0;
}

/**
 * Remove Signal K value entries that the server will reject before calling
 * app.handleMessage or forwarding over the link. Metadata-only updates are
 * preserved, but updates with neither valid values nor meta are dropped.
 */
export function sanitizeDeltaForSignalK(delta: Delta | null | undefined): Delta | null {
  if (!delta || !Array.isArray(delta.updates)) {
    return null;
  }

  let changed = false;
  const sanitizedUpdates: DeltaUpdate[] = [];

  for (const rawUpdate of delta.updates as unknown[]) {
    if (!isObject(rawUpdate)) {
      changed = true;
      continue;
    }

    const update = rawUpdate as unknown as DeltaUpdate;
    let updateChanged = false;
    const rawValues = Array.isArray(update.values) ? (update.values as unknown[]) : [];
    if (!Array.isArray(update.values)) {
      updateChanged = true;
    }

    const values: DeltaValue[] = [];
    for (const rawValue of rawValues) {
      if (!isObject(rawValue) || !isValidValuePath(rawValue.path)) {
        updateChanged = true;
        continue;
      }
      values.push(rawValue as unknown as DeltaValue);
    }

    if (values.length !== rawValues.length) {
      updateChanged = true;
    }

    const hasMeta = Array.isArray(update.meta) && update.meta.length > 0;
    if (values.length === 0 && !hasMeta) {
      changed = true;
      continue;
    }

    if (updateChanged) {
      changed = true;
    }
    sanitizedUpdates.push(updateChanged ? { ...update, values } : update);
  }

  if (sanitizedUpdates.length === 0) {
    return null;
  }

  if (!changed && sanitizedUpdates.length === delta.updates.length) {
    return delta;
  }

  return {
    ...delta,
    updates: sanitizedUpdates
  };
}

function isDeltaLike(value: unknown): value is Delta {
  return isObject(value) && Array.isArray(value.updates);
}

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

export function sanitizeDeltaPayloadForSignalK(delta: DeltaPayload): DeltaPayload | null {
  if (Array.isArray(delta)) {
    const sanitized = delta
      .map((item) => sanitizeDeltaForSignalK(item))
      .filter((item): item is Delta => item !== null);
    return sanitized.length > 0 ? sanitized : null;
  }

  if (isDeltaLike(delta)) {
    return sanitizeDeltaForSignalK(delta);
  }

  const sanitizedEntries: Array<[string, Delta]> = [];
  for (const [key, value] of Object.entries(delta)) {
    const sanitized = sanitizeDeltaForSignalK(value);
    if (sanitized !== null) {
      sanitizedEntries.push([key, sanitized]);
    }
  }

  return sanitizedEntries.length > 0 ? Object.fromEntries(sanitizedEntries) : null;
}
