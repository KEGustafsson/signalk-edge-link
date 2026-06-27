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
} from "../foundation/types";
import { SOURCE_REGISTRY_MAX_RECORDS, SOURCE_REGISTRY_TTL_MS } from "../foundation/constants";

/** Wire schema version for source-replication snapshots. Bump on breaking changes. */
export const SOURCE_REPLICATION_SCHEMA_VERSION = 1;
/** Source registry record, metrics, and snapshot types re-exported for consumer convenience. */
export type {
  SourceReplicationRecord,
  SourceRegistryMetrics,
  SourceRegistrySnapshot
} from "../foundation/types";

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

/** Parsed source fields extracted from a delta update, before identity resolution. */
interface ParsedSourceFields {
  sourceRef: string | undefined;
  label: string | undefined;
  type: string;
  src: string | undefined;
  instance: string | undefined;
  pgn: number | undefined;
  parsedDeviceId: string | undefined;
}

function parseSourceFields(update: DeltaUpdate): ParsedSourceFields {
  const source =
    update.source && typeof update.source === "object"
      ? (update.source as Record<string, unknown>)
      : undefined;
  const sourceRef = normalizeText(update.$source);
  return {
    sourceRef,
    label: normalizeText(source?.label) || (sourceRef ? `legacy:${sourceRef}` : undefined),
    type: normalizeText(source?.type) || (sourceRef ? "legacy" : "unknown"),
    src: normalizeText(source?.src),
    instance: normalizeText(source?.instance),
    pgn: Number.isFinite(Number(source?.pgn)) ? Number(source?.pgn) : undefined,
    parsedDeviceId: normalizeText(source?.deviceId)
  };
}

/** True when the update carried at least one usable source field. */
function hasAnySourceMetadata(fields: ParsedSourceFields): boolean {
  return (
    !!fields.label ||
    !!fields.sourceRef ||
    fields.src !== undefined ||
    fields.instance !== undefined ||
    fields.pgn !== undefined ||
    fields.parsedDeviceId !== undefined
  );
}

function toCanonicalIdentity(
  update: DeltaUpdate,
  sourceClientInstanceId: string
): SourceReplicationRecord["identity"] | null {
  const fields = parseSourceFields(update);
  if (!hasAnySourceMetadata(fields)) {
    return null;
  }

  const deviceId =
    fields.parsedDeviceId ||
    (sourceClientInstanceId ? sanitizeKeyPart(sourceClientInstanceId) : undefined);

  return {
    label: fields.label || "unknown-source",
    type: normalizeText(fields.type) || "unknown",
    src: fields.src,
    instance: fields.instance,
    pgn: fields.pgn,
    deviceId
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
  // SHA-256 for consistency with the identity-key hash; this is a
  // content-addressable dedup hash, not a security boundary.
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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

/** Shared mutable state + deps for the source registry's module-level helpers. */
interface RegistryContext {
  app: { debug: (msg: string) => void };
  // Insertion-order Map doubles as an LRU: refresh() moves an entry to the
  // tail (delete + set), evict() drops from the head.
  records: Map<string, SourceReplicationRecord>;
  metrics: SourceRegistryMetrics;
  evictions: number;
  lastLoggedRegistrySize: number;
}

function evictStaleAndOverflow(ctx: RegistryContext, nowMs: number): void {
  const { records } = ctx;
  // TTL pass: scan from oldest (insertion order). Map iteration order is
  // insertion order, so we can stop at the first non-stale entry.
  const cutoff = nowMs - SOURCE_REGISTRY_TTL_MS;
  for (const [key, record] of records) {
    const ts = Date.parse(record.lastSeenAt);
    if (Number.isFinite(ts) && ts < cutoff) {
      records.delete(key);
      ctx.evictions++;
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
    ctx.evictions++;
  }
}

/** Build the pre-merge record for an update, copying identity from `identity`
 *  and provenance/raw fields from the update. */
function buildMergedBase(
  update: DeltaUpdate,
  identity: NonNullable<SourceReplicationRecord["identity"]>,
  key: string,
  sourceClientInstanceId: string,
  existing: SourceReplicationRecord | undefined,
  nowIso: string
): Omit<SourceReplicationRecord, "mergeHash"> {
  const sourceRef = normalizeText(update.$source);
  const updateTs = normalizeText(update.timestamp);
  const sourceObj =
    update.source && typeof update.source === "object"
      ? ({ ...(update.source as Record<string, unknown>) } as Record<string, unknown>)
      : undefined;

  return {
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
}

/** Resolve the timestamp (ms) to use as the "current" side when merging an
 *  existing record against an incoming update. */
function resolveExistingTs(existing: SourceReplicationRecord): number {
  const existingUpdateTs = normalizeText(existing.provenance?.updateTimestamp);
  const parsedExistingTs = existingUpdateTs ? Date.parse(existingUpdateTs) : NaN;
  const parsedExistingUpdatedAt = Date.parse(existing.lastUpdatedAt);
  return Number.isFinite(parsedExistingTs)
    ? parsedExistingTs
    : Number.isFinite(parsedExistingUpdatedAt)
      ? parsedExistingUpdatedAt
      : Date.now();
}

/** Merge an existing record's identity + metadata into `mergedBase` in place,
 *  returning the number of conflicts observed. */
function mergeExistingRecord(
  existing: SourceReplicationRecord,
  mergedBase: Omit<SourceReplicationRecord, "mergeHash">,
  updateTsMs: number
): number {
  const conflictCounter = { count: 0 };
  const currentTs = resolveExistingTs(existing);
  const pick = (current: unknown, incoming: unknown): unknown =>
    chooseValue(current, incoming, currentTs, updateTsMs, conflictCounter);

  const id = mergedBase.identity;
  id.label = pick(existing.identity.label, id.label) as string;
  id.type = pick(existing.identity.type, id.type) as string;
  id.src = pick(existing.identity.src, id.src) as string | undefined;
  id.instance = pick(existing.identity.instance, id.instance) as string | undefined;
  id.pgn = pick(existing.identity.pgn, id.pgn) as number | undefined;
  id.deviceId = pick(existing.identity.deviceId, id.deviceId) as string | undefined;

  const incomingMeta = mergedBase.metadata;
  const allKeys = new Set([...Object.keys(existing.metadata), ...Object.keys(incomingMeta)]);
  for (const metaKey of allKeys) {
    mergedBase.metadata[metaKey] = pick(existing.metadata[metaKey], incomingMeta[metaKey]);
  }
  return conflictCounter.count;
}

/** Upsert a single update into the registry (one iteration of the loop). */
function upsertSingleUpdate(
  ctx: RegistryContext,
  update: DeltaUpdate,
  sourceClientInstanceId: string
): void {
  const { records, metrics } = ctx;
  const identity = toCanonicalIdentity(update, sourceClientInstanceId);
  if (!identity) {
    metrics.missingIdentity++;
    return;
  }
  const key = createSourceKey(update, identity);
  const nowIso = new Date().toISOString();
  const updateTs = normalizeText(update.timestamp);
  const parsedIncomingTs = updateTs ? Date.parse(updateTs) : NaN;
  const updateTsMs = Number.isFinite(parsedIncomingTs) ? parsedIncomingTs : Date.now();

  const existing = records.get(key);
  const mergedBase = buildMergedBase(
    update,
    identity,
    key,
    sourceClientInstanceId,
    existing,
    nowIso
  );

  if (existing) {
    metrics.conflicts += mergeExistingRecord(existing, mergedBase, updateTsMs);
  }

  const mergeHash = toMergeHash(mergedBase);
  if (existing && existing.mergeHash === mergeHash) {
    existing.lastSeenAt = nowIso;
    // Refresh LRU position so an actively-seen record is not evicted
    // ahead of stale ones at the head of the insertion-order Map.
    records.delete(key);
    records.set(key, existing);
    metrics.noops++;
    return;
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
    evictStaleAndOverflow(ctx, Date.now());
  }
}

function upsertFromDelta(ctx: RegistryContext, delta: Delta, sourceClientInstanceId: string): void {
  if (!delta || !Array.isArray(delta.updates)) {
    return;
  }

  for (const update of delta.updates) {
    if (!update || typeof update !== "object") {
      continue;
    }
    upsertSingleUpdate(ctx, update, sourceClientInstanceId);
  }

  evictStaleAndOverflow(ctx, Date.now());

  const { records } = ctx;
  if (records.size % 50 === 0 && records.size > 0 && records.size !== ctx.lastLoggedRegistrySize) {
    ctx.app.debug(`[source-replication] registry-size=${records.size}`);
    ctx.lastLoggedRegistrySize = records.size;
  }
}

function snapshot(ctx: RegistryContext): SourceRegistrySnapshot {
  // Prune on read so callers never observe TTL-expired entries that
  // only happen to be reachable because no write has landed yet.
  evictStaleAndOverflow(ctx, Date.now());
  const sources = [...ctx.records.values()].sort((a, b) => a.key.localeCompare(b.key));
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

/** Create a per-process LRU+TTL source identity registry, keyed by source-ref or identity hash. */
export function createSourceRegistry(app: { debug: (msg: string) => void }) {
  const ctx: RegistryContext = {
    app,
    records: new Map<string, SourceReplicationRecord>(),
    metrics: {
      upserts: 0,
      noops: 0,
      missingIdentity: 0,
      conflicts: 0
    },
    evictions: 0,
    lastLoggedRegistrySize: 0
  };

  function getMetrics(): SourceRegistryMetrics {
    return { ...ctx.metrics, evictions: ctx.evictions };
  }

  function getSize(): number {
    evictStaleAndOverflow(ctx, Date.now());
    return ctx.records.size;
  }

  return {
    upsertFromDelta: (delta: Delta, sourceClientInstanceId: string) =>
      upsertFromDelta(ctx, delta, sourceClientInstanceId),
    snapshot: () => snapshot(ctx),
    getMetrics,
    getSize
  };
}
