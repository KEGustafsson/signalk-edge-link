"use strict";

/**
 * Config file watcher re-export (L4 application layer).
 *
 * Single import point for config file watching utilities.
 *
 * @module app/config/watcher
 */

export {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  initializePersistentStorage
} from "../../config-watcher";

export type { DebouncedConfigHandler } from "../../config-watcher";
