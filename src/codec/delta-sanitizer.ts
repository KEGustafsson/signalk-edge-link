"use strict";

import type {
  Delta,
  DeltaMeta,
  DeltaUpdate,
  DeltaValue,
  PathFilterConfig
} from "../foundation/types";
import { PATH_THROTTLE_STATE_MAX } from "../foundation/constants";

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

// ── Path filtering (allowlist / blocklist) ────────────────────────────────────

/**
 * Test whether `path` matches a glob pattern.
 *
 * Supported forms:
 *   `*`                    — match any path
 *   `navigation.*`         — match any path that starts with `navigation.`
 *   `navigation.speed*`    — NOT supported; use prefix-glob only
 *   `navigation.speedOverGround` — exact match
 *
 * Dots are Signal K path separators; a trailing `.*` means "this node and
 * all its children".
 */
function pathMatchesGlob(path: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // e.g. "navigation."
    return path.startsWith(prefix);
  }
  return path === pattern;
}

/**
 * Returns true if `path` passes through the filter configuration.
 *
 * Semantics:
 * - If `allow` is non-empty, the path must match at least one allow pattern.
 * - If `deny` is non-empty, the path must not match any deny pattern.
 * - `deny` is evaluated after `allow`, so it can narrow an allow-list down.
 */
export function isPathAllowed(path: string, config: PathFilterConfig): boolean {
  if (config.allow && config.allow.length > 0) {
    if (!config.allow.some((p) => pathMatchesGlob(path, p))) return false;
  }
  if (config.deny && config.deny.length > 0) {
    if (config.deny.some((p) => pathMatchesGlob(path, p))) return false;
  }
  return true;
}

/**
 * Remove value entries that fail the path filter.  Updates that become empty
 * after filtering are dropped; returns `null` when the entire delta becomes
 * empty.  Returns the original reference when nothing is removed (no
 * allocation).
 */
export function filterDelta(delta: Delta, config: PathFilterConfig): Delta | null {
  if (!Array.isArray(delta.updates)) return null;
  let deltaChanged = false;
  const updates: DeltaUpdate[] = [];

  for (const update of delta.updates) {
    if (!Array.isArray(update.values)) {
      updates.push(update);
      continue;
    }
    let valuesChanged = false;
    const values: DeltaValue[] = [];
    for (const entry of update.values) {
      if (entry === null || typeof entry !== "object") {
        values.push(entry as DeltaValue);
        continue;
      }
      const v = entry as DeltaValue;
      if (typeof v.path !== "string") {
        values.push(entry as DeltaValue);
        continue;
      }
      if (isPathAllowed(v.path, config)) {
        values.push(entry as DeltaValue);
      } else {
        valuesChanged = true;
      }
    }
    // Apply the same filter to meta entries
    let metaChanged = false;
    let filteredMeta: DeltaMeta[] | undefined;
    if (Array.isArray(update.meta)) {
      filteredMeta = update.meta.filter(
        (m) => typeof m.path !== "string" || isPathAllowed(m.path, config)
      );
      if (filteredMeta.length !== update.meta.length) metaChanged = true;
    }

    if (!valuesChanged && !metaChanged) {
      updates.push(update);
      continue;
    }
    deltaChanged = true;
    if (values.length > 0 || (filteredMeta && filteredMeta.length > 0)) {
      const next: DeltaUpdate = { ...update, values };
      if (metaChanged) {
        if (filteredMeta && filteredMeta.length > 0) {
          next.meta = filteredMeta;
        } else {
          delete next.meta;
        }
      }
      updates.push(next);
    }
    // updates with no remaining values or meta are dropped
  }

  if (!deltaChanged) return delta;
  if (updates.length === 0) return null;
  return { ...delta, updates };
}

/**
 * Apply {@link filterDelta} to a `Delta`, `Delta[]`, or `Record<string, Delta>`.
 * Returns `null` when everything is filtered out.  Short-circuits and returns
 * the original reference when the config has no rules.
 */
export function filterDeltaPayload(
  payload: DeltaPayload,
  config: PathFilterConfig | undefined | null
): DeltaPayload | null {
  if (!config || (!config.allow?.length && !config.deny?.length)) return payload;

  if (Array.isArray(payload)) {
    const out: Delta[] = [];
    for (const d of payload) {
      const f = filterDelta(d, config);
      if (f !== null) out.push(f);
    }
    return out.length > 0 ? out : null;
  }
  if (isDeltaLike(payload)) {
    return filterDelta(payload, config);
  }
  const out: Record<string, Delta> = {};
  let anyKept = false;
  for (const [k, v] of Object.entries(payload as Record<string, Delta>)) {
    const f = filterDelta(v, config);
    if (f !== null) {
      out[k] = f;
      anyKept = true;
    }
  }
  return anyKept ? out : null;
}
