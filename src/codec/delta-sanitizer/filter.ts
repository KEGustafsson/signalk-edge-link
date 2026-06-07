"use strict";

/** L1 codec — path allow/deny glob filtering (rewrite plan doc 02 split). */

import type {
  Delta,
  DeltaMeta,
  DeltaUpdate,
  DeltaValue,
  PathFilterConfig
} from "../../foundation/types";
import type { DeltaPayload } from "./internal";
import { isDeltaLike } from "./internal";

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
