"use strict";

/**
 * Subscription manager (L3 domain service).
 *
 * Owns the Signal K subscription lifecycle: normalising the configured
 * subscription, the (re)subscribe choreography (tear down old listeners first,
 * then subscribe — see the 2× delivery race note inline), generation-guarded
 * delta delivery, the staged metadata-config commit, and the exponential-then-
 * slow retry loop that keeps a failed subscribe from leaving the instance
 * silently dead. Extracted from the `instance.ts` God Object.
 *
 * The subscribe/retry paths re-prime the receiver and (re)arm metadata
 * streaming, so those collaborators are injected as callbacks; the active
 * subscription generation is owned here and exposed for invalidation via
 * {@link SubscriptionManager.invalidateGeneration} (called from the
 * connection's `stop()`).
 *
 * @module domain/subscription-manager
 */

import type { SignalKApp, InstanceState, MetricsApi, Delta, MetaConfig } from "../foundation/types";
import { MetaCache } from "../codec/metadata-codec";
import {
  createDebouncedConfigHandler,
  type DebouncedConfigHandler
} from "../foundation/config-reload";

const SUBSCRIPTION_RETRY_BASE_DELAY = 5000;
const SUBSCRIPTION_RETRY_MAX_DELAY = 300000;
const SUBSCRIPTION_RETRY_MAX_ATTEMPTS = 10;
// After the fast-retry window, keep trying at this interval indefinitely.
const SUBSCRIPTION_RETRY_SLOW_DELAY = 5 * 60 * 1000; // 5 minutes

/** Injected dependencies for `createSubscriptionManager`. */
export interface SubscriptionManagerDeps {
  state: InstanceState;
  app: SignalKApp;
  instanceId: string;
  recordError: MetricsApi["recordError"];
  /** Live delta producer (buffers + dispatches to the send pipeline). */
  processDelta: (delta: Delta) => void;
  /** Updates the connection status line / health. */
  setStatus: (msg: string, healthyOverride?: boolean) => void;
  /** Last-sent meta cache, shared with the connection. */
  metaCache: MetaCache;
  parseMetaConfig: (raw: unknown) => MetaConfig | null;
  restartMetadataTimer: () => void;
  scheduleMetadataSnapshot: (delayMs: number) => void;
  replayValuesSnapshot: (reason: string) => void;
}

/** Public API returned by `createSubscriptionManager`. */
export interface SubscriptionManager {
  /** Debounced subscription-config handler (callable; `.flush()` runs now). */
  handleSubscriptionChange: DebouncedConfigHandler;
  /** Bump the active generation so in-flight delta handlers stop delivering. */
  invalidateGeneration(): void;
}

/** Shared mutable context for the subscription manager's module-level helpers. */
interface SubscriptionContext {
  deps: SubscriptionManagerDeps;
  activeSubscriptionGeneration: number;
}

/** Collapse a wildcard (`path: "*"`) subscription to a single row, logging
 *  any overlapping rows that are being dropped. */
function applyWildcardRow(
  ctx: SubscriptionContext,
  record: Record<string, unknown>,
  rows: unknown[],
  wildcardRow: unknown
): Record<string, unknown> {
  const { app, instanceId } = ctx.deps;
  if (rows.length > 1) {
    app.debug(
      `[${instanceId}] Subscription contains path="*"; ignoring ${rows.length - 1} overlapping row(s)`
    );
  }
  return { ...record, subscribe: [wildcardRow] };
}

/** Drop rows with duplicate string `path` values, preserving non-row entries. */
function dedupeSubscriptionRows(rows: unknown[]): { deduped: unknown[]; dropped: number } {
  const seenPaths = new Set<string>();
  const deduped: unknown[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      deduped.push(row);
      continue;
    }
    const path = (row as Record<string, unknown>).path;
    if (typeof path !== "string") {
      deduped.push(row);
      continue;
    }
    if (seenPaths.has(path)) {
      dropped++;
      continue;
    }
    seenPaths.add(path);
    deduped.push(row);
  }
  return { deduped, dropped };
}

function normalizeSubscriptionConfig(ctx: SubscriptionContext, config: unknown): unknown {
  const { app, instanceId } = ctx.deps;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const record = config as Record<string, unknown>;
  if (!Array.isArray(record.subscribe)) {
    return config;
  }

  const rows = record.subscribe as unknown[];
  const wildcardRow = rows.find(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>).path === "*"
  );
  if (wildcardRow) {
    return applyWildcardRow(ctx, record, rows, wildcardRow);
  }

  const { deduped, dropped } = dedupeSubscriptionRows(rows);
  if (dropped > 0) {
    app.debug(`[${instanceId}] Removed ${dropped} duplicate subscription row(s)`);
    return { ...record, subscribe: deduped };
  }
  return config;
}

function createSubscriptionDeltaHandler(
  ctx: SubscriptionContext,
  subscriptionGeneration: number
): (delta: Delta) => void {
  return (delta: Delta) => {
    if (subscriptionGeneration !== ctx.activeSubscriptionGeneration) {
      return;
    }
    ctx.deps.processDelta(delta);
  };
}

/** Compute the backoff delay for a retry attempt, logging the transition to
 *  slow-retry mode the first time it is reached. */
function computeRetryDelay(ctx: SubscriptionContext, attempt: number): number {
  const { app, instanceId, recordError } = ctx.deps;
  // Beyond the fast-retry window, switch to a slow keep-alive retry.
  const isSlow = attempt > SUBSCRIPTION_RETRY_MAX_ATTEMPTS;
  if (isSlow && attempt === SUBSCRIPTION_RETRY_MAX_ATTEMPTS + 1) {
    app.error(
      `[${instanceId}] Subscription failed after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts — ` +
        `switching to slow retry every ${SUBSCRIPTION_RETRY_SLOW_DELAY / 1000}s`
    );
    recordError(
      "subscription",
      `Subscription entering slow-retry mode after ${SUBSCRIPTION_RETRY_MAX_ATTEMPTS} attempts`
    );
  }

  return isSlow
    ? SUBSCRIPTION_RETRY_SLOW_DELAY
    : Math.min(
        SUBSCRIPTION_RETRY_BASE_DELAY * Math.pow(2, attempt - 1),
        SUBSCRIPTION_RETRY_MAX_DELAY
      );
}

/** Run a single retry attempt: tear down partial listeners, resubscribe, and
 *  on success promote any staged meta config and replay the tree. */
function runSubscriptionRetry(ctx: SubscriptionContext, attempt: number): void {
  const {
    state,
    app,
    instanceId,
    recordError,
    setStatus,
    metaCache,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    replayValuesSnapshot
  } = ctx.deps;
  state.subscriptionRetryTimer = null;
  if (state.stopped) {
    return;
  }
  app.debug(`[${instanceId}] Retrying subscription (attempt ${attempt})...`);
  // Tear down any partial listeners left behind by a previous failed
  // subscribe attempt before adding new ones — same reason as the main
  // handleSubscriptionChange path: keeping stale partial listeners in
  // state.unsubscribes alongside a fresh subscribe() causes them to fire
  // for every push, doubling processDelta delivery for affected paths.
  const partialUnsubscribes = state.unsubscribes.splice(0);
  partialUnsubscribes.forEach((f: () => void) => f());

  try {
    const subscriptionGeneration = ++ctx.activeSubscriptionGeneration;
    state.subscribing = true;
    try {
      app.subscriptionmanager.subscribe(
        state.localSubscription,
        state.unsubscribes,
        (retrySubError: unknown) => {
          app.error(`[${instanceId}] Subscription error (attempt ${attempt}): ${retrySubError}`);
          state.readyToSend = false;
          setStatus("Subscription error - data transmission paused", false);
          recordError("subscription", `Subscription error: ${retrySubError}`);
        },
        createSubscriptionDeltaHandler(ctx, subscriptionGeneration)
      );
    } finally {
      state.subscribing = false;
    }
    // Retry succeeded — perform the staged commit that the original
    // processConfig catch block skipped. Without this, the operator's
    // new meta block (stashed on state.pendingMetaConfig) would remain
    // inactive even though subscribe() is now working.
    if (state.pendingMetaConfig !== undefined) {
      state.metaConfig = state.pendingMetaConfig;
      state.pendingMetaConfig = undefined;
      restartMetadataTimer();
      metaCache.clear();
      if (state.metaConfig?.enabled) {
        scheduleMetadataSnapshot(2000);
      }
    }
    state.readyToSend = true;
    setStatus("Subscription restored", true);
    // Replay current tree state so any value that arrived in the tree
    // while we were retrying isn't permanently lost.
    replayValuesSnapshot("subscription retry");
  } catch (retryError: unknown) {
    const msg = retryError instanceof Error ? retryError.message : String(retryError);
    app.error(`[${instanceId}] Subscription retry ${attempt} failed: ${msg}`);
    recordError("subscription", `Subscription retry ${attempt} failed: ${msg}`);
    scheduleSubscriptionRetry(ctx, attempt + 1);
  }
}

/**
 * Schedule a subscription retry with exponential backoff.
 * After SUBSCRIPTION_RETRY_MAX_ATTEMPTS consecutive failures the backoff
 * saturates at SUBSCRIPTION_RETRY_SLOW_DELAY and retries continue
 * indefinitely so that a transient Signal K startup race does not leave
 * the instance silently dead for the lifetime of the process.
 */
function scheduleSubscriptionRetry(ctx: SubscriptionContext, attempt: number): void {
  const { state, app, instanceId } = ctx.deps;
  const delay = computeRetryDelay(ctx, attempt);

  app.debug(
    `[${instanceId}] Scheduling subscription retry (attempt ${attempt}/${SUBSCRIPTION_RETRY_MAX_ATTEMPTS}) in ${delay}ms`
  );

  // Clear any pending retry timer before scheduling a new one to prevent
  // duplicate timers leaking when called multiple times before the first fires.
  if (state.subscriptionRetryTimer) {
    clearTimeout(state.subscriptionRetryTimer);
  }
  state.subscriptionRetryTimer = setTimeout(() => runSubscriptionRetry(ctx, attempt), delay);
}

/** Handle a failed (re)subscribe in the main config path: stash the staged
 *  meta config and kick off the retry loop. */
function handleSubscribeFailure(
  ctx: SubscriptionContext,
  subscribeError: unknown,
  pendingMetaConfig: MetaConfig | null,
  previousMetaConfig: MetaConfig | null,
  previousUnsubscribes: Array<() => void>
): void {
  const { state, app, instanceId, recordError, setStatus } = ctx.deps;
  // Re-subscribe failed. The old subscription was already torn down
  // before we attempted the new subscribe(), so we cannot restore it —
  // any partial subscriptions registered by the failed subscribe() are
  // already in state.unsubscribes and stop() can clean them up.
  // The retry path (scheduleSubscriptionRetry) will attempt a fresh
  // subscribe() against state.unsubscribes; if any partial listeners
  // exist they get added to alongside, but that's no worse than the
  // pre-fix behaviour and avoids the more serious 2× delivery race.
  // Leave state.metaConfig / metaCache / metaTimer untouched so the
  // previous subscription's metadata behaviour rules are preserved
  // pending retry.
  void previousMetaConfig; // explicit: intentionally unchanged
  void previousUnsubscribes; // intentionally not restored — see above
  // Stash the new meta config on state so the scheduled retry can
  // promote it when subscribe() finally succeeds. Otherwise the
  // operator's new meta settings would silently sit unused until the
  // user re-saved subscription.json.
  state.pendingMetaConfig = pendingMetaConfig;
  const subErrMsg =
    subscribeError instanceof Error ? subscribeError.message : String(subscribeError);
  app.error(`[${instanceId}] Failed to subscribe: ${subErrMsg}`);
  state.readyToSend = false;
  setStatus("Failed to subscribe - data transmission paused", false);
  recordError("subscription", `Failed to subscribe: ${subErrMsg}`);

  // Retry with exponential backoff (5s, 10s, 20s, 40s … up to 300s max).
  // Store the handle so stop() can cancel it before it fires.
  scheduleSubscriptionRetry(ctx, 1);
}

/** Process a (re)subscribe config change: normalise, tear down the old
 *  subscription, subscribe afresh, and commit/stage the meta config. */
function processSubscriptionConfig(ctx: SubscriptionContext, config: unknown): void {
  const {
    state,
    app,
    instanceId,
    recordError,
    setStatus,
    metaCache,
    parseMetaConfig,
    restartMetadataTimer,
    scheduleMetadataSnapshot,
    replayValuesSnapshot
  } = ctx.deps;
  state.localSubscription = normalizeSubscriptionConfig(ctx, config);
  app.debug(`[${instanceId}] Subscription configuration updated`);

  // Stage the new metadata config — do NOT yet touch state.metaConfig,
  // the periodic timer, or metaCache. If subscribe() throws, the old
  // subscription remains active until the retry succeeds, so its
  // previous metadata behaviour must remain intact.
  const previousMetaConfig = state.metaConfig;
  const pendingMetaConfig = parseMetaConfig(state.localSubscription);

  // Tear down the old subscription FIRST, then establish the new one.
  // The previous "subscribe-then-unsubscribe" ordering tried to avoid
  // dropping any delta during the handover, but it leaves a window
  // where BOTH the old and new subscriptions are simultaneously
  // attached to every per-path bus in signalk-server's
  // `streambundle.buses`. Any push that lands in that window — or any
  // listener that the new subscribe() registers asynchronously via
  // streambundle.keys.onValue for a path whose bus is created during
  // the window — fires both callbacks, doubling processDelta delivery
  // for the rest of the process lifetime.
  //
  // Replaying via `replayValuesSnapshot("initial subscribe")` below
  // recovers any value that was already in the SK tree, and any
  // genuinely live delta that lands in the brief teardown→subscribe
  // gap will be re-emitted by its publisher within the subscription's
  // throttle period.
  const previousUnsubscribes = state.unsubscribes.splice(0);
  previousUnsubscribes.forEach((f: () => void) => f());

  try {
    const subscriptionGeneration = ++ctx.activeSubscriptionGeneration;
    state.subscribing = true;
    try {
      app.subscriptionmanager.subscribe(
        state.localSubscription,
        state.unsubscribes,
        (subscriptionError: unknown) => {
          app.error(`[${instanceId}] Subscription error: ${subscriptionError}`);
          state.readyToSend = false;
          setStatus("Subscription error - data transmission paused", false);
          recordError("subscription", `Subscription error: ${subscriptionError}`);
        },
        createSubscriptionDeltaHandler(ctx, subscriptionGeneration)
      );
    } finally {
      state.subscribing = false;
    }
    // Commit the new metadata config AFTER a successful subscribe: swap
    // state.metaConfig, (re)start the periodic timer, and reset the diff
    // cache so the next snapshot represents the live state in full. We
    // reset the cache unconditionally here because even "meta unchanged"
    // still needs an empty cache for the new subscription's path set.
    state.metaConfig = pendingMetaConfig;
    restartMetadataTimer();
    metaCache.clear();
    // Prime the receiver's meta cache with a full snapshot once the
    // Signal K state tree has had a moment to settle after (re)subscribe.
    if (state.metaConfig?.enabled) {
      scheduleMetadataSnapshot(2000);
    }
    // Replay every value already present in the tree. Without this,
    // one-shot startup deltas published before subscribe() ran (e.g. by
    // a co-located edge-link server-mode instance) never reach the
    // receiver, since the subscription manager only delivers future
    // events.
    replayValuesSnapshot("initial subscribe");
  } catch (subscribeError: unknown) {
    handleSubscribeFailure(
      ctx,
      subscribeError,
      pendingMetaConfig,
      previousMetaConfig,
      previousUnsubscribes
    );
  }
}

/** Creates the subscription lifecycle manager; the returned generation counter lets in-flight delta handlers bail out immediately when the subscription is torn down without waiting for all async handlers to drain. */
export function createSubscriptionManager(deps: SubscriptionManagerDeps): SubscriptionManager {
  const { state, instanceId, app } = deps;
  const ctx: SubscriptionContext = {
    deps,
    activeSubscriptionGeneration: 0
  };

  // Subscription change handler (also wires up the main delta subscription)
  const handleSubscriptionChange = createDebouncedConfigHandler({
    name: "Subscription",
    getFilePath: () => state.subscriptionFile,
    processConfig: (config: unknown) => processSubscriptionConfig(ctx, config),
    state,
    instanceId,
    app,
    readFallback: { context: "*", subscribe: [{ path: "*" }] }
  });

  function invalidateGeneration(): void {
    ctx.activeSubscriptionGeneration++;
  }

  return { handleSubscriptionChange, invalidateGeneration };
}
