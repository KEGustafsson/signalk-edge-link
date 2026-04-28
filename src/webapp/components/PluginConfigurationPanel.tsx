import React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { RJSFSchema, UiSchema, getDefaultFormState } from "@rjsf/utils";
import { apiFetch, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "../utils/apiFetch";
import { buildWebappConnectionSchema } from "../../shared/connection-schema";

const API_BASE = "/plugins/signalk-edge-link";

// ── Stable ID helper ──────────────────────────────────────────────────────────
// Each connection object carries a frontend-only `_id` for use as React key.
// `connectionId` is persisted so redacted secrets can survive identity edits.

let _idSeq = 0;
function makeId(): string { return `skel-${Date.now()}-${++_idSeq}`; }

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectionData {
  _id: string;
  connectionId?: string;
  name?: string;
  serverType?: string;
  udpPort?: number;
  secretKey?: string;
  stretchAsciiKey?: boolean;
  useMsgpack?: boolean;
  usePathDictionary?: boolean;
  enableNotifications?: boolean;
  skipOwnData?: boolean;
  protocolVersion?: number;
  udpAddress?: string;
  helloMessageSender?: number;
  testAddress?: string;
  testPort?: number;
  pingIntervalTime?: number;
  [key: string]: unknown;
}

interface SaveStatus {
  type: "saving" | "success" | "error";
  message: string;
}

// ── Default config factories ──────────────────────────────────────────────────

function defaultClientConnection(name?: string): ConnectionData {
  const id = makeId();
  return {
    _id: id,
    connectionId: id,
    name: name || "client",
    serverType: "client",
    udpPort: 4446,
    secretKey: "",
    stretchAsciiKey: false,
    useMsgpack: false,
    usePathDictionary: false,
    enableNotifications: false,
    skipOwnData: false,
    protocolVersion: 1,
    udpAddress: "127.0.0.1",
    helloMessageSender: 60,
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1
  };
}

function defaultServerConnection(name?: string): ConnectionData {
  const id = makeId();
  return {
    _id: id,
    connectionId: id,
    name: name || "server",
    serverType: "server",
    udpPort: 4446,
    secretKey: "",
    stretchAsciiKey: false,
    useMsgpack: false,
    usePathDictionary: false,
    protocolVersion: 1
  };
}

/** Attach a stable _id to loaded connections that don't already have one. */
function withId(conn: Omit<ConnectionData, "_id"> & { _id?: string }): ConnectionData {
  const connectionId =
    typeof conn.connectionId === "string" && conn.connectionId.trim()
      ? conn.connectionId.trim()
      : conn._id || makeId();
  return {
    ...conn,
    _id: conn._id || connectionId,
    connectionId
  } as ConnectionData;
}

// Fill schema defaults into loaded form data so RJSF has nothing to augment on
// mount — otherwise RJSF fires a synthetic onChange for every field that is
// defined in the schema but absent from the persisted config (e.g.
// stretchAsciiKey on pre-existing connections), which would trip the dirty flag
// and surface "Unsaved changes" immediately after a fresh load.
function withSchemaDefaults(conn: ConnectionData): ConnectionData {
  const isClient = conn.serverType !== "server";
  const schema = buildWebappConnectionSchema(isClient, conn.protocolVersion) as RJSFSchema;
  const { _id, ...formData } = conn;
  const enriched = getDefaultFormState(validator, schema, formData) as Record<string, unknown>;
  return { ...(enriched as Omit<ConnectionData, "_id">), _id };
}

// Deep equality that is insensitive to key insertion order (unlike
// JSON.stringify). Used to decide whether an RJSF onChange carries a real
// field-level difference.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function connectionsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) { return false; }
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) { return false; }
    const av = a[k];
    const bv = b[k];
    if (av === bv) { continue; }
    if (av !== null && bv !== null && typeof av === "object" && typeof bv === "object") {
      if (stableStringify(av) !== stableStringify(bv)) { return false; }
      continue;
    }
    return false;
  }
  return true;
}

// ── Schema ────────────────────────────────────────────────────────────────────
// Single source of truth for field definitions: src/shared/connection-schema.ts
// (also consumed by plugin.schema in src/index.ts).

const uiSchemaClient: UiSchema = {
  "ui:order": [
    "name", "serverType", "udpAddress", "udpPort", "secretKey", "stretchAsciiKey", "protocolVersion",
    "useMsgpack", "usePathDictionary", "testAddress", "testPort", "pingIntervalTime",
    "helloMessageSender", "heartbeatInterval", "reliability", "congestionControl", "bonding", "skipOwnData", "enableNotifications", "alertThresholds"
  ],
  secretKey: { "ui:widget": "password", "ui:help": "Use 32-character ASCII, 64-character hex, or 44-character base64" },
  stretchAsciiKey: { "ui:help": "Only applies to 32-char ASCII keys. Must match on both peers." },
  serverType: { "ui:widget": "select" },
  reliability: {
    "ui:classNames": "skel-optional-group"
  },
  congestionControl: {
    "ui:classNames": "skel-optional-group"
  },
  bonding: {
    "ui:classNames": "skel-optional-group"
  },
  alertThresholds: {
    "ui:classNames": "skel-optional-group"
  }
};

const uiSchemaServer: UiSchema = {
  "ui:order": [
    "name", "serverType", "udpPort", "secretKey", "stretchAsciiKey", "useMsgpack", "usePathDictionary",
    "protocolVersion", "reliability"
  ],
  secretKey: { "ui:widget": "password", "ui:help": "Use 32-character ASCII, 64-character hex, or 44-character base64" },
  stretchAsciiKey: { "ui:help": "Only applies to 32-char ASCII keys. Must match on both peers." },
  serverType: { "ui:widget": "select" }
};

// Shared fields preserved when the user toggles server <-> client mode
const SHARED_FIELDS = ["name", "udpPort", "secretKey", "stretchAsciiKey", "useMsgpack", "usePathDictionary", "protocolVersion"];

// ── Styles ────────────────────────────────────────────────────────────────────
// Using `skel-` prefix (Signal K Edge Link) to avoid collisions with other
// plugins that may inject CSS into the same admin panel page.

const css = `
.skel-config { font-family: inherit; }
.skel-dirty-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: #fff3cd;
  color: #664d03;
  border: 1px solid #ffe69c;
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 0.88rem;
}
.skel-card {
  border: 1px solid #dee2e6;
  border-radius: 6px;
  margin-bottom: 12px;
  overflow: hidden;
}
.skel-card-header {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: #f8f9fa;
  cursor: pointer;
  user-select: none;
  gap: 10px;
}
.skel-card-header:hover { background: #e9ecef; }
.skel-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.skel-badge-server { background: #cfe2ff; color: #084298; }
.skel-badge-client { background: #d1e7dd; color: #0a3622; }
.skel-card-title { font-weight: 600; flex: 1; }
.skel-expand-icon { font-size: 0.8rem; color: #6c757d; }
.skel-btn-remove {
  background: none;
  border: 1px solid #dc3545;
  color: #dc3545;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.8rem;
  cursor: pointer;
}
.skel-btn-remove:hover { background: #dc3545; color: white; }
.skel-btn-remove:disabled { opacity: 0.4; cursor: default; border-color: #aaa; color: #aaa; }
.skel-btn-remove:disabled:hover { background: none; }
.skel-card-body { padding: 16px; border-top: 1px solid #dee2e6; }
.skel-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #dee2e6;
  flex-wrap: wrap;
}
.skel-btn {
  padding: 7px 16px;
  border-radius: 4px;
  font-size: 0.95rem;
  cursor: pointer;
  border: none;
}
.skel-btn-primary { background: #0d6efd; color: white; }
.skel-btn-primary:hover { background: #0b5ed7; }
.skel-btn-primary:disabled { background: #6c757d; cursor: default; }
.skel-btn-secondary { background: white; color: #0d6efd; border: 1px solid #0d6efd; }
.skel-btn-secondary:hover { background: #e7f0ff; }
.skel-alert {
  padding: 10px 14px;
  border-radius: 4px;
  margin-bottom: 14px;
  font-size: 0.9rem;
}
.skel-alert-success { background: #d1e7dd; color: #0a3622; border: 1px solid #a3cfbb; }
.skel-alert-error   { background: #f8d7da; color: #58151c; border: 1px solid #f1aeb5; }
.skel-alert-saving  { background: #fff3cd; color: #664d03; border: 1px solid #ffe69c; }
.skel-dup-warn { font-size: 0.8rem; color: #dc3545; margin-top: 4px; }
.skel-plugin-settings {
  border: 1px solid #dee2e6;
  border-radius: 6px;
  margin-bottom: 20px;
  padding: 16px;
  background: #f8f9fa;
}
.skel-plugin-settings h3 {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 600;
}
.skel-field-group {
  margin-bottom: 14px;
}
.skel-field-group label {
  display: block;
  font-weight: 500;
  margin-bottom: 4px;
  font-size: 0.9rem;
}
.skel-field-group input[type="text"],
.skel-field-group input[type="password"] {
  width: 100%;
  max-width: 420px;
  padding: 6px 10px;
  border: 1px solid #ced4da;
  border-radius: 4px;
  font-size: 0.9rem;
}
.skel-field-group input[type="checkbox"] {
  margin-right: 6px;
}
.skel-field-desc {
  font-size: 0.8rem;
  color: #5c6773;
  margin-top: 3px;
}
.skel-config .field-description {
  color: #5c6773;
  font-size: 0.83rem;
  line-height: 1.35;
}
.skel-config legend,
.skel-config label {
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.skel-optional-group {
  margin-top: 12px;
  border: 1px dashed #ccd5df;
  border-radius: 6px;
  padding: 10px 12px 4px;
  background: #fbfcfe;
}
.skel-optional-group legend {
  font-size: 0.92rem;
  margin-bottom: 6px;
}
.skel-optional-group .form-group {
  margin-bottom: 10px;
}
.skel-optional-group .form-control {
  max-width: 340px;
}
`;

// ── ConnectionCard ────────────────────────────────────────────────────────────

interface ConnectionCardProps {
  conn: ConnectionData;
  index: number;
  totalCount: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (data: ConnectionData) => void;
  onRemove: () => void;
}

function ConnectionCard({ conn, index, totalCount, expanded, onToggle, onChange, onRemove }: ConnectionCardProps) {
  const isClient = conn.serverType !== "server";
  const schema = buildWebappConnectionSchema(isClient, conn.protocolVersion) as RJSFSchema;
  const uiSchema = isClient ? uiSchemaClient : uiSchemaServer;
  const modeLabel = isClient ? "Client" : "Server";
  const displayName = (conn.name || `Connection ${index + 1}`).trim();

  function handleFormChange(e: any) {
    const next: ConnectionData = e.formData;
    if (next.serverType !== conn.serverType) {
      const base = next.serverType === "server"
        ? defaultServerConnection(next.name)
        : defaultClientConnection(next.name);
      const merged: ConnectionData = {
        ...base,
        _id: conn._id,
        connectionId: conn.connectionId || conn._id
      };
      for (const k of SHARED_FIELDS) {
        if (next[k] !== undefined) { (merged as Record<string, unknown>)[k] = next[k]; }
      }
      merged.serverType = next.serverType;
      onChange(merged);
      return;
    }
    // Skip propagation when the incoming form data is identical to the current
    // connection — RJSF can fire onChange with no effective diff (e.g. after
    // internal re-renders), and we do not want that to trip the dirty flag.
    // Order-insensitive compare so a reshuffled-but-equivalent formData does
    // not look like a real edit.
    const proposed: ConnectionData = {
      ...next,
      _id: conn._id,
      connectionId: next.connectionId || conn.connectionId || conn._id
    };
    const { _id: _aId, ...a } = proposed;
    const { _id: _bId, ...b } = conn;
    if (connectionsEqual(a, b)) { return; }
    onChange(proposed);
  }

  // Strip the frontend-only _id before passing to RJSF
  const { _id, ...formData } = conn;

  return (
    <div className="skel-card">
      <div className="skel-card-header" onClick={onToggle} role="button" aria-expanded={expanded}>
        <span className={`skel-badge ${isClient ? "skel-badge-client" : "skel-badge-server"}`}>
          {modeLabel}
        </span>
        <span className="skel-card-title">{displayName}</span>
        <span className="skel-expand-icon">{expanded ? "\u25B2" : "\u25BC"}</span>
        <button
          className="skel-btn-remove"
          disabled={totalCount <= 1}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title={totalCount <= 1 ? "Cannot remove the only connection" : "Remove this connection"}
        >
          Remove
        </button>
      </div>
      {expanded && (
        <div className="skel-card-body">
          <Form
            schema={schema}
            uiSchema={uiSchema}
            formData={formData}
            validator={validator}
            onChange={handleFormChange}
            onSubmit={() => {}}
            liveValidate={false}
          >
            {/* Hide the default submit button – saving is done from the outer toolbar */}
            <div />
          </Form>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

function PluginConfigurationPanel(_props: Record<string, unknown>) {
  const [connections, setConnections] = useState<ConnectionData[]>([]);
  const [managementApiToken, setManagementApiToken] = useState<string>("");
  const [requireManagementApiToken, setRequireManagementApiToken] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [inlineValidationMessage, setInlineValidationMessage] = useState<string | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [isDirty, setIsDirty] = useState(false);
  const savingRef = useRef(false);

  // ── Load config ─────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch(`${API_BASE}/plugin-config`);
        if (res.status === 401) {
          throw new Error(MANAGEMENT_TOKEN_ERROR_MESSAGE);
        }
        if (!res.ok) { throw new Error(`HTTP ${res.status}: ${res.statusText}`); }
        const body = await res.json();
        if (!body.success) { throw new Error(body.error || "Failed to load configuration"); }

        const cfg = body.configuration || {};
        let list: ConnectionData[];
        if (Array.isArray(cfg.connections) && cfg.connections.length > 0) {
          list = cfg.connections.map((c: Omit<ConnectionData, "_id">) => withSchemaDefaults(withId(c)));
        } else if (cfg.serverType) {
          list = [withSchemaDefaults(withId(cfg))];
        } else {
          list = [defaultClientConnection()];
        }
        setConnections(list);
        setManagementApiToken(typeof cfg.managementApiToken === "string" ? cfg.managementApiToken : "");
        setRequireManagementApiToken(cfg.requireManagementApiToken === true);
        setExpandedIndex(0);
        setIsDirty(false);
      } catch (err: unknown) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Duplicate server-port detection ─────────────────────────────────────────
  const serverPorts = connections
    .filter((c) => c.serverType === "server")
    .map((c) => c.udpPort);
  const duplicatePortSet = new Set(
    serverPorts.filter((p, i) => serverPorts.indexOf(p) !== i)
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  function markDirty() {
    setIsDirty(true);
    setSaveStatus(null);
    setInlineValidationMessage(null);
  }

  function updateConnection(idx: number, data: ConnectionData) {
    setConnections((prev) => prev.map((c, i) => (i === idx ? data : c)));
    markDirty();
  }

  function addServer() {
    setConnections((prev) => {
      const next = [...prev, defaultServerConnection(`server-${prev.length + 1}`)];
      setExpandedIndex(next.length - 1);
      return next;
    });
    markDirty();
  }

  function addClient() {
    setConnections((prev) => {
      const next = [...prev, defaultClientConnection(`client-${prev.length + 1}`)];
      setExpandedIndex(next.length - 1);
      return next;
    });
    markDirty();
  }

  function removeConnection(idx: number) {
    setConnections((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== idx);
      setExpandedIndex((prevExpanded) => (prevExpanded !== null && prevExpanded >= idx && prevExpanded > 0 ? prevExpanded - 1 : prevExpanded));
      return next;
    });
    markDirty();
  }

  function toggleExpand(idx: number) {
    setExpandedIndex((prev) => (prev === idx ? null : idx));
  }

  const handleSave = useCallback(async () => {
    if (savingRef.current) { return; }
    if (connections.length === 0) {
      setInlineValidationMessage("At least one connection is required before saving.");
      setSaveStatus({
        type: "error",
        message: "Cannot save an empty configuration. Add at least one connection."
      });
      return;
    }

    setInlineValidationMessage(null);
    if (duplicatePortSet.size > 0) {
      setSaveStatus({
        type: "error",
        message: `Duplicate server ports detected: ${[...duplicatePortSet].join(", ")}. Each server must use a unique UDP port.`
      });
      return;
    }

    savingRef.current = true;
    setSaveStatus({ type: "saving", message: "Saving configuration..." });
    try {
      const payload = connections.map(({ _id, ...rest }) => ({
        ...rest,
        connectionId:
          typeof rest.connectionId === "string" && rest.connectionId.trim()
            ? rest.connectionId.trim()
            : _id
      }));
      const res = await apiFetch(`${API_BASE}/plugin-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connections: payload,
          managementApiToken: managementApiToken,
          requireManagementApiToken: requireManagementApiToken
        })
      });
      if (res.status === 401) {
        throw new Error(MANAGEMENT_TOKEN_ERROR_MESSAGE);
      }
      const body = await res.json();
      if (res.ok && body.success) {
        setSaveStatus({ type: "success", message: body.message || "Configuration saved. Plugin restarting..." });
        setIsDirty(false);
      } else {
        throw new Error(body.error || "Failed to save");
      }
    } catch (err: unknown) {
      setSaveStatus({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      savingRef.current = false;
    }
  }, [connections, duplicatePortSet, managementApiToken, requireManagementApiToken]);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) {
    return <div style={{ padding: "20px", textAlign: "center" }}>Loading configuration...</div>;
  }

  if (loadError) {
    return (
      <div style={{ padding: "20px" }}>
        <div className="skel-alert skel-alert-error">
          <strong>Error loading configuration:</strong> {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="skel-config">
      <style>{css}</style>

      {isDirty && saveStatus?.type !== "saving" && (
        <div className="skel-dirty-banner">
          <span>&#9888;</span>
          <span>You have unsaved changes.</span>
        </div>
      )}

      {saveStatus && (
        <div className={`skel-alert skel-alert-${saveStatus.type === "saving" ? "saving" : saveStatus.type === "success" ? "success" : "error"}`}>
          {saveStatus.message}
        </div>
      )}

      {/* Plugin-level security settings */}
      <div className="skel-plugin-settings">
        <h3>Plugin Security Settings</h3>
        <div className="skel-field-group">
          <label htmlFor="skel-mgmt-token">Management API Token</label>
          <input
            id="skel-mgmt-token"
            type="password"
            value={managementApiToken}
            placeholder="Leave empty for open access"
            onChange={(e) => { setManagementApiToken(e.target.value); markDirty(); }}
            autoComplete="new-password"
          />
          <div className="skel-field-desc">
            Shared secret to protect the management API endpoints. Strongly recommended for
            production. Can also be set via the{" "}
            <code>SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN</code> environment variable (env var takes
            priority). Leave empty to allow open access.
          </div>
        </div>
        <div className="skel-field-group">
          <label>
            <input
              type="checkbox"
              checked={requireManagementApiToken}
              onChange={(e) => { setRequireManagementApiToken(e.target.checked); markDirty(); }}
            />
            Require Management API Token
          </label>
          <div className="skel-field-desc">
            When enabled, all management API requests are rejected if no token is configured
            (fail-closed). When disabled, requests are allowed if no token is set (open access).
          </div>
        </div>
      </div>

      {connections.map((conn, idx) => (
        <div key={conn._id}>
          <ConnectionCard
            conn={conn}
            index={idx}
            totalCount={connections.length}
            expanded={expandedIndex === idx}
            onToggle={() => toggleExpand(idx)}
            onChange={(data: ConnectionData) => updateConnection(idx, data)}
            onRemove={() => removeConnection(idx)}
          />
          {conn.serverType === "server" && duplicatePortSet.has(conn.udpPort) && (
            <div className="skel-dup-warn">
              Port {conn.udpPort} is used by multiple server connections. Each server requires a unique port.
            </div>
          )}
        </div>
      ))}

      <div className="skel-toolbar">
        <button className="skel-btn skel-btn-secondary" onClick={addServer}>
          + Add Server
        </button>
        <button className="skel-btn skel-btn-secondary" onClick={addClient}>
          + Add Client
        </button>
        <button
          className="skel-btn skel-btn-primary"
          onClick={handleSave}
          disabled={(saveStatus && saveStatus.type === "saving") || connections.length === 0}
        >
          {isDirty ? "Save Changes" : "Save Configuration"}
        </button>
        {inlineValidationMessage && (
          <span style={{ color: "#dc3545", fontSize: "0.85rem", fontWeight: 500 }}>
            {inlineValidationMessage}
          </span>
        )}
        <span style={{ fontSize: "0.85rem", color: "#6c757d" }}>
          {connections.length} connection{connections.length !== 1 ? "s" : ""}
          {" \u00B7 "}
          {connections.filter((c) => c.serverType === "server").length} server
          {connections.filter((c) => c.serverType === "server").length !== 1 ? "s" : ""}
          {", "}
          {connections.filter((c) => c.serverType !== "server").length} client
          {connections.filter((c) => c.serverType !== "server").length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

export default PluginConfigurationPanel;
