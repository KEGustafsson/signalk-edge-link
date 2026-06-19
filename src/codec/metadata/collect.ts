"use strict";

/**
 * L1 codec — meta collection: snapshot/live extraction, config parsing
 * (incl. ReDoS guard), packet splitting and envelope build.
 */

import type {
  Delta,
  DeltaMeta,
  MetaConfig,
  MetaEntry,
  MetaEnvelope,
  SignalKApp
} from "../../foundation/types";

const STRIP_UNSET = Symbol("strip-unset");

/**
 * Deep-clone a metadata payload while removing unset placeholders.
 *
 * Explicit `null` values are preserved so metadata clear operations
 * (`{ someField: null }`) can propagate to receivers.
 *
 * Returns a private sentinel when no useful data remains.
 */
function stripUnsetDeep(value: unknown): unknown {
  if (value === undefined) {
    return STRIP_UNSET;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => stripUnsetDeep(item))
      .filter((item) => item !== STRIP_UNSET);
    return cleaned.length > 0 ? cleaned : STRIP_UNSET;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = stripUnsetDeep(v);
    if (cleaned !== STRIP_UNSET) {
      out[k] = cleaned;
    }
  }
  return Object.keys(out).length > 0 ? out : STRIP_UNSET;
}

// Signal K "value", "timestamp", "$source" etc. are leaves, not sub-paths, so
// walkMeta does not descend into them.
const META_WALK_LEAF_KEYS = new Set([
  "meta",
  "value",
  "values",
  "timestamp",
  "$source",
  "sentence"
]);

/** Return the cleaned meta object for a node, or null if it has none / is empty. */
function cleanedNodeMeta(obj: Record<string, unknown>): Record<string, unknown> | null {
  if (!obj.meta || typeof obj.meta !== "object" || Array.isArray(obj.meta)) {
    return null;
  }
  const cleanedMeta = stripUnsetDeep(obj.meta);
  if (
    cleanedMeta === STRIP_UNSET ||
    !cleanedMeta ||
    typeof cleanedMeta !== "object" ||
    Array.isArray(cleanedMeta)
  ) {
    return null;
  }
  return cleanedMeta as Record<string, unknown>;
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
  const meta = cleanedNodeMeta(obj);
  if (meta) {
    onMeta(pathParts.join("."), meta);
  }
  for (const key of Object.keys(obj)) {
    if (META_WALK_LEAF_KEYS.has(key)) {
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
/** Retrieve the SK full-model tree, returning null when unavailable/malformed. */
function retrieveTree(app: SignalKApp): Record<string, unknown> | null {
  if (!app.signalk || typeof app.signalk.retrieve !== "function") {
    return null;
  }
  let tree: Record<string, unknown>;
  try {
    tree = app.signalk.retrieve();
  } catch {
    return null;
  }
  if (!tree || typeof tree !== "object") {
    return null;
  }
  return tree;
}

/** Collect meta entries for every context under one top-level context group. */
function collectGroupMeta(
  group: unknown,
  contextGroup: string,
  filter: (path: string) => boolean,
  entries: MetaEntry[]
): void {
  if (!group || typeof group !== "object") {
    return;
  }
  for (const contextId of Object.keys(group as Record<string, unknown>)) {
    const contextNode = (group as Record<string, unknown>)[contextId];
    if (!contextNode || typeof contextNode !== "object") {
      continue;
    }
    const contextLabel = `${contextGroup}.${contextId}`;
    walkMeta(contextNode, [], (path, meta) => {
      if (filter(path)) {
        entries.push({ context: contextLabel, path, meta });
      }
    });
  }
}

export function collectSnapshot(app: SignalKApp, config: MetaConfig | null): MetaEntry[] {
  if (!config || !config.enabled) {
    return [];
  }
  const tree = retrieveTree(app);
  if (!tree) {
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
    collectGroupMeta(tree[contextGroup], contextGroup, filter, entries);
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
/**
 * Parse a clamped numeric meta-config field. Returns the value when it is a
 * finite number within [min, max]; otherwise reports the out-of-range error
 * via `report` and returns `fallback`.
 */
function parseClampedNumber(
  value: unknown,
  bounds: { min: number; max: number; fallback: number },
  report: MetaConfigErrorReporter,
  describe: (raw: string) => string
): number {
  if (value === undefined) {
    return bounds.fallback;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max
  ) {
    return value;
  }
  report(describe(String(value)));
  return bounds.fallback;
}

/**
 * Parse `meta.includePathsMatching`. Returns the pattern when present, safe,
 * and compilable; otherwise reports the reason via `report` and returns null.
 */
function parseIncludePathsMatching(
  value: unknown,
  tag: string,
  report: MetaConfigErrorReporter
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const pattern = value;
  if (pattern.length > MAX_PATH_FILTER_PATTERN_LENGTH) {
    report(
      `${tag} meta.includePathsMatching exceeds ${MAX_PATH_FILTER_PATTERN_LENGTH} chars; ignoring filter`
    );
    return null;
  }
  if (isLikelyUnsafePathFilter(pattern)) {
    report(
      `${tag} meta.includePathsMatching "${pattern}" has a nested unbounded quantifier (ReDoS shape); ignoring filter`
    );
    return null;
  }
  try {
    new RegExp(pattern);
    return pattern;
  } catch (err: unknown) {
    report(
      `${tag} meta.includePathsMatching "${pattern}" failed to compile: ${err instanceof Error ? err.message : String(err)}; ignoring filter`
    );
    return null;
  }
}

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

  const intervalSec = parseClampedNumber(
    mo.intervalSec,
    { min: META_INTERVAL_MIN, max: META_INTERVAL_MAX, fallback: META_DEFAULT_INTERVAL_SEC },
    report,
    (raw) =>
      `${tag} meta.intervalSec ${raw} out of range ` +
      `[${META_INTERVAL_MIN},${META_INTERVAL_MAX}]; using default ${META_DEFAULT_INTERVAL_SEC}s`
  );

  const maxPathsPerPacket = parseClampedNumber(
    mo.maxPathsPerPacket,
    { min: META_MAX_PATHS_MIN, max: META_MAX_PATHS_MAX, fallback: META_DEFAULT_MAX_PATHS },
    report,
    (raw) =>
      `${tag} meta.maxPathsPerPacket ${raw} out of range ` +
      `[${META_MAX_PATHS_MIN},${META_MAX_PATHS_MAX}]; using default ${META_DEFAULT_MAX_PATHS}`
  );

  const includePathsMatching = parseIncludePathsMatching(mo.includePathsMatching, tag, report);

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
/**
 * Resolve the effective context for a live-meta entry.
 *
 * Normalizes "vessels.self" to the concrete self URN so MetaCache keys match
 * snapshot keys exactly. If the self URN isn't known yet, returns null so the
 * caller skips the entry rather than emit it under a context that will never
 * match collectSnapshot's output — otherwise the receiver would see two copies
 * (one under vessels.self, one under the real URN) and the local MetaCache diff
 * logic would never dedupe them.
 */
function resolveLiveMetaContext(
  rawContext: string,
  selfContext: string | null | undefined
): string | null {
  if (rawContext === "vessels.self") {
    return selfContext ? selfContext : null;
  }
  return rawContext;
}

/** Convert a single live `DeltaMeta` entry into a `MetaEntry`, or null to skip. */
function liveMetaEntry(
  m: DeltaMeta,
  delta: Delta,
  filter: (path: string) => boolean,
  selfContext: string | null | undefined
): MetaEntry | null {
  if (!m || typeof m.path !== "string" || !m.value || typeof m.value !== "object") {
    return null;
  }
  if (!filter(m.path)) {
    return null;
  }
  const context = resolveLiveMetaContext(delta.context || "vessels.self", selfContext);
  if (context === null) {
    return null;
  }
  const cleanedMeta = stripUnsetDeep(m.value);
  if (
    cleanedMeta === STRIP_UNSET ||
    !cleanedMeta ||
    typeof cleanedMeta !== "object" ||
    Array.isArray(cleanedMeta)
  ) {
    return null;
  }
  return {
    context,
    path: m.path,
    meta: cleanedMeta as Record<string, unknown>
  };
}

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
      const entry = liveMetaEntry(m, delta, filter, selfContext);
      if (entry) {
        out.push(entry);
      }
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
  if (pattern.length > MAX_PATH_FILTER_PATTERN_LENGTH || isLikelyUnsafePathFilter(pattern)) {
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
