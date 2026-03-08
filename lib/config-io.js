"use strict";

/**
 * Shared configuration file I/O helpers.
 *
 * Used by both instance.js and routes.js to load/save JSON config files.
 *
 * @module lib/config-io
 */

const { promises: fs } = require("fs");
const path = require("path");

/**
 * Loads a JSON configuration file from disk.
 * @param {string} filePath - Full path to the config file
 * @param {Object} [logger] - Optional logger with debug/error methods
 * @returns {Promise<Object|null>} Parsed JSON or null on failure
 */
async function loadConfigFile(filePath, logger) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    try {
      return JSON.parse(content);
    } catch (err) {
      if (logger && logger.error) {
        logger.error(`Error parsing JSON in ${filePath}: ${err.message}`);
      }
      return null;
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (logger && logger.debug) {
        logger.debug(`Config file not found ${filePath}`);
      }
    } else if (logger && logger.error) {
      logger.error(`Error loading ${filePath}: ${err.message}`);
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
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const tempPath = path.join(dir, `.${baseName}.tmp`);
  let fileHandle;

  try {
    fileHandle = await fs.open(tempPath, "w");
    await fileHandle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;

    await fs.rename(tempPath, filePath);

    if (logger && logger.debug) {
      logger.debug(`Configuration saved to ${filePath}`);
    }
    return true;
  } catch (err) {
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

module.exports = { loadConfigFile, saveConfigFile };
