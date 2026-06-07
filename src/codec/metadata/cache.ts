"use strict";

/**
 * L1 codec — meta change-detection cache (rewrite plan doc 02; split out of
 * metadata-codec.ts). Tracks the last-sent hashed meta value per context+path
 * so periodic snapshot re-broadcasts only carry what changed.
 */

import { createHash } from "crypto";
import type { MetaEntry, MetaEnvelope } from "../../foundation/types";

/**
 * Produces a stable JSON representation of a meta object for change detection.
 * Sorts object keys recursively so `{units:"m",description:"x"}` and
 * `{description:"x",units:"m"}` hash identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

function hashMeta(meta: Record<string, unknown>): string {
  return createHash("sha1").update(stableStringify(meta)).digest("hex");
}

/**
 * Cache of the last-sent meta value (hash) per `context+path` pair.
 *
 * `diff` returns only the entries whose hashed value has changed since the
 * last call, so periodic snapshot re-broadcasts stay cheap when the fleet's
 * meta is stable.
 */
export class MetaCache {
  private hashes = new Map<string, string>();
  private gen = 0;

  /**
   * Monotonic generation counter — bumped by every `clear()` so a caller can
   * snapshot the generation before kicking off an async send and check it
   * before applying `commit()`. Avoids the race where a resubscribe clears
   * the cache while a previous-subscription's diff-send is still in flight
   * and would otherwise repopulate stale entries into the new cache.
   */
  generation(): number {
    return this.gen;
  }

  private keyFor(entry: MetaEntry): string {
    return entry.context + "|" + entry.path;
  }

  /**
   * Returns only the entries whose meta has changed (or is new) relative to
   * this cache, and simultaneously updates the cache.
   */
  diff(entries: MetaEntry[]): MetaEntry[] {
    const changed: MetaEntry[] = [];
    for (const entry of entries) {
      const key = this.keyFor(entry);
      const h = hashMeta(entry.meta);
      if (this.hashes.get(key) !== h) {
        this.hashes.set(key, h);
        changed.push(entry);
      }
    }
    return changed;
  }

  /**
   * Non-mutating variant of {@link diff}. Returns the subset of entries that
   * are new or whose meta has changed without updating the internal cache.
   * Used by the send pipeline so the cache is only updated after a
   * successful transmission — a failed send leaves the cache untouched and
   * the entries will be re-attempted on the next diff.
   */
  computeDiff(entries: MetaEntry[]): MetaEntry[] {
    const changed: MetaEntry[] = [];
    for (const entry of entries) {
      const key = this.keyFor(entry);
      const h = hashMeta(entry.meta);
      if (this.hashes.get(key) !== h) {
        changed.push(entry);
      }
    }
    return changed;
  }

  /**
   * Mark the supplied entries as sent by updating their hashes in the cache.
   * Call this only after a successful send so future diffs don't re-emit
   * the same content.
   */
  commit(entries: MetaEntry[]): void {
    for (const entry of entries) {
      this.hashes.set(this.keyFor(entry), hashMeta(entry.meta));
    }
  }

  /**
   * Overwrite the cache with the supplied entries. Used after a successful
   * full-snapshot send so the next diff is computed against the transmitted
   * state.
   */
  replaceAll(entries: MetaEntry[]): void {
    this.hashes.clear();
    for (const entry of entries) {
      this.hashes.set(this.keyFor(entry), hashMeta(entry.meta));
    }
  }

  clear(): void {
    this.hashes.clear();
    this.gen++;
  }

  size(): number {
    return this.hashes.size;
  }
}
