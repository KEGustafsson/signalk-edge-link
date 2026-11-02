"use strict";

/**
 * Signal K Edge Link - reliable client: write fleet deltas into the tree.
 *
 * Drops the client's own vessel, applies the client's requested path filter,
 * refuses values older than one already applied for the same
 * (context, $source, path) — a retransmit can arrive after newer data — and
 * records each context for the uplink loop guard (protocol-v3-spec §15.7).
 *
 * @module transport/pipeline/reliable-client/fleet-dispatch
 */

import { sanitizeDeltaForSignalK } from "../../../codec/delta-sanitizer";
import { handleMessageBySource, normalizeDeltaSourceRefs } from "../../../codec/source-dispatch";
import { ensureFleetMetrics, fleetPathAllowed } from "../../fleet/common";
import type { Delta, DeltaUpdate } from "../../../foundation/types";
import type { ClientContext } from "./context";
import type { FleetClientRuntime } from "./fleet";

/** Bound on remembered (context, $source, path) timestamps. */
const MAX_TRACKED_VALUE_TIMES = 20000;

type FleetMetricsRef = ReturnType<typeof ensureFleetMetrics>;
type MetaEntry = { path?: unknown; value?: unknown };

/** Keep values that pass the filter and are not older than what was applied. */
function filterValues(
  fleet: FleetClientRuntime,
  metrics: FleetMetricsRef,
  context: string,
  update: DeltaUpdate
): void {
  if (!Array.isArray(update.values)) {
    update.values = [];
    return;
  }
  const at = typeof update.timestamp === "string" ? Date.parse(update.timestamp) : NaN;
  update.values = update.values.filter((v) => {
    if (!fleetPathAllowed(v.path, fleet.pathFilter)) {
      return false;
    }
    if (!Number.isFinite(at)) {
      return true;
    }
    const key = `${context}\u0000${update.$source ?? ""}\u0000${v.path}`;
    const previous = fleet.appliedTimes.get(key);
    if (previous !== undefined && at < previous) {
      metrics.staleValues++;
      return false;
    }
    if (fleet.appliedTimes.size >= MAX_TRACKED_VALUE_TIMES && previous === undefined) {
      fleet.appliedTimes.clear();
    }
    fleet.appliedTimes.set(key, at);
    return true;
  });
}

/** Keep metadata entries for paths the client asked for. */
function filterMeta(fleet: FleetClientRuntime, update: DeltaUpdate): number {
  const record = update as unknown as { meta?: MetaEntry[] };
  if (!Array.isArray(record.meta)) {
    return 0;
  }
  record.meta = record.meta.filter(
    (m) => m && typeof m.path === "string" && fleetPathAllowed(m.path, fleet.pathFilter)
  );
  if (record.meta.length === 0) {
    delete record.meta;
    return 0;
  }
  return record.meta.length;
}

export function dispatchFleetDeltas(
  ctx: ClientContext,
  fleet: FleetClientRuntime,
  deltas: Delta[]
): void {
  const metrics = ensureFleetMetrics(ctx.metricsApi.metrics);
  for (const raw of deltas) {
    const context = raw?.context;
    // Never accept data about ourselves over the fleet channel, whatever the
    // server sent: our own sensors are the authority for our own vessel.
    if (typeof context !== "string" || context === fleet.self || context === "vessels.self") {
      continue;
    }
    const sanitized = sanitizeDeltaForSignalK(raw);
    if (!sanitized || !Array.isArray(sanitized.updates)) {
      continue;
    }
    let metaCount = 0;
    for (const update of sanitized.updates) {
      filterValues(fleet, metrics, context, update);
      metaCount += filterMeta(fleet, update);
    }
    sanitized.updates = sanitized.updates.filter(
      (u) =>
        (Array.isArray(u.values) && u.values.length > 0) ||
        Array.isArray((u as unknown as { meta?: unknown[] }).meta)
    );
    if (sanitized.updates.length === 0) {
      continue;
    }
    const delta = normalizeDeltaSourceRefs(sanitized);
    // Record before dispatch: handleMessage re-emits synchronously on the
    // local bus, and the uplink must already know to drop it.
    if (!fleet.learnedContexts.has(context)) {
      fleet.learnedContexts.add(context);
      metrics.contextsKnown = fleet.learnedContexts.size;
    }
    handleMessageBySource(ctx.app, delta);
    metrics.metaReceived += metaCount;
    for (const update of delta.updates) {
      metrics.valuesReceived += Array.isArray(update.values) ? update.values.length : 0;
    }
  }
}
