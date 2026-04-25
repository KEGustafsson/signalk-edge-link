"use strict";

import type { Delta, DeltaUpdate, DeltaValue } from "./types";

export type DeltaPayload = Delta | Delta[] | Record<string, Delta>;

/**
 * Path prefixes for data this plugin publishes locally. When the
 * `skipOwnData` option is set on a client connection, value entries with
 * matching paths are stripped before the delta is forwarded over the link so
 * the receiver's Signal K tree is not polluted with the sender's own
 * edge-link metrics.
 */
const OWN_DATA_PATH_PREFIXES = ["networking.edgeLink.", "networking.modem."];

function isOwnDataPath(path: unknown): boolean {
  if (typeof path !== "string") {
    return false;
  }
  for (const prefix of OWN_DATA_PATH_PREFIXES) {
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
