"use strict";

/**
 * Content hash used by the source registry to tell a genuine identity change
 * from a repeat of what it already holds.
 *
 * Split out of `source-registry.ts` because it is a self-contained concern —
 * canonical serialisation plus a non-cryptographic digest — with no knowledge
 * of the registry's LRU, TTL or merge policy.
 *
 * @module domain/source-registry/merge-hash
 */

import type { SourceReplicationRecord } from "../../foundation/types";

/**
 * Emit key-sorted JSON directly, without first building a canonicalized copy of
 * the object graph. `upsertSingleUpdate` runs for every update of every received
 * delta (hundreds per second on an NMEA2000 vessel), so the old
 * canonicalize-then-stringify pass allocated a full deep clone per update and
 * threw it away immediately.
 */
function stableStringify(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      stableStringify(value[i], out);
    }
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input).sort();
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      stableStringify(input[keys[i]], out);
    }
    out.push("}");
    return;
  }
  out.push(JSON.stringify(value));
}

/**
 * FNV-1a. Two independently-seeded 32-bit passes are concatenated into a 64-bit
 * digest, which is ample for distinguishing at most MAX_RECORDS entries.
 *
 * This replaced SHA-256: the comment on the old implementation already noted
 * this is "a content-addressable dedup hash, not a security boundary", and
 * OpenSSL context setup cost ~6us per call regardless of input size — the single
 * largest cost on the per-update receive path, and ~100% of it was discarded
 * because an instrument's identity is constant for the life of the link.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, in 32-bit space without overflowing to float.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function toMergeHash(record: Omit<SourceReplicationRecord, "mergeHash">): string {
  const stablePayload = {
    schemaVersion: record.schemaVersion,
    key: record.key,
    identity: record.identity,
    metadata: record.metadata,
    // `provenance.updateTimestamp` is deliberately excluded. It carries the
    // per-sample Signal K timestamp, which changes on literally every update,
    // so including it made this hash differ every time and the registry's
    // no-op branch unreachable: `noops` sat at 0 for the life of the process,
    // `upserts` degraded into a plain update counter, `lastUpdatedAt` came to
    // mean "last seen" rather than "identity changed", and the hot receive
    // path allocated a record plus a Map delete+set per update — the exact
    // work this hash exists to skip.
    provenance: {
      lastUpdatedBy: record.provenance?.lastUpdatedBy,
      sourceClientInstanceId: record.provenance?.sourceClientInstanceId
    },
    raw: record.raw
  };
  const parts: string[] = [];
  stableStringify(stablePayload, parts);
  const canonical = parts.join("");
  const a = fnv1a(canonical, 0x811c9dc5);
  const b = fnv1a(canonical, 0x01000193);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
