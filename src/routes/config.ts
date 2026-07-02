"use strict";

import { getAllPaths, PATH_CATEGORIES } from "../codec/path-dictionary";
import { RouteRequest, RouteResponse, Router, RouteContext, RouteHandler } from "./types";
import type { ConnectionConfig } from "../foundation/types";
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

  function getPersistedConnections(config: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(config.connections)) {
      return config.connections.map((connection: unknown) => ({
        ...(connection as Record<string, unknown>)
      }));
    }

    if (config && typeof config === "object" && config.serverType) {
      return [{ ...config }];
    }

    return [];
  }

  function normalizeConnectionId(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function getLegacyConnectionIdentityKey(connection: Record<string, unknown>): string | null {
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

  function getConnectionIdentityKey(connection: Record<string, unknown>): string | null {
    if (!connection || typeof connection !== "object") {
      return null;
    }

    const normalizedConnectionId = normalizeConnectionId(connection.connectionId);
    if (normalizedConnectionId) {
      return `id:${normalizedConnectionId}`;
    }

    return getLegacyConnectionIdentityKey(connection);
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

      const normalizedConnectionId = normalizeConnectionId(connection.connectionId);
      const identityKey = getConnectionIdentityKey(connection);
      const persisted = identityKey ? persistedByIdentity.get(identityKey) : null;
      const legacyIdentityKey = getLegacyConnectionIdentityKey(connection);
      const persistedAtIndex =
        normalizedConnectionId &&
        legacyIdentityKey &&
        persistedConnections.length === connectionList.length
          ? persistedConnections[index]
          : null;
      const persistedAtIndexLegacyKey = persistedAtIndex
        ? getLegacyConnectionIdentityKey(persistedAtIndex)
        : null;
      const indexFallbackIsSafe =
        !!persistedAtIndex &&
        persistedAtIndexLegacyKey === legacyIdentityKey &&
        typeof persistedAtIndex.secretKey === "string" &&
        !!persistedAtIndex.secretKey &&
        !duplicateIdentityKeys.has(legacyIdentityKey || "") &&
        !getConnectionIdentityKey(persistedAtIndex)?.startsWith("id:");

      if (!identityKey && !indexFallbackIsSafe) {
        throw new Error(
          `connections[${index}].secretKey is redacted, but connection identity is incomplete (requires connectionId or name/serverType/udpPort)`
        );
      }

      if (identityKey && duplicateIdentityKeys.has(identityKey)) {
        throw new Error(
          `connections[${index}] (${connection.name || "unnamed"}) is ambiguous: multiple stored connections match its identity`
        );
      }

      const matchedPersisted = persisted || (indexFallbackIsSafe ? persistedAtIndex : null);
      if (
        !matchedPersisted ||
        typeof matchedPersisted.secretKey !== "string" ||
        !matchedPersisted.secretKey
      ) {
        throw new Error(
          `connections[${index}] (${connection.name || "unnamed"} ${connection.serverType || "unknown"} ${connection.udpPort || "unknown"}) has redacted secretKey, but no stored secretKey exists for this connection identity`
        );
      }

      return {
        ...connection,
        secretKey: matchedPersisted.secretKey
      };
    });
  }

  router.get(
    "/paths",
    rateLimitMiddleware,
    managementAuthMiddleware("paths.read"),
    (req: RouteRequest, res: RouteResponse) => {
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
    }
  );

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
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        app.error(`Error reading plugin config: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    }
  );

  router.post(
    "/plugin-config",
    rateLimitMiddleware,
    managementAuthMiddleware("config.update"),
    requireJson,
    async (req: RouteRequest, res: RouteResponse) => {
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
        } catch (error: unknown) {
          return res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        connectionList = connectionList.map((connection: Record<string, unknown>) =>
          sanitizeConnectionConfig(connection as unknown as ConnectionConfig)
        );

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

        // Resolve managementApiToken. The whole plugin config is replaced on
        // save, so we must never silently drop the token:
        //   - field omitted entirely      → preserve persisted token
        //   - REDACTED_SECRET sentinel     → preserve persisted token
        //   - explicit non-empty string    → use it
        //   - explicit empty string        → clear (operator opt-out)
        const persistedToken =
          typeof persistedConfig.managementApiToken === "string"
            ? persistedConfig.managementApiToken
            : undefined;
        let resolvedManagementToken: string | undefined;
        const incomingToken = req.body.managementApiToken;
        if (typeof incomingToken === "string") {
          if (incomingToken === REDACTED_SECRET) {
            resolvedManagementToken = persistedToken;
          } else {
            resolvedManagementToken = incomingToken || undefined;
          }
        } else {
          // Field absent from the request body → carry the existing token forward.
          resolvedManagementToken = persistedToken;
        }

        const finalConfig: Record<string, unknown> = {
          connections: connectionList
        };

        if (resolvedManagementToken !== undefined) {
          finalConfig.managementApiToken = resolvedManagementToken;
        }

        // Preserve the persisted fail-closed flag unless the caller explicitly
        // sets it, so an incomplete write cannot relax the auth posture.
        if (typeof req.body.requireManagementApiToken === "boolean") {
          finalConfig.requireManagementApiToken = req.body.requireManagementApiToken;
        } else if (typeof persistedConfig.requireManagementApiToken === "boolean") {
          finalConfig.requireManagementApiToken = persistedConfig.requireManagementApiToken;
        }

        if (typeof pluginRef._restartPlugin === "function") {
          // Await so a promise-returning restart handler (tests, future server
          // versions) surfaces failures as a 500. Note signalk-server's own
          // restart callback returns undefined and reports save errors only to
          // its console, so on a real server the "restarting" response is
          // best-effort — a failed persist there cannot be detected here.
          await pluginRef._restartPlugin(finalConfig);
          return res.json({
            success: true,
            message: "Configuration saved. Plugin restarting...",
            restarting: true
          });
        }

        if (typeof app.savePluginOptions === "function") {
          await new Promise<void>((resolve, reject) => {
            app.savePluginOptions!(finalConfig, (error) => (error ? reject(error) : resolve()));
          });
          return res.json({
            success: true,
            message: "Configuration saved. Restart plugin to apply changes.",
            restarting: false
          });
        }

        // Neither a restart handler nor a save handler is available — fail
        // deterministically instead of leaving the request hanging.
        return res.status(503).json({
          success: false,
          error: "No restart or save handler available to persist configuration"
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        app.error(`Error saving plugin config: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    }
  );

  router.get(
    "/plugin-schema",
    rateLimitMiddleware,
    managementAuthMiddleware("plugin-schema.read"),
    (req: RouteRequest, res: RouteResponse) => {
      const bundle = getFirstBundle();
      res.json({
        schema: pluginRef.schema,
        currentMode: bundle ? (bundle.state.isServerMode ? "server" : "client") : "unknown"
      });
    }
  );

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
      } catch (error: unknown) {
        // Log the detail (may include absolute paths) but return a generic
        // message so filesystem layout is not disclosed to API callers.
        const detail = error instanceof Error ? error.message : String(error);
        if (app?.error) app.error(`[config-file.read] ${req.params.filename}: ${detail}`);
        res.status(500).json({ error: "Failed to read configuration file" });
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
          return res.status(200).json({ success: true });
        }

        return res.status(500).json({ error: "Failed to save configuration file" });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        if (app?.error) app.error(`[config-file.update] ${req.params.filename}: ${detail}`);
        res.status(500).json({ error: "Failed to save configuration file" });
      }
    }
  );
}

export { register };
