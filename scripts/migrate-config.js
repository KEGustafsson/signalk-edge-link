#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function validateLegacyConfig(serverType, udpPort, secretKey) {
  if (serverType !== "server" && serverType !== "client") {
    throw new Error("Legacy config must include serverType as 'server' or 'client'");
  }

  if (!Number.isInteger(udpPort) || udpPort < 1024 || udpPort > 65535) {
    throw new Error("Legacy config must include udpPort as an integer between 1024 and 65535");
  }

  if (typeof secretKey !== "string" || secretKey.length !== 32) {
    throw new Error("Legacy config must include secretKey as a 32-character string");
  }
}

function migrateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Expected plugin config object");
  }

  if (Array.isArray(config.connections)) {
    return { ...config };
  }

  const hasLegacyConnection =
    Object.prototype.hasOwnProperty.call(config, "serverType") ||
    Object.prototype.hasOwnProperty.call(config, "udpPort") ||
    Object.prototype.hasOwnProperty.call(config, "secretKey");

  if (!hasLegacyConnection) {
    return { ...config };
  }

  const {
    name,
    serverType,
    udpPort,
    secretKey,
    useMsgpack,
    usePathDictionary,
    protocolVersion,
    ...rest
  } = config;

  validateLegacyConfig(serverType, udpPort, secretKey);

  const migrated = {
    ...rest,
    connections: [
      {
        name: name || "default",
        serverType,
        udpPort,
        secretKey,
        ...(useMsgpack !== undefined ? { useMsgpack: Boolean(useMsgpack) } : {}),
        ...(usePathDictionary !== undefined ? { usePathDictionary: Boolean(usePathDictionary) } : {}),
        protocolVersion: protocolVersion || 1
      }
    ]
  };

  return migrated;
}

async function runCli() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/migrate-config.js <input.json> [output.json]");
    process.exitCode = 1;
    return;
  }

  const outputPath = process.argv[3] || inputPath;
  const absoluteIn = path.resolve(process.cwd(), inputPath);
  const absoluteOut = path.resolve(process.cwd(), outputPath);

  const raw = await fs.readFile(absoluteIn, "utf8");
  const parsed = JSON.parse(raw);
  const migrated = migrateConfig(parsed);

  await fs.writeFile(absoluteOut, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");

  const count = Array.isArray(migrated.connections) ? migrated.connections.length : 0;
  console.log(`Migrated config written to ${absoluteOut} (${count} connection${count === 1 ? "" : "s"})`);
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  migrateConfig
};
