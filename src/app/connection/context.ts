"use strict";

/**
 * Shared connection context (L4 application layer).
 *
 * `createConnection` is a large factory wiring together L3 domain services and
 * the L2 transport pipeline over a single shared mutable `state`. To keep the
 * factory thin and its inner closures testable, the closures are extracted into
 * module-level helpers (see sibling files) that receive this {@link ConnectionContext}
 * as an explicit parameter instead of closing over factory locals.
 *
 * The context bundles the immutable dependencies (app, options, ids, domain
 * services) together with the small pieces of mutable bookkeeping that the
 * lifecycle and hot-path helpers share (dedupe map, backoff counters, cascade
 * handler). Mutable scalars live on the context object so a helper in another
 * module can read and write them by reference.
 *
 * @module app/connection/context
 */

import type dgram from "dgram";
import type { UdpSocketManager } from "../../transport/udp-socket-manager";
import type { Lifecycle } from "../lifecycle";
import type { MetaCache } from "../../codec/metadata-codec";
import type { DeltaBatcher } from "../../domain/delta-batcher";
import type { KeepaliveManager } from "../../domain/keepalive-manager";
import type { MetadataStreamer } from "../../domain/metadata-streamer";
import type { SourceSnapshotService } from "../../domain/source-snapshot-service";
import type { SubscriptionManager } from "../../domain/subscription-manager";
import type {
  SignalKApp,
  ConnectionConfig,
  InstanceState,
  MetricsApi,
  Delta,
  MetaConfig
} from "../../foundation/types";

/** Minimal v1-pipeline surface used lazily by the connection helpers. */
export interface V1PipelineLike {
  packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    address: string,
    port: number
  ): Promise<void>;
  unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
}

/** Domain services constructed by the factory and shared with the helpers. */
export interface ConnectionServices
  extends
    Pick<DeltaBatcher, "scheduleDeltaTimer" | "flushDeltaBatch">,
    Pick<
      MetadataStreamer,
      | "sendMetadataSnapshot"
      | "enqueueMetaDiff"
      | "restartMetadataTimer"
      | "scheduleMetadataSnapshot"
      | "handleMetaRequest"
    >,
    Pick<
      SourceSnapshotService,
      | "handleFullStatusRequest"
      | "sendSourceSnapshot"
      | "replayValuesSnapshot"
      | "restartSourceSnapshotTimer"
    >,
    Pick<SubscriptionManager, "handleSubscriptionChange"> {
  keepaliveManager: KeepaliveManager;
  metaCache: MetaCache;
  parseMetaConfig: (raw: unknown) => MetaConfig | null;
  invalidateSubscriptionGeneration: () => void;
}

/** Config-watcher change handlers used during client setup. */
export interface ConnectionConfigHandlers {
  handleDeltaTimerChange: SubscriptionManager["handleSubscriptionChange"];
  handleSentenceFilterChange: SubscriptionManager["handleSubscriptionChange"];
}

/**
 * Shared mutable context threaded through the connection helper modules.
 *
 * Object identity is stable for the lifetime of the connection; helpers mutate
 * the scalar fields (`dedupeCleanupTimer`, `socketRecoveryBackoffMs`,
 * `lastDupLogAt`, `reportPending`, `v1Pipeline`, `fullStatusCascadeHandler`) in
 * place so changes are visible across modules.
 */
export interface ConnectionContext {
  // ── Immutable deps ─────────────────────────────────────────────────────────
  app: SignalKApp;
  appProxy: SignalKApp;
  options: ConnectionConfig;
  instanceId: string;
  pluginId: string;
  onStatusChange: (instanceId: string, message: string) => void;
  lifecycle: Lifecycle;
  metricsApi: MetricsApi;
  metrics: MetricsApi["metrics"];
  recordError: MetricsApi["recordError"];
  resetMetrics: MetricsApi["resetMetrics"];
  socketManager: UdpSocketManager;
  state: InstanceState;
  services: ConnectionServices;
  configHandlers: ConnectionConfigHandlers;

  // ── Status helper ────────────────────────────────────────────────────────
  setStatus: (msg: string, healthyOverride?: boolean) => void;

  // ── Outbound dedupe ──────────────────────────────────────────────────────
  recentOutboundDeltas: Map<string, number>;
  cleanupDedupeMap: (now: number) => void;

  // ── v1 pipeline (lazy) ─────────────────────────────────────────────────────
  getV1Pipeline: () => V1PipelineLike;

  // ── Output coalescer / ping helpers ────────────────────────────────────────
  scheduleReportOutputMessages: () => void;
  handlePingSuccess: (res: { time?: number } | null, event: string) => void;

  // ── Socket recovery handlers (wired by the factory) ─────────────────────────
  handleClientSocketError: (err: NodeJS.ErrnoException) => void;

  // ── Mutable bookkeeping ──────────────────────────────────────────────────
  dedupeCleanupTimer: ReturnType<typeof setInterval> | null;
  lastDupLogAt: number;
  reportPending: boolean;
  /** Deltas enqueued since the last coalesced `reportOutputMessages` call. */
  reportPendingCount: number;
  v1Pipeline: V1PipelineLike | null;
  socketRecoveryBackoffMs: number;
  fullStatusCascadeHandler: (() => void) | null;
}

/** Re-export for helper modules that need the dgram RemoteInfo type. */
export type RemoteInfo = dgram.RemoteInfo;

/** Tunables for socket recovery backoff (client mode). */
export const SOCKET_RECOVERY_BASE_MS = 5000;
export const SOCKET_RECOVERY_MAX_MS = 60000;
