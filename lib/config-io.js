"use strict";

/**
 * Shared configuration file I/O helpers.
 *
 * Used by both instance.js and routes.js to load/save JSON config files.
 *
 * @module lib/config-io
 */

const { readFile, writeFile } = require("fs").promises;

class ConfigFileLoadError extends Error {
  constructor(type, filePath, message, metadata = {}) {
    super(message);
    this.name = "ConfigFileLoadError";
    this.type = type;
    this.filePath = filePath;
    this.metadata = metadata;
  }
}

/**
 * Loads a JSON configuration file from disk.
 * @param {string} filePath - Full path to the config file
 * @param {Object} [logger] - Optional logger with debug/error methods
 * @returns {Promise<Object|null>} Parsed JSON or null when file does not exist
 */
async function loadConfigFile(filePath, logger) {
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (logger && logger.debug) {
        logger.debug(`Config file not found at ${filePath}`);
      }
      return null;
    }

    const wrappedError = new ConfigFileLoadError(
      "io_error",
      filePath,
      `Failed to read config file ${filePath}: ${err.message}`,
      { code: err.code || null, cause: err }
    );

    if (logger && logger.debug) {
      logger.debug(wrappedError.message);
    }

    throw wrappedError;
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    const wrappedError = new ConfigFileLoadError(
      "invalid_json",
      filePath,
      `Invalid JSON config in ${filePath}: ${err.message}`,
      { cause: err }
    );
    if (logger && logger.debug) {
      logger.debug(wrappedError.message);
    }
    throw wrappedError;
  }
}

/**
 * Saves configuration data to a JSON file.
 * @param {string} filePath - Full path to the config file
 * @param {Object} data - Configuration data to save
 * @param {Object} [logger] - Optional logger with debug/error methods
 * @returns {Promise<boolean>} True if successful
 */
async function saveConfigFile(filePath, data, logger) {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    if (logger && logger.debug) {
      logger.debug(`Configuration saved to ${filePath}`);
    }
    return true;
  } catch (err) {
    if (logger && logger.error) {
      logger.error(`Error saving ${filePath}: ${err.message}`);
    }
    return false;
  }
}

module.exports = { loadConfigFile, saveConfigFile, ConfigFileLoadError };
