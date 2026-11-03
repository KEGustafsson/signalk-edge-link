"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: fleet metadata on first sight
 *
 * The first time a session is sent a (context, path), the server attaches
 * that path's metadata (units, zones, display name) from its own Signal K
 * tree, inside the same FLEET_DATA update (protocol-v3-spec §15.4). A
 * receiver therefore shows a fleet value with its units without a separate
 * metadata channel or request. Later metadata changes travel as live
 * `updates[].meta` entries (see `enqueueMeta` in `./fleet`).
 *
 * @module transport/pipeline/reliable-server/fleet-meta
 */

import { fleetPathAllowed } from "../../fleet/common";
import type { DeltaUpdate } from "../../../foundation/types";
import type { ServerContext } from "./context";
import type { FleetSessionState, PendingValue } from "./fleet";

/** Bound on remembered (context, path) metadata keys per session. */
const MAX_META_KEYS = 20000;

/** Walk the tree to a leaf's `meta`, or undefined. */
export function lookupTreeMeta(
  tree: Record<string, unknown> | null,
  context: string,
  path: string
): Record<string, unknown> | undefined {
  if (!tree) {
    return undefined;
  }
  const dot = context.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  let node: unknown = (tree[context.slice(0, dot)] as Record<string, unknown> | undefined)?.[
    context.slice(dot + 1)
  ];
  for (const segment of path.split(".")) {
    if (!node || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  const meta =
    node && typeof node === "object" ? (node as Record<string, unknown>).meta : undefined;
  return meta && typeof meta === "object" && Object.keys(meta).length > 0
    ? (meta as Record<string, unknown>)
    : undefined;
}

function retrieveTree(ctx: ServerContext): Record<string, unknown> | null {
  try {
    return (ctx.app.signalk?.retrieve() as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/**
 * Return `values` plus a meta entry for every (context, path) this session
 * has not had metadata for yet, and record those keys as sent. `added` lists
 * the keys recorded, so a caller that does not send the packet can undo them.
 */
export function withFirstSightMeta(
  ctx: ServerContext,
  fleetSession: FleetSessionState,
  values: PendingValue[]
): { values: PendingValue[]; added: string[] } {
  if (fleetSession.metaSent.size >= MAX_META_KEYS) {
    fleetSession.metaSent.clear();
  }
  let tree: Record<string, unknown> | null | undefined;
  const extra: PendingValue[] = [];
  const added: string[] = [];
  for (const v of values) {
    const key = `${v.context}\u0000${v.path}`;
    if (fleetSession.metaSent.has(key)) {
      continue;
    }
    fleetSession.metaSent.add(key);
    added.push(key);
    if (v.kind === "meta") {
      continue;
    }
    if (tree === undefined) {
      tree = retrieveTree(ctx);
    }
    const meta = lookupTreeMeta(tree, v.context, v.path);
    if (meta) {
      extra.push({
        ...v,
        kind: "meta",
        $source: undefined,
        source: undefined,
        timestamp: undefined,
        value: meta
      });
    }
  }
  return { values: extra.length > 0 ? [...values, ...extra] : values, added };
}

/** Queue live `updates[].meta` entries (units, zones, display names). */
export function enqueueMeta(
  ctx: ServerContext,
  fleetSession: FleetSessionState,
  context: string,
  update: DeltaUpdate
): void {
  const metaEntries = (update as unknown as { meta?: unknown }).meta;
  if (!Array.isArray(metaEntries)) {
    return;
  }
  const serverFilter = ctx.fleet!.config.pathFilter;
  for (const entry of metaEntries as Array<{ path?: unknown; value?: unknown }>) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !entry.value ||
      typeof entry.value !== "object"
    ) {
      continue;
    }
    if (!fleetPathAllowed(entry.path, serverFilter, fleetSession.pathFilter)) {
      continue;
    }
    const key = `m\u0000${context}\u0000${entry.path}`;
    fleetSession.pending.delete(key);
    fleetSession.pending.set(key, {
      kind: "meta",
      context,
      $source: undefined,
      source: undefined,
      timestamp: undefined,
      path: entry.path,
      value: entry.value
    });
  }
}
