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
import type { Delta } from "../../../foundation/types";
import type { ClientContext } from "./context";
import type { FleetClientRuntime } from "./fleet";

/** Bound on remembered (context, $source, path) timestamps. */
const MAX_TRACKED_VALUE_TIMES = 20000;

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
    for (const update of sanitized.updates) {
      if (!Array.isArray(update.values)) {
        continue;
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
    sanitized.updates = sanitized.updates.filter(
      (u) => Array.isArray(u.values) && u.values.length > 0
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
    for (const update of delta.updates) {
      metrics.valuesReceived += Array.isArray(update.values) ? update.values.length : 0;
    }
  }
}
