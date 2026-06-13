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

export { validateConnectionConfig, sanitizeConnectionConfig } from "../../connection-config";
