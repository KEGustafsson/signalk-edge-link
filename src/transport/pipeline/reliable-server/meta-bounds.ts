"use strict";

/**
 * Structural bounds for META entries injected into the Signal K tree. The
 * sibling source-snapshot channel enforces key/depth/size caps; without an
 * equivalent gate, an authenticated peer could push arbitrarily deep or wide
 * meta objects (within the decompression cap) straight into
 * `app.handleMessage`. Limits are generous against real Signal K meta (units,
 * descriptions, zones, enums) — the point is boundedness, not shape policing.
 *
 * @module transport/pipeline/reliable-server/meta-bounds
 */

const META_MAX_CONTEXT_LENGTH = 256;
const META_MAX_PATH_LENGTH = 512;
const META_MAX_DEPTH = 6;
const META_MAX_OBJECT_KEYS = 64;
const META_MAX_ARRAY_LENGTH = 256;
const META_MAX_STRING_LENGTH = 4096;
const META_BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively enforce depth, width, and string-length caps on a meta value. */
function isBoundedMetaValue(value: unknown, depth: number): boolean {
  if (depth > META_MAX_DEPTH) {
    return false;
  }
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
      return value.length <= META_MAX_STRING_LENGTH;
    case "number":
      return Number.isFinite(value);
    case "boolean":
      return true;
    case "object": {
      if (Array.isArray(value)) {
        if (value.length > META_MAX_ARRAY_LENGTH) {
          return false;
        }
        return value.every((entry) => isBoundedMetaValue(entry, depth + 1));
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > META_MAX_OBJECT_KEYS) {
        return false;
      }
      for (const key of keys) {
        if (META_BLOCKED_KEYS.has(key) || key.length > META_MAX_STRING_LENGTH) {
          return false;
        }
        if (!isBoundedMetaValue(record[key], depth + 1)) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** True when a decoded META entry's path, context, and meta stay in bounds. */
export function metaEntryWithinBounds(path: string, context: string, meta: unknown): boolean {
  return (
    path.length <= META_MAX_PATH_LENGTH &&
    context.length <= META_MAX_CONTEXT_LENGTH &&
    isBoundedMetaValue(meta, 1)
  );
}
