"use strict";

import { getAllPaths, PATH_CATEGORIES } from "../pathDictionary";
import { RouteRequest, RouteResponse, Router, RouteContext, RouteHandler } from "./types";
import type { ConnectionConfig } from "../types";
import {
  validateConnectionConfig,
  sanitizeConnectionConfig,
  validateUniqueServerPorts
} from "../connection-config";
import { validateRuntimeConfigBody } from "./config-validation";

/**
 * Registers config routes: /paths, /plugin-config (GET+POST), /plugin-schema,
 * /config/:filename (GET+POST)
 *
 * @param router - Express router
 * @param ctx - Shared route context
 */
function register(router: Router, ctx: RouteContext): void {
  const {
    app,
    rateLimitMiddleware,
    requireJson,
    pluginRef,
    getFirstBundle,
    getFirstClientBundle,
    getConfigFilePath,
    loadConfigFile,
    saveConfigFile,
    managementAuthMiddleware
  } = ctx;
  const REDACTED_SECRET = "[redacted]";

  // Field names whose values should never appear in API responses.
  const SENSITIVE_FIELDS = new Set(["secretKey", "managementApiToken"]);

  function redactSecretKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => redactSecretKeys(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_FIELDS.has(key) ? REDACTED_SECRET : redactSecretKeys(entry);
    }
    return out;
  }

  function getPersistedConfiguration() {
    const options =
      (typeof app.readPluginOptions === "function" ? app.readPluginOptions() : {}) || {};
    return options.configuration || {};
  }

  function getPersistedConnections(config: Record<string, unknown>) {
    if (Array.isArray(config.connections)) {
      return config.connections.map((connection: unknown) => ({ ...(connection as object) }));
    }

    if (config && typeof config === "object" && config.serverType) {
      return [{ ...config }];
    }

    return [];
  }

  function getConnectionIdentityKey(connection: Record<string, unknown>): string | null {
    if (!connection || typeof connection !== "object") {
      return null;
    }

    if (connection.connectionId && typeof connection.connectionId === "string") {
      return `id:${connection.connectionId}`;
    }

    if (
      !connection.name ||
      !connection.serverType ||
      connection.udpPort === undefined ||
      connection.udpPort === null
    ) {
      return null;
    }

    return `legacy:${connection.name}::${connection.serverType}::${connection.udpPort}`;
  }

  function restoreRedactedSecretKeys(
    connectionList: Record<string, unknown>[],
    persistedConfig: Record<string, unknown>
  ) {
    const persistedConnections = getPersistedConnections(persistedConfig);
    const persistedByIdentity = new Map<string, Record<string, unknown>>();
    const duplicateIdentityKeys = new Set<string>();

    for (const persisted of persistedConnections) {
      const identityKey = getConnectionIdentityKey(persisted);
      if (!identityKey) {
        continue;
      }

      if (persistedByIdentity.has(identityKey)) {
        duplicateIdentityKeys.add(identityKey);
        continue;
      }

      persistedByIdentity.set(identityKey, persisted);
    }

    return connectionList.map((connection, index) => {
      if (!connection || connection.secretKey !== REDACTED_SECRET) {
        return connection;
      }

      const identityKey = getConnectionIdentityKey(connection);
      if (!identityKey) {
        throw new Error(
          `connections[${index}].secretKey is redacted, but connection identity is incomplete (requires connectionId or name/serverType/udpPort)`
        );
      }

      if (duplicateIdentityKeys.has(identityKey)) {
        throw new Error(
          `connections[${index}] (${connection.name || "unnamed"}) is ambiguous: multiple stored connections match its identity`
        );
      }

      const persisted = persistedByIdentity.get(identityKey);
      if (!persisted || typeof persisted.secretKey !== "string" || !persisted.secretKey) {
        throw new Error(
          `connections[${index}] (${connection.name || "unnamed"} ${connection.serverType || "unknown"} ${connection.udpPort || "unknown"}) has redacted secretKey, but no stored secretKey exists for this connection identity`
        );
      }

      return {
        ...connection,
        secretKey: persisted.secretKey
      };
    });
  }

  router.get("/paths", rateLimitMiddleware, (req: RouteRequest, res: RouteResponse) => {
    const paths = getAllPaths();

    const categorized: Record<string, unknown> = {};
    for (const [key, category] of Object.entries(PATH_CATEGORIES) as [
      string,
      { prefix: string }
    ][]) {
      categorized[key] = {
        ...category,
        paths: paths.filter((path: string) => path.startsWith(category.prefix))
      };
    }

    res.json({ total: paths.length, categories: categorized });
  });

  router.get(
    "/plugin-config",
    rateLimitMiddleware,
    managementAuthMiddleware("config.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const pluginConfig =
          (typeof app.readPluginOptions === "function" ? app.readPluginOptions() : {}) || {};
        res.json({
          success: true,
          configuration: redactSecretKeys(pluginConfig.configuration || {})
        });
      } catch (error: any) {
        app.error(`Error reading plugin config: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    }
  );

  router.post(
    "/plugin-config",
    rateLimitMiddleware,
    managementAuthMiddleware("config.update"),
    requireJson,
    (req: RouteRequest, res: RouteResponse) => {
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          return res
            .status(400)
            .json({ success: false, error: "Request body must be a JSON object" });
        }

        const persistedConfig = getPersistedConfiguration() as Record<string, unknown>;
        let connectionList;
        if (Array.isArray(req.body.connections)) {
          if (req.body.connections.length === 0) {
            return res
              .status(400)
              .json({ success: false, error: "connections array must contain at least one entry" });
          }
          connectionList = req.body.connections.map((connection: unknown) => ({
            ...(connection as object)
          }));
        } else if (req.body.serverType) {
          connectionList = [{ ...req.body }];
        } else {
          return res.status(400).json({
            success: false,
            error: "Request body must have a 'connections' array or a top-level 'serverType' field"
          });
        }

        try {
          connectionList = restoreRedactedSecretKeys(connectionList, persistedConfig);
        } catch (error: any) {
          return res.status(400).json({ success: false, error: error.message });
        }

        for (let index = 0; index < connectionList.length; index++) {
          const prefix = connectionList.length > 1 ? `connections[${index}].` : "";
          const validationError = validateConnectionConfig(connectionList[index], prefix);
          if (validationError) {
            return res.status(400).json({ success: false, error: validationError });
          }
        }

        const uniquePortError = validateUniqueServerPorts(connectionList);
        if (uniquePortError) {
          return res.status(400).json({ success: false, error: uniquePortError });
        }

        const finalConfig = {
          connections: connectionList.map((connection: Record<string, unknown>) =>
            sanitizeConnectionConfig(connection as unknown as ConnectionConfig)
          )
        };

        if (typeof pluginRef._restartPlugin === "function") {
          pluginRef._restartPlugin(finalConfig);
          return res.json({
            success: true,
            message: "Configuration saved. Plugin restarting...",
            restarting: true
          });
        }

        app.savePluginOptions?.(finalConfig, (error) => {
          if (error) {
            app.error(`Error saving plugin config: ${error.message}`);
            return res.status(500).json({ success: false, error: error.message });
          }

          return res.json({
            success: true,
            message: "Configuration saved. Restart plugin to apply changes.",
            restarting: false
          });
        });
      } catch (error: any) {
        app.error(`Error saving plugin config: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    }
  );

  router.get("/plugin-schema", rateLimitMiddleware, (req: RouteRequest, res: RouteResponse) => {
    const bundle = getFirstBundle();
    res.json({
      schema: pluginRef.schema,
      currentMode: bundle ? (bundle.state.isServerMode ? "server" : "client") : "unknown"
    });
  });

  const clientModeMiddleware: RouteHandler = (req, res, next) => {
    const bundle = getFirstClientBundle();
    if (!bundle) {
      return res.status(404).json({ error: "Not available in server mode" });
    }
    if (!bundle.state.deltaTimerFile || !bundle.state.subscriptionFile) {
      return res.status(503).json({ error: "Plugin not fully initialized" });
    }
    if (next) next();
  };

  router.get(
    "/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("config-file.read"),
    clientModeMiddleware,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstClientBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }

        const filePath = getConfigFilePath(bundle.state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }

        res.contentType("application/json");
        const config = await loadConfigFile(filePath);
        res.send(JSON.stringify(config || {}));
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  router.post(
    "/config/:filename",
    rateLimitMiddleware,
    managementAuthMiddleware("config-file.update"),
    requireJson,
    clientModeMiddleware,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstClientBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }

        const filePath = getConfigFilePath(bundle.state, req.params.filename);
        if (!filePath) {
          return res.status(400).json({ error: "Invalid filename" });
        }

        const validationError = validateRuntimeConfigBody(req.params.filename, req.body);
        if (validationError) {
          return res.status(400).json({ error: validationError });
        }

        const success = await saveConfigFile(filePath, req.body);
        if (success) {
          return res.status(200).send("OK");
        }

        return res.status(500).send("Failed to save configuration");
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );
}

export { register };
