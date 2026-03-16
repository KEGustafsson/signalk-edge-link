"use strict";

/**
 * Shared configuration file I/O helpers.
 *
 * Used by both instance.js and routes.js to load/save JSON config files.
 *
 * @module lib/config-io
 */

import { promises as fs } from "fs";
import * as path from "path";

interface Logger {
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

/** Discriminated result returned by {@link loadConfigFileSafe}. */
export type ConfigFileResult =
  | { status: "ok"; data: unknown }
  | { status: "not_found" }
  | { status: "parse_error"; message: string }
  | { status: "read_error"; message: string };

/**
 * Loads a JSON configuration file from disk and returns a discriminated result
 * so callers can distinguish "file not found" (normal first-run) from a genuine
 * parse or I/O failure (data corruption, permission denied, etc.).
 *
 * @param filePath - Full path to the config file
 * @param logger - Optional logger with debug/error methods
 */
export async function loadConfigFileSafe(
  filePath: string,
  logger?: Logger
): Promise<ConfigFileResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      if (logger?.debug) {
        logger.debug(`Config file not found ${filePath}`);
      }
      return { status: "not_found" };
    }
    if (logger?.error) {
      logger.error(`Error loading ${filePath}: ${err.message}`);
    }
    return { status: "read_error", message: err.message };
  }

  try {
    return { status: "ok", data: JSON.parse(content) };
  } catch (err: any) {
    if (logger?.error) {
      logger.error(`Error parsing JSON in ${filePath}: ${err.message}`);
    }
    return { status: "parse_error", message: err.message };
  }
}

/**
 * Loads a JSON configuration file from disk.
 * @param filePath - Full path to the config file
 * @param logger - Optional logger with debug/error methods
 * @returns Parsed JSON or null on failure (both not-found and parse-error map to null)
 */
export async function loadConfigFile(filePath: string, logger?: Logger): Promise<unknown | null> {
  const result = await loadConfigFileSafe(filePath, logger);
  return result.status === "ok" ? result.data : null;
}

/**
 * Saves configuration data to a JSON file.
 * @param filePath - Full path to the config file
 * @param data - Configuration data to save
 * @param logger - Optional logger with debug/error methods
 * @returns True if successful
 */
export async function saveConfigFile(
  filePath: string,
  data: unknown,
  logger?: Logger
): Promise<boolean> {
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const tempPath = path.join(dir, `.${baseName}.tmp`);
  let fileHandle: fs.FileHandle | undefined;

  try {
    fileHandle = await fs.open(tempPath, "w");
    await fileHandle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;

    await fs.rename(tempPath, filePath);

    if (logger && logger.debug) {
      logger.debug(`Configuration saved to ${filePath}`);
    }
    return true;
  } catch (err: any) {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (_closeErr) {
        // no-op, keep original error context
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch (_unlinkErr) {
      // no-op, temp file might not exist
    }

    if (logger && logger.error) {
      logger.error(`Error saving ${filePath}: ${err.message}`);
    }
    return false;
  }
}
