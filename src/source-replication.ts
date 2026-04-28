"use strict";

import crypto from "node:crypto";
import type { Delta, DeltaUpdate } from "./types";

export const SOURCE_REPLICATION_SCHEMA_VERSION = 1;

export interface SourceReplicationRecord {
  schemaVersion: number;
  key: string;
  identity: {
    label: string;
    type: string;
    src?: string;
    instance?: string;
    pgn?: number;
    deviceId?: string;
  };
  metadata: {
    talker?: string;
    sentence?: string;
    network?: string;
    [key: string]: unknown;
  };
  firstSeenAt: string;
  lastSeenAt: string;
  lastUpdatedAt: string;
  provenance: {
    lastUpdatedBy: "source" | "$source" | "merge";
    sourceClientInstanceId: string;
    updateTimestamp?: string;
  };
  raw: {
    source?: Record<string, unknown>;
    $source?: string;
  };
  mergeHash: string;
}

export interface SourceRegistryMetrics {
  upserts: number;
  noops: number;
  missingIdentity: number;
  conflicts: number;
}

export interface SourceRegistrySnapshot {
  schemaVersion: number;
  size: number;
  sources: SourceReplicationRecord[];
  // Legacy compatibility used by existing UI/source label readers.
  legacy: {
    byLabel: Record<string, string>;
    bySourceRef: Record<string, string>;
  };
}

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

  if (!label && !sourceRef) {
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
      (sourceClientInstanceId ? sanitizeKeyPart(sourceClientInstanceId) : undefined)
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
  if (update.source && typeof update.source === "object") {
    const canonical = JSON.stringify(update.source);
    return `source-obj:${sanitizeKeyPart(canonical)}`;
  }
  return `source-label:${sanitizeKeyPart(`${identity.type}:${identity.label}`)}`;
}

function toMergeHash(record: Omit<SourceReplicationRecord, "mergeHash">): string {
  return crypto.createHash("sha1").update(JSON.stringify(record)).digest("hex");
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
  const records = new Map<string, SourceReplicationRecord>();
  const metrics: SourceRegistryMetrics = {
    upserts: 0,
    noops: 0,
    missingIdentity: 0,
    conflicts: 0
  };

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
      const updateTsMs = updateTs ? Date.parse(updateTs) : Date.now();

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
        metadata: sourceObj ? { ...sourceObj } : {},
        firstSeenAt: existing ? existing.firstSeenAt : nowIso,
        lastSeenAt: nowIso,
        lastUpdatedAt: nowIso,
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
        const currentTs = Date.parse(existing.lastUpdatedAt) || 0;
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
        metrics.noops++;
        continue;
      }

      records.set(key, { ...mergedBase, mergeHash });
      metrics.upserts++;
    }

    if (records.size % 50 === 0 && records.size > 0) {
      app.debug(`[source-replication] registry-size=${records.size}`);
    }
  }

  function snapshot(): SourceRegistrySnapshot {
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
    return { ...metrics };
  }

  return {
    upsertFromDelta,
    snapshot,
    getMetrics
  };
}
