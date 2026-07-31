"use strict";

/**
 * Client-mode startup (L4 application layer).
 *
 * Initializes persistent storage, loads the delta-timer config, optionally arms
 * the v1 ping monitor, builds the reliable (v2/v3) pipeline + enhanced
 * monitoring + bonding, and finally installs the config-file watchers.
 * Extracted from `createConnection` and split into focused helpers to keep the
 * statement count and cyclomatic complexity within the layer caps.
 *
 * @module app/connection/start-client
 */

import dgram from "dgram";
import { dirname, join } from "node:path";
import Monitor from "ping-monitor";
import {
  PacketLossTracker,
  PathLatencyTracker,
  RetransmissionTracker,
  AlertManager
} from "../../domain/monitoring";
import { PacketCapture, PacketInspector } from "../../domain/monitoring/packet-capture";
import { DEFAULT_DELTA_TIMER } from "../../foundation/constants";
import { loadConfigFileSafe } from "../../foundation/config-io";
import { resolveMonotonicEpoch } from "../../transport/reliability/connection-epoch";
import { createWatcherWithRecovery, initializePersistentStorage } from "../config/watcher";
import type { ConnectionContext } from "./context";

/** Persisted-epoch file path for a connection, beside its other runtime files. */
function epochFilePath(ctx: ConnectionContext): string | null {
  return ctx.state.deltaTimerFile
    ? join(dirname(ctx.state.deltaTimerFile), "replay_epoch.json")
    : null;
}

/** Load and apply the persisted delta-timer interval, falling back to default. */
async function loadDeltaTimer(ctx: ConnectionContext): Promise<void> {
  const { state, app, instanceId } = ctx;
  const dtResult = await loadConfigFileSafe(state.deltaTimerFile ?? "", app);
  if (dtResult.status === "parse_error" || dtResult.status === "read_error") {
    app.error(
      `[${instanceId}] Delta timer config load failed (${dtResult.status}): ${dtResult.message} — using default`
    );
  }
  const dtData = dtResult.status === "ok" ? (dtResult.data as Record<string, unknown>) : null;
  const rawDt = typeof dtData?.deltaTimer === "number" ? dtData.deltaTimer : NaN;
  state.deltaTimerTime = Number.isFinite(rawDt) && rawDt >= 100 ? rawDt : DEFAULT_DELTA_TIMER;
}

/** Arm the v1 TCP ping monitor (protocol < 2 only). */
function startPingMonitor(ctx: ConnectionContext): void {
  const { state, app, instanceId, options } = ctx;
  const pingIntervalMinutes =
    typeof options.pingIntervalTime === "number" && Number.isFinite(options.pingIntervalTime)
      ? options.pingIntervalTime
      : 1;
  state.pingMonitor = new Monitor({
    address: options.testAddress ?? "",
    port: options.testPort,
    interval: pingIntervalMinutes,
    protocol: "tcp"
  });
  state.pingMonitor.on("up", (res: { time?: number } | null) => ctx.handlePingSuccess(res, "up"));
  state.pingMonitor.on("restored", (res: { time?: number } | null) =>
    ctx.handlePingSuccess(res, "restored")
  );
  for (const e of ["down", "stop", "timeout"]) {
    state.pingMonitor.on(e, () => app.debug(`[${instanceId}] Connection monitor: ${e}`));
  }
  state.pingMonitor.on("error", (error: NodeJS.ErrnoException | null) => {
    if (!error) {
      app.debug(`[${instanceId}] Connection monitor error`);
      return;
    }
    const msg =
      error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
        ? `Could not resolve address ${options.testAddress}.`
        : `Connection monitor error: ${error.message || String(error)}`;
    app.debug(`[${instanceId}] ${msg}`);
  });
}

/** Allocate the enhanced-monitoring trackers for the reliable pipeline. */
function initMonitoring(ctx: ConnectionContext): void {
  const { state, app, instanceId, options, appProxy } = ctx;
  state.monitoring = {
    packetLossTracker: new PacketLossTracker(),
    pathLatencyTracker: new PathLatencyTracker(),
    retransmissionTracker: new RetransmissionTracker(),
    alertManager: new AlertManager(appProxy, {
      thresholds: options.alertThresholds || {},
      instanceId: state.instanceId,
      enabled: options.enableNotifications === true
    }),
    packetCapture: new PacketCapture(),
    packetInspector: new PacketInspector()
  };
  app.debug(`[${instanceId}] [v3] Enhanced monitoring initialized`);
}

/** Minimal reliable (v2/v3) client pipeline surface used during startup. */
interface ReliableClient {
  setMonitoring: (m: unknown) => void;
  setMetaRequestHandler?: (h: unknown) => void;
  setFullStatusRequestHandler?: (h: unknown) => void;
  startMetricsPublishing: () => void;
  startCongestionControl: () => void;
  startHeartbeat: (addr: string, port: number, opts: { heartbeatInterval?: number }) => unknown;
  sendHello: (addr: string, port: number) => Promise<void>;
  handleControlPacket: (msg: Buffer, rinfo: dgram.RemoteInfo) => Promise<void>;
  initBonding: (cfg: unknown) => Promise<void>;
  getBondingManager?: () => {
    onFailover: (h: (from: string, to: string) => void) => void;
    onFailback: (h: (from: string, to: string) => void) => void;
  } | null;
}

/** Initialize connection bonding when configured. */
async function initBonding(ctx: ConnectionContext, v2: ReliableClient): Promise<void> {
  const { state, app, instanceId, options } = ctx;
  if (!options.bonding?.enabled) return;
  const bondCfg = {
    mode: options.bonding.mode || "main-backup",
    primary: options.bonding.primary || { address: options.udpAddress, port: options.udpPort },
    backup: options.bonding.backup || {
      address: options.udpAddress,
      port: options.udpPort + 1
    },
    failover: options.bonding.failover || {},
    instanceId: state.instanceId,
    notificationsEnabled: options.enableNotifications === true,
    secretKey: options.secretKey,
    stretchAsciiKey: !!options.stretchAsciiKey
  };
  try {
    await v2.initBonding(bondCfg);
    app.debug(`[${instanceId}] [Bonding] Connection bonding initialized`);
  } catch (err: unknown) {
    app.error(
      `[${instanceId}] [Bonding] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Re-send HELLO after a bonding link change.
 *
 * A failover/failback swaps the active link socket, so packets start leaving
 * from a different source port. The server keys sessions and replay guards on
 * `address:port`, so without a fresh HELLO the new port looks like an
 * unhandshaked peer: replay enforcement cannot arm for it and the peer stays
 * unidentified, silently dropping client telemetry.
 */
function registerBondingHandshakeHooks(ctx: ConnectionContext, v2: ReliableClient): void {
  const { app, instanceId, options, lifecycle } = ctx;
  const manager = typeof v2.getBondingManager === "function" ? v2.getBondingManager() : null;
  if (!manager) return;

  const reHello = (reason: string, to: string) => {
    if (lifecycle?.isShuttingDown?.()) return;
    v2.sendHello(options.udpAddress ?? "", options.udpPort)
      .then(() => {
        app.debug(`[${instanceId}] [Bonding] re-sent HELLO after ${reason} to ${to}`);
      })
      .catch((err: unknown) => {
        app.error(
          `[${instanceId}] [Bonding] HELLO after ${reason} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  manager.onFailover((_from: string, to: string) => reHello("failover", to));
  manager.onFailback((_from: string, to: string) => reHello("failback", to));
}

/** Construct the reliable (v2/v3) client pipeline. */
function createReliableClient(ctx: ConnectionContext): ReliableClient {
  const { appProxy, state, metricsApi } = ctx;
  const { createPipelineV2Client } = require("../../transport/pipeline/reliable-client");
  return createPipelineV2Client(appProxy, state, metricsApi);
}

/** Build the reliable client pipeline and wire its handlers/heartbeat/HELLO. */
async function setupReliableClient(ctx: ConnectionContext): Promise<void> {
  const { state, app, instanceId, options, services, recordError, lifecycle } = ctx;
  if (lifecycle.isShuttingDown()) return;
  initMonitoring(ctx);

  const v2 = createReliableClient(ctx);
  state.pipeline = v2 as unknown as typeof state.pipeline;
  v2.setMonitoring(state.monitoring);
  if (typeof v2.setMetaRequestHandler === "function") {
    v2.setMetaRequestHandler(services.handleMetaRequest);
  }
  if (typeof v2.setFullStatusRequestHandler === "function") {
    v2.setFullStatusRequestHandler(services.handleFullStatusRequest);
  }
  v2.startMetricsPublishing();
  if (options.congestionControl?.enabled) v2.startCongestionControl();
  state.heartbeatHandle = v2.startHeartbeat(options.udpAddress ?? "", options.udpPort, {
    heartbeatInterval: options.heartbeatInterval
  }) as typeof state.heartbeatHandle;
  state.socketUdp!.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    v2.handleControlPacket(msg, rinfo).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] Control packet error: ${m}`);
      recordError("general", `Control packet error: ${m}`);
    });
  });

  // Bonding must be initialized BEFORE the first HELLO. `udpSendAsync` only
  // routes through a bonding link socket once `mut.bondingManager` is set, so a
  // HELLO sent earlier leaves from the plain socket's ephemeral port while all
  // subsequent DATA leaves from the bonding link's port. The server keys
  // sessions and replay guards on address:port, so the session that actually
  // carries data would never see a handshake: its epoch stays 0 (disabling
  // replay enforcement) and the peer stays unidentified (dropping all client
  // telemetry).
  await initBonding(ctx, v2);
  if (lifecycle.isShuttingDown()) return;

  // Re-HELLO whenever the active link changes: failover moves the source port
  // again, which the server sees as a brand-new, unhandshaked peer.
  registerBondingHandshakeHooks(ctx, v2);

  await v2.sendHello(options.udpAddress ?? "", options.udpPort);
  services.restartSourceSnapshotTimer();
  services.sendSourceSnapshot().catch((err: unknown) => {
    app.debug(
      `[${instanceId}] initial source snapshot failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
  app.debug(`[${instanceId}] [v3] Reliable client pipeline initialized`);
}

/** Warn about v2-only features requested under the legacy v1 protocol. */
function warnLegacyV1(ctx: ConnectionContext): void {
  const { app, instanceId, options } = ctx;
  if (options.congestionControl?.enabled) {
    app.error(`[${instanceId}] [v1] Congestion control requires Protocol v2 – ignoring`);
  }
  if (options.bonding?.enabled) {
    app.error(`[${instanceId}] [v1] Connection bonding requires Protocol v2 – ignoring`);
  }
  app.debug(`[${instanceId}] [v1] Client pipeline initialized`);
}

/** Create the per-instance config-file watchers and flush the subscription. */
async function setupConfigWatchers(ctx: ConnectionContext): Promise<void> {
  const { state, app, instanceId, services, configHandlers } = ctx;
  try {
    const watchers = [
      {
        filePath: state.deltaTimerFile,
        onChange: configHandlers.handleDeltaTimerChange,
        name: "Delta timer"
      },
      {
        filePath: state.subscriptionFile,
        onChange: services.handleSubscriptionChange,
        name: "Subscription"
      },
      {
        filePath: state.sentenceFilterFile,
        onChange: configHandlers.handleSentenceFilterChange,
        name: "Sentence filter"
      }
    ];
    state.configWatcherObjects = watchers.map((cfg) =>
      createWatcherWithRecovery({ ...cfg, instanceId, app, state })
    );
    await services.handleSubscriptionChange.flush();
    app.debug(`[${instanceId}] Configuration file watchers initialized`);
  } catch (err: unknown) {
    app.error(
      `[${instanceId}] Error setting up config watchers: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Start the UDP client: storage, monitors, pipeline, and config watchers. */
export async function startClient(ctx: ConnectionContext): Promise<void> {
  const { state, instanceId, app, options, lifecycle, socketManager, services } = ctx;
  await initializePersistentStorage({ instanceId, app, state });
  if (lifecycle.isShuttingDown()) return;

  await loadDeltaTimer(ctx);
  if (lifecycle.isShuttingDown()) return;

  // Resolve the monotonic anti-replay epoch before the pipeline (and its first
  // HELLO) is built in setupReliableClient below.
  state.connectionEpoch = await resolveMonotonicEpoch(epochFilePath(ctx), app);

  // Every allocation below (keepalive interval, UDP socket, metrics and
  // congestion intervals, heartbeat interval, source-snapshot interval, bonding
  // sockets + health interval) happens after an await. Without this guard a
  // stop() landing in one of those windows still creates them — and because
  // teardown has already run, nothing is left holding a handle to clear them.
  if (lifecycle.isShuttingDown()) return;

  services.keepaliveManager.start();
  state.socketUdp = socketManager.create();
  // NOTE: do NOT mark readyToSend here. The send gate must stay aligned with
  // the lifecycle FSM (Ready), which start() reaches only after the reliable
  // pipeline, heartbeat, HELLO, source snapshot, and config watchers below
  // have all initialized. Setting it now would let processDelta() send deltas
  // before the pipeline is actually ready. start() sets readyToSend together
  // with the Ready transition once startClient() returns. The socket itself is
  // up, so the status bar can already show "Connected".
  ctx.setStatus("Connected", true);
  state.socketUdp.on("error", ctx.handleClientSocketError);
  services.scheduleDeltaTimer();

  if ((options.protocolVersion ?? 0) < 2) {
    startPingMonitor(ctx);
  }

  if ((options.protocolVersion ?? 0) >= 2) {
    await setupReliableClient(ctx);
  } else {
    warnLegacyV1(ctx);
  }

  if (lifecycle.isShuttingDown()) return;
  // Enable sending only now — AFTER the reliable pipeline, heartbeat, HELLO,
  // and initial source snapshot have been set up above. setupConfigWatchers()
  // establishes the subscription and replays the current values snapshot,
  // which legitimately needs the send path enabled; doing it here (rather than
  // at socket-creation time) closes the window where deltas could be sent
  // before the pipeline was actually ready. start() re-affirms this together
  // with the lifecycle Ready transition once startClient() returns.
  state.readyToSend = true;
  await setupConfigWatchers(ctx);
}
