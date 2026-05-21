"use strict";

/**
 * Signal K Edge Link — Source Tree Replicator
 *
 * NOTE: This module is one of three sibling files with confusable names.
 * They cover three different layers:
 *
 *   - source-snapshot.ts   (THIS FILE) — WIRE TRANSPORT. Captures the
 *     sender's `app.signalk.retrieve().sources` tree as a snapshot and
 *     merges incoming peer snapshots into the receiver's tree. Bounded
 *     by SOURCE_SNAPSHOT_MAX_* constants so a malicious peer cannot
 *     pollute /signalk/v1/api/sources with arbitrary keys.
 *
 *   - source-replication.ts — SERVER-SIDE REGISTRY. Normalised
 *     in-memory record per logical source (identity hash, metadata,
 *     provenance), populated incrementally from DATA ingest. The
 *     content of `sources` it replicates actually arrives via this
 *     module's METADATA channel.
 *
 *   - source-dispatch.ts — RECEIVER-SIDE DELTA NORMALIZATION. Massages
 *     incoming DATA deltas (source-ref handling, edge-link-injected
 *     filter) before app.handleMessage().
 *
 * @module lib/source-snapshot
 */

import type { SignalKApp } from "./types";
import {
  SOURCE_SNAPSHOT_MAX_PROVIDERS,
  SOURCE_SNAPSHOT_MAX_KEY_LENGTH,
  SOURCE_SNAPSHOT_MAX_STRING_LENGTH,
  SOURCE_SNAPSHOT_MAX_DEPTH
} from "./constants";

export type SourceTree = Record<string, unknown>;

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Provider/sub-keys come from a peer; constrain to printable ASCII without
// control bytes so a malicious peer cannot pollute /signalk/v1/api/sources
// with control characters or overlong strings that would explode
// JSON-encoded API responses. Spaces and the broader printable range are
// allowed because legitimate provider names ("Arabella Compass", talker
// labels) and NMEA sentence keys exercise the full printable set.
// eslint-disable-next-line no-control-regex
const KEY_PATTERN = /^[\x20-\x7E]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlain(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!BLOCKED_KEYS.has(key)) {
      out[key] = clonePlain(entry);
    }
  }
  return out;
}

function isAcceptableKey(key: string): boolean {
  return (
    !BLOCKED_KEYS.has(key) &&
    key.length > 0 &&
    key.length <= SOURCE_SNAPSHOT_MAX_KEY_LENGTH &&
    KEY_PATTERN.test(key)
  );
}

function isAcceptableValue(value: unknown, depth: number): boolean {
  if (depth > SOURCE_SNAPSHOT_MAX_DEPTH) {
    return false;
  }
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
      return value.length <= SOURCE_SNAPSHOT_MAX_STRING_LENGTH;
    case "number":
      return Number.isFinite(value);
    case "boolean":
      return true;
    case "object": {
      if (Array.isArray(value)) {
        return value.every((entry) => isAcceptableValue(entry, depth + 1));
      }
      const record = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(record)) {
        if (!isAcceptableKey(k)) {
          return false;
        }
        if (!isAcceptableValue(v, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

function mergePlain(target: Record<string, unknown>, incoming: Record<string, unknown>): void {
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (!isAcceptableKey(key)) {
      continue;
    }
    if (!isAcceptableValue(incomingValue, 1)) {
      continue;
    }
    const currentValue = target[key];
    if (isRecord(currentValue) && isRecord(incomingValue)) {
      mergePlain(currentValue, incomingValue);
    } else {
      target[key] = clonePlain(incomingValue);
    }
  }
}

function getSignalKRoot(app: Pick<SignalKApp, "debug">): Record<string, unknown> | null {
  const signalk = (app as unknown as { signalk?: { retrieve?: () => unknown } }).signalk;
  if (!signalk || typeof signalk.retrieve !== "function") {
    return null;
  }
  const root = signalk.retrieve();
  return isRecord(root) ? root : null;
}

export function collectSourceSnapshot(app: Pick<SignalKApp, "debug">): SourceTree | null {
  const root = getSignalKRoot(app);
  if (!root || !isRecord(root.sources)) {
    return null;
  }
  return clonePlain(root.sources) as SourceTree;
}

export function mergeSourceSnapshot(app: Pick<SignalKApp, "debug">, sources: unknown): number {
  if (!isRecord(sources)) {
    return 0;
  }

  const root = getSignalKRoot(app);
  if (!root) {
    return 0;
  }
  if (!isRecord(root.sources)) {
    root.sources = {};
  }

  const target = root.sources as Record<string, unknown>;
  const before = Object.keys(target).length;
  // Cap incoming provider count so a misbehaving or malicious peer cannot
  // grow root.sources without bound.
  const limited: Record<string, unknown> = {};
  let count = 0;
  let dropped = 0;
  for (const [key, value] of Object.entries(sources)) {
    if (count >= SOURCE_SNAPSHOT_MAX_PROVIDERS) {
      dropped++;
      continue;
    }
    if (!isAcceptableKey(key) || !isAcceptableValue(value, 1)) {
      dropped++;
      continue;
    }
    limited[key] = value;
    count++;
  }
  if (dropped > 0) {
    app.debug(`[source-snapshot] rejected ${dropped} provider key(s) (validation/cap)`);
  }
  mergePlain(target, limited);
  return Object.keys(target).length - before;
}
