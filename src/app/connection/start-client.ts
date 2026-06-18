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
import { createWatcherWithRecovery, initializePersistentStorage } from "../config/watcher";
import type { ConnectionContext } from "./context";

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

/** Construct the reliable (v2/v3) client pipeline. */
function createReliableClient(ctx: ConnectionContext): ReliableClient {
  const { appProxy, state, metricsApi } = ctx;
  const { createPipelineV2Client } = require("../../transport/pipeline/reliable-client");
  return createPipelineV2Client(appProxy, state, metricsApi);
}

/** Build the reliable client pipeline and wire its handlers/heartbeat/HELLO. */
async function setupReliableClient(ctx: ConnectionContext): Promise<void> {
  const { state, app, instanceId, options, services, recordError } = ctx;
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
  await v2.sendHello(options.udpAddress ?? "", options.udpPort);
  services.restartSourceSnapshotTimer();
  services.sendSourceSnapshot().catch((err: unknown) => {
    app.debug(
      `[${instanceId}] initial source snapshot failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
  state.socketUdp!.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    v2.handleControlPacket(msg, rinfo).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      app.error(`[${instanceId}] Control packet error: ${m}`);
      recordError("general", `Control packet error: ${m}`);
    });
  });

  await initBonding(ctx, v2);
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
