"use strict";

/**
 * Configuration validation re-export (L4 application layer).
 *
 * Single import point for connection config validation used by both the
 * connection manager and the route handlers, eliminating the mirrored
 * validation constant in routes/config-validation.ts.
 *
 * @module app/config/validation
 */

/** Validate a ConnectionConfig object; returns an error message string, or null on success. */
export { validateConnectionConfig } from "../../connection-config";
/** Strip unknown fields and apply defaults to produce a clean ConnectionConfig. */
export { sanitizeConnectionConfig } from "../../connection-config";
