"use strict";

/**
 * MQTT-SN transparent gateway (v4, server role).
 *
 * Accepts UDP connections from MQTT-SN devices, handles the CONNECT /
 * REGISTER / PUBLISH / PINGREQ / DISCONNECT handshake, decrypts payloads
 * with the shared AES-256-GCM key, and injects values into Signal K via
 * app.handleMessage().
 *
 * Device sessions are keyed by "remoteAddress:remotePort". Each device
 * gets its own TopicRegistry; topic IDs are per-session.
 */

import * as msgpack from "@msgpack/msgpack";
import { decryptBinary } from "./crypto";
import {
  buildConnack,
  buildGwInfo,
  buildPubAck,
  buildPingResp,
  buildRegack,
  parseMessage,
  RC
} from "./mqttsn-protocol";
import { TopicRegistry, topicToSkPath } from "./mqttsn-topic-registry";
import type { Delta, InstanceState, MetricsApi, SignalKApp } from "./types";

// ── Session state ──────────────────────────────────────────────────────────────

interface DeviceSession {
  clientId: string;
  remoteAddress: string;
  remotePort: number;
  keepaliveSec: number;
  topicRegistry: TopicRegistry;
  lastSeenMs: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
}

// ── Gateway API ───────────────────────────────────────────────────────────────

export interface MqttSnGatewayApi {
  /** Called by pipeline-mqttsn-server.ts to start accepting connections. */
  start(): void;
  /** Called on cleanup — stops the watchdog timers and clears sessions. */
  stop(): void;
  /** Dispatch a raw UDP datagram from a known remote endpoint. */
  handleMessage(msg: Buffer, rinfo: { address: string; port: number }): void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMqttSnGateway(
  app: SignalKApp,
  state: InstanceState,
  _metricsApi: MetricsApi
): MqttSnGatewayApi {
  const instanceId = state.instanceId;
  const sessions = new Map<string, DeviceSession>();
  let running = false;

  // ── Helper: send a buffer back to a remote endpoint ─────────────────────────

  function udpSend(frame: Buffer, remotePort: number, remoteAddress: string): void {
    if (!state.socketUdp) return;
    state.socketUdp.send(frame, remotePort, remoteAddress, (err) => {
      if (err) {
        app.error(`[${instanceId}] [mqttsn-gw] UDP send error: ${err.message}`);
      }
    });
  }

  // ── Helper: reset per-device keepalive watchdog ──────────────────────────────

  function resetWatchdog(session: DeviceSession): void {
    if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
    const timeoutMs = session.keepaliveSec * 1500; // 1.5× keepalive as tolerance
    session.watchdogTimer = setTimeout(() => {
      const key = `${session.remoteAddress}:${session.remotePort}`;
      app.debug(
        `[${instanceId}] [mqttsn-gw] Keepalive expired for "${session.clientId}" — removing session`
      );
      sessions.delete(key);
    }, timeoutMs);
  }

  // ── Message handler ───────────────────────────────────────────────────────────

  function handleMessage(msg: Buffer, rinfo: { address: string; port: number }): void {
    if (!running) return;

    const parsed = parseMessage(msg);
    const key = `${rinfo.address}:${rinfo.port}`;

    switch (parsed.type) {
      case "CONNECT": {
        // Clean up any existing session for this endpoint
        const existing = sessions.get(key);
        if (existing?.watchdogTimer) clearTimeout(existing.watchdogTimer);

        const session: DeviceSession = {
          clientId: parsed.clientId,
          remoteAddress: rinfo.address,
          remotePort: rinfo.port,
          keepaliveSec: parsed.duration > 0 ? parsed.duration : 60,
          topicRegistry: new TopicRegistry(),
          lastSeenMs: Date.now(),
          watchdogTimer: null
        };
        sessions.set(key, session);
        resetWatchdog(session);

        udpSend(buildConnack(RC.ACCEPTED), rinfo.port, rinfo.address);
        app.debug(
          `[${instanceId}] [mqttsn-gw] CONNECT from "${parsed.clientId}" ` +
            `@ ${rinfo.address}:${rinfo.port} duration=${parsed.duration}s`
        );
        break;
      }

      case "REGISTER": {
        const session = sessions.get(key);
        if (!session) {
          app.debug(`[${instanceId}] [mqttsn-gw] REGISTER from unknown session ${key} — ignoring`);
          return;
        }
        session.lastSeenMs = Date.now();
        resetWatchdog(session);

        const topicId = session.topicRegistry.assign(parsed.topicName);
        udpSend(buildRegack(topicId, parsed.msgId, RC.ACCEPTED), rinfo.port, rinfo.address);
        app.debug(
          `[${instanceId}] [mqttsn-gw] REGISTER "${parsed.topicName}" ` +
            `→ topicId=${topicId} for "${session.clientId}"`
        );
        break;
      }

      case "PUBLISH": {
        const session = sessions.get(key);
        if (!session) {
          app.debug(`[${instanceId}] [mqttsn-gw] PUBLISH from unknown session ${key} — ignoring`);
          return;
        }
        session.lastSeenMs = Date.now();
        resetWatchdog(session);

        // Resolve topic ID → topic name → Signal K path
        const topicName = session.topicRegistry.getNameForId(parsed.topicId);
        if (!topicName) {
          app.error(
            `[${instanceId}] [mqttsn-gw] Unknown topicId=${parsed.topicId} ` +
              `from "${session.clientId}"`
          );
          if (parsed.qos === 1) {
            udpSend(
              buildPubAck(parsed.topicId, parsed.msgId, RC.REJECTED_INVALID_TOPIC),
              rinfo.port,
              rinfo.address
            );
          }
          return;
        }

        const options = state.options!;
        const topicPrefix = options.mqttsnTopicPrefix ?? "sk";
        const skPath = topicToSkPath(topicName, topicPrefix);
        if (!skPath) {
          app.error(
            `[${instanceId}] [mqttsn-gw] Topic "${topicName}" does not match prefix "${topicPrefix}"`
          );
          return;
        }

        // Decrypt payload (AES-256-GCM, same key model as v1/v2/v3)
        let decrypted: Buffer;
        try {
          decrypted = decryptBinary(parsed.payload, options.secretKey, {
            stretchAsciiKey: options.stretchAsciiKey ?? false
          });
        } catch (err) {
          app.error(
            `[${instanceId}] [mqttsn-gw] Decrypt failed for "${session.clientId}" ` +
              `topicId=${parsed.topicId}: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        // Deserialize
        let value: unknown;
        try {
          if (options.useMsgpack) {
            value = msgpack.decode(decrypted);
          } else {
            value = JSON.parse(decrypted.toString("utf8"));
          }
        } catch (err) {
          app.error(
            `[${instanceId}] [mqttsn-gw] Deserialize failed for "${session.clientId}" ` +
              `path="${skPath}": ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        // Inject into Signal K
        const delta: Delta = {
          context: "vessels.self",
          updates: [
            {
              source: { label: `mqttsn-${session.clientId}`, type: "MQTT-SN" },
              timestamp: new Date().toISOString(),
              values: [{ path: skPath, value }]
            }
          ]
        };
        app.handleMessage("", delta);

        // QoS 1 acknowledgment
        if (parsed.qos === 1) {
          udpSend(
            buildPubAck(parsed.topicId, parsed.msgId, RC.ACCEPTED),
            rinfo.port,
            rinfo.address
          );
        }
        break;
      }

      case "PINGREQ": {
        const session = sessions.get(key);
        if (session) {
          session.lastSeenMs = Date.now();
          resetWatchdog(session);
        }
        udpSend(buildPingResp(), rinfo.port, rinfo.address);
        break;
      }

      case "DISCONNECT": {
        const session = sessions.get(key);
        if (session) {
          if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
          sessions.delete(key);
          app.debug(`[${instanceId}] [mqttsn-gw] DISCONNECT from "${session.clientId}"`);
        }
        break;
      }

      case "SEARCHGW": {
        const gatewayId = state.options?.mqttsnGatewayId ?? 1;
        udpSend(buildGwInfo(gatewayId), rinfo.port, rinfo.address);
        break;
      }

      case "UNKNOWN":
        // Silently ignore unrecognised or malformed frames
        break;

      default:
        break;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function start(): void {
    if (running) return;
    running = true;
    app.debug(`[${instanceId}] [mqttsn-gw] Gateway started`);
  }

  function stop(): void {
    running = false;
    for (const session of sessions.values()) {
      if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
    }
    sessions.clear();
    app.debug(`[${instanceId}] [mqttsn-gw] Gateway stopped`);
  }

  return { start, stop, handleMessage };
}
