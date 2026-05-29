"use strict";

/**
 * Same-as-last value deduplication for outbound deltas.
 *
 * For paths whose values rarely change (status strings, mode enums, etc.),
 * a long-lived link sends the same value over and over. This module
 * replaces unchanged values with a small sentinel object before
 * serialization. The receiver maintains the same per-(context, path)
 * cache and restores the value before injecting into Signal K.
 *
 * Wire-format flag: `useValueDedup` — both peers must agree, exactly like
 * `useMsgpack` and `usePathDictionary`. When the flag is enabled, the
 * receiver MUST run this module before injecting deltas into Signal K,
 * or downstream consumers will see the sentinel object as the value.
 *
 * Cache is per-(context, path) so two vessels publishing the same path
 * do not interfere. Cache state persists for the lifetime of the
 * pipeline (client) or session (server). On (re)connect, both caches
 * start empty so the first value for each path is sent absolutely.
 */

import type { Delta, DeltaValue } from "./types";
import type { DeltaPayload } from "./delta-sanitizer";
import { VALUE_DEDUP_CACHE_MAX } from "./constants";

/**
 * Sentinel object that replaces unchanged values on the wire.
 * The two-character key `$$` is reserved here and is intentionally an
 * unlikely real Signal K field name.
 */
export const DUP_SENTINEL = { $$: "dup" } as const;

/** Per-(context, path) cache: last value sent or received. */
export interface ValueDedupState {
  cache: Map<string, unknown>;
}

export function createValueDedupState(): ValueDedupState {
  return { cache: new Map() };
}

function cacheKey(context: string | undefined, path: string): string {
  return `${context || "*"}\u0000${path}`;
}

/**
 * Insert or refresh a cache entry with LRU eviction. On a Map (which
 * preserves insertion order) a delete-then-set moves the key to the tail,
 * so the least-recently-written key is always at the head and evicted
 * first when the cache is full. Bounds memory for links that see a very
 * large number of distinct (context, path) pairs.
 */
function cacheSet(cache: Map<string, unknown>, key: string, value: unknown): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= VALUE_DEDUP_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

function isSentinel(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).$$ === "dup" &&
    Object.keys(value as Record<string, unknown>).length === 1
  );
}

/**
 * Stable string representation used for "same as previous" comparison.
 * `JSON.stringify` produces deterministic output for primitives, arrays,
 * and plain objects with the same key insertion order. That's good
 * enough for our purposes — Signal K values are produced by the same
 * sender so insertion order will match across consecutive emissions.
 */
function stableRepr(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Outbound: collapse unchanged values into sentinel ────────────────────────

/**
 * Walk a delta and replace each value that matches the cached
 * value-for-that-path with {@link DUP_SENTINEL}. Updates the cache with
 * the *original* (non-sentinel) values that get sent.
 *
 * Returns the original delta reference when nothing changes
 * (no allocation).
 */
export function dedupDelta(delta: Delta, state: ValueDedupState): Delta {
  if (!Array.isArray(delta.updates)) return delta;
  const context = delta.context;
  let deltaChanged = false;

  const updates = delta.updates.map((update) => {
    if (!Array.isArray(update.values)) return update;
    let valuesChanged = false;
    const values = update.values.map((entry) => {
      // Pass malformed entries through — sanitize is responsible for them.
      if (entry === null || typeof entry !== "object") return entry;
      const v = entry as DeltaValue;
      if (typeof v.path !== "string" || v.path.length === 0) return entry;
      const key = cacheKey(context, v.path);
      const cached = state.cache.get(key);
      const cachedRepr = cached === undefined ? undefined : stableRepr(cached);
      const currentRepr = stableRepr(v.value);
      if (cachedRepr !== undefined && cachedRepr === currentRepr) {
        valuesChanged = true;
        // Refresh LRU position so a stable path that only ever emits
        // sentinels is not evicted ahead of churnier ones.
        cacheSet(state.cache, key, cached);
        return { ...v, value: DUP_SENTINEL };
      }
      // First occurrence or value changed — cache the absolute value
      cacheSet(state.cache, key, v.value);
      return entry;
    });
    if (!valuesChanged) return update;
    deltaChanged = true;
    return { ...update, values };
  });

  if (!deltaChanged) return delta;
  return { ...delta, updates };
}

/** Apply {@link dedupDelta} to an array of deltas in order. */
export function dedupDeltaArray(deltas: Delta[], state: ValueDedupState): Delta[] {
  let anyChanged = false;
  const out = deltas.map((d) => {
    const r = dedupDelta(d, state);
    if (r !== d) anyChanged = true;
    return r;
  });
  return anyChanged ? out : deltas;
}

function isDeltaLike(value: unknown): value is Delta {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { updates?: unknown }).updates)
  );
}

/**
 * Apply {@link dedupDelta} to a Delta, Delta[], or Record<string, Delta>.
 */
export function dedupDeltaPayload(payload: DeltaPayload, state: ValueDedupState): DeltaPayload {
  if (Array.isArray(payload)) {
    return dedupDeltaArray(payload, state);
  }
  if (isDeltaLike(payload)) {
    return dedupDelta(payload, state);
  }
  const out: Record<string, Delta> = {};
  let anyChanged = false;
  for (const [k, v] of Object.entries(payload)) {
    const r = dedupDelta(v, state);
    if (r !== v) anyChanged = true;
    out[k] = r;
  }
  return anyChanged ? out : payload;
}

// ── Inbound: expand sentinel back to the cached value ────────────────────────

/**
 * Walk a delta and replace each {@link DUP_SENTINEL} value with the cached
 * value for that path. Updates the cache with absolute (non-sentinel)
 * values as they arrive. Sentinel values for paths the receiver has
 * never seen are passed through as-is (caller decides whether to drop
 * them); this should not happen in practice once the link is steady.
 *
 * Robust to malformed entries (null/non-object/missing path) — they pass
 * through untouched so the downstream sanitize step can reject them.
 */
export function undedupDelta(delta: Delta, state: ValueDedupState): Delta {
  if (!Array.isArray(delta.updates)) return delta;
  const context = delta.context;
  let deltaChanged = false;

  const updates = delta.updates.map((update) => {
    if (!Array.isArray(update.values)) return update;
    let valuesChanged = false;
    const values: DeltaValue[] = [];
    for (const entry of update.values) {
      // Pass malformed entries through unchanged — sanitizeDeltaForSignalK
      // is responsible for rejecting null / missing-path entries.
      if (entry === null || typeof entry !== "object") {
        values.push(entry as DeltaValue);
        continue;
      }
      const v = entry as DeltaValue;
      if (typeof v.path !== "string" || v.path.length === 0) {
        values.push(entry as DeltaValue);
        continue;
      }
      const key = cacheKey(context, v.path);
      if (isSentinel(v.value)) {
        const cached = state.cache.get(key);
        if (cached === undefined) {
          // Receiver missed the absolute baseline — skip rather than inject the sentinel.
          // The sender will resync on the next absolute value.
          valuesChanged = true;
          continue;
        }
        valuesChanged = true;
        // Refresh LRU position so a stable path is not evicted ahead of
        // churnier ones (mirrors the sender-side dedup behaviour).
        cacheSet(state.cache, key, cached);
        values.push({ ...v, value: cached });
      } else {
        // Absolute value — update cache and pass through
        cacheSet(state.cache, key, v.value);
        values.push(entry as DeltaValue);
      }
    }
    if (!valuesChanged) return update;
    deltaChanged = true;
    return { ...update, values };
  });

  if (!deltaChanged) return delta;
  return { ...delta, updates };
}

export function undedupDeltaArray(deltas: Delta[], state: ValueDedupState): Delta[] {
  let anyChanged = false;
  const out = deltas.map((d) => {
    const r = undedupDelta(d, state);
    if (r !== d) anyChanged = true;
    return r;
  });
  return anyChanged ? out : deltas;
}

// Re-export for tests / external users that want to introspect a sentinel.
export { isSentinel as isDupSentinel };
