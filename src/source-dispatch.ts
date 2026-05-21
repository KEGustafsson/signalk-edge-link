"use strict";

/**
 * Signal K Edge Link — Delta Source Dispatcher
 *
 * NOTE: One of three sibling files with confusable names. See the
 * top-of-file block in src/source-snapshot.ts for the full taxonomy.
 *
 * This module handles RECEIVER-SIDE NORMALIZATION of incoming deltas
 * before they are dispatched into the local Signal K tree via
 * app.handleMessage. Responsibilities: synthesize `$source` from the
 * structured `source` object when missing, drop deltas that carry
 * stale edge-link-injected attribution (preventing source loops
 * across multi-hop chains), and split a multi-source delta into one
 * handleMessage call per source so signalk-server's source recompute
 * lands on the correct bucket.
 *
 * Distinct from `source-replication.ts` (per-process source identity
 * registry, populated from DATA ingest) and `source-snapshot.ts`
 * (wire transport for the full /sources tree).
 *
 * @module lib/source-dispatch
 */

import type { Delta, DeltaMeta, DeltaUpdate, DeltaValue, SignalKApp } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isStaleEdgeLinkRef(sourceRef: string): boolean {
  return (
    sourceRef === "signalk-edge-link" ||
    sourceRef.startsWith("signalk-edge-link.") ||
    sourceRef.startsWith("signalk-edge-link:")
  );
}

/**
 * Mirror of signalk-schema's `getSourceId` for use when the incoming update
 * lacks a `$source` string and we have to synthesize one from the structured
 * `source` object. Kept locally so we don't introduce a runtime dependency
 * on signalk-schema just for this one function.
 *
 * Notably: the schema's fallback for a labelled-but-otherwise-empty source
 * is `${label}.XX` (literal "XX"). We deliberately do NOT reproduce that
 * fallback here — emitting a bare label keeps the receiver's $source key
 * identical to what a single-source publisher would have stored.
 */
function deriveSourceRefFromObject(source: Record<string, unknown>): string {
  const label = trimmedString(source.label);
  if (!label) {
    return "";
  }
  const canName = trimmedString(source.canName);
  if (canName) {
    return `${label}.${canName}`;
  }
  const src = source.src === undefined || source.src === null ? "" : String(source.src).trim();
  if (src) {
    return `${label}.${src}`;
  }
  const talker = trimmedString(source.talker);
  if (talker) {
    return `${label}.${talker}`;
  }
  return label;
}

/**
 * Resolve the canonical `$source` string for an update, preferring the
 * incoming `$source` field over a derived value from the structured source
 * object. A stale `signalk-edge-link.*` explicit ref is only replaced when
 * the derived ref is genuinely fresh — otherwise we'd be swapping one stale
 * attribution for another (e.g. when `source.label` is itself
 * `"signalk-edge-link"` on a relayed update), which would collapse keys and
 * misroute downstream subscribers.
 */
function resolveSourceRef(update: DeltaUpdate): string {
  const explicit = trimmedString(update.$source);
  const sourceObj = isRecord(update.source) ? update.source : null;
  const derived = sourceObj ? deriveSourceRefFromObject(sourceObj) : "";

  if (explicit) {
    if (!isStaleEdgeLinkRef(explicit)) {
      return explicit;
    }
    // Explicit is stale; only swap to derived if derived is genuinely fresh.
    if (!derived || isStaleEdgeLinkRef(derived)) {
      return explicit;
    }
  }
  return derived;
}

/**
 * Build the update object actually handed to `app.handleMessage`.
 *
 * Critically, the structured `source` object is dropped — signalk-server's
 * `FullSignalK.addValue` unconditionally recomputes the leaf's `$source` via
 * `getSourceId(source)` whenever a structured source is present, which in turn
 * uses the providerId-rewritten `source.label` and the hardcoded `.XX` fallback
 * from signalk-schema. Passing the canonical `$source` as a string instead
 * (via the `update.source || update.$source` short-circuit in addUpdate)
 * makes addValue store the leaf under our chosen key verbatim, so a leaf
 * published on the boat as `$source = "bedroom"` lands on every downstream
 * node as `$source = "bedroom"` too.
 *
 * Side effect: per-leaf `pgn` / `sentence` metadata that signalk-schema's
 * `setMessage` would attach from the source object is no longer applied at
 * the receiver — that metadata still rides across the link via the source
 * snapshot envelope (`sendSourceSnapshot` / `mergeSourceSnapshot`) and is
 * available under `/signalk/v1/api/sources`.
 */
function prepareUpdateForDispatch(update: DeltaUpdate): DeltaUpdate {
  const sourceRef = resolveSourceRef(update);
  const prepared: DeltaUpdate = {
    values: Array.isArray(update.values)
      ? update.values.map((value) => ({ ...(value as DeltaValue) }))
      : update.values
  };
  if (update.timestamp !== undefined) {
    prepared.timestamp = update.timestamp;
  }
  if (Array.isArray(update.meta)) {
    prepared.meta = update.meta.map((entry) => ({ ...(entry as DeltaMeta) }));
  }
  if (sourceRef) {
    prepared.$source = sourceRef;
  }
  return prepared;
}

/**
 * Strip stale `signalk-edge-link.*` `$source` values from a delta in place
 * (well, by returning a cloned delta when needed). Kept for callers that need
 * to massage a delta without going through full dispatch — currently used by
 * the v2 server pipeline before `_ingestRemoteTelemetry`.
 *
 * After the resolve-source-ref rewrite this is largely a no-op for the
 * dispatch path itself: `resolveSourceRef` already prefers a fresh structured
 * source over a stale `signalk-edge-link.*` `$source`. It remains useful so
 * downstream consumers (e.g. source-replication metrics) see the same
 * normalised `$source` the receiver would store.
 */
export function normalizeDeltaSourceRefs(delta: Delta): Delta {
  if (!delta || !Array.isArray(delta.updates)) {
    return delta;
  }

  let changed = false;
  const updates = delta.updates.map((update) => {
    const sourceRef = trimmedString(update.$source);
    if (!sourceRef || !isStaleEdgeLinkRef(sourceRef)) {
      return update;
    }
    const sourceObj = isRecord(update.source) ? update.source : null;
    const sourceLabel = trimmedString(sourceObj?.label);
    // Only strip when we have a real (non-edge-link) structured source the
    // receiver can fall back to. Otherwise keep the stale $source so the
    // value still has *some* attribution downstream. Use prefix-aware
    // staleness detection so a label like `"signalk-edge-link:<instanceId>"`
    // is treated the same as the bare `"signalk-edge-link"`.
    if (!sourceLabel || isStaleEdgeLinkRef(sourceLabel)) {
      return update;
    }
    changed = true;
    const cloned = { ...update };
    delete cloned.$source;
    return cloned;
  });

  return changed ? { ...delta, updates } : delta;
}

/**
 * Hand a delta to `app.handleMessage` with `$source` preserved end-to-end.
 *
 * signalk-server's plugin handleMessage wrapper substitutes the calling
 * plugin's id for whatever providerId argument we pass, so dispatching one
 * call per source label is pointless — we always end up with providerId =
 * `"signalk-edge-link"` anyway. The important work is in
 * `prepareUpdateForDispatch`, which drops the structured `source` object so
 * `FullSignalK.addValue` doesn't recompute the leaf's `$source` from the
 * rewritten label.
 */
export function handleMessageBySource(app: Pick<SignalKApp, "handleMessage">, delta: Delta): void {
  if (!delta || !Array.isArray(delta.updates) || delta.updates.length === 0) {
    return;
  }

  const prepared = delta.updates.map(prepareUpdateForDispatch);
  app.handleMessage("", { ...delta, updates: prepared });
}
