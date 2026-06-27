import React, { useState, useEffect, useRef, useCallback } from "react";
import { SubscriptionConfig } from "../../types";
import { configPath } from "../../utils";
import { useApi, ApiError } from "../../hooks/useApi";
import { Card } from "./shared";

const DEBOUNCE_MS = 300;

interface Props {
  connId: string;
  config: SubscriptionConfig | null;
  onNotify: (msg: string, type: string) => void;
  onSaved: (cfg: SubscriptionConfig) => void;
}

function buildJson(
  context: string,
  paths: string[],
  metaEnabled: boolean,
  metaIntervalSec: number,
  metaPathsRegex: string,
  metaMaxPerPacket: number
): SubscriptionConfig {
  const cfg: SubscriptionConfig = {
    context,
    subscribe: paths.map((p) => ({ path: p })).filter((s) => s.path.trim() !== "")
  };
  if (metaEnabled) {
    cfg.meta = {
      enabled: true,
      intervalSec: metaIntervalSec,
      includePathsMatching: metaPathsRegex || null,
      maxPathsPerPacket: metaMaxPerPacket
    };
  }
  return cfg;
}

export function SubscriptionCard({ connId, config, onNotify, onSaved }: Props) {
  const [context, setContext] = useState(config?.context ?? "*");
  const [paths, setPaths] = useState<string[]>(config?.subscribe?.map((s) => s.path) ?? []);
  const [metaEnabled, setMetaEnabled] = useState(config?.meta?.enabled ?? false);
  const [metaIntervalSec, setMetaIntervalSec] = useState(config?.meta?.intervalSec ?? 300);
  const [metaPathsRegex, setMetaPathsRegex] = useState(config?.meta?.includePathsMatching ?? "");
  const [metaMaxPerPacket, setMetaMaxPerPacket] = useState(config?.meta?.maxPathsPerPacket ?? 500);
  const [jsonText, setJsonText] = useState(
    JSON.stringify(config ?? { context: "*", subscribe: [] }, null, 2)
  );
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { request, authMessage } = useApi();

  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const cfg = buildJson(
      context,
      paths,
      metaEnabled,
      metaIntervalSec,
      metaPathsRegex,
      metaMaxPerPacket
    );
    setJsonText(JSON.stringify(cfg, null, 2));
  }, [context, paths, metaEnabled, metaIntervalSec, metaPathsRegex, metaMaxPerPacket]);

  useEffect(() => {
    if (!config) return;
    setContext(config.context ?? "*");
    setPaths(config.subscribe?.map((s) => s.path) ?? []);
    setMetaEnabled(config.meta?.enabled ?? false);
    setMetaIntervalSec(config.meta?.intervalSec ?? 300);
    setMetaPathsRegex(config.meta?.includePathsMatching ?? "");
    setMetaMaxPerPacket(config.meta?.maxPathsPerPacket ?? 500);
  }, [config]);

  const handleJsonChange = useCallback((text: string) => {
    setJsonText(text);
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    syncTimeoutRef.current = setTimeout(() => {
      try {
        const parsed = JSON.parse(text);
        if (parsed.context) setContext(parsed.context);
        if (Array.isArray(parsed.subscribe))
          setPaths(parsed.subscribe.map((s: { path?: string }) => s.path ?? ""));
        if (parsed.meta?.enabled) {
          setMetaEnabled(true);
          setMetaIntervalSec(parsed.meta.intervalSec ?? 300);
          setMetaPathsRegex(parsed.meta.includePathsMatching ?? "");
          setMetaMaxPerPacket(parsed.meta.maxPathsPerPacket ?? 500);
        } else {
          setMetaEnabled(false);
        }
      } catch {
        // invalid JSON — ignore, user is still typing
      }
    }, DEBOUNCE_MS);
  }, []);

  const handleSave = async () => {
    try {
      const cfg = buildJson(
        context,
        paths,
        metaEnabled,
        metaIntervalSec,
        metaPathsRegex,
        metaMaxPerPacket
      );
      if (!cfg.context) throw new Error("Context is required");
      if (!Array.isArray(cfg.subscribe)) throw new Error("Subscribe array is required");
      if (metaEnabled) {
        if (!Number.isFinite(metaIntervalSec) || metaIntervalSec < 30 || metaIntervalSec > 86400) {
          throw new Error("Snapshot interval must be between 30 and 86400 seconds");
        }
        if (
          !Number.isFinite(metaMaxPerPacket) ||
          metaMaxPerPacket < 10 ||
          metaMaxPerPacket > 5000
        ) {
          throw new Error("Max paths per packet must be between 10 and 5000");
        }
        if (metaPathsRegex) {
          // Mirror the server's cheap length cap (the backend remains the
          // authoritative validator, including its ReDoS-shape heuristic).
          if (metaPathsRegex.length > 256) {
            throw new Error("Path regex must be 256 characters or fewer");
          }
          try {
            new RegExp(metaPathsRegex);
          } catch {
            throw new Error(`Invalid path regex: ${metaPathsRegex}`);
          }
        }
      }

      const res = await request(configPath(connId, "subscription.json"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg)
      });

      if (res.ok) {
        onSaved(cfg);
        onNotify("Subscription configuration saved successfully!", "success");
      } else {
        throw new Error("Failed to save configuration");
      }
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("saving subscription")
          : `Error saving subscription: ${e.message}`,
        "error"
      );
    }
  };

  return (
    <Card
      title="Subscription Configuration"
      subtitle="Define which SignalK data paths to subscribe to"
    >
      <div className="form-group">
        <label htmlFor="context">Context:</label>
        <input
          id="context"
          type="text"
          placeholder="*"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
        <small className="help-text">
          Context for the subscription (e.g., "vessels.self", "*" for all)
        </small>
      </div>

      <div className="subscription-paths">
        <h3>Subscription Paths</h3>
        <div className="paths-list">
          {paths.map((p, i) => (
            <div key={i} className="path-item">
              <input
                type="text"
                className="path-input"
                value={p}
                placeholder="navigation.position"
                onChange={(e) => {
                  const updated = [...paths];
                  updated[i] = e.target.value;
                  setPaths(updated);
                }}
              />
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setPaths(paths.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setPaths([...paths, ""])}
        >
          Add Path
        </button>
      </div>

      <fieldset className="meta-config">
        <legend>Metadata streaming</legend>
        <p className="help-text">
          Also forward Signal K path metadata to the remote receiver. Disabled by default.
        </p>
        <div className="form-group">
          <label>
            <input
              type="checkbox"
              id="metaEnabled"
              checked={metaEnabled}
              onChange={(e) => setMetaEnabled(e.target.checked)}
            />{" "}
            Include metadata
          </label>
        </div>
        <div className="form-group">
          <label htmlFor="metaIntervalSec">Snapshot interval (seconds):</label>
          <input
            id="metaIntervalSec"
            type="number"
            min={30}
            max={86400}
            step={1}
            placeholder="300"
            value={Number.isFinite(metaIntervalSec) ? metaIntervalSec : ""}
            onChange={(e) => setMetaIntervalSec(Number(e.target.value))}
          />
          <small className="help-text">Between 30 and 86400. Default 300 (5 minutes).</small>
        </div>
        <div className="form-group">
          <label htmlFor="metaPathsRegex">Include paths matching (regex, optional):</label>
          <input
            id="metaPathsRegex"
            type="text"
            placeholder=""
            value={metaPathsRegex}
            onChange={(e) => setMetaPathsRegex(e.target.value)}
          />
          <small className="help-text">Leave empty to include every subscribed path.</small>
        </div>
        <div className="form-group">
          <label htmlFor="metaMaxPerPacket">Max paths per packet:</label>
          <input
            id="metaMaxPerPacket"
            type="number"
            min={10}
            max={5000}
            step={1}
            placeholder="500"
            value={Number.isFinite(metaMaxPerPacket) ? metaMaxPerPacket : ""}
            onChange={(e) => setMetaMaxPerPacket(Number(e.target.value))}
          />
          <small className="help-text">Between 10 and 5000. Default 500.</small>
        </div>
      </fieldset>

      <div className="json-editor">
        <h3>JSON Editor</h3>
        <textarea
          id="subscriptionJson"
          rows={10}
          placeholder='{"context": "*", "subscribe": [{"path": "*"}]}'
          value={jsonText}
          onChange={(e) => handleJsonChange(e.target.value)}
        />
        <small className="help-text">Advanced: Edit the raw JSON configuration</small>
      </div>

      <button className="btn btn-primary" onClick={handleSave}>
        Save Subscription
      </button>
    </Card>
  );
}
