"use strict";

/** L0 foundation types — signalk. */

export interface DeltaValue {
  path: string;
  value: unknown;
}

/** A Signal K metadata entry attached to a delta update. */
export interface DeltaMeta {
  path: string;
  value: Record<string, unknown>;
}

/** A Signal K delta update block. */
export interface DeltaUpdate {
  source?: {
    label?: string;
    type?: string;
  };
  $source?: string;
  timestamp?: string;
  values: DeltaValue[];
  meta?: DeltaMeta[];
}

/** Metadata streaming configuration (optional block in subscription.json). */
export interface MetaConfig {
  enabled: boolean;
  intervalSec: number;
  includePathsMatching?: string | null;
  maxPathsPerPacket?: number;
}

/** A single metadata entry emitted on the wire. */
export interface MetaEntry {
  context: string;
  path: string;
  meta: Record<string, unknown>;
}

/** Envelope for a metadata packet payload (JSON or msgpack, pre-compression). */
export interface MetaEnvelope {
  v: 1;
  kind: "snapshot" | "diff";
  seq: number;
  idx: number;
  total: number;
  entries: MetaEntry[];
}

/** Envelope carrying a chunk of the Signal K `/sources` tree over METADATA. */
export interface SourceSnapshotEnvelope {
  v: 1;
  kind: "sources";
  seq: number;
  idx: number;
  total: number;
  sources: Record<string, unknown>;
}

/** A Signal K delta message. */
export interface Delta {
  context: string;
  updates: DeltaUpdate[];
}

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
  metadata: Record<string, unknown>;
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

export interface SourceRegistrySnapshot {
  schemaVersion: number;
  size: number;
  sources: SourceReplicationRecord[];
  legacy: {
    byLabel: Record<string, string>;
    bySourceRef: Record<string, string>;
  };
}

export interface SourceRegistryMetrics {
  upserts: number;
  noops: number;
  missingIdentity: number;
  conflicts: number;
  evictions?: number;
}
