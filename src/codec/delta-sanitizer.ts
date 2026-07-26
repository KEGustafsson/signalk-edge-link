"use strict";

/**
 * L1 codec — delta sanitization public surface.
 * Composes own-data stripping + core SignalK sanitize with the split
 * quantize / throttle / filter concerns.
 *
 * @module codec/delta-sanitizer
 */

import type { Delta, DeltaUpdate, DeltaValue } from "../foundation/types";
import type { DeltaPayload } from "./delta-sanitizer/internal";
import { isObject, isDeltaLike } from "./delta-sanitizer/internal";

export type { DeltaPayload } from "./delta-sanitizer/internal";
export * from "./delta-sanitizer/quantize";
export * from "./delta-sanitizer/throttle";
export * from "./delta-sanitizer/filter";

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

/** Result of stripping own data from a single update. */
type StripUpdateResult =
  | { kind: "unchanged"; update: DeltaUpdate }
  | { kind: "replaced"; update: DeltaUpdate }
  | { kind: "dropped" };

/**
 * Strip own-data value/meta entries from a single update.
 * Returns whether the update is unchanged, replaced, or dropped entirely.
 */
function stripOwnDataFromUpdate(update: DeltaUpdate): StripUpdateResult {
  const rawValues = Array.isArray(update.values) ? update.values : [];
  const values = rawValues.filter((v) => !isOwnDataPath((v as DeltaValue)?.path));
  const valuesChanged = values.length !== rawValues.length;

  const rawMeta = Array.isArray(update.meta) ? update.meta : null;
  const meta = rawMeta ? rawMeta.filter((m) => !isOwnDataPath(m?.path)) : null;
  const metaChanged = rawMeta !== null && meta !== null && meta.length !== rawMeta.length;

  if (values.length === 0 && (!meta || meta.length === 0)) {
    return { kind: "dropped" };
  }

  if (!valuesChanged && !metaChanged) {
    return { kind: "unchanged", update };
  }

  const next: DeltaUpdate = { ...update, values };
  if (meta && meta.length > 0) {
    next.meta = meta;
  } else if (rawMeta) {
    delete next.meta;
  }
  return { kind: "replaced", update: next };
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
    const result = stripOwnDataFromUpdate(update);
    if (result.kind === "dropped") {
      changed = true;
    } else {
      if (result.kind === "replaced") {
        changed = true;
      }
      surviving.push(result.update);
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

function isValidValuePath(path: unknown): path is string {
  return typeof path === "string" && path.trim().length > 0;
}

/** Result of sanitizing a single update for Signal K. */
type SanitizeUpdateResult =
  | { kind: "unchanged"; update: DeltaUpdate }
  | { kind: "replaced"; update: DeltaUpdate }
  | { kind: "dropped" };

/**
 * Sanitize a single raw update: drop invalid value entries and report whether
 * the update is unchanged, replaced, or dropped entirely (no valid values and
 * no meta).
 */
function sanitizeUpdateForSignalK(rawUpdate: unknown): SanitizeUpdateResult {
  if (!isObject(rawUpdate)) {
    return { kind: "dropped" };
  }

  const update = rawUpdate as unknown as DeltaUpdate;
  let updateChanged = false;
  const rawValues = Array.isArray(update.values) ? (update.values as unknown[]) : [];
  if (!Array.isArray(update.values)) {
    updateChanged = true;
  }

  // Allocate the filtered array only once something actually needs filtering.
  // This runs per update of every delta (hundreds per second on an NMEA2000
  // vessel, and twice per outbound delta because the sender re-sanitizes a
  // payload the producer already sanitized), and the overwhelmingly common case
  // is that nothing changes.
  let values: DeltaValue[] | null = null;
  let validCount = 0;
  for (let i = 0; i < rawValues.length; i++) {
    const rawValue = rawValues[i];
    if (!isObject(rawValue) || !isValidValuePath(rawValue.path)) {
      if (values === null) {
        // First rejection: materialize the values accepted so far.
        values = rawValues.slice(0, i) as unknown as DeltaValue[];
      }
      updateChanged = true;
      continue;
    }
    validCount++;
    if (values !== null) {
      values.push(rawValue as unknown as DeltaValue);
    }
  }

  const hasMeta = Array.isArray(update.meta) && update.meta.length > 0;
  if (validCount === 0 && !hasMeta) {
    return { kind: "dropped" };
  }

  if (!updateChanged) {
    return { kind: "unchanged", update };
  }
  return { kind: "replaced", update: { ...update, values: values ?? [] } };
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

  // As above: build the replacement array lazily so an unchanged delta — the
  // common case — costs no allocation at all.
  let sanitizedUpdates: DeltaUpdate[] | null = null;
  let keptCount = 0;
  const rawUpdates = delta.updates as unknown[];

  for (let i = 0; i < rawUpdates.length; i++) {
    const result = sanitizeUpdateForSignalK(rawUpdates[i]);
    if (result.kind === "dropped") {
      if (sanitizedUpdates === null) {
        sanitizedUpdates = (delta.updates as DeltaUpdate[]).slice(0, i);
      }
      continue;
    }
    if (result.kind === "replaced" && sanitizedUpdates === null) {
      sanitizedUpdates = (delta.updates as DeltaUpdate[]).slice(0, i);
    }
    keptCount++;
    if (sanitizedUpdates !== null) {
      sanitizedUpdates.push(result.update);
    }
  }

  if (keptCount === 0) {
    return null;
  }

  if (sanitizedUpdates === null) {
    return delta;
  }

  return {
    ...delta,
    updates: sanitizedUpdates
  };
}

export function sanitizeDeltaPayloadForSignalK(delta: DeltaPayload): DeltaPayload | null {
  if (Array.isArray(delta)) {
    // Return the input array by reference when every entry survives unchanged,
    // avoiding the two intermediate arrays that .map().filter() allocates per
    // batch.
    let sanitized: Delta[] | null = null;
    let keptCount = 0;
    for (let i = 0; i < delta.length; i++) {
      const item = sanitizeDeltaForSignalK(delta[i]);
      if (item === null) {
        if (sanitized === null) sanitized = delta.slice(0, i);
        continue;
      }
      if (item !== delta[i] && sanitized === null) {
        sanitized = delta.slice(0, i);
      }
      keptCount++;
      if (sanitized !== null) sanitized.push(item);
    }
    if (keptCount === 0) return null;
    return sanitized ?? delta;
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
