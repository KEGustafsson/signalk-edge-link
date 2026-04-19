"use strict";

import { validateSecretKey } from "./crypto";
import type {
  ConnectionConfig,
  BondingConfig,
  CongestionControlConfig,
  ReliabilityConfig,
  AlertThresholds
} from "./types";

export const VALID_CONNECTION_KEYS: string[] = [
  "name",
  "serverType",
  "udpPort",
  "secretKey",
  "stretchAsciiKey",
  "useMsgpack",
  "usePathDictionary",
  "enableNotifications",
  "protocolVersion",
  "udpAddress",
  "helloMessageSender",
  "heartbeatInterval",
  "testAddress",
  "testPort",
  "pingIntervalTime",
  "reliability",
  "congestionControl",
  "bonding",
  "alertThresholds"
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPort(value: unknown, min = 1): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= 65535;
}

function numberRangeError(
  object: Record<string, unknown> | undefined,
  key: string,
  min: number,
  max: number,
  label: string
): string | null {
  if (object && object[key] !== undefined) {
    if (
      !isFiniteNumber(object[key]) ||
      (object[key] as number) < min ||
      (object[key] as number) > max
    ) {
      return `${label} must be a number between ${min} and ${max}`;
    }
  }
  return null;
}

export function normalizeServerType(serverType: unknown): string | undefined {
  if (serverType === true) {
    return "server";
  }
  if (serverType === false) {
    return "client";
  }
  return serverType as string | undefined;
}

export function validateConnectionConfig(connection: unknown, prefix = ""): string | null {
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    return `${prefix || "connection"} must be an object`;
  }

  const conn = connection as Record<string, unknown>;
  const p = prefix;
  const serverType = normalizeServerType(conn.serverType);

  if (serverType !== "server" && serverType !== "client") {
    return `${p}serverType must be 'server' or 'client'`;
  }

  if (serverType === "server") {
    if (conn.congestionControl !== undefined) {
      return `${p}congestionControl is not supported in server mode`;
    }
    if (conn.bonding !== undefined) {
      return `${p}bonding is not supported in server mode`;
    }
    if (conn.alertThresholds !== undefined) {
      return `${p}alertThresholds is not supported in server mode`;
    }
  }

  if (!isValidPort(conn.udpPort, 1024)) {
    return `${p}udpPort must be an integer between 1024 and 65535`;
  }

  try {
    validateSecretKey(conn.secretKey as string);
  } catch (error: unknown) {
    return `${p}${error instanceof Error ? error.message : String(error)}`;
  }

  if (
    conn.protocolVersion !== undefined &&
    conn.protocolVersion !== 1 &&
    conn.protocolVersion !== 2 &&
    conn.protocolVersion !== 3
  ) {
    return `${p}protocolVersion must be 1, 2, or 3`;
  }
  if (conn.useMsgpack !== undefined && typeof conn.useMsgpack !== "boolean") {
    return `${p}useMsgpack must be a boolean`;
  }
  if (conn.usePathDictionary !== undefined && typeof conn.usePathDictionary !== "boolean") {
    return `${p}usePathDictionary must be a boolean`;
  }
  if (conn.stretchAsciiKey !== undefined && typeof conn.stretchAsciiKey !== "boolean") {
    return `${p}stretchAsciiKey must be a boolean`;
  }
  if (conn.enableNotifications !== undefined && typeof conn.enableNotifications !== "boolean") {
    return `${p}enableNotifications must be a boolean`;
  }
  if (
    conn.name !== undefined &&
    (typeof conn.name !== "string" || (conn.name as string).length > 40)
  ) {
    return `${p}name must be a string of at most 40 characters`;
  }

  if (serverType === "client") {
    if (!conn.udpAddress || typeof conn.udpAddress !== "string") {
      return `${p}udpAddress is required in client mode`;
    }
    if (!conn.testAddress || typeof conn.testAddress !== "string") {
      return `${p}testAddress is required in client mode`;
    }
    if (!isValidPort(conn.testPort, 1)) {
      return `${p}testPort must be between 1 and 65535 in client mode`;
    }
  }

  if (conn.alertThresholds !== undefined) {
    if (
      !conn.alertThresholds ||
      typeof conn.alertThresholds !== "object" ||
      Array.isArray(conn.alertThresholds)
    ) {
      return `${p}alertThresholds must be an object`;
    }
    const validMetrics = ["rtt", "packetLoss", "retransmitRate", "jitter", "queueDepth"];
    for (const [metric, threshold] of Object.entries(
      conn.alertThresholds as Record<string, unknown>
    )) {
      if (!validMetrics.includes(metric)) {
        return `${p}alertThresholds: unknown metric '${metric}'`;
      }
      if (!threshold || typeof threshold !== "object" || Array.isArray(threshold)) {
        return `${p}alertThresholds.${metric} must be an object`;
      }
      const t = threshold as Record<string, unknown>;
      if (t.warning !== undefined && !isFiniteNumber(t.warning)) {
        return `${p}alertThresholds.${metric}.warning must be a finite number`;
      }
      if (t.critical !== undefined && !isFiniteNumber(t.critical)) {
        return `${p}alertThresholds.${metric}.critical must be a finite number`;
      }
      // Domain-specific range checks
      const ratioMetrics = ["packetLoss", "retransmitRate"];
      if (ratioMetrics.includes(metric)) {
        if (t.warning !== undefined && ((t.warning as number) < 0 || (t.warning as number) > 1)) {
          return `${p}alertThresholds.${metric}.warning must be between 0 and 1`;
        }
        if (
          t.critical !== undefined &&
          ((t.critical as number) < 0 || (t.critical as number) > 1)
        ) {
          return `${p}alertThresholds.${metric}.critical must be between 0 and 1`;
        }
      } else {
        // rtt, jitter, queueDepth must be positive
        if (t.warning !== undefined && (t.warning as number) <= 0) {
          return `${p}alertThresholds.${metric}.warning must be > 0`;
        }
        if (t.critical !== undefined && (t.critical as number) <= 0) {
          return `${p}alertThresholds.${metric}.critical must be > 0`;
        }
      }
      if (
        t.warning !== undefined &&
        t.critical !== undefined &&
        (t.warning as number) > (t.critical as number)
      ) {
        return `${p}alertThresholds.${metric}.warning must be <= critical`;
      }
    }
  }

  if (conn.reliability !== undefined) {
    if (
      !conn.reliability ||
      typeof conn.reliability !== "object" ||
      Array.isArray(conn.reliability)
    ) {
      return `${p}reliability must be an object`;
    }
    const reliability = conn.reliability as Record<string, unknown>;
    const reliabilityChecks =
      serverType === "server"
        ? ([
            ["ackInterval", 20, 5000, `${p}reliability.ackInterval`],
            ["ackResendInterval", 100, 10000, `${p}reliability.ackResendInterval`],
            ["nakTimeout", 20, 5000, `${p}reliability.nakTimeout`]
          ] as [string, number, number, string][])
        : ([
            ["retransmitQueueSize", 100, 50000, `${p}reliability.retransmitQueueSize`],
            ["maxRetransmits", 1, 20, `${p}reliability.maxRetransmits`],
            ["retransmitMaxAge", 1000, 300000, `${p}reliability.retransmitMaxAge`],
            ["retransmitMinAge", 200, 30000, `${p}reliability.retransmitMinAge`],
            ["retransmitRttMultiplier", 2, 20, `${p}reliability.retransmitRttMultiplier`],
            ["ackIdleDrainAge", 500, 30000, `${p}reliability.ackIdleDrainAge`],
            ["forceDrainAfterMs", 2000, 120000, `${p}reliability.forceDrainAfterMs`],
            ["recoveryBurstSize", 10, 1000, `${p}reliability.recoveryBurstSize`],
            ["recoveryBurstIntervalMs", 50, 5000, `${p}reliability.recoveryBurstIntervalMs`],
            ["recoveryAckGapMs", 500, 120000, `${p}reliability.recoveryAckGapMs`]
          ] as [string, number, number, string][]);
    for (const [key, min, max, label] of reliabilityChecks) {
      const error = numberRangeError(reliability, key, min, max, label);
      if (error) {
        return error;
      }
    }
    if (
      reliability.forceDrainAfterAckIdle !== undefined &&
      typeof reliability.forceDrainAfterAckIdle !== "boolean"
    ) {
      return `${p}reliability.forceDrainAfterAckIdle must be a boolean`;
    }
    if (
      reliability.recoveryBurstEnabled !== undefined &&
      typeof reliability.recoveryBurstEnabled !== "boolean"
    ) {
      return `${p}reliability.recoveryBurstEnabled must be a boolean`;
    }
    if (
      reliability.retransmitMinAge !== undefined &&
      reliability.retransmitMaxAge !== undefined &&
      (reliability.retransmitMinAge as number) > (reliability.retransmitMaxAge as number)
    ) {
      return `${p}reliability.retransmitMinAge must be <= retransmitMaxAge`;
    }
  }

  if (conn.bonding !== undefined) {
    if (!conn.bonding || typeof conn.bonding !== "object" || Array.isArray(conn.bonding)) {
      return `${p}bonding must be an object`;
    }
    const bonding = conn.bonding as Record<string, unknown>;
    if (bonding.enabled !== undefined && typeof bonding.enabled !== "boolean") {
      return `${p}bonding.enabled must be a boolean`;
    }
    if (bonding.mode !== undefined && bonding.mode !== "main-backup") {
      return `${p}bonding.mode must be 'main-backup'`;
    }
    for (const linkKey of ["primary", "backup"]) {
      if (bonding[linkKey] !== undefined) {
        const link = bonding[linkKey] as Record<string, unknown>;
        if (!link || typeof link !== "object" || Array.isArray(link)) {
          return `${p}bonding.${linkKey} must be an object`;
        }
        if (link.address !== undefined && typeof link.address !== "string") {
          return `${p}bonding.${linkKey}.address must be a string`;
        }
        if (link.port !== undefined && !isValidPort(link.port, 1024)) {
          return `${p}bonding.${linkKey}.port must be between 1024 and 65535`;
        }
        if (link.interface !== undefined && typeof link.interface !== "string") {
          return `${p}bonding.${linkKey}.interface must be a string`;
        }
      }
    }
    // Validate that primary and backup links are different
    const primaryLink = bonding.primary as Record<string, unknown> | undefined;
    const backupLink = bonding.backup as Record<string, unknown> | undefined;
    if (primaryLink && backupLink) {
      const sameAddress =
        primaryLink.address !== undefined &&
        backupLink.address !== undefined &&
        primaryLink.address === backupLink.address;
      const samePort =
        primaryLink.port !== undefined &&
        backupLink.port !== undefined &&
        primaryLink.port === backupLink.port;
      if (sameAddress && samePort) {
        return `${p}bonding primary and backup links must use different address:port combinations`;
      }
    }
    if (bonding.failover !== undefined) {
      if (
        !bonding.failover ||
        typeof bonding.failover !== "object" ||
        Array.isArray(bonding.failover)
      ) {
        return `${p}bonding.failover must be an object`;
      }
      const failoverChecks: [string, number, number, string][] = [
        ["rttThreshold", 100, 5000, `${p}bonding.failover.rttThreshold`],
        ["lossThreshold", 0.01, 0.5, `${p}bonding.failover.lossThreshold`],
        ["healthCheckInterval", 500, 10000, `${p}bonding.failover.healthCheckInterval`],
        ["failbackDelay", 5000, 300000, `${p}bonding.failover.failbackDelay`],
        ["heartbeatTimeout", 1000, 30000, `${p}bonding.failover.heartbeatTimeout`]
      ];
      for (const [key, min, max, label] of failoverChecks) {
        const error = numberRangeError(
          bonding.failover as Record<string, unknown>,
          key,
          min,
          max,
          label
        );
        if (error) {
          return error;
        }
      }
    }
  }

  if (conn.congestionControl !== undefined) {
    if (
      !conn.congestionControl ||
      typeof conn.congestionControl !== "object" ||
      Array.isArray(conn.congestionControl)
    ) {
      return `${p}congestionControl must be an object`;
    }
    const congestionControl = conn.congestionControl as Record<string, unknown>;
    const congestionChecks: [string, number, number, string][] = [
      ["targetRTT", 50, 2000, `${p}congestionControl.targetRTT`],
      ["nominalDeltaTimer", 100, 10000, `${p}congestionControl.nominalDeltaTimer`],
      ["minDeltaTimer", 50, 1000, `${p}congestionControl.minDeltaTimer`],
      ["maxDeltaTimer", 1000, 30000, `${p}congestionControl.maxDeltaTimer`]
    ];
    for (const [key, min, max, label] of congestionChecks) {
      const error = numberRangeError(congestionControl, key, min, max, label);
      if (error) {
        return error;
      }
    }
    if (congestionControl.enabled !== undefined && typeof congestionControl.enabled !== "boolean") {
      return `${p}congestionControl.enabled must be a boolean`;
    }
    if (
      congestionControl.minDeltaTimer !== undefined &&
      congestionControl.maxDeltaTimer !== undefined &&
      (congestionControl.minDeltaTimer as number) > (congestionControl.maxDeltaTimer as number)
    ) {
      return `${p}congestionControl.minDeltaTimer must be <= maxDeltaTimer`;
    }
  }

  return null;
}

export function sanitizeConnectionConfig(connection: unknown): Partial<ConnectionConfig> {
  if (!connection || typeof connection !== "object") {
    return {};
  }

  const conn = connection as Record<string, unknown>;
  const serverType = normalizeServerType(conn.serverType);
  const out: Record<string, unknown> = {};
  for (const key of VALID_CONNECTION_KEYS) {
    if (conn[key] !== undefined) {
      out[key] = conn[key];
    }
  }

  if (serverType !== undefined) {
    out.serverType = serverType;
  }

  if (serverType === "server") {
    delete out.udpAddress;
    delete out.helloMessageSender;
    delete out.testAddress;
    delete out.testPort;
    delete out.pingIntervalTime;
    delete out.congestionControl;
    delete out.bonding;
    delete out.alertThresholds;
  }

  return out as Partial<ConnectionConfig>;
}

export function slugifyConnectionName(name: unknown): string {
  if (!name || typeof name !== "string") {
    return "connection";
  }

  return (
    (name as string)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

export function deriveConnectionIds(connections: Array<Partial<ConnectionConfig>>): string[] {
  const used = new Set<string>();
  return connections.map((config) => {
    const base = slugifyConnectionName(config && config.name ? config.name : "connection");
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    let suffix = 1;
    while (used.has(`${base}-${suffix}`)) {
      suffix++;
    }

    const id = `${base}-${suffix}`;
    used.add(id);
    return id;
  });
}

export function findConnectionIndexByInstanceId(
  connections: Array<Partial<ConnectionConfig>>,
  instanceId: string
): number {
  const ids = deriveConnectionIds(connections);
  return ids.findIndex((id) => id === instanceId);
}

export function validateUniqueServerPorts(
  connections: Array<Partial<ConnectionConfig>>
): string | null {
  const serverPorts = connections
    .filter((connection) => connection && normalizeServerType(connection.serverType) === "server")
    .map((connection) => Number(connection.udpPort))
    .filter((port) => Number.isInteger(port));

  const duplicates = serverPorts.filter((port, index) => serverPorts.indexOf(port) !== index);
  if (duplicates.length > 0) {
    return `Duplicate server ports are not allowed: ${[...new Set(duplicates)].join(", ")}`;
  }
  return null;
}
