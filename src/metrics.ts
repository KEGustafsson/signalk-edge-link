// Re-export shim — implementation re-homed to the L3 domain layer.
import createMetrics = require("./domain/metrics/registry");
export = createMetrics;
