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

import type { Delta, DeltaUpdate, DeltaValue, SignalKApp } from "../foundation/types";

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

  // Prefer the top-level single-source view: it reflects the *current*
  // writer, which is what live subscription deltas also carry. The
  // multi-source `values: { … }` map is signalk-server's append-only
  // history bookkeeping — entries created by sources that have since
  // stopped writing (different N2K source address, a previous edge-link
  // version, a one-shot delta from another local provider) stay there
  // for the life of the signalk-server process with no TTL. Walking
  // that map would ship every historical `$source` to the receiver,
  // where they become ghost entries that never refresh because no live
  // writer is producing them anymore.
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

  // No top-level leaf — fall back to the multi-source map for older
  // signalk-server versions or partial trees that only populated `values`.
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

  // Container — descend.
  for (const key of Object.keys(node)) {
    if (SK_LEAF_KEYS.has(key)) {
      continue;
    }
    walkValues(node[key], pathParts.concat(key), onLeaf);
  }
}

/**
 * Build a lookup map from $source reference string → structured source object
 * using the top-level `sources` section of the SK full model tree.
 *
 * signalk-server stores sources as sources[provider][key] = { label, type, ... }
 * and formats $source references as "provider.key". This function inverts that
 * structure so we can attach the correct source object to each synthetic update.
 *
 * Falls back to a minimal { label } entry derived from the $source string if
 * the sources section is absent or the exact reference is not found there.
 */
function buildSourceLookup(tree: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  const sourcesNode = tree.sources;
  if (!isRecord(sourcesNode)) {
    return lookup;
  }
  for (const [provider, providerNode] of Object.entries(sourcesNode)) {
    if (!isRecord(providerNode)) {
      continue;
    }
    for (const [key, sourceObj] of Object.entries(providerNode)) {
      if (isRecord(sourceObj)) {
        lookup.set(`${provider}.${key}`, sourceObj);
      }
    }
  }
  return lookup;
}

/**
 * Resolve the source object for a $source reference string. Tries the exact
 * reference in the lookup, then falls back to a { label } derived from the
 * part of the reference before the first ".".
 */
function resolveSource(
  sourceRef: string,
  lookup: Map<string, Record<string, unknown>>
): { label?: string; type?: string } | undefined {
  const found = lookup.get(sourceRef);
  if (found) {
    return found as { label?: string; type?: string };
  }
  // Fallback: provider label is the part before the first "."
  const dotIdx = sourceRef.indexOf(".");
  const label = dotIdx > 0 ? sourceRef.slice(0, dotIdx) : sourceRef;
  return label ? { label } : undefined;
}

/**
 * Build synthetic deltas for every value currently in the Signal K tree.
 *
 * Returns one delta per `(context, source, timestamp)` triple so that the
 * original per-path measurement time is preserved. Values from the same
 * source that were last updated at different times (e.g. GPS speed vs
 * autopilot settings) end up in separate updates rather than being collapsed
 * under the latest timestamp of the group.
 *
 * Each update carries both `$source` (the reference string) and `source`
 * (the structured source object looked up from the SK sources tree) so that
 * `handleMessageBySource` can call `app.handleMessage(source.label, delta)`
 * with the original instrument label rather than an empty provider ID.
 *
 * Returns [] when `app.signalk` isn't exposed (older signalk-server) or the
 * tree is empty.
 */
/** A grouped synthetic update keyed by (context, source, timestamp). */
interface SnapshotGroup {
  context: string;
  source: string | undefined;
  timestamp: string;
  values: DeltaValue[];
}

/**
 * Decide whether a leaf injected under a "signalk-edge-link.*" $source should be
 * skipped. Values stored under those $source keys were injected by this plugin
 * (data received via an upstream edge-link server connection or a downstream
 * edge-link client connection). Skip them only when the SK sources table cannot
 * provide a proper original-sensor label — that case would produce wrong
 * attribution on the receiver. When the sources table does resolve to a real
 * label (e.g. "pypilot"), include the value so relay data reaches the upstream
 * server after its restart; the receiver's normalizeDeltaSourceRefs will strip
 * the stale $source and handleMessageBySource will dispatch under the original
 * label.
 */
function shouldSkipOwnInjectedLeaf(
  source: string | undefined,
  sourceLookup: Map<string, Record<string, unknown>>
): boolean {
  const src = source ?? "";
  if (
    src !== "signalk-edge-link" &&
    !src.startsWith("signalk-edge-link.") &&
    !src.startsWith("signalk-edge-link:")
  ) {
    return false;
  }
  const resolved = sourceLookup.get(src);
  const resolvedLabel = typeof resolved?.label === "string" ? resolved.label.trim() : "";
  return (
    !resolvedLabel ||
    resolvedLabel === "signalk-edge-link" ||
    resolvedLabel.startsWith("signalk-edge-link.") ||
    resolvedLabel.startsWith("signalk-edge-link:")
  );
}

/**
 * Walk every context in the tree and group value leaves by
 * (context, source, timestamp). This preserves per-path timestamps: paths from
 * the same source that were last updated at different times (e.g. GPS vs
 * autopilot settings) are not collapsed under the same (latest) timestamp.
 */
function groupLeavesByMeasurement(
  tree: Record<string, unknown>,
  sourceLookup: Map<string, Record<string, unknown>>
): Map<string, SnapshotGroup> {
  const grouped = new Map<string, SnapshotGroup>();

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
        if (shouldSkipOwnInjectedLeaf(leaf.source, sourceLookup)) {
          return;
        }
        const key = `${context}|${leaf.source ?? ""}|${leaf.timestamp}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.values.push({ path: leaf.path, value: leaf.value });
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

  return grouped;
}

/** Build one synthetic Delta per grouped (context, source, timestamp) entry. */
function buildSnapshotDeltas(
  grouped: Map<string, SnapshotGroup>,
  sourceLookup: Map<string, Record<string, unknown>>
): Delta[] {
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
      const sourceObj = resolveSource(entry.source, sourceLookup);
      if (sourceObj) {
        update.source = sourceObj;
      }
    }
    deltas.push({ context: entry.context, updates: [update] });
  }
  return deltas;
}

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

  // Build $source → source object lookup from the top-level sources tree so
  // each synthetic update can carry the correct source.label for attribution.
  const sourceLookup = buildSourceLookup(tree);
  const grouped = groupLeavesByMeasurement(tree, sourceLookup);
  return buildSnapshotDeltas(grouped, sourceLookup);
}
