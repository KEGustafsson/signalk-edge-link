"use strict";

/**
 * Signal K Edge Link — Source Identity Registry
 *
 * NOTE: One of three sibling files with confusable names. See the
 * top-of-file block in src/source-snapshot.ts for the full taxonomy.
 *
 * This module owns a per-process LRU+TTL Map keyed by either source-ref
 * or a SHA-256 hash of the canonical identity tuple. Records are
 * upserted from incoming DATA deltas as the server pipeline ingests
 * them; the conflict counter tracks divergence when the same logical
 * source emits two different identities. Bounded by
 * SOURCE_REGISTRY_MAX_RECORDS (LRU) and SOURCE_REGISTRY_TTL_MS (drop
 * unseen records).
 *
 * Distinct from `source-snapshot.ts` which captures and merges the
 * full /sources tree on the wire, and from `source-dispatch.ts` which
 * normalises per-delta source attribution before app.handleMessage.
 *
 * @module lib/source-replication
 */

import crypto from "node:crypto";
import type {
  Delta,
  DeltaUpdate,
  SourceReplicationRecord,
  SourceRegistryMetrics,
  SourceRegistrySnapshot
} from "./types";
import { SOURCE_REGISTRY_MAX_RECORDS, SOURCE_REGISTRY_TTL_MS } from "./constants";

export const SOURCE_REPLICATION_SCHEMA_VERSION = 1;
export type {
  SourceReplicationRecord,
  SourceRegistryMetrics,
  SourceRegistrySnapshot
} from "./types";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeKeyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

function toCanonicalIdentity(
  update: DeltaUpdate,
  sourceClientInstanceId: string
): SourceReplicationRecord["identity"] | null {
  const source =
    update.source && typeof update.source === "object"
      ? (update.source as Record<string, unknown>)
      : undefined;
  const sourceRef = normalizeText(update.$source);

  const label = normalizeText(source?.label) || (sourceRef ? `legacy:${sourceRef}` : undefined);
  const type = normalizeText(source?.type) || (sourceRef ? "legacy" : "unknown");

  const src = normalizeText(source?.src);
  const instance = normalizeText(source?.instance);
  const pgn = Number.isFinite(Number(source?.pgn)) ? Number(source?.pgn) : undefined;
  const parsedDeviceId = normalizeText(source?.deviceId);
  const hasMetadata =
    !!label ||
    !!sourceRef ||
    src !== undefined ||
    instance !== undefined ||
    pgn !== undefined ||
    parsedDeviceId !== undefined;

  if (
    !label &&
    !sourceRef &&
    src === undefined &&
    instance === undefined &&
    pgn === undefined &&
    parsedDeviceId === undefined
  ) {
    return null;
  }

  return {
    label: label || "unknown-source",
    type: normalizeText(type) || "unknown",
    src,
    instance,
    pgn,
    deviceId:
      parsedDeviceId ||
      (hasMetadata && sourceClientInstanceId ? sanitizeKeyPart(sourceClientInstanceId) : undefined)
  };
}

function createSourceKey(
  update: DeltaUpdate,
  identity: SourceReplicationRecord["identity"]
): string {
  const sourceRef = normalizeText(update.$source);
  if (sourceRef) {
    return `source-ref:${sanitizeKeyPart(sourceRef)}`;
  }
  if (identity) {
    const canonicalIdentity = JSON.stringify({
      type: identity.type || "",
      label: identity.label || "",
      src: identity.src || "",
      instance: identity.instance || "",
      pgn: identity.pgn ?? "",
      deviceId: identity.deviceId || ""
    });
    const identityHash = crypto.createHash("sha256").update(canonicalIdentity).digest("hex");
    return `source-identity:${identityHash}`;
  }
  return "source-identity:unknown";
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForHash(entry));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = canonicalizeForHash(input[key]);
    }
    return out;
  }
  return value;
}

function toMergeHash(record: Omit<SourceReplicationRecord, "mergeHash">): string {
  const stablePayload = {
    schemaVersion: record.schemaVersion,
    key: record.key,
    identity: record.identity,
    metadata: record.metadata,
    provenance: record.provenance,
    raw: record.raw
  };
  const canonical = canonicalizeForHash(stablePayload);
  return crypto.createHash("sha1").update(JSON.stringify(canonical)).digest("hex");
}

function chooseValue(
  current: unknown,
  incoming: unknown,
  currentTs: number,
  incomingTs: number,
  conflicts: { count: number }
): unknown {
  if (incoming === undefined || incoming === null || incoming === "") {
    return current;
  }
  if (current === undefined || current === null || current === "") {
    return incoming;
  }
  if (JSON.stringify(current) === JSON.stringify(incoming)) {
    return current;
  }
  conflicts.count++;
  return incomingTs >= currentTs ? incoming : current;
}

export function createSourceRegistry(app: { debug: (msg: string) => void }) {
  // Insertion-order Map doubles as an LRU: refresh() moves an entry to the
  // tail (delete + set), evict() drops from the head.
  const records = new Map<string, SourceReplicationRecord>();
  let lastLoggedRegistrySize = 0;
  const metrics: SourceRegistryMetrics = {
    upserts: 0,
    noops: 0,
    missingIdentity: 0,
    conflicts: 0
  };
  let evictions = 0;

  function evictStaleAndOverflow(nowMs: number): void {
    // TTL pass: scan from oldest (insertion order). Map iteration order is
    // insertion order, so we can stop at the first non-stale entry.
    const cutoff = nowMs - SOURCE_REGISTRY_TTL_MS;
    for (const [key, record] of records) {
      const ts = Date.parse(record.lastSeenAt);
      if (Number.isFinite(ts) && ts < cutoff) {
        records.delete(key);
        evictions++;
        continue;
      }
      break;
    }
    // Hard cap: if still over the limit, drop oldest until under.
    while (records.size > SOURCE_REGISTRY_MAX_RECORDS) {
      const oldest = records.keys().next();
      if (oldest.done) {
        break;
      }
      records.delete(oldest.value);
      evictions++;
    }
  }

  function upsertFromDelta(delta: Delta, sourceClientInstanceId: string): void {
    if (!delta || !Array.isArray(delta.updates)) {
      return;
    }

    for (const update of delta.updates) {
      if (!update || typeof update !== "object") {
        continue;
      }

      const identity = toCanonicalIdentity(update, sourceClientInstanceId);
      if (!identity) {
        metrics.missingIdentity++;
        continue;
      }
      const sourceRef = normalizeText(update.$source);
      const key = createSourceKey(update, identity);

      const nowIso = new Date().toISOString();
      const updateTs = normalizeText(update.timestamp);
      const parsedIncomingTs = updateTs ? Date.parse(updateTs) : NaN;
      const updateTsMs = Number.isFinite(parsedIncomingTs) ? parsedIncomingTs : Date.now();

      const sourceObj =
        update.source && typeof update.source === "object"
          ? ({ ...(update.source as Record<string, unknown>) } as Record<string, unknown>)
          : undefined;

      const existing = records.get(key);
      const mergedBase: Omit<SourceReplicationRecord, "mergeHash"> = {
        schemaVersion: SOURCE_REPLICATION_SCHEMA_VERSION,
        key,
        identity: {
          label: identity.label,
          type: identity.type,
          src: identity.src,
          instance: identity.instance,
          pgn: identity.pgn,
          deviceId: identity.deviceId
        },
        metadata: {},
        firstSeenAt: existing ? existing.firstSeenAt : nowIso,
        lastSeenAt: existing ? existing.lastSeenAt : nowIso,
        lastUpdatedAt: existing ? existing.lastUpdatedAt : nowIso,
        provenance: {
          lastUpdatedBy: sourceObj ? "source" : update.$source ? "$source" : "merge",
          sourceClientInstanceId,
          updateTimestamp: updateTs
        },
        raw: {
          source: sourceObj,
          $source: sourceRef
        }
      };

      if (existing) {
        const conflictCounter = { count: 0 };
        const existingUpdateTs = normalizeText(existing.provenance?.updateTimestamp);
        const parsedExistingTs = existingUpdateTs ? Date.parse(existingUpdateTs) : NaN;
        const parsedExistingUpdatedAt = Date.parse(existing.lastUpdatedAt);
        const currentTs = Number.isFinite(parsedExistingTs)
          ? parsedExistingTs
          : Number.isFinite(parsedExistingUpdatedAt)
            ? parsedExistingUpdatedAt
            : Date.now();
        mergedBase.identity.label = chooseValue(
          existing.identity.label,
          mergedBase.identity.label,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as string;
        mergedBase.identity.type = chooseValue(
          existing.identity.type,
          mergedBase.identity.type,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as string;
        mergedBase.identity.src = chooseValue(
          existing.identity.src,
          mergedBase.identity.src,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as string | undefined;
        mergedBase.identity.instance = chooseValue(
          existing.identity.instance,
          mergedBase.identity.instance,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as string | undefined;
        mergedBase.identity.pgn = chooseValue(
          existing.identity.pgn,
          mergedBase.identity.pgn,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as number | undefined;
        mergedBase.identity.deviceId = chooseValue(
          existing.identity.deviceId,
          mergedBase.identity.deviceId,
          currentTs,
          updateTsMs,
          conflictCounter
        ) as string | undefined;

        const incomingMeta = mergedBase.metadata;
        const allKeys = new Set([...Object.keys(existing.metadata), ...Object.keys(incomingMeta)]);
        for (const metaKey of allKeys) {
          mergedBase.metadata[metaKey] = chooseValue(
            existing.metadata[metaKey],
            incomingMeta[metaKey],
            currentTs,
            updateTsMs,
            conflictCounter
          );
        }
        metrics.conflicts += conflictCounter.count;
      }

      const mergeHash = toMergeHash(mergedBase);
      if (existing && existing.mergeHash === mergeHash) {
        existing.lastSeenAt = nowIso;
        // Refresh LRU position so an actively-seen record is not evicted
        // ahead of stale ones at the head of the insertion-order Map.
        records.delete(key);
        records.set(key, existing);
        metrics.noops++;
        continue;
      }

      mergedBase.lastSeenAt = nowIso;
      mergedBase.lastUpdatedAt = nowIso;
      // Re-insert at the tail of the LRU order: delete-then-set so updates
      // to an existing record refresh its position the same way as noops.
      if (existing) {
        records.delete(key);
      }
      records.set(key, { ...mergedBase, mergeHash });
      metrics.upserts++;
      // Cap mid-loop so a single oversized delta cannot push records far
      // above SOURCE_REGISTRY_MAX_RECORDS before cleanup runs.
      if (records.size > SOURCE_REGISTRY_MAX_RECORDS) {
        evictStaleAndOverflow(Date.now());
      }
    }

    evictStaleAndOverflow(Date.now());

    if (records.size % 50 === 0 && records.size > 0 && records.size !== lastLoggedRegistrySize) {
      app.debug(`[source-replication] registry-size=${records.size}`);
      lastLoggedRegistrySize = records.size;
    }
  }

  function snapshot(): SourceRegistrySnapshot {
    // Prune on read so callers never observe TTL-expired entries that
    // only happen to be reachable because no write has landed yet.
    evictStaleAndOverflow(Date.now());
    const sources = [...records.values()].sort((a, b) => a.key.localeCompare(b.key));
    const legacyByLabel: Record<string, string> = {};
    const legacyBySourceRef: Record<string, string> = {};

    for (const source of sources) {
      legacyByLabel[source.identity.label] = source.key;
      if (source.raw.$source) {
        legacyBySourceRef[source.raw.$source] = source.key;
      }
    }

    return {
      schemaVersion: SOURCE_REPLICATION_SCHEMA_VERSION,
      size: sources.length,
      sources,
      legacy: {
        byLabel: legacyByLabel,
        bySourceRef: legacyBySourceRef
      }
    };
  }

  function getMetrics(): SourceRegistryMetrics {
    return { ...metrics, evictions };
  }

  function getSize(): number {
    evictStaleAndOverflow(Date.now());
    return records.size;
  }

  return {
    upsertFromDelta,
    snapshot,
    getMetrics,
    getSize
  };
}
