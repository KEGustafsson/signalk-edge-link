"use strict";

/**
 * Signal K Edge Link - Values Snapshot
 *
 * `app.subscriptionmanager.subscribe()` only delivers *future* deltas, so any
 * value already present in the Signal K tree at subscribe time — including
 * one-shot startup values published by other plugins before edge-link's
 * subscription was wired up — is silently missed. Walking
 * `app.signalk.retrieve()` once, building synthetic deltas from the current
 * leaves, and feeding them through the regular outbound pipeline catches
 * those startup values up at the receiver.
 *
 * Intentionally narrow scope: only walks value leaves and ignores `meta`
 * (metadata has its own snapshot pathway in `metadata.ts`) and `sources`
 * (handled by `source-snapshot.ts`).
 *
 * @module lib/values-snapshot
 */

import type { Delta, DeltaUpdate, DeltaValue, SignalKApp } from "./types";

// Reserved leaf-level keys we must not descend into when walking the tree.
const SK_LEAF_KEYS = new Set([
  "value",
  "values",
  "timestamp",
  "$source",
  "meta",
  "sentence",
  "pgn"
]);

// Top-level tree keys that aren't context groups.
const SK_NON_CONTEXT_KEYS = new Set(["self", "version", "sources"]);

interface ValueLeaf {
  path: string;
  value: unknown;
  timestamp: string;
  source: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readLeafFromNode(obj: Record<string, unknown>): {
  value: unknown;
  timestamp: string;
  source: string | undefined;
} | null {
  // A Signal K value leaf has either a `value` property with sibling
  // `timestamp`, or a multi-source `values` map. Single-source leaves are the
  // common case so we handle them first.
  if ("value" in obj && typeof obj.timestamp === "string") {
    return {
      value: obj.value,
      timestamp: obj.timestamp,
      source: typeof obj.$source === "string" ? obj.$source : undefined
    };
  }
  return null;
}

function walkValues(node: unknown, pathParts: string[], onLeaf: (leaf: ValueLeaf) => void): void {
  if (!isRecord(node)) {
    return;
  }

  // Multi-source case wins when present: `values` is { sourceLabel:
  // { value, timestamp } } and is more authoritative than the top-level
  // `value`/`timestamp` (which mirror the latest of the multi-source map).
  // Emit one leaf per source so the receiver retains attribution, then stop
  // — the rest of the node is per-source bookkeeping.
  if (isRecord(node.values)) {
    for (const [sourceLabel, sourceData] of Object.entries(node.values)) {
      if (
        isRecord(sourceData) &&
        "value" in sourceData &&
        typeof sourceData.timestamp === "string"
      ) {
        onLeaf({
          path: pathParts.join("."),
          value: sourceData.value,
          timestamp: sourceData.timestamp,
          source: sourceLabel
        });
      }
    }
    return;
  }

  // Single-source leaf.
  const single = readLeafFromNode(node);
  if (single !== null) {
    onLeaf({
      path: pathParts.join("."),
      value: single.value,
      timestamp: single.timestamp,
      source: single.source
    });
    return;
  }

  // Container — descend.
  for (const key of Object.keys(node)) {
    if (SK_LEAF_KEYS.has(key)) {
      continue;
    }
    walkValues(node[key], pathParts.concat(key), onLeaf);
  }
}

/**
 * Build synthetic deltas for every value currently in the Signal K tree.
 *
 * Returns one delta per `(context, source)` pair, with all matching leaves
 * grouped into a single `updates[].values[]` array. `DeltaUpdate.timestamp`
 * is per-update (not per-leaf), so the latest timestamp across the group is
 * used — receivers treat the delta as "current state" anyway.
 *
 * Returns [] when `app.signalk` isn't exposed (older signalk-server) or the
 * tree is empty.
 */
export function collectValuesSnapshot(app: Pick<SignalKApp, "signalk" | "debug">): Delta[] {
  if (!app.signalk || typeof app.signalk.retrieve !== "function") {
    return [];
  }

  let tree: Record<string, unknown>;
  try {
    const retrieved = app.signalk.retrieve();
    if (!isRecord(retrieved)) {
      return [];
    }
    tree = retrieved;
  } catch {
    return [];
  }

  // Group leaves by (context, source) so we emit one delta per group.
  const grouped = new Map<
    string,
    {
      context: string;
      source: string | undefined;
      timestamp: string;
      values: DeltaValue[];
    }
  >();

  for (const contextGroup of Object.keys(tree)) {
    if (SK_NON_CONTEXT_KEYS.has(contextGroup)) {
      continue;
    }
    const group = tree[contextGroup];
    if (!isRecord(group)) {
      continue;
    }
    for (const contextId of Object.keys(group)) {
      const contextNode = group[contextId];
      if (!isRecord(contextNode)) {
        continue;
      }
      const context = `${contextGroup}.${contextId}`;

      walkValues(contextNode, [], (leaf) => {
        const key = `${context}|${leaf.source ?? ""}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.values.push({ path: leaf.path, value: leaf.value });
          if (leaf.timestamp > existing.timestamp) {
            existing.timestamp = leaf.timestamp;
          }
        } else {
          grouped.set(key, {
            context,
            source: leaf.source,
            timestamp: leaf.timestamp,
            values: [{ path: leaf.path, value: leaf.value }]
          });
        }
      });
    }
  }

  const deltas: Delta[] = [];
  for (const entry of grouped.values()) {
    if (entry.values.length === 0) {
      continue;
    }
    const update: DeltaUpdate = {
      timestamp: entry.timestamp,
      values: entry.values
    };
    if (entry.source) {
      update.$source = entry.source;
    }
    deltas.push({ context: entry.context, updates: [update] });
  }

  return deltas;
}
