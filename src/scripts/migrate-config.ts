"use strict";

import fs from "node:fs/promises";
import { CURRENT_CONFIG_SCHEMA_VERSION } from "../foundation/constants";
import path from "node:path";

import {
  VALID_CONNECTION_KEYS,
  validateConnectionConfig,
  sanitizeConnectionConfig
} from "../connection-config";

function validateLegacyConfig(config: any): void {
  const connection = {
    ...config,
    name: config.name || "default",
    protocolVersion: config.protocolVersion || 1
  };
  const validationError = validateConnectionConfig(connection);
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

  // Sanitize BEFORE validating, matching startup order
  // (connection-manager/start.ts sanitizes then validates). Validating first
  // rejected legacy configs that startup accepts: a stored `protocolVersion: 2`
  // carrying v1-only ping fields (testAddress/testPort/pingIntervalTime) threw
  // here, even though sanitize strips exactly those fields for protocolVersion
  // >= 2 — which is why the same file loads fine at runtime and why the repo
  // ships samples in that shape.
  const connection = sanitizeConnectionConfig({
    ...config,
    name: config.name || "default",
    protocolVersion: config.protocolVersion || 1
  });

  validateLegacyConfig(connection);

  return {
    ...stripLegacyConnectionFields(config),
    // Stamp the version the migrated file is written in, so the same field the
    // plugin schema declares is actually present in a migrated config.
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
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
