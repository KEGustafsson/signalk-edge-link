"use strict";

/**
 * Config file watcher re-export (L4 application layer).
 *
 * Single import point for config file watching utilities.
 *
 * @module app/config/watcher
 */

/** Create a debounced handler that reloads and applies a config file on change. */
export { createDebouncedConfigHandler } from "../../config-watcher";
/** Create a file watcher that automatically recovers from transient fs errors. */
export { createWatcherWithRecovery } from "../../config-watcher";
/** Resolve and initialise the persistent storage paths for an instance. */
export { initializePersistentStorage } from "../../config-watcher";
/** Handler type returned by `createDebouncedConfigHandler`. */
export type { DebouncedConfigHandler } from "../../config-watcher";
