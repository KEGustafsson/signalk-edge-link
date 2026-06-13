"use strict";

/**
 * Source / values snapshot service (L3 domain service).
 *
 * Owns the "re-prime the receiver" paths that exist because the subscription
 * manager only delivers *future* deltas:
 *
 *  - `sendSourceSnapshot` — periodic ($source registry) snapshot for v2/v3.
 *  - `replayValuesSnapshot` — replays the current Signal K value tree as
 *    synthetic deltas (on subscribe, subscribe-retry, socket recovery, and
 *    FULL_STATUS_REQUEST) so values published before subscribe still reach
 *    the receiver.
 *  - `handleFullStatusRequest` — rate-limited server-initiated full replay,
 *    with optional cascade to downstream clients in multi-hop chains.
 *
 * Extracted from the `instance.ts` God Object. State (including
 * `state.processDelta`, the buffer producer the replay feeds) is shared by
 * reference; the cascade handler is read through an injected getter because
 * instance.ts owns it via its public `setFullStatusCascadeHandler`.
 *
 * @module domain/source-snapshot-service
 */

import type { SignalKApp, ConnectionConfig, InstanceState, MetricsApi, Delta } from "../types";
import { SNAPSHOT_REPLAY_CHUNK_SIZE, SOURCE_SNAPSHOT_INTERVAL_MS } from "../constants";
import { collectSourceSnapshot } from "../source-snapshot";
import { collectValuesSnapshot } from "../values-snapshot";

/** Minimum gap between server-initiated full-status replays. Prevents a
 *  restarting or misconfigured server from flooding the link. */
const FULL_STATUS_REQUEST_RATE_LIMIT_MS = 10000;

export interface SourceSnapshotServiceDeps {
  state: InstanceState;
  options: ConnectionConfig;
  app: SignalKApp;
  /** App proxy used for self-context resolution during snapshot collection. */
  appProxy: SignalKApp;
  instanceId: string;
  metrics: MetricsApi["metrics"];
  /** Reads the (optionally configured) downstream cascade handler. */
  getFullStatusCascadeHandler: () => (() => void) | null;
}

export interface SourceSnapshotService {
  handleFullStatusRequest(): void;
  sendSourceSnapshot(): Promise<void>;
  replayValuesSnapshot(reason: string): void;
  restartSourceSnapshotTimer(): void;
}

export function createSourceSnapshotService(
  deps: SourceSnapshotServiceDeps
): SourceSnapshotService {
  const { state, options, app, appProxy, instanceId, metrics, getFullStatusCascadeHandler } = deps;

  /** Server asked for a full values snapshot (FULL_STATUS_REQUEST control
   *  packet). Replays the entire current Signal K tree to the server.
   *  Rate-limited to prevent replay floods across rapid server restarts. */
  function handleFullStatusRequest(): void {
    const now = Date.now();
    if (now - state.lastFullStatusRequestAt < FULL_STATUS_REQUEST_RATE_LIMIT_MS) {
      app.debug(`[${instanceId}] FULL_STATUS_REQUEST rate-limited, skipping`);
      return;
    }
    state.lastFullStatusRequestAt = now;
    app.debug(`[${instanceId}] FULL_STATUS_REQUEST received — replaying values snapshot`);
    replayValuesSnapshot("full-status-request");
    const fullStatusCascadeHandler = getFullStatusCascadeHandler();
    if (fullStatusCascadeHandler) {
      app.debug(`[${instanceId}] FULL_STATUS_REQUEST cascading to downstream clients`);
      metrics.fullStatusCascadeFired = (metrics.fullStatusCascadeFired || 0) + 1;
      fullStatusCascadeHandler();
    }
  }

  async function sendSourceSnapshot(): Promise<void> {
    if (
      state.stopped ||
      !state.readyToSend ||
      !state.pipeline ||
      typeof state.pipeline.sendSourceSnapshot !== "function" ||
      !options.secretKey ||
      !options.udpAddress
    ) {
      return;
    }

    const sources = collectSourceSnapshot(appProxy);
    if (!sources || Object.keys(sources).length === 0) {
      return;
    }

    try {
      await state.pipeline.sendSourceSnapshot(
        sources,
        options.secretKey,
        options.udpAddress,
        options.udpPort
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] source snapshot send failed: ${msg}`);
    }
  }

  /**
   * Replay every value currently in the local Signal K tree by feeding
   * synthetic deltas through `processDelta`. The subscription manager only
   * delivers *future* deltas, so values published into the tree before
   * `subscribe()` ran (one-shot startup deltas, or deltas published by a
   * co-located edge-link server-mode instance via `app.handleMessage`) would
   * otherwise never reach the receiver. Triggered on initial subscribe
   * success, on subscribe-retry success, and on UDP socket recovery so the
   * receiver gets re-primed if it restarted.
   *
   * Returns silently if the SignalK app object doesn't expose `signalk`
   * (older signalk-server versions or test mocks), or while the instance is
   * not yet ready to send.
   */
  function replayValuesSnapshot(reason: string): void {
    if (state.stopped || !state.readyToSend || !state.processDelta) {
      return;
    }
    let snapshot: Delta[];
    try {
      snapshot = collectValuesSnapshot(appProxy);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.debug(`[${instanceId}] values snapshot collect failed (${reason}): ${msg}`);
      return;
    }
    if (snapshot.length === 0) {
      return;
    }
    app.debug(`[${instanceId}] Replaying ${snapshot.length} value-snapshot delta(s) (${reason})`);
    recordSnapshotReplay(reason, snapshot.length);
    // Chunk via setImmediate so a hundred-leaf snapshot can't fill
    // MAX_DELTAS_BUFFER_SIZE in a single tick and force-drop concurrent
    // live deltas. Each chunk yields to a later event-loop turn.
    let i = 0;
    function pumpChunk(): void {
      if (state.stopped || !state.readyToSend || !state.processDelta) {
        return;
      }
      const end = Math.min(i + SNAPSHOT_REPLAY_CHUNK_SIZE, snapshot.length);
      try {
        for (; i < end; i++) {
          state.processDelta(snapshot[i]);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.debug(`[${instanceId}] values snapshot replay failed (${reason}): ${msg}`);
        return;
      }
      if (i < snapshot.length) {
        setImmediate(pumpChunk);
      }
    }
    pumpChunk();
  }

  function recordSnapshotReplay(reason: string, count: number): void {
    metrics.snapshotsReplayed = metrics.snapshotsReplayed || {
      initialSubscribe: 0,
      subscriptionRetry: 0,
      socketRecovery: 0,
      fullStatusRequest: 0
    };
    if (reason === "initial subscribe") {
      metrics.snapshotsReplayed.initialSubscribe++;
    } else if (reason === "subscription retry") {
      metrics.snapshotsReplayed.subscriptionRetry++;
    } else if (reason === "socket recovery") {
      metrics.snapshotsReplayed.socketRecovery++;
    } else if (reason === "full-status-request") {
      metrics.snapshotsReplayed.fullStatusRequest++;
    }
    metrics.snapshotReplayDeltas = (metrics.snapshotReplayDeltas || 0) + count;
  }

  function restartSourceSnapshotTimer(): void {
    clearInterval(state.sourceSnapshotTimer ?? undefined);
    state.sourceSnapshotTimer = null;
    if ((options.protocolVersion ?? 0) < 2) {
      return;
    }
    state.sourceSnapshotTimer = setInterval(() => {
      sendSourceSnapshot().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.debug(`[${instanceId}] periodic source snapshot failed: ${msg}`);
      });
    }, SOURCE_SNAPSHOT_INTERVAL_MS);
  }

  return {
    handleFullStatusRequest,
    sendSourceSnapshot,
    replayValuesSnapshot,
    restartSourceSnapshotTimer
  };
}
