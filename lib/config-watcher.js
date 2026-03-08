"use strict";

/**
 * Signal K Edge Link - Config File Watcher
 *
 * Manages per-instance configuration file watchers with debouncing,
 * content-hash deduplication, and automatic recovery on file rename.
 *
 * @module lib/config-watcher
 */

const { readFile, writeFile, mkdir } = require("fs").promises;
const { watch } = require("fs");
const { join } = require("path");
const crypto = require("crypto");
const { loadConfigFile, saveConfigFile } = require("./config-io");
const {
  DEFAULT_DELTA_TIMER,
  FILE_WATCH_DEBOUNCE_DELAY,
  CONTENT_HASH_ALGORITHM,
  WATCHER_RECOVERY_DELAY
} = require("./constants");

/**
 * Create a debounced config-change handler.
 *
 * @param {Object}   opts
 * @param {string}   opts.name           - Human-readable name (e.g. "Delta timer")
 * @param {Function} opts.getFilePath    - Returns current file path
 * @param {Function} opts.processConfig  - Async callback receiving parsed config
 * @param {Object}   opts.state          - Shared mutable state (debounce timers, hashes)
 * @param {string}   opts.instanceId     - Instance identifier for log prefixes
 * @param {Object}   opts.app            - Signal K app (for logging)
 * @param {*}        [opts.readFallback] - Default value when file is missing
 * @returns {Function} Change handler
 */
function createDebouncedConfigHandler(opts) {
  const { name, getFilePath, processConfig, state, instanceId, app, readFallback } = opts;

  return function handleChange() {
    clearTimeout(state.configDebounceTimers[name]);
    state.configDebounceTimers[name] = setTimeout(async () => {
      try {
        let content;
        if (readFallback !== undefined) {
          content = await readFile(getFilePath(), "utf-8").catch(() => null);
        } else {
          content = await readFile(getFilePath(), "utf-8");
        }

        const hashSource = content || JSON.stringify(readFallback) || "";
        const contentHash = crypto.createHash(CONTENT_HASH_ALGORITHM).update(hashSource).digest("hex");

        if (contentHash === state.configContentHashes[name]) {
          app.debug(`[${instanceId}] ${name} file unchanged, skipping`);
          return;
        }

        const parsed = content ? JSON.parse(content) : readFallback;
        await processConfig(parsed);
        state.configContentHashes[name] = contentHash;
      } catch (err) {
        app.error(`[${instanceId}] Error handling ${name} change: ${err.message}`);
      }
    }, FILE_WATCH_DEBOUNCE_DELAY);
  };
}

/**
 * Create a file-system watcher with automatic recovery on error or rename.
 *
 * @param {Object}   opts
 * @param {string}   opts.filePath   - Absolute path to watch
 * @param {Function} opts.onChange    - Callback on change event
 * @param {string}   opts.name       - Human-readable name for logging
 * @param {string}   opts.instanceId - Instance identifier
 * @param {Object}   opts.app        - Signal K app
 * @param {Object}   opts.state      - Shared mutable state (to check stopped flag)
 * @returns {Object} Watcher handle with a close() method
 */
function createWatcherWithRecovery(opts) {
  const { filePath, onChange, name, instanceId, app, state } = opts;
  const watcherObj = { watcher: null, recoveryTimer: null };

  function scheduleWatcherRecreate() {
    if (watcherObj.recoveryTimer) {
      clearTimeout(watcherObj.recoveryTimer);
    }
    watcherObj.recoveryTimer = setTimeout(() => {
      watcherObj.recoveryTimer = null;
      if (state.stopped) { return; }
      app.debug(`[${instanceId}] Recreating ${name} watcher...`);
      const created = createWatcher();
      if (!created) {
        scheduleWatcherRecreate();
      }
    }, WATCHER_RECOVERY_DELAY);
  }

  function createWatcher() {
    try {
      if (watcherObj.watcher) {
        watcherObj.watcher.close();
        watcherObj.watcher = null;
      }
      watcherObj.watcher = watch(filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          app.debug(`[${instanceId}] ${name} file changed`);
          onChange();
          if (eventType === "rename") {
            scheduleWatcherRecreate();
          }
        }
      });

      watcherObj.watcher.on("error", (error) => {
        app.error(`[${instanceId}] ${name} watcher error: ${error.message}`);
        if (watcherObj.watcher) { watcherObj.watcher.close(); watcherObj.watcher = null; }
        scheduleWatcherRecreate();
      });

      return true;
    } catch (err) {
      app.error(`[${instanceId}] Failed to create ${name} watcher: ${err.message}`);
      return false;
    }
  }

  createWatcher();

  return {
    get watcher() { return watcherObj.watcher; },
    close() {
      if (watcherObj.recoveryTimer) { clearTimeout(watcherObj.recoveryTimer); watcherObj.recoveryTimer = null; }
      if (watcherObj.watcher) { watcherObj.watcher.close(); watcherObj.watcher = null; }
    }
  };
}

/**
 * Migrate legacy root-level config files to the instance-namespaced directory
 * when upgrading from single-instance to multi-instance mode.
 *
 * @param {Object} opts
 * @param {string} opts.instanceId  - Instance identifier
 * @param {string} opts.dataDir     - Signal K data directory
 * @param {string} opts.instanceDir - Per-instance config directory
 * @param {Object} opts.app         - Signal K app
 */
async function migrateLegacyConfigFiles({ instanceId, dataDir, instanceDir, app }) {
  if (instanceId !== "default") { return; }
  const legacyFiles = ["delta_timer.json", "subscription.json", "sentence_filter.json"];
  for (const file of legacyFiles) {
    const legacy = join(dataDir, file);
    const target = join(instanceDir, file);
    try {
      const data = await readFile(legacy, "utf-8");
      await writeFile(target, data, { encoding: "utf-8", flag: "wx" });
      app.debug(`[${instanceId}] Migrated legacy ${file} → instances/default/${file}`);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EEXIST") {
        app.error(`[${instanceId}] Migration failed for ${file}: ${err.message}`);
      }
    }
  }
}

/**
 * Initialize per-instance persistent storage (config files and defaults).
 *
 * @param {Object} opts
 * @param {string} opts.instanceId - Instance identifier
 * @param {Object} opts.app        - Signal K app
 * @param {Object} opts.state      - Shared mutable state
 * @returns {Promise<void>}
 */
async function initializePersistentStorage({ instanceId, app, state }) {
  const instanceDir = join(app.getDataDirPath(), "instances", instanceId);
  await mkdir(instanceDir, { recursive: true });

  await migrateLegacyConfigFiles({
    instanceId,
    dataDir: app.getDataDirPath(),
    instanceDir,
    app
  });

  state.deltaTimerFile = join(instanceDir, "delta_timer.json");
  state.subscriptionFile = join(instanceDir, "subscription.json");
  state.sentenceFilterFile = join(instanceDir, "sentence_filter.json");

  const defaults = [
    { file: state.deltaTimerFile, data: { deltaTimer: DEFAULT_DELTA_TIMER }, name: "delta_timer.json" },
    { file: state.subscriptionFile, data: { context: "*", subscribe: [{ path: "*" }] }, name: "subscription.json" },
    { file: state.sentenceFilterFile, data: { excludedSentences: ["GSV"] }, name: "sentence_filter.json" }
  ];

  for (const { file, data, name } of defaults) {
    const existing = await loadConfigFile(file);
    if (!existing) {
      await saveConfigFile(file, data);
      app.debug(`[${instanceId}] Initialized ${name} with defaults`);
    } else if (name === "sentence_filter.json") {
      state.excludedSentences = existing.excludedSentences || ["GSV"];
    }
  }
}

module.exports = {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  migrateLegacyConfigFiles,
  initializePersistentStorage
};
