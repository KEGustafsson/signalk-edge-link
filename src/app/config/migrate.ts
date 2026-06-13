"use strict";

/**
 * Configuration migration re-export (L4 application layer).
 *
 * Provides the config migration entry point from a single canonical location.
 *
 * @module app/config/migrate
 */

/** Migrate a stored plugin config object to the current schema version. */
export { migrateConfig } from "../../scripts/migrate-config";
