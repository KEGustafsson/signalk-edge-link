import React, { useState, useEffect } from "react";
import { API_BASE } from "../../utils";
import { useApi, ApiError } from "../../hooks/useApi";
import { Card, StatItem } from "./shared";

interface Props {
  pluginConfig: Record<string, unknown> | null;
  pluginSchema: Record<string, unknown> | null;
  activeConnectionIndex: number;
  totalConnections: number;
  tokenHelpText: string;
  onNotify: (msg: string, type: string) => void;
  onConfigSaved: (cfg: Record<string, unknown>) => void;
}

export function ConfigFileEditorCard({
  pluginConfig,
  pluginSchema,
  activeConnectionIndex,
  totalConnections,
  tokenHelpText,
  onNotify,
  onConfigSaved
}: Props) {
  const [jsonText, setJsonText] = useState(JSON.stringify(pluginConfig ?? {}, null, 2));
  const { request, authMessage } = useApi();

  useEffect(() => {
    setJsonText(JSON.stringify(pluginConfig ?? {}, null, 2));
  }, [pluginConfig]);

  const handleSave = async () => {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Plugin configuration must be a JSON object");
      }

      const res = await request(`${API_BASE}/plugin-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });

      const result = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok || !result.success) {
        throw new Error(
          result.error
            ? String(result.error)
            : `Failed to save plugin configuration (${res.status})`
        );
      }

      onConfigSaved(parsed);
      onNotify(
        result.message
          ? String(result.message)
          : "Plugin configuration saved. Refresh to apply changes.",
        "success"
      );
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("saving full plugin config")
          : `Error saving full plugin config: ${e.message}`,
        "error"
      );
    }
  };

  const handleReload = async () => {
    try {
      const res = await request(`${API_BASE}/plugin-config`);
      if (!res.ok) throw new Error(`Failed to load plugin configuration (${res.status})`);
      const data = await res.json();
      const cfg =
        data?.configuration &&
        typeof data.configuration === "object" &&
        !Array.isArray(data.configuration)
          ? data.configuration
          : {};
      onConfigSaved(cfg);
      onNotify("Plugin configuration reloaded.", "success");
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("reloading plugin config")
          : `Error reloading plugin config: ${e.message}`,
        "error"
      );
    }
  };

  const summaryConfig =
    pluginConfig &&
    Array.isArray(pluginConfig.connections) &&
    (pluginConfig.connections as unknown[]).length > 0
      ? ((pluginConfig.connections as Record<string, unknown>[])[
          Math.min(activeConnectionIndex, (pluginConfig.connections as unknown[]).length - 1)
        ] ?? {})
      : (pluginConfig ?? {});

  const mode =
    summaryConfig.serverType === "server" || summaryConfig.serverType === true
      ? "server"
      : "client";
  const pv = Number(summaryConfig.protocolVersion) >= 2 ? Number(summaryConfig.protocolVersion) : 1;
  const keyCount = Object.keys(summaryConfig).length;
  const scopeLabel =
    pluginConfig &&
    Array.isArray(pluginConfig.connections) &&
    (pluginConfig.connections as unknown[]).length > 0
      ? `Connection ${activeConnectionIndex + 1}/${(pluginConfig.connections as unknown[]).length}`
      : "Top-level";

  return (
    <Card
      title="Full Plugin Configuration"
      subtitle="All parameters from /plugin-config (advanced JSON editor)"
    >
      {pluginConfig && (
        <div className="plugin-config-summary">
          <div className="plugin-summary-grid">
            <StatItem label="Scope" value={scopeLabel} />
            <StatItem label="Mode" value={mode.toUpperCase()} />
            <StatItem label="Protocol" value={`v${pv}`} />
            <StatItem label="Fields" value={String(keyCount)} />
          </div>
        </div>
      )}

      <div className="json-editor plugin-config-editor">
        <h3>Plugin Config JSON</h3>
        <textarea
          id="pluginConfigJson"
          rows={20}
          placeholder='{"serverType":"client","udpPort":4446,"secretKey":"..."}'
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
        <small className="help-text">
          This editor exposes all available plugin fields. Save triggers plugin restart when
          supported.
        </small>
        <small className="help-text">{tokenHelpText}</small>
      </div>

      <div className="plugin-config-actions">
        <button id="savePluginConfig" className="btn btn-primary" onClick={handleSave}>
          Save Full Plugin Config
        </button>
        <button id="reloadPluginConfig" className="btn btn-secondary" onClick={handleReload}>
          Reload From Server
        </button>
        <button
          id="loadDefaultPluginConfig"
          className="btn btn-secondary"
          onClick={() => {
            const defaults =
              pluginSchema && typeof pluginSchema === "object" && !Array.isArray(pluginSchema)
                ? pluginSchema
                : {};
            setJsonText(JSON.stringify(defaults, null, 2));
            onNotify("Loaded schema defaults into editor. Save to apply.", "warning");
          }}
        >
          Load Schema Defaults
        </button>
      </div>
    </Card>
  );
}
