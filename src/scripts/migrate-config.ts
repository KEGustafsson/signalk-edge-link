"use strict";

import fs from "node:fs/promises";
import path from "node:path";

import {
  VALID_CONNECTION_KEYS,
  validateConnectionConfig,
  sanitizeConnectionConfig
} from "../connection-config";

function validateLegacyConfig(config: any): void {
  const raw = {
    ...config,
    name: config.name || "default",
    protocolVersion: config.protocolVersion || 1
  };
  // Sanitize first so legacy v2/v3 configs with v1-only fields are cleaned
  // before validation — mirrors the startup sanitize-before-validate pattern.
  const sanitized = sanitizeConnectionConfig(raw);
  const validationError = validateConnectionConfig(sanitized as any);
  if (validationError) {
    throw new Error(`Legacy config ${validationError}`);
  }
}

function stripLegacyConnectionFields(config: any): any {
  const rest = { ...config };
  for (const key of VALID_CONNECTION_KEYS) {
    delete rest[key];
  }
  return rest;
}

function migrateConfig(config: any): any {
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

  validateLegacyConfig(config);

  const connection = sanitizeConnectionConfig({
    ...config,
    name: config.name || "default",
    protocolVersion: config.protocolVersion || 1
  });

  return {
    ...stripLegacyConnectionFields(config),
    connections: [connection]
  };
}

async function runCli(): Promise<void> {
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
  console.log(
    `Migrated config written to ${absoluteOut} (${count} connection${count === 1 ? "" : "s"})`
  );
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { migrateConfig };
