"use strict";

/**
 * Signal K Edge Link - Metadata Streaming
 *
 * Collects Signal K path metadata (units, descriptions, zones, display names, ...)
 * and packages it for transmission alongside the main delta stream.
 *
 * Meta is deliberately separated from deltas on the wire:
 *   - the existing delta encoder strips `updates[].meta[]` via pathDictionary
 *     `transformDelta`, so meta has never flowed through the pipeline; and
 *   - sending meta on every delta would multiply bandwidth for values that
 *     essentially never change.
 *
 * Strategy: snapshot once at startup from `app.signalk.retrieve()`, forward
 * runtime changes via `extractLiveMeta`, and periodically re-broadcast the
 * full snapshot so a restarted receiver recovers within one interval.
 *
 * @module lib/metadata
 */

import { createHash } from "crypto";
import type { Delta, DeltaMeta, MetaEntry, MetaEnvelope, MetaConfig, SignalKApp } from "./types";

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
  }

  size(): number {
    return this.hashes.size;
  }
}

/**
 * Walks the value recursively and calls `onMeta(path, metaValue)` for every
 * subtree that has a `meta` child. Arrays are left alone — Signal K meta
 * lives inside regular path nodes only.
 */
function walkMeta(
  node: unknown,
  pathParts: string[],
  onMeta: (path: string, meta: Record<string, unknown>) => void
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.meta && typeof obj.meta === "object" && !Array.isArray(obj.meta)) {
    onMeta(pathParts.join("."), obj.meta as Record<string, unknown>);
  }
  for (const key of Object.keys(obj)) {
    // Signal K "value", "timestamp", "$source" are leaves, not sub-paths.
    if (
      key === "meta" ||
      key === "value" ||
      key === "values" ||
      key === "timestamp" ||
      key === "$source" ||
      key === "sentence"
    ) {
      continue;
    }
    walkMeta(obj[key], pathParts.concat(key), onMeta);
  }
}

/**
 * Build a full metadata snapshot from the Signal K app state tree.
 *
 * Iterates `app.signalk.retrieve()` (when available) and collects every node
 * that has a `meta` object. Returns entries scoped to the "self" vessel plus
 * any other contexts present. Applies the `includePathsMatching` regex
 * filter when configured.
 *
 * On signalk-server versions where `app.signalk` is not exposed to plugins,
 * returns an empty array — live meta will still trickle in through
 * `extractLiveMeta` once providers emit meta updates.
 */
export function collectSnapshot(app: SignalKApp, config: MetaConfig | null): MetaEntry[] {
  if (!config || !config.enabled) {
    return [];
  }
  if (!app.signalk || typeof app.signalk.retrieve !== "function") {
    return [];
  }

  let tree: Record<string, unknown>;
  try {
    tree = app.signalk.retrieve();
  } catch {
    return [];
  }
  if (!tree || typeof tree !== "object") {
    return [];
  }

  const filter = buildPathFilter(config.includePathsMatching);
  const entries: MetaEntry[] = [];

  for (const contextGroup of Object.keys(tree)) {
    // `tree.self` is an alias string pointing to the local vessel URN, and
    // `tree.version` is a server version string; both are leaves, not
    // context containers, so skip them outright.
    if (contextGroup === "self" || contextGroup === "version") {
      continue;
    }
    const group = tree[contextGroup];
    if (!group || typeof group !== "object") {
      continue;
    }
    for (const contextId of Object.keys(group as Record<string, unknown>)) {
      const contextNode = (group as Record<string, unknown>)[contextId];
      if (!contextNode || typeof contextNode !== "object") {
        continue;
      }
      const contextLabel = `${contextGroup}.${contextId}`;
      walkMeta(contextNode, [], (path, meta) => {
        if (!filter(path)) {
          return;
        }
        entries.push({ context: contextLabel, path, meta });
      });
    }
  }

  return entries;
}

/**
 * Receiver for parseMetaConfig diagnostics. The plugin's `app` object
 * implements this trivially (`app.error.bind(app)`); tests can pass
 * `() => {}` or a jest.fn().
 */
export type MetaConfigErrorReporter = (message: string) => void;

const META_CONFIG_LOG_PREFIX = "[meta-config]";
const META_DEFAULT_INTERVAL_SEC = 300;
const META_DEFAULT_MAX_PATHS = 500;
const META_INTERVAL_MIN = 30;
const META_INTERVAL_MAX = 86400;
const META_MAX_PATHS_MIN = 10;
const META_MAX_PATHS_MAX = 5000;

/**
 * Parse the `meta` block out of a subscription.json document.
 *
 * Returns null when meta is absent, malformed, or explicitly disabled.
 * Out-of-range numeric fields and unsafe `includePathsMatching` patterns
 * fall back to defaults / null and report a `[meta-config]`-prefixed error
 * via `report` so log analysis can grep for misconfiguration in one place.
 *
 * Lives here (not in `instance.ts`) so it can be unit-tested directly without
 * spinning up an entire instance. The same parser is also used as the
 * single source of truth for the plugin runtime via instance.ts.
 */
export function parseMetaConfig(
  raw: unknown,
  report: MetaConfigErrorReporter,
  context: string = ""
): MetaConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const m = obj.meta;
  if (!m || typeof m !== "object") {
    return null;
  }
  const mo = m as Record<string, unknown>;
  if (mo.enabled !== true) {
    return null;
  }

  const tag = context ? `${META_CONFIG_LOG_PREFIX} [${context}]` : META_CONFIG_LOG_PREFIX;

  let intervalSec = META_DEFAULT_INTERVAL_SEC;
  if (mo.intervalSec !== undefined) {
    if (
      typeof mo.intervalSec === "number" &&
      Number.isFinite(mo.intervalSec) &&
      mo.intervalSec >= META_INTERVAL_MIN &&
      mo.intervalSec <= META_INTERVAL_MAX
    ) {
      intervalSec = mo.intervalSec;
    } else {
      report(
        `${tag} meta.intervalSec ${String(mo.intervalSec)} out of range ` +
          `[${META_INTERVAL_MIN},${META_INTERVAL_MAX}]; using default ${META_DEFAULT_INTERVAL_SEC}s`
      );
    }
  }

  let maxPathsPerPacket = META_DEFAULT_MAX_PATHS;
  if (mo.maxPathsPerPacket !== undefined) {
    if (
      typeof mo.maxPathsPerPacket === "number" &&
      Number.isFinite(mo.maxPathsPerPacket) &&
      mo.maxPathsPerPacket >= META_MAX_PATHS_MIN &&
      mo.maxPathsPerPacket <= META_MAX_PATHS_MAX
    ) {
      maxPathsPerPacket = mo.maxPathsPerPacket;
    } else {
      report(
        `${tag} meta.maxPathsPerPacket ${String(mo.maxPathsPerPacket)} out of range ` +
          `[${META_MAX_PATHS_MIN},${META_MAX_PATHS_MAX}]; using default ${META_DEFAULT_MAX_PATHS}`
      );
    }
  }

  let includePathsMatching: string | null = null;
  if (typeof mo.includePathsMatching === "string" && mo.includePathsMatching.length > 0) {
    const pattern = mo.includePathsMatching;
    if (pattern.length > MAX_PATH_FILTER_PATTERN_LENGTH) {
      report(
        `${tag} meta.includePathsMatching exceeds ${MAX_PATH_FILTER_PATTERN_LENGTH} chars; ignoring filter`
      );
    } else if (isLikelyUnsafePathFilter(pattern)) {
      report(
        `${tag} meta.includePathsMatching "${pattern}" has a nested unbounded quantifier (ReDoS shape); ignoring filter`
      );
    } else {
      try {
        new RegExp(pattern);
        includePathsMatching = pattern;
      } catch (err: unknown) {
        report(
          `${tag} meta.includePathsMatching "${pattern}" failed to compile: ${err instanceof Error ? err.message : String(err)}; ignoring filter`
        );
      }
    }
  }

  return {
    enabled: true,
    intervalSec,
    includePathsMatching,
    maxPathsPerPacket
  };
}

/**
 * Resolve the local vessel's context string (e.g. `vessels.urn:mrn:...`) from
 * the Signal K app. Used to normalize `delta.context === "vessels.self"` in
 * the live meta stream to the same concrete URN `collectSnapshot` emits, so
 * `MetaCache` can dedupe snapshot and diff entries against the same key.
 *
 * Returns `null` when the self URN is not yet known — a fallback to the
 * literal `"vessels.self"` would reintroduce the snapshot/live-meta key
 * mismatch. Callers should treat null as "self not resolvable yet" and
 * decline to emit `vessels.self` live entries until a concrete URN arrives.
 */
export function resolveSelfContext(app: SignalKApp): string | null {
  try {
    const self = app.getSelfPath?.("");
    if (self && typeof self === "object") {
      const id = (self as Record<string, unknown>).mmsi ?? (self as Record<string, unknown>).uuid;
      if (typeof id === "string" && id.length > 0) {
        const prefix = (self as Record<string, unknown>).mmsi
          ? "urn:mrn:imo:mmsi:"
          : "urn:mrn:signalk:uuid:";
        return `vessels.${prefix}${id}`;
      }
    }
    if (app.signalk && typeof app.signalk.retrieve === "function") {
      const tree = app.signalk.retrieve() as Record<string, unknown>;
      const alias = tree?.self;
      if (typeof alias === "string" && alias.length > 0) {
        return `vessels.${alias}`;
      }
    }
  } catch {
    /* fall through */
  }
  if (typeof app.debug === "function") {
    app.debug("[metadata] self URN not yet resolvable; vessels.self live meta will be skipped");
  }
  return null;
}

/**
 * Extract any `updates[].meta[]` entries from a live delta without mutating
 * the delta object. Callers should invoke this BEFORE the delta is passed to
 * the pipeline encoder (which silently drops meta).
 */
export function extractLiveMeta(
  delta: Delta,
  config: MetaConfig | null,
  selfContext?: string | null
): MetaEntry[] {
  if (!config || !config.enabled) {
    return [];
  }
  if (!delta || !Array.isArray(delta.updates) || delta.updates.length === 0) {
    return [];
  }
  const filter = buildPathFilter(config.includePathsMatching);
  const out: MetaEntry[] = [];
  for (const update of delta.updates) {
    const metaArr = (update as { meta?: DeltaMeta[] }).meta;
    if (!Array.isArray(metaArr) || metaArr.length === 0) {
      continue;
    }
    for (const m of metaArr) {
      if (!m || typeof m.path !== "string" || !m.value || typeof m.value !== "object") {
        continue;
      }
      if (!filter(m.path)) {
        continue;
      }
      const rawContext = delta.context || "vessels.self";
      // Normalize "vessels.self" to the concrete self URN so MetaCache keys
      // match snapshot keys exactly. If the self URN isn't known yet, skip
      // the entry rather than emit it under a context that will never match
      // collectSnapshot's output — otherwise the receiver would see two
      // copies (one under vessels.self, one under the real URN) and the
      // local MetaCache diff logic would never dedupe them.
      let context: string;
      if (rawContext === "vessels.self") {
        if (!selfContext) {
          continue;
        }
        context = selfContext;
      } else {
        context = rawContext;
      }
      out.push({
        context,
        path: m.path,
        meta: m.value as Record<string, unknown>
      });
    }
  }
  return out;
}

/** Maximum operator-supplied regex length. A typical path-matching regex is
 *  well under 100 chars; refusing huge patterns is a cheap safeguard against
 *  the obvious catastrophic-backtracking shapes (hundreds of nested `(a+)*`
 *  groups, etc.) without pulling in a re2 dependency. */
const MAX_PATH_FILTER_PATTERN_LENGTH = 256;

/**
 * Heuristic detector for the most common ReDoS shape: nested unbounded
 * quantifiers such as `(a+)+`, `(.*)+`, `(a*)*`, `(.+)*`.
 *
 * The check is deliberately narrow — it does not attempt a full ReDoS
 * analysis (which would require pulling in `safe-regex2` or `re2`) — but it
 * catches the specific failure mode that is easy to accidentally write and
 * easy to verify by eye. Callers should also enforce
 * {@link MAX_PATH_FILTER_PATTERN_LENGTH} and wrap regex compilation in
 * try/catch so invalid patterns fail safely.
 *
 * Exported so the config parser can reject unsafe patterns at load time
 * with a descriptive error rather than silently dropping to allow-all at
 * runtime, which would hide operator mistakes.
 */
export function isLikelyUnsafePathFilter(pattern: string): boolean {
  // Matches a group whose body ends in an unbounded quantifier (* or +,
  // optionally with ? for lazy), immediately followed by another unbounded
  // quantifier. This is the classic (a+)+ / (a*)* / (a+)* / (a*)+ family.
  const nested = /\([^()]*[*+][*+?]?\s*\)\s*[*+][*+?]?/;
  return nested.test(pattern);
}

/**
 * Build a path-inclusion predicate from the user-supplied regex string.
 * Falsy / empty string / null ⇒ always-true. Invalid or oversized regex
 * ⇒ always-true (silent fallback — operators see no filtering rather
 * than hitting a hard error, which matches the existing behaviour).
 */
function buildPathFilter(pattern: string | null | undefined): (path: string) => boolean {
  if (!pattern) {
    return () => true;
  }
  if (pattern.length > MAX_PATH_FILTER_PATTERN_LENGTH) {
    return () => true;
  }
  try {
    const re = new RegExp(pattern);
    return (p) => re.test(p);
  } catch {
    return () => true;
  }
}

/**
 * Split a list of meta entries into packet-sized chunks.
 * `max` is clamped to at least 1.
 */
export function splitIntoPackets(entries: MetaEntry[], max: number): MetaEntry[][] {
  const size = Math.max(1, Math.floor(max) || 1);
  if (entries.length === 0) {
    return [];
  }
  const chunks: MetaEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

/**
 * Construct an on-wire envelope for a single chunk of meta entries.
 *
 * The envelope is then JSON- or msgpack-serialized, compressed, encrypted,
 * and wrapped in a METADATA (0x06) packet by the client pipeline.
 */
export function buildMetaEnvelope(
  entries: MetaEntry[],
  kind: "snapshot" | "diff",
  seq: number,
  idx: number,
  total: number
): MetaEnvelope {
  return {
    v: 1,
    kind,
    seq: seq >>> 0,
    idx,
    total,
    entries
  };
}
