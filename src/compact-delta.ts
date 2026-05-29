"use strict";

/**
 * Positional / schema-aware delta encoding.
 *
 * Standard Signal K JSON has enormous per-delta field-name overhead:
 *   {"context":"...","updates":[{"source":{"label":"..."},
 *    "timestamp":"...","values":[{"path":"...","value":...}]}]}
 *
 * Those field names alone cost ~70-100 bytes per delta. When both
 * peers use MessagePack and have already agreed on the path
 * dictionary, we can drop the field names entirely and send the same
 * information as a positional array of arrays:
 *
 *   [context, [
 *     [source, $source, timestamp, [[pathId, value], ...], [[pathId, meta], ...]],
 *     ...
 *   ]]
 *
 * The receiver knows the positional layout and reconstructs the same
 * Delta shape before handing off to the rest of the pipeline.
 *
 * **Wire-format flag**: `useCompactDeltas` — both peers must agree. This
 * flag implies `useMsgpack: true` (the gain only materializes in
 * binary form; JSON-mode `[...]` strings are not noticeably smaller
 * than `{...}` after Brotli). The flag is independent of
 * `usePathDictionary` — if dictionary encoding is on the path slot
 * holds an integer, otherwise it holds a string. The decoder accepts
 * both.
 *
 * Realistic gain: 60-80% reduction on small batches BEFORE Brotli, and
 * because Brotli has less work to do (fewer repeated strings to
 * deduplicate), 15-30% reduction AFTER Brotli too.
 */

import type { Delta, DeltaMeta, DeltaUpdate, DeltaValue } from "./types";

// Update tuple position constants — keeps the encoder and decoder honest.
const POS_SOURCE = 0;
const POS_DOLLAR_SOURCE = 1;
const POS_TIMESTAMP = 2;
const POS_VALUES = 3;
const POS_META = 4;

// Length we always emit so positional access is stable.
const UPDATE_TUPLE_LEN = 5;

/**
 * Encode a single update block into a positional 5-element array.
 * Missing fields are encoded as `null` to keep positions stable.
 */
function encodeUpdate(update: DeltaUpdate): unknown[] {
  const valuesArr: unknown[][] = [];
  if (Array.isArray(update.values)) {
    for (const v of update.values) {
      if (v && typeof v === "object" && (v as DeltaValue).path !== undefined) {
        valuesArr.push([(v as DeltaValue).path, (v as DeltaValue).value]);
      }
    }
  }
  const metaArr: unknown[][] = [];
  if (Array.isArray(update.meta)) {
    for (const m of update.meta) {
      if (m && typeof m === "object" && (m as DeltaMeta).path !== undefined) {
        metaArr.push([(m as DeltaMeta).path, (m as DeltaMeta).value]);
      }
    }
  }
  // Use null for absent source/timestamp; null compresses to a single byte in msgpack.
  return [
    update.source ?? null,
    update.$source ?? null,
    update.timestamp ?? null,
    valuesArr,
    metaArr.length > 0 ? metaArr : null
  ];
}

/**
 * Encode a single Delta into a positional 2-element array.
 *
 *   [context, [updateTuple, updateTuple, ...]]
 */
export function encodeCompactDelta(delta: Delta): unknown[] {
  const updates = Array.isArray(delta.updates) ? delta.updates : [];
  return [delta.context ?? null, updates.map(encodeUpdate)];
}

/**
 * Encode a Delta, Delta[], or Record<string, Delta> as a flat array of
 * compact deltas. The shape (single / array / record) is collapsed to
 * an array because the receiver pipeline already handles both array
 * and object batch forms identically.
 */
export function encodeCompactPayload(payload: Delta | Delta[] | Record<string, Delta>): unknown[] {
  if (Array.isArray(payload)) {
    return payload.map(encodeCompactDelta);
  }
  if (payload && typeof payload === "object" && Array.isArray((payload as Delta).updates)) {
    return [encodeCompactDelta(payload as Delta)];
  }
  // Record<string, Delta>
  const out: unknown[] = [];
  for (const d of Object.values(payload as Record<string, Delta>)) {
    if (d && typeof d === "object") {
      out.push(encodeCompactDelta(d));
    }
  }
  return out;
}

// ── Decoding ─────────────────────────────────────────────────────────────────

function decodeUpdate(tuple: unknown): DeltaUpdate | null {
  if (!Array.isArray(tuple) || tuple.length < UPDATE_TUPLE_LEN) return null;
  const source = tuple[POS_SOURCE];
  const dollarSource = tuple[POS_DOLLAR_SOURCE];
  const timestamp = tuple[POS_TIMESTAMP];
  const rawValues = tuple[POS_VALUES];
  const rawMeta = tuple[POS_META];

  const values: DeltaValue[] = [];
  if (Array.isArray(rawValues)) {
    for (const vt of rawValues) {
      if (Array.isArray(vt) && vt.length >= 2) {
        values.push({ path: vt[0] as string, value: vt[1] });
      }
    }
  }

  const update: DeltaUpdate = { values };
  if (source !== null && source !== undefined) {
    update.source = source as DeltaUpdate["source"];
  }
  if (typeof dollarSource === "string") {
    update.$source = dollarSource;
  }
  if (typeof timestamp === "string") {
    update.timestamp = timestamp;
  }
  if (Array.isArray(rawMeta)) {
    const meta: DeltaMeta[] = [];
    for (const mt of rawMeta) {
      if (Array.isArray(mt) && mt.length >= 2) {
        meta.push({ path: mt[0] as string, value: mt[1] as Record<string, unknown> });
      }
    }
    if (meta.length > 0) update.meta = meta;
  }
  return update;
}

/**
 * Decode a single compact-encoded delta back into a Signal K Delta.
 * Returns null for malformed input so the caller can drop it cleanly.
 */
export function decodeCompactDelta(payload: unknown): Delta | null {
  if (!Array.isArray(payload) || payload.length < 2) return null;
  const context = payload[0];
  const rawUpdates = payload[1];
  if (!Array.isArray(rawUpdates)) return null;
  const updates: DeltaUpdate[] = [];
  for (const u of rawUpdates) {
    const decoded = decodeUpdate(u);
    if (decoded) updates.push(decoded);
  }
  const out: Delta = {
    context: typeof context === "string" ? context : "",
    updates
  };
  return out;
}

/**
 * Detect whether a parsed message is compact-encoded (flat array of
 * 2-element arrays) versus a standard Signal K Delta array. We use the
 * first element's shape as the discriminator:
 *   - compact:  [[ctx, [...updates]], ...]  → element 0 is itself a 2-tuple
 *   - standard: [{context, updates}, ...]   → element 0 is an object
 */
export function isCompactDeltaArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0];
  return (
    Array.isArray(first) && first.length >= 2 && Array.isArray(first[1]) // updates slot is itself an array
  );
}

/**
 * Decode a compact-encoded array of deltas into an array of standard
 * Signal K Deltas. Skips entries that fail to decode.
 */
export function decodeCompactDeltaArray(payload: unknown): Delta[] {
  if (!Array.isArray(payload)) return [];
  const out: Delta[] = [];
  for (const item of payload) {
    const d = decodeCompactDelta(item);
    if (d) out.push(d);
  }
  return out;
}
