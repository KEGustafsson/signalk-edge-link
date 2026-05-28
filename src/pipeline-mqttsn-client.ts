"use strict";

/**
 * MQTT-SN client pipeline (v4) — publisher role only.
 *
 * Connects to an MQTT-SN gateway, registers Signal K paths as MQTT topic
 * names, and publishes each path/value pair as a PUBLISH message with
 * AES-256-GCM encrypted payload.
 *
 * Incoming control packets (CONNACK, REGACK, PUBACK, PINGRESP, DISCONNECT)
 * arrive via handleControlPacket(), which instance.ts calls for every UDP
 * message received on state.socketUdp.
 */

import * as msgpack from "@msgpack/msgpack";
import { encryptBinary } from "./crypto";
import {
  buildConnect,
  buildDisconnect,
  buildPingReq,
  buildPublish,
  buildRegister,
  parseMessage,
  RC
} from "./mqttsn-protocol";
import { TopicRegistry, skPathToTopic } from "./mqttsn-topic-registry";
import type {
  BondingManagerApi,
  ClientPipelineApi,
  CongestionControlApi,
  Delta,
  InstanceState,
  MetricsApi,
  MetricsPublisherApi,
  MonitoringState,
  SignalKApp
} from "./types";

// ── Internal types ─────────────────────────────────────────────────────────────

type ClientState = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

interface PendingRegistration {
  topicName: string;
  resolve: (topicId: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  msgId: number;
}

interface PendingPubAck {
  frame: Buffer;
  topicId: number;
  timer: ReturnType<typeof setTimeout>;
  attempts: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 5_000;
const REGISTER_TIMEOUT_MS = 5_000;
const REGISTER_MAX_ATTEMPTS = 3;
const PUBACK_TIMEOUT_MS = 5_000;
const PUBACK_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPipelineMqttSnClient(
  app: SignalKApp,
  state: InstanceState,
  _metricsApi: MetricsApi
): ClientPipelineApi {
  const instanceId = state.instanceId;

  // Per-instance message ID counter (1–65534; 0x0000 and 0xFFFF reserved)
  let _msgId = 0;
  function nextMsgId(): number {
    _msgId = _msgId >= 0xfffe ? 1 : _msgId + 1;
    return _msgId;
  }

  let clientState: ClientState = "DISCONNECTED";
  const registry = new TopicRegistry();

  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let pingWatchdog: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  // Serial registration queue — at most one REGISTER in-flight at a time
  const registrationQueue: PendingRegistration[] = [];
  const pendingByName = new Map<string, PendingRegistration>();
  let registerInProgress = false;

  // QoS 1 PUBACK tracking keyed by msgId
  const pendingPubAcks = new Map<number, PendingPubAck>();

  // Cached gateway address/port (set on first sendHello / sendDelta call)
  let gatewayAddress = "";
  let gatewayPort = 0;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function udpSend(frame: Buffer): void {
    if (!state.socketUdp || !gatewayAddress || !gatewayPort) return;
    state.socketUdp.send(frame, gatewayPort, gatewayAddress, (err) => {
      if (err) app.error(`[${instanceId}] [mqttsn] UDP send error: ${err.message}`);
    });
  }

  function clearAllTimers(): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    if (pingWatchdog) {
      clearTimeout(pingWatchdog);
      pingWatchdog = null;
    }
    for (const p of pendingPubAcks.values()) clearTimeout(p.timer);
    pendingPubAcks.clear();
    for (const r of registrationQueue) {
      if (r.timer) clearTimeout(r.timer);
    }
    registrationQueue.length = 0;
    pendingByName.clear();
    registerInProgress = false;
  }

  function scheduleReconnect(): void {
    if (state.stopped) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    app.debug(`[${instanceId}] [mqttsn] Reconnect in ${delay}ms (attempt ${reconnectAttempt})`);
    state.pendingRetry = setTimeout(() => {
      state.pendingRetry = null;
      if (!state.stopped) connect();
    }, delay);
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────────

  function connect(): void {
    if (clientState !== "DISCONNECTED") return;
    if (!gatewayAddress || !gatewayPort) return;

    clientState = "CONNECTING";
    const options = state.options!;
    const clientId = options.mqttsnClientId || `sk-${(options.name || instanceId).slice(0, 20)}`;
    const keepalive = options.mqttsnKeepalive ?? 60;
    const cleanSession = options.mqttsnCleanSession ?? true;

    app.debug(
      `[${instanceId}] [mqttsn] Sending CONNECT clientId="${clientId}" duration=${keepalive}`
    );
    udpSend(buildConnect(clientId, cleanSession, keepalive));

    connectTimer = setTimeout(() => {
      connectTimer = null;
      app.error(`[${instanceId}] [mqttsn] CONNACK timeout — will retry`);
      clientState = "DISCONNECTED";
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
  }

  function onConnack(returnCode: number): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (returnCode !== RC.ACCEPTED) {
      app.error(`[${instanceId}] [mqttsn] CONNACK rejected: code=0x${returnCode.toString(16)}`);
      clientState = "DISCONNECTED";
      scheduleReconnect();
      return;
    }

    clientState = "CONNECTED";
    reconnectAttempt = 0;
    app.debug(`[${instanceId}] [mqttsn] Connected to gateway`);

    // Start PINGREQ keepalive
    const keepaliveSec = state.options?.mqttsnKeepalive ?? 60;
    keepaliveInterval = setInterval(() => {
      if (clientState !== "CONNECTED") return;
      udpSend(buildPingReq());
      // Watchdog: if no PINGRESP within 1.5× keepalive, declare unreachable
      if (pingWatchdog) clearTimeout(pingWatchdog);
      pingWatchdog = setTimeout(() => {
        app.error(`[${instanceId}] [mqttsn] Gateway unreachable (PINGRESP timeout)`);
        handleDisconnect();
      }, keepaliveSec * 1500);
    }, keepaliveSec * 1000);

    // Process any registrations that queued up while connecting
    processNextRegistration();
  }

  function handleDisconnect(): void {
    clearAllTimers();
    registry.clear();
    if (state.pendingRetry) {
      clearTimeout(state.pendingRetry);
      state.pendingRetry = null;
    }
    clientState = "DISCONNECTED";
    if (!state.stopped) scheduleReconnect();
  }

  // ── Topic registration (serial queue) ────────────────────────────────────────

  function enqueueRegistration(topicName: string): Promise<number> {
    // Reuse in-flight registration for the same topic
    const existing = pendingByName.get(topicName);
    if (existing) {
      return new Promise((resolve, reject) => {
        const prev = { resolve: existing.resolve, reject: existing.reject };
        existing.resolve = (id) => {
          prev.resolve(id);
          resolve(id);
        };
        existing.reject = (e) => {
          prev.reject(e);
          reject(e);
        };
      });
    }

    return new Promise<number>((resolve, reject) => {
      const entry: PendingRegistration = {
        topicName,
        resolve,
        reject,
        timer: null,
        attempts: 0,
        msgId: 0
      };
      registrationQueue.push(entry);
      pendingByName.set(topicName, entry);
      if (!registerInProgress) processNextRegistration();
    });
  }

  function processNextRegistration(): void {
    if (registrationQueue.length === 0 || clientState !== "CONNECTED") {
      registerInProgress = false;
      return;
    }
    registerInProgress = true;
    const entry = registrationQueue[0];
    entry.msgId = nextMsgId();
    entry.attempts++;

    app.debug(
      `[${instanceId}] [mqttsn] REGISTER "${entry.topicName}" msgId=${entry.msgId} attempt=${entry.attempts}`
    );
    udpSend(buildRegister(entry.topicName, entry.msgId));

    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.attempts < REGISTER_MAX_ATTEMPTS) {
        processNextRegistration(); // retry with same queue head
      } else {
        const err = new Error(
          `[mqttsn] REGISTER timeout for "${entry.topicName}" after ${entry.attempts} attempts`
        );
        app.error(`[${instanceId}] ${err.message}`);
        registrationQueue.shift();
        pendingByName.delete(entry.topicName);
        entry.reject(err);
        registerInProgress = false;
        processNextRegistration();
      }
    }, REGISTER_TIMEOUT_MS);
  }

  function onRegack(topicId: number, msgId: number, returnCode: number): void {
    const entry = registrationQueue[0];
    if (!entry || entry.msgId !== msgId) return; // stale or unexpected

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    registrationQueue.shift();
    pendingByName.delete(entry.topicName);

    if (returnCode === RC.ACCEPTED) {
      registry.set(entry.topicName, topicId);
      app.debug(`[${instanceId}] [mqttsn] REGACK "${entry.topicName}" → topicId=${topicId}`);
      entry.resolve(topicId);
    } else {
      const err = new Error(
        `[mqttsn] REGACK rejected for "${entry.topicName}": code=0x${returnCode.toString(16)}`
      );
      app.error(`[${instanceId}] ${err.message}`);
      entry.reject(err);
    }

    registerInProgress = false;
    processNextRegistration();
  }

  // ── QoS 1 PUBACK tracking ─────────────────────────────────────────────────────

  function trackPubAck(msgId: number, frame: Buffer, topicId: number): void {
    const pending: PendingPubAck = {
      frame,
      topicId,
      attempts: 1,
      timer: setTimeout(function retry() {
        const p = pendingPubAcks.get(msgId);
        if (!p) return;
        if (p.attempts >= PUBACK_MAX_ATTEMPTS) {
          app.error(`[${instanceId}] [mqttsn] PUBACK timeout msgId=${msgId} (gave up)`);
          pendingPubAcks.delete(msgId);
          return;
        }
        p.attempts++;
        // Rebuild with DUP=true for retransmit
        const options = state.options!;
        const qos = (options.mqttsnQos ?? 0) as 0 | 1;
        const retain = options.mqttsnPublishRetain ?? false;
        const dupFrame = buildPublish(p.topicId, msgId, p.frame, qos, retain, true);
        udpSend(dupFrame);
        p.timer = setTimeout(retry, PUBACK_TIMEOUT_MS);
      }, PUBACK_TIMEOUT_MS)
    };
    pendingPubAcks.set(msgId, pending);
  }

  function onPubAck(msgId: number, returnCode: number): void {
    const p = pendingPubAcks.get(msgId);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPubAcks.delete(msgId);
    if (returnCode !== RC.ACCEPTED) {
      app.error(
        `[${instanceId}] [mqttsn] PUBACK rejected msgId=${msgId}: code=0x${returnCode.toString(16)}`
      );
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  async function sendDelta(
    deltas: Delta | Delta[],
    secretKey: string,
    address: string,
    port: number
  ): Promise<void> {
    // Update cached gateway coordinates
    if (address) gatewayAddress = address;
    if (port) gatewayPort = port;

    if (clientState !== "CONNECTED") {
      app.debug(`[${instanceId}] [mqttsn] Delta dropped — not connected`);
      return;
    }

    const options = state.options!;
    const qos = (options.mqttsnQos ?? 0) as 0 | 1;
    const retain = options.mqttsnPublishRetain ?? false;
    const topicPrefix = options.mqttsnTopicPrefix ?? "sk";
    const useMsgpack = options.useMsgpack ?? false;
    const stretchAsciiKey = options.stretchAsciiKey ?? false;

    const deltaArr = Array.isArray(deltas) ? deltas : [deltas];

    for (const delta of deltaArr) {
      for (const update of delta.updates ?? []) {
        for (const valueEntry of update.values ?? []) {
          const path = valueEntry.path;
          const value = valueEntry.value;

          let topicName: string;
          try {
            topicName = skPathToTopic(path, topicPrefix);
          } catch {
            app.debug(`[${instanceId}] [mqttsn] Skipping path with invalid chars: "${path}"`);
            continue;
          }

          // Ensure topic is registered
          let topicId = registry.getIdForName(topicName);
          if (topicId === undefined) {
            try {
              topicId = await enqueueRegistration(topicName);
            } catch {
              continue; // registration failed; skip this value
            }
          }

          // Serialize value
          let serialized: Buffer;
          if (useMsgpack) {
            serialized = Buffer.from(msgpack.encode(value));
          } else {
            serialized = Buffer.from(JSON.stringify(value), "utf8");
          }

          // Encrypt (AES-256-GCM, same key model as v1/v2/v3)
          let encrypted: Buffer;
          try {
            encrypted = encryptBinary(serialized, secretKey, { stretchAsciiKey });
          } catch (err) {
            app.error(
              `[${instanceId}] [mqttsn] Encryption error for "${path}": ${err instanceof Error ? err.message : String(err)}`
            );
            continue;
          }

          // For QoS 0, msgId must be 0x0000 per spec
          const msgId = qos === 1 ? nextMsgId() : 0x0000;
          const publishFrame = buildPublish(topicId, msgId, encrypted, qos, retain);
          udpSend(publishFrame);

          if (qos === 1) {
            // Store the raw encrypted payload so the retry closure can rebuild the frame
            trackPubAck(msgId, encrypted, topicId);
          }
        }
      }
    }
  }

  async function handleControlPacket(
    msg: Buffer,
    _rinfo: import("dgram").RemoteInfo
  ): Promise<void> {
    const parsed = parseMessage(msg);
    switch (parsed.type) {
      case "CONNACK":
        onConnack(parsed.returnCode);
        break;
      case "REGACK":
        onRegack(parsed.topicId, parsed.msgId, parsed.returnCode);
        break;
      case "PUBACK":
        onPubAck(parsed.msgId, parsed.returnCode);
        break;
      case "PINGRESP":
        // Reset watchdog; the next keepalive interval will set a new one
        if (pingWatchdog) {
          clearTimeout(pingWatchdog);
          pingWatchdog = null;
        }
        break;
      case "DISCONNECT":
        app.debug(`[${instanceId}] [mqttsn] DISCONNECT received from gateway`);
        handleDisconnect();
        break;
      default:
        // Ignore ADVERTISE, GWINFO, and anything else
        break;
    }
  }

  async function sendHello(address: string, port: number): Promise<void> {
    if (address) gatewayAddress = address;
    if (port) gatewayPort = port;
    if (clientState === "DISCONNECTED") connect();
  }

  function startHeartbeat(
    address: string,
    port: number,
    _opts?: { heartbeatInterval?: number }
  ): { stop(): void } {
    if (address) gatewayAddress = address;
    if (port) gatewayPort = port;
    // PINGREQ keepalive is started automatically after CONNACK.
    // This handle just exposes a stop() so instance.ts can tear it down.
    return {
      stop() {
        if (keepaliveInterval) {
          clearInterval(keepaliveInterval);
          keepaliveInterval = null;
        }
        if (pingWatchdog) {
          clearTimeout(pingWatchdog);
          pingWatchdog = null;
        }
      }
    };
  }

  // ── Stubs for unused ClientPipelineApi methods ─────────────────────────────────

  function stubCongestionControl(): CongestionControlApi {
    return {
      getState: () => ({
        enabled: false,
        manualMode: false,
        currentDeltaTimer: 0,
        nominalDeltaTimer: 0,
        avgRTT: 0,
        avgLoss: 0,
        targetRTT: 0,
        minDeltaTimer: 0,
        maxDeltaTimer: 0,
        adjustInterval: 0,
        maxAdjustment: 0
      }),
      enableAutoMode: () => {},
      getCurrentDeltaTimer: () => state.deltaTimerTime ?? 1000,
      setManualDeltaTimer: () => {}
    };
  }

  function stubMetricsPublisher(): MetricsPublisherApi {
    return {
      calculateLinkQuality: () => 0,
      publish: () => {},
      publishLinkMetrics: () => {}
    };
  }

  async function stubInitBonding(_config: Record<string, unknown>): Promise<BondingManagerApi> {
    return {
      getState: () => ({
        enabled: false,
        mode: "",
        activeLink: "",
        lastFailoverTime: 0,
        failoverThresholds: {},
        links: {}
      }),
      forceFailover: () => {},
      getActiveLinkName: () => "",
      getLinkHealth: () => ({}),
      failoverThresholds: {}
    };
  }

  // Full cleanup: send DISCONNECT, clear all timers, reset state.
  // Called via stopCongestionControl() by instance.ts during teardown.
  function fullStop(): void {
    clearAllTimers();
    if (state.pendingRetry) {
      clearTimeout(state.pendingRetry);
      state.pendingRetry = null;
    }
    if (clientState !== "DISCONNECTED" && state.socketUdp && gatewayAddress && gatewayPort) {
      try {
        udpSend(buildDisconnect());
      } catch {
        /* ignore — socket may already be closed */
      }
    }
    clientState = "DISCONNECTED";
    registry.clear();
  }

  return {
    sendDelta,
    handleControlPacket,
    sendHello,
    startHeartbeat,

    startMetricsPublishing: () => {},
    stopMetricsPublishing: () => {},
    startCongestionControl: () => {},
    stopCongestionControl: fullStop,
    initBonding: stubInitBonding,
    stopBonding: () => {},
    getBondingManager: () => null,
    getCongestionControl: stubCongestionControl,
    getMetricsPublisher: stubMetricsPublisher,
    getPacketBuilder: () => null,
    getRetransmitQueue: () => null,
    setMonitoring: (_hooks: MonitoringState | null) => {},
    setMetaRequestHandler: (_handler: (() => void) | null) => {},
    setFullStatusRequestHandler: (_handler: (() => void) | null) => {}
  };
}
