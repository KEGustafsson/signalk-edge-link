"use strict";

import createRoutes = require("./routes");
import { createConnectionManager } from "./app/connection-manager";
import { buildPluginSchema } from "./app/config/schema";
import type { SignalKApp } from "./foundation/types";
import type { Router } from "./routes/types";

const pkg = require("../package.json");

/** Signal K Edge Link plugin factory. Returns the plugin object registered with the Signal K server. */
module.exports = function createPlugin(app: SignalKApp) {
  const plugin: Record<string, unknown> = {};
  plugin.id = pkg.name;
  plugin.name = "Signal K Edge Link";
  plugin.description = pkg.description;

  // ── Status helper ─────────────────────────────────────────────────────────
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});

  // ── Connection manager ────────────────────────────────────────────────────
  const manager = createConnectionManager({
    app,
    pluginId: String(plugin.id),
    setStatus
  });

  // Routes are created once at module init (before start) because
  // registerWithRouter is called by Signal K before start().
  const routes = createRoutes(app, manager.registry, plugin);

  // ── Plugin lifecycle ──────────────────────────────────────────────────────

  plugin.registerWithRouter = (router: Router) => {
    routes.registerWithRouter(router);
  };

  plugin.start = async function start(
    options: Record<string, unknown> = {},
    restartPlugin?: (config: unknown) => Promise<void>
  ) {
    plugin._currentOptions = options;
    plugin._restartPlugin = typeof restartPlugin === "function" ? restartPlugin : null;

    // Keep _currentOptions in sync with sanitized connections so route
    // handlers always see the cleaned-up config.
    const { sanitizeConnectionConfig } = require("./connection-config");
    if (Array.isArray(options.connections) && options.connections.length > 0) {
      const sanitized = options.connections.map((c: Record<string, unknown>) =>
        sanitizeConnectionConfig(c)
      );
      plugin._currentOptions = { ...options, connections: sanitized };
    } else if (options.serverType) {
      const { connections: _drop, ...rest } = options as Record<string, unknown>;
      const sanitized = sanitizeConnectionConfig({ ...rest });
      plugin._currentOptions = { ...rest, ...sanitized };
    }

    routes.startRateLimitCleanup();
    // Now that _currentOptions reflects the saved config, warn if the
    // management API is reachable without authentication.
    routes.warnIfOpenAccess();
    await manager.start(options);
  };

  plugin.stop = function stop() {
    plugin._restartPlugin = null;
    plugin._currentOptions = null;
    routes.stopRateLimitCleanup();
    manager.stop();
  };

  // ── Schema ────────────────────────────────────────────────────────────────
  plugin.schema = buildPluginSchema();

  return plugin;
};
