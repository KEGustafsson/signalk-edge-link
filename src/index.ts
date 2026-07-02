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

  // ── Status helpers ────────────────────────────────────────────────────────
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});
  // setPluginError marks the plugin red in the server UI; fall back to the
  // plain status line on servers that predate it.
  const setError = app.setPluginError || app.setProviderError || setStatus;

  // ── Connection manager ────────────────────────────────────────────────────
  const manager = createConnectionManager({
    app,
    pluginId: String(plugin.id),
    setStatus,
    setError
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
    // Lazy import, hoisted above the try so a module-load failure surfaces
    // distinctly instead of being folded into the generic start error.
    const { sanitizeConnectionConfig } = require("./connection-config");

    // signalk-server invokes plugin.start() without awaiting the returned
    // promise, so a rejection here would surface as an unhandled promise
    // rejection in the server process. Report failures through the plugin
    // error status instead of rethrowing.
    try {
      plugin._currentOptions = options;
      plugin._restartPlugin = typeof restartPlugin === "function" ? restartPlugin : null;

      // Keep _currentOptions in sync with sanitized connections so route
      // handlers always see the cleaned-up config.
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
      await manager.start(options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.error(`Plugin start failed: ${msg}`);
      setError(`Start failed: ${msg}`);
    }
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
