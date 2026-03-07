"use strict";

/**
 * Shared configuration file I/O helpers.
 *
 * Used by both instance.js and routes.js to load/save JSON config files.
 *
 * @module lib/config-io
 */

const fs = require("fs").promises;

async function cleanupTempFile(tempPath) {
  try {
    await fs.unlink(tempPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Loads a JSON configuration file from disk.
 * @param {string} filePath - Full path to the config file
 * @param {Object} [logger] - Optional logger with debug/error methods
 * @returns {Promise<Object|null>} Parsed JSON or null on failure
 */
async function loadConfigFile(filePath, logger) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
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
  const tempPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2);
  let handle;

  try {
    handle = await fs.open(tempPath, "w");

    try {
      await handle.writeFile(content, "utf-8");
    } catch (err) {
      if (logger && logger.error) {
        logger.error(`Error saving ${filePath} (write): ${err.message}`);
      }
      return false;
    }

    try {
      await handle.sync();
    } catch (err) {
      if (logger && logger.error) {
        logger.error(`Error saving ${filePath} (fsync): ${err.message}`);
      }
      return false;
    }

    await handle.close();
    handle = null;

    try {
      await fs.rename(tempPath, filePath);
    } catch (err) {
      if (logger && logger.error) {
        logger.error(`Error saving ${filePath} (rename): ${err.message}`);
      }
      return false;
    }

    if (logger && logger.debug) {
      logger.debug(`Configuration saved to ${filePath}`);
    }
    return true;
  } catch (err) {
    if (logger && logger.error) {
      logger.error(`Error saving ${filePath} (write): ${err.message}`);
    }
    return false;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_err) {
        // Ignore close errors during cleanup
      }
    }

    try {
      await cleanupTempFile(tempPath);
    } catch (err) {
      if (logger && logger.error) {
        logger.error(`Error saving ${filePath} (cleanup): ${err.message}`);
      }
    }
  }
}

module.exports = { loadConfigFile, saveConfigFile };
