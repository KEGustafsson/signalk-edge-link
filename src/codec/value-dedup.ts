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
 *
 * ## Keeping the two caches in agreement
 *
 * A sentinel means "the value you already have", so the sender's cache and
 * the receiver's cache must agree or the receiver injects a stale value and
 * keeps injecting it — the sender has no reason to send an absolute again.
 * Two mechanisms hold the invariant:
 *
 * 1. **Sender-side resync.** Any event that means a DATA packet was built but
 *    may never have been delivered — retransmit-queue eviction, abandonment
 *    after `maxRetransmits`, age expiry, or a throw between dedup and send —
 *    calls {@link resetValueDedupState}. The sender then re-sends every path
 *    absolutely, which is the only way to re-establish a shared baseline.
 *    The receiver needs no signal: absolute values simply overwrite.
 * 2. **Receiver-side sequence guard.** Payloads are dispatched in arrival
 *    order, so a reordered older packet can otherwise overwrite a newer
 *    value in the receive cache and desynchronise it from the sender. The
 *    receive path therefore records the DATA sequence that last wrote each
 *    entry and ignores absolute values arriving from an older sequence.
 *
 * The sender also resets at link resync points (HELLO/epoch change, and the
 * full-status replay a restarted server asks for), because a fresh server
 * session starts with an empty cache; see `reliable-client/lifecycle`.
 */

import type { Delta, DeltaValue } from "../foundation/types";
import type { DeltaPayload } from "./delta-sanitizer";
import { mapDeltaPayload } from "./delta-sanitizer/internal";
import { VALUE_DEDUP_CACHE_MAX } from "../foundation/constants";
import { serialAtOrAfter } from "../foundation/serial";

/**
 * Sentinel object that replaces unchanged values on the wire.
 * The two-character key `$$` is reserved here and is intentionally an
 * unlikely real Signal K field name.
 */
export const DUP_SENTINEL = { $$: "dup" } as const;

/**
 * One cached value plus the DATA sequence that wrote it.
 *
 * `seq` is only meaningful on the receive path, where it orders concurrent
 * writes to the same path; the send path has no sequence at dedup time
 * (`buildDataPacket` allocates it later) and always stores {@link NO_SEQ}.
 */
interface DedupEntry {
  value: unknown;
  seq: number;
}

/** Sentinel "no sequence recorded" marker for send-side entries. */
const NO_SEQ = -1;

/** Per-(context, path) cache: last value sent or received. */
export interface ValueDedupState {
  cache: Map<string, DedupEntry>;
}

export function createValueDedupState(): ValueDedupState {
  return { cache: new Map() };
}

/**
 * Drop every cached baseline so the next delta for each path is sent — and
 * expected — as an absolute value.
 *
 * Call this on the sending side whenever a built packet may not have reached
 * the peer, and on both sides at a link resync point. Clearing is always safe:
 * the worst case is a few redundant absolute values, whereas a stale cache
 * silently delivers wrong data for as long as the true value stays put.
 */
export function resetValueDedupState(state: ValueDedupState): void {
  state.cache.clear();
}

/** Cache key for a (context, path) pair; contexts default to `*`. */
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
function cacheSet(cache: Map<string, DedupEntry>, key: string, entry: DedupEntry): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= VALUE_DEDUP_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

/**
 * True when `value` is exactly the dup sentinel object shape.
 *
 * The shape `{$$: "dup"}` is RESERVED by the v3 dedup encoding: it is the
 * in-band duplicate marker on the wire, so a receiver cannot distinguish a
 * genuine value of exactly this shape from the marker and will expand it
 * from its baseline cache (or drop it when no baseline exists). An escaping
 * representation would change what existing receivers must decode — a wire
 * format change the compatibility policy forbids — so the sender instead
 * passes such values through verbatim and uncached (see dedupDelta), and the
 * reservation is documented in configuration-reference.md.
 */
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
 *
 * Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) must be encoded
 * distinctly at any nesting depth: `JSON.stringify` serializes all of them —
 * and `null` — to the literal `"null"`, which would make them compare equal.
 * The MessagePack transport preserves non-finite numbers on the wire, so a
 * path that switches between e.g. `{a: NaN}` and `{a: null}` would otherwise
 * be deduped to the wrong cached value and silently delivered as the stale
 * one. The replacer maps them to NUL-prefixed tag strings, and escapes any
 * genuine string that itself starts with NUL into a disjoint `\0str:`
 * namespace, so no string value can collide with a tag and suppress a real
 * update. Only the comparison key is affected — cached and sent values stay
 * verbatim.
 */
/** JSON.stringify replacer tagging non-finite numbers at any depth. */
function nonFiniteReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return "\0nan";
    return value > 0 ? "\0+inf" : "\0-inf";
  }
  if (typeof value === "string" && value.charCodeAt(0) === 0) {
    return "\0str:" + value;
  }
  return value;
}

function stableRepr(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return "\0nan";
    return value > 0 ? "\0+inf" : "\0-inf";
  }
  try {
    return JSON.stringify(value, nonFiniteReplacer);
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
    // Pass malformed updates through — sanitize is responsible for them.
    if (!update || typeof update !== "object" || !Array.isArray(update.values)) return update;
    let valuesChanged = false;
    const values = update.values.map((entry) => {
      // Pass malformed entries through — sanitize is responsible for them.
      if (entry === null || typeof entry !== "object") return entry;
      const v = entry as DeltaValue;
      if (typeof v.path !== "string" || v.path.length === 0) return entry;
      // A genuine value identical to the sentinel cannot be told apart by the
      // receiver, which never caches sentinels — send it verbatim without
      // caching so the two caches stay in agreement.
      if (isSentinel(v.value)) return entry;
      const key = cacheKey(context, v.path);
      const cached = state.cache.get(key);
      const cachedRepr = cached === undefined ? undefined : stableRepr(cached.value);
      const currentRepr = stableRepr(v.value);
      if (cachedRepr !== undefined && cachedRepr === currentRepr) {
        valuesChanged = true;
        // Refresh LRU position so a stable path that only ever emits
        // sentinels is not evicted ahead of churnier ones.
        cacheSet(state.cache, key, cached!);
        return { ...v, value: DUP_SENTINEL };
      }
      // First occurrence or value changed — cache the absolute value
      cacheSet(state.cache, key, { value: v.value, seq: NO_SEQ });
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

/**
 * Apply {@link dedupDelta} to a Delta, Delta[], or Record<string, Delta>.
 */
export function dedupDeltaPayload(payload: DeltaPayload, state: ValueDedupState): DeltaPayload {
  // dedupDelta never returns null, so the payload survives.
  return mapDeltaPayload(payload, (d) => dedupDelta(d, state)) as DeltaPayload;
}

// ── Inbound: expand sentinel back to the cached value ────────────────────────

/**
 * Walk a delta and replace each {@link DUP_SENTINEL} value with the cached
 * value for that path. Updates the cache with absolute (non-sentinel)
 * values as they arrive. Sentinel values for paths the receiver has never
 * seen (no cached baseline) are dropped rather than forwarded, so the raw
 * sentinel never leaks downstream; the sender resyncs on the next absolute
 * value. This should not happen in practice once the link is steady.
 *
 * Robust to malformed entries (null/non-object/missing path) — they pass
 * through untouched so the downstream sanitize step can reject them.
 *
 * @param seq - Sequence of the DATA packet carrying this delta. When given,
 *   an absolute value from a sequence older than the one that last wrote the
 *   entry is delivered but not cached, so a reordered packet cannot roll the
 *   receive cache backwards and desynchronise it from the sender.
 */
/**
 * Cache an absolute value unless it arrived from a sequence older than the
 * one that last wrote the entry. Payloads are dispatched in arrival order, so
 * without this a reordered older packet would leave the receive cache holding
 * a value the sender has already moved past, and the next sentinel would
 * expand to it.
 */
function cacheAbsoluteIfNewest(
  state: ValueDedupState,
  key: string,
  cached: DedupEntry | undefined,
  value: unknown,
  seq: number | undefined
): void {
  const stale =
    seq !== undefined &&
    cached !== undefined &&
    cached.seq !== NO_SEQ &&
    !serialAtOrAfter(seq, cached.seq);
  if (!stale) {
    cacheSet(state.cache, key, { value, seq: seq ?? NO_SEQ });
  }
}

/**
 * @param onMissingBaseline - Called (once per dropped entry) when a sentinel
 *   arrives for a path with no cached baseline. This is the signature of a
 *   receiver that lost its cache while the sender kept deduping — session
 *   expiry, eviction, or a receiver restart — and every affected path stays
 *   absent until its value actually changes; the receiver can use the hook to
 *   ask the sender for a full replay.
 */
export function undedupDelta(
  delta: Delta,
  state: ValueDedupState,
  seq?: number,
  onMissingBaseline?: () => void
): Delta {
  if (!Array.isArray(delta.updates)) return delta;
  const context = delta.context;
  let deltaChanged = false;

  const updates = delta.updates.map((update) => {
    // Pass malformed updates through — sanitize is responsible for them.
    if (!update || typeof update !== "object" || !Array.isArray(update.values)) return update;
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
      const cached = state.cache.get(key);
      if (isSentinel(v.value)) {
        if (cached === undefined) {
          // Receiver missed the absolute baseline — skip rather than inject the sentinel.
          // The sender will resync on the next absolute value.
          valuesChanged = true;
          onMissingBaseline?.();
          continue;
        }
        valuesChanged = true;
        // Refresh LRU position so a stable path is not evicted ahead of
        // churnier ones (mirrors the sender-side dedup behaviour).
        cacheSet(state.cache, key, cached);
        values.push({ ...v, value: cached.value });
      } else {
        // Absolute value — always delivered, but only cached when it is the
        // newest write for this path (see cacheAbsoluteIfNewest).
        cacheAbsoluteIfNewest(state, key, cached, v.value, seq);
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

export function undedupDeltaArray(
  deltas: Delta[],
  state: ValueDedupState,
  seq?: number,
  onMissingBaseline?: () => void
): Delta[] {
  let anyChanged = false;
  const out = deltas.map((d) => {
    const r = undedupDelta(d, state, seq, onMissingBaseline);
    if (r !== d) anyChanged = true;
    return r;
  });
  return anyChanged ? out : deltas;
}

// Re-export for tests / external users that want to introspect a sentinel.
export { isSentinel as isDupSentinel };
