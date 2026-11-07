"use strict";

/**
 * Signal K Edge Link - reliable client: contexts learned from the fleet
 *
 * Every context received over the fleet channel, with when it was last seen
 * (protocol-v3-spec §15.7). The uplink drops deltas and metadata for these so
 * fleet data is never sent back upstream.
 *
 * The set outlives one client pipeline: the local Signal K tree keeps the
 * other vessels after a socket recovery or a plugin restart, and its
 * snapshots would otherwise carry them upstream. It is therefore reused by
 * the next pipeline of the same instance and saved to the instance's data
 * directory. Entries expire after FLEET_LEARNED_TTL_MS without a packet, and
 * the set is capped at FLEET_LEARNED_MAX (least recently seen evicted first).
 *
 * @module transport/pipeline/reliable-client/fleet-learned
 */

import { readFileSync } from "node:fs";
import { saveConfigFile } from "../../../foundation/config-io";
import {
  FLEET_LEARNED_MAX,
  FLEET_LEARNED_SAVE_INTERVAL_MS,
  FLEET_LEARNED_TTL_MS
} from "../../../foundation/constants";

/** Re-stamp a context at most this often, so busy contexts cost one Map hit. */
const TOUCH_GRANULARITY_MS = 60_000;

export class LearnedContexts {
  /** Context → last time seen (ms). Map order is least recently seen first. */
  private readonly seen = new Map<string, number>();
  private dirty = false;
  private lastSavedAt = 0;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly file: string | null,
    private readonly ttlMs: number = FLEET_LEARNED_TTL_MS,
    private readonly max: number = FLEET_LEARNED_MAX
  ) {}

  has(context: string): boolean {
    return this.seen.has(context);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Record that `context` arrived over the fleet channel now. */
  touch(context: string, now: number): void {
    const last = this.seen.get(context);
    if (last !== undefined && now - last < TOUCH_GRANULARITY_MS) {
      return;
    }
    this.seen.delete(context);
    this.seen.set(context, now);
    this.dirty = true;
    while (this.seen.size > this.max) {
      this.seen.delete(this.seen.keys().next().value as string);
    }
  }

  /** Forget contexts not seen for the TTL. */
  prune(now: number): void {
    for (const [context, at] of this.seen) {
      if (now - at < this.ttlMs) {
        break;
      }
      this.seen.delete(context);
      this.dirty = true;
    }
  }

  /** Read the saved set. A missing or unreadable file leaves the set empty. */
  load(now: number): void {
    if (!this.file) {
      return;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf-8"));
    } catch {
      return;
    }
    const contexts = (saved as { contexts?: unknown })?.contexts;
    if (!contexts || typeof contexts !== "object") {
      return;
    }
    const entries = Object.entries(contexts as Record<string, unknown>)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1])
      )
      .sort((a, b) => a[1] - b[1]);
    for (const [context, at] of entries) {
      this.seen.set(context, Math.min(at, now));
    }
    while (this.seen.size > this.max) {
      this.seen.delete(this.seen.keys().next().value as string);
    }
    this.prune(now);
    this.dirty = false;
  }

  /**
   * Write the set when it changed, at most every FLEET_LEARNED_SAVE_INTERVAL_MS
   * unless `force`. saveConfigFile writes a uniquely named, synced temporary
   * file and renames it, so a crash or a second instance mid-write leaves a
   * complete file. A forced save (connection stop) waits for a save already
   * in flight and then writes whatever changed since that one's snapshot.
   */
  async save(now: number, force = false): Promise<void> {
    if (this.saving) {
      if (!force) {
        return;
      }
      await this.saving;
    }
    if (!this.file || !this.dirty) {
      return;
    }
    if (!force && now - this.lastSavedAt < FLEET_LEARNED_SAVE_INTERVAL_MS) {
      return;
    }
    this.dirty = false;
    this.lastSavedAt = now;
    const body = { v: 1, contexts: Object.fromEntries(this.seen) };
    this.saving = saveConfigFile(this.file, body)
      .then((saved) => {
        if (!saved) {
          // Not fatal: the in-memory set still guards this run.
          this.dirty = true;
        }
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
  }
}
