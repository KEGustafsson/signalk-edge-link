"use strict";

/**
 * Shared configuration file I/O helpers.
 *
 * Used by both instance.js and routes.js to load/save JSON config files.
 *
 * @module lib/config-io
 */

const { readFile, writeFile } = require("fs").promises;

/**
 * Loads a JSON configuration file from disk.
 * @param {string} filePath - Full path to the config file
 * @param {Object} [logger] - Optional logger with debug/error methods
 * @returns {Promise<Object|null>} Parsed JSON or null on failure
 */
async function loadConfigFile(filePath, logger) {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if (logger && logger.debug) {
      logger.debug(`Config file not found or error loading ${filePath}: ${err.message}`);
    }
    return null;
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

module.exports = { loadConfigFile, saveConfigFile };
