// @ts-nocheck
const { validateSecretKey } = require("./crypto.ts");

const VALID_CONNECTION_KEYS = [
  "name",
  "serverType",
  "udpPort",
  "secretKey",
  "useMsgpack",
  "usePathDictionary",
  "enableNotifications",
  "protocolVersion",
  "udpAddress",
  "helloMessageSender",
  "testAddress",
  "testPort",
  "pingIntervalTime",
  "reliability",
  "congestionControl",
  "bonding",
  "alertThresholds"
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPort(value, min = 1) {
  return Number.isInteger(value) && value >= min && value <= 65535;
}

function numberRangeError(object, key, min, max, label) {
  if (object && object[key] !== undefined) {
    if (!isFiniteNumber(object[key]) || object[key] < min || object[key] > max) {
      return `${label} must be a number between ${min} and ${max}`;
    }
  }
  return null;
}

function normalizeServerType(serverType) {
  if (serverType === true) {
    return "server";
  }
  if (serverType === false) {
    return "client";
  }
  return serverType;
}

function validateConnectionConfig(connection, prefix = "") {
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    return `${prefix || "connection"} must be an object`;
  }

  const p = prefix;
  const serverType = normalizeServerType(connection.serverType);

  if (serverType !== "server" && serverType !== "client") {
    return `${p}serverType must be 'server' or 'client'`;
  }

  if (serverType === "server") {
    if (connection.congestionControl !== undefined) {
      return `${p}congestionControl is not supported in server mode`;
    }
    if (connection.bonding !== undefined) {
      return `${p}bonding is not supported in server mode`;
    }
    if (connection.alertThresholds !== undefined) {
      return `${p}alertThresholds is not supported in server mode`;
    }
  }

  if (!isValidPort(connection.udpPort, 1024)) {
    return `${p}udpPort must be an integer between 1024 and 65535`;
  }

  try {
    validateSecretKey(connection.secretKey);
  } catch (error) {
    return `${p}${error.message}`;
  }

  if (
    connection.protocolVersion !== undefined &&
    connection.protocolVersion !== 1 &&
    connection.protocolVersion !== 2 &&
    connection.protocolVersion !== 3
  ) {
    return `${p}protocolVersion must be 1, 2, or 3`;
  }
  if (connection.useMsgpack !== undefined && typeof connection.useMsgpack !== "boolean") {
    return `${p}useMsgpack must be a boolean`;
  }
  if (
    connection.usePathDictionary !== undefined &&
    typeof connection.usePathDictionary !== "boolean"
  ) {
    return `${p}usePathDictionary must be a boolean`;
  }
  if (
    connection.enableNotifications !== undefined &&
    typeof connection.enableNotifications !== "boolean"
  ) {
    return `${p}enableNotifications must be a boolean`;
  }
  if (
    connection.name !== undefined &&
    (typeof connection.name !== "string" || connection.name.length > 40)
  ) {
    return `${p}name must be a string of at most 40 characters`;
  }

  if (serverType === "client") {
    if (!connection.udpAddress || typeof connection.udpAddress !== "string") {
      return `${p}udpAddress is required in client mode`;
    }
    if (!connection.testAddress || typeof connection.testAddress !== "string") {
      return `${p}testAddress is required in client mode`;
    }
    if (!isValidPort(connection.testPort, 1)) {
      return `${p}testPort must be between 1 and 65535 in client mode`;
    }
    const helloError = numberRangeError(
      connection,
      "helloMessageSender",
      10,
      3600,
      `${p}helloMessageSender`
    );
    if (helloError) {
      return helloError;
    }
    const pingError = numberRangeError(
      connection,
      "pingIntervalTime",
      0.1,
      60,
      `${p}pingIntervalTime`
    );
    if (pingError) {
      return pingError;
    }
  }

  if (connection.alertThresholds !== undefined) {
    if (
      !connection.alertThresholds ||
      typeof connection.alertThresholds !== "object" ||
      Array.isArray(connection.alertThresholds)
    ) {
      return `${p}alertThresholds must be an object`;
    }
    const validMetrics = ["rtt", "packetLoss", "retransmitRate", "jitter", "queueDepth"];
    for (const [metric, threshold] of Object.entries(connection.alertThresholds)) {
      if (!validMetrics.includes(metric)) {
        return `${p}alertThresholds: unknown metric '${metric}'`;
      }
      if (!threshold || typeof threshold !== "object" || Array.isArray(threshold)) {
        return `${p}alertThresholds.${metric} must be an object`;
      }
      if (threshold.warning !== undefined && !isFiniteNumber(threshold.warning)) {
        return `${p}alertThresholds.${metric}.warning must be a finite number`;
      }
      if (threshold.critical !== undefined && !isFiniteNumber(threshold.critical)) {
        return `${p}alertThresholds.${metric}.critical must be a finite number`;
      }
      if (
        threshold.warning !== undefined &&
        threshold.critical !== undefined &&
        threshold.warning > threshold.critical
      ) {
        return `${p}alertThresholds.${metric}.warning must be <= critical`;
      }
    }
  }

  if (connection.reliability !== undefined) {
    if (
      !connection.reliability ||
      typeof connection.reliability !== "object" ||
      Array.isArray(connection.reliability)
    ) {
      return `${p}reliability must be an object`;
    }
    const reliability = connection.reliability;
    const reliabilityChecks =
      serverType === "server"
        ? [
          ["ackInterval", 20, 5000, `${p}reliability.ackInterval`],
          ["ackResendInterval", 100, 10000, `${p}reliability.ackResendInterval`],
          ["nakTimeout", 20, 5000, `${p}reliability.nakTimeout`]
        ]
        : [
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
        ];
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
      reliability.retransmitMinAge > reliability.retransmitMaxAge
    ) {
      return `${p}reliability.retransmitMinAge must be <= retransmitMaxAge`;
    }
  }

  if (connection.bonding !== undefined) {
    if (
      !connection.bonding ||
      typeof connection.bonding !== "object" ||
      Array.isArray(connection.bonding)
    ) {
      return `${p}bonding must be an object`;
    }
    const bonding = connection.bonding;
    if (bonding.enabled !== undefined && typeof bonding.enabled !== "boolean") {
      return `${p}bonding.enabled must be a boolean`;
    }
    if (bonding.mode !== undefined && bonding.mode !== "main-backup") {
      return `${p}bonding.mode must be 'main-backup'`;
    }
    for (const linkKey of ["primary", "backup"]) {
      if (bonding[linkKey] !== undefined) {
        const link = bonding[linkKey];
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
    if (bonding.failover !== undefined) {
      if (
        !bonding.failover ||
        typeof bonding.failover !== "object" ||
        Array.isArray(bonding.failover)
      ) {
        return `${p}bonding.failover must be an object`;
      }
      const failoverChecks = [
        ["rttThreshold", 100, 5000, `${p}bonding.failover.rttThreshold`],
        ["lossThreshold", 0.01, 0.5, `${p}bonding.failover.lossThreshold`],
        ["healthCheckInterval", 500, 10000, `${p}bonding.failover.healthCheckInterval`],
        ["failbackDelay", 5000, 300000, `${p}bonding.failover.failbackDelay`],
        ["heartbeatTimeout", 1000, 30000, `${p}bonding.failover.heartbeatTimeout`]
      ];
      for (const [key, min, max, label] of failoverChecks) {
        const error = numberRangeError(bonding.failover, key, min, max, label);
        if (error) {
          return error;
        }
      }
    }
  }

  if (connection.congestionControl !== undefined) {
    if (
      !connection.congestionControl ||
      typeof connection.congestionControl !== "object" ||
      Array.isArray(connection.congestionControl)
    ) {
      return `${p}congestionControl must be an object`;
    }
    const congestionControl = connection.congestionControl;
    const congestionChecks = [
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
      congestionControl.minDeltaTimer > congestionControl.maxDeltaTimer
    ) {
      return `${p}congestionControl.minDeltaTimer must be <= maxDeltaTimer`;
    }
  }

  return null;
}

function sanitizeConnectionConfig(connection) {
  if (!connection || typeof connection !== "object") {
    return {};
  }

  const serverType = normalizeServerType(connection.serverType);
  const out = {};
  for (const key of VALID_CONNECTION_KEYS) {
    if (connection[key] !== undefined) {
      out[key] = connection[key];
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

  return out;
}

function slugifyConnectionName(name) {
  if (!name || typeof name !== "string") {
    return "connection";
  }

  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

function deriveConnectionIds(connections) {
  const used = new Set();
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

function findConnectionIndexByInstanceId(connections, instanceId) {
  const ids = deriveConnectionIds(connections);
  return ids.findIndex((id) => id === instanceId);
}

function validateUniqueServerPorts(connections) {
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

module.exports = {
  VALID_CONNECTION_KEYS,
  validateConnectionConfig,
  sanitizeConnectionConfig,
  validateUniqueServerPorts,
  normalizeServerType,
  slugifyConnectionName,
  deriveConnectionIds,
  findConnectionIndexByInstanceId
};
