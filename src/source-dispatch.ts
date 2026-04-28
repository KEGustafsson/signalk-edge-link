"use strict";

import type { Delta, DeltaMeta, DeltaUpdate, DeltaValue, SignalKApp } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getSourceLabel(update: DeltaUpdate): string {
  const source = isRecord(update.source) ? update.source : null;
  const label = source && typeof source.label === "string" ? source.label.trim() : "";
  return label.length > 0 ? label : "";
}

function hasStaleEdgeLinkSourceRef(update: DeltaUpdate): boolean {
  const sourceLabel = getSourceLabel(update);
  const sourceRef = typeof update.$source === "string" ? update.$source.trim() : "";
  if (!sourceLabel || !sourceRef || sourceLabel === "signalk-edge-link") {
    return false;
  }
  return (
    sourceRef === "signalk-edge-link" ||
    sourceRef.startsWith("signalk-edge-link.") ||
    sourceRef.startsWith("signalk-edge-link:")
  );
}

function normalizeUpdateSourceRef(update: DeltaUpdate): DeltaUpdate {
  if (!hasStaleEdgeLinkSourceRef(update)) {
    return update;
  }
  const cloned = { ...update };
  delete cloned.$source;
  return cloned;
}

function cloneUpdate(update: DeltaUpdate): DeltaUpdate {
  const normalized = normalizeUpdateSourceRef(update);
  const cloned = {
    ...normalized,
    source: isRecord(normalized.source)
      ? ({ ...normalized.source } as DeltaUpdate["source"])
      : normalized.source,
    values: Array.isArray(normalized.values)
      ? normalized.values.map((value) => ({ ...(value as DeltaValue) }))
      : normalized.values,
    meta: Array.isArray(normalized.meta)
      ? normalized.meta.map((entry) => ({ ...(entry as DeltaMeta) }))
      : normalized.meta
  };

  return cloned;
}

export function normalizeDeltaSourceRefs(delta: Delta): Delta {
  if (!delta || !Array.isArray(delta.updates)) {
    return delta;
  }

  let changed = false;
  const updates = delta.updates.map((update) => {
    const normalized = normalizeUpdateSourceRef(update);
    if (normalized !== update) {
      changed = true;
    }
    return normalized;
  });

  return changed ? { ...delta, updates } : delta;
}

/**
 * Signal K's app.handleMessage(providerId, delta) rewrites update.source.label
 * to providerId before applying the delta. Remote updates can contain several
 * original source labels, so dispatch them under their original label. Stale
 * edge-link `$source` values are removed separately before dispatch so Signal K
 * can recompute them from the structured source object.
 */
export function handleMessageBySource(app: Pick<SignalKApp, "handleMessage">, delta: Delta): void {
  if (!delta || !Array.isArray(delta.updates) || delta.updates.length === 0) {
    return;
  }

  const grouped = new Map<string, DeltaUpdate[]>();
  let hasOriginalSourceLabel = false;

  for (const update of delta.updates) {
    const sourceLabel = getSourceLabel(update);
    if (sourceLabel) {
      hasOriginalSourceLabel = true;
    }
    const providerId = sourceLabel || "";
    const updates = grouped.get(providerId);
    if (updates) {
      updates.push(update);
    } else {
      grouped.set(providerId, [update]);
    }
  }

  if (!hasOriginalSourceLabel) {
    app.handleMessage("", delta);
    return;
  }

  for (const [providerId, updates] of grouped) {
    app.handleMessage(providerId, {
      ...delta,
      updates: updates.map(cloneUpdate)
    });
  }
}
