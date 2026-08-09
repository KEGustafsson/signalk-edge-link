import React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { RJSFSchema, UiSchema, ValidatorType, getDefaultFormState } from "@rjsf/utils";
import { apiFetch, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "../utils/apiFetch";
import { readErrorMessage } from "../hooks/useApi";
import {
  buildWebappConnectionSchema,
  commonConnectionProperties
} from "../../shared/connection-schema";
import { ErrorBoundary } from "./ErrorBoundary";
// API_BASE is a plain string constant bundled into the federated remote (it is
// not a shared singleton), so importing it from utils is safe.
import { API_BASE } from "../utils";
// Type-only import (erased at build time, so it adds no runtime coupling to the
// federated remote) — derive the UI connection type from the canonical backend
// config shape so the form is typed against the real fields.
import type { ConnectionConfig } from "../../foundation/types/config";

// ── Stable ID helper ──────────────────────────────────────────────────────────
// Each connection object carries a frontend-only `_id` for use as React key.
// `connectionId` is persisted so redacted secrets can survive identity edits.

let _idSeq = 0;
function makeId(): string {
  return `skel-${Date.now()}-${++_idSeq}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

// Derived from the canonical ConnectionConfig so the known fields (including
// bonding, congestionControl, reliability, alertThresholds, pathFilter, the
// reliable-only toggles, etc.) are typed against the backend truth. `_id` is a
// frontend-only React key; `serverType` is widened to string because the form
// holds in-progress values, and the index signature keeps RJSF-driven extras
// permissive.
type ConnectionData = Partial<Omit<ConnectionConfig, "serverType">> & {
  _id: string;
  serverType?: string;
  [key: string]: unknown;
};

type ConnectionFormData = Partial<ConnectionData> & Record<string, unknown>;

interface ConnectionFormChangeEvent {
  formData?: ConnectionFormData;
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
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
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
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) {
      return false;
    }
    const av = a[k];
    const bv = b[k];
    if (av === bv) {
      continue;
    }
    if (av !== null && bv !== null && typeof av === "object" && typeof bv === "object") {
      if (stableStringify(av) !== stableStringify(bv)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

// ── Schema ────────────────────────────────────────────────────────────────────
// Single source of truth for field definitions: src/shared/connection-schema.ts
// (also consumed by plugin.schema in src/index.ts).

// `ui:order` must cover EVERY property the schema can produce: RJSF throws
// "uiSchema order list does not contain property 'x'" and the whole panel fails
// to render. The trailing "*" is the guard — it absorbs any property not named
// explicitly, so adding a field to the shared schema can never again break the
// config UI. Named entries still control the order; "*" only decides where the
// unnamed remainder lands. `__tests__/PluginConfigurationPanel.test.js` asserts
// full explicit coverage so new fields get placed deliberately rather than
// silently drifting to the end.
const uiSchemaClient: UiSchema = {
  "ui:order": [
    // Hidden (see the connectionId ui:widget below), but ui:order must still
    // list every schema property or RJSF throws.
    "connectionId",
    "name",
    "serverType",
    "udpAddress",
    "udpPort",
    "secretKey",
    "stretchAsciiKey",
    "authenticatedHeaders",
    "epochBoundAuth",
    "protocolVersion",
    "useMsgpack",
    "useValueDedup",
    "useCompactDeltas",
    "pathFilter",
    "brotliQuality",
    "pathPrecision",
    "pathThrottle",
    "usePathDictionary",
    "testAddress",
    "testPort",
    "pingIntervalTime",
    "helloMessageSender",
    "heartbeatInterval",
    "reliability",
    "congestionControl",
    "bonding",
    "skipOwnData",
    "enableNotifications",
    "alertThresholds",
    "*"
  ],
  // Assigned automatically to keep a connection identifiable across saves;
  // nothing for an operator to set, so it is not rendered.
  connectionId: { "ui:widget": "hidden" },
  secretKey: {
    "ui:widget": "password",
    "ui:help": "Use 32-character ASCII, 64-character hex, or base64 (standard or URL-safe)"
  },
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
  // Sender-only fields (useValueDedup, useCompactDeltas, pathFilter,
  // brotliQuality, pathPrecision, pathThrottle) are deliberately absent: a
  // server connection no longer offers them, so listing them here described a
  // form that cannot be rendered.
  "ui:order": [
    // Hidden (see the connectionId ui:widget below), but ui:order must still
    // list every schema property or RJSF throws.
    "connectionId",
    "name",
    "serverType",
    "udpPort",
    "secretKey",
    "stretchAsciiKey",
    "authenticatedHeaders",
    "epochBoundAuth",
    "useMsgpack",
    "usePathDictionary",
    "protocolVersion",
    "requestFullStatusOnRestart",
    "reliability",
    "*"
  ],
  // Assigned automatically to keep a connection identifiable across saves;
  // nothing for an operator to set, so it is not rendered.
  connectionId: { "ui:widget": "hidden" },
  secretKey: {
    "ui:widget": "password",
    "ui:help": "Use 32-character ASCII, 64-character hex, or base64 (standard or URL-safe)"
  },
  stretchAsciiKey: { "ui:help": "Only applies to 32-char ASCII keys. Must match on both peers." },
  serverType: { "ui:widget": "select" }
};

// Fields preserved when the user toggles server <-> client mode.
//
// Derived from the shared schema rather than hand-maintained: a hardcoded list
// silently dropped useValueDedup, useCompactDeltas, pathFilter, brotliQuality,
// pathPrecision and pathThrottle, so toggling mode and back destroyed the
// operator's entire path-tuning configuration with no warning.
const SHARED_FIELDS = ["name", ...Object.keys(commonConnectionProperties)];

// Boolean toggles that, when on, mean the connection is using advanced options.
// Every advanced boolean the panel can render. `connectionUsesAdvanced` walks
// this list to decide whether to open the Advanced section, so a key missing
// here makes the panel claim a connection is at defaults when it is not —
// which matters most for the two security/recovery flags, whose whole point is
// that both peers agree about them.
const ADVANCED_BOOL_KEYS = [
  "stretchAsciiKey",
  "authenticatedHeaders",
  "epochBoundAuth",
  "useMsgpack",
  "useValueDedup",
  "useCompactDeltas",
  "usePathDictionary",
  "skipOwnData",
  "enableNotifications",
  "requestFullStatusOnRestart"
];

// Object groups that, when present and non-empty, mean advanced options are set.
const ADVANCED_OBJECT_KEYS = [
  "pathFilter",
  "pathPrecision",
  "pathThrottle",
  "reliability",
  "congestionControl",
  "bonding",
  "alertThresholds"
];

// Scalar fields that count as advanced when they differ from the schema
// default. Only the names matter: the comparison value comes from
// `schemaDefaultsFor`, which derives it from the live schema, so listing
// literals here would be a second copy free to drift out of step with it.
const ADVANCED_SCALAR_KEYS = [
  "brotliQuality",
  "helloMessageSender",
  "heartbeatInterval",
  "testAddress",
  "testPort",
  "pingIntervalTime"
];

/**
 * Decide whether a loaded connection already uses advanced options, so the
 * Advanced section starts expanded instead of hiding settings the user has
 * deliberately configured.
 *
 * Compares each advanced key against the value RJSF would materialize from the
 * schema for an otherwise-bare connection of the same mode/protocol. Anything
 * equal to its schema default was filled in by `withSchemaDefaults` on load and
 * does not indicate operator intent.
 *
 * Getting this wrong is easy and was: an earlier version treated any `true`
 * boolean as advanced, and `authenticatedHeaders` defaults to `true`, so every
 * loaded connection reported "uses advanced options" and the progressive
 * disclosure never engaged for anything but a brand-new card.
 */
function schemaDefaultsFor(conn: ConnectionData): Record<string, unknown> {
  const isClient = conn.serverType !== "server";
  const schema = buildWebappConnectionSchema(isClient, conn.protocolVersion) as RJSFSchema;
  const bare: Record<string, unknown> = {
    serverType: conn.serverType,
    protocolVersion: conn.protocolVersion
  };
  try {
    return getDefaultFormState(validator, schema, bare) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function connectionUsesAdvanced(conn: ConnectionData): boolean {
  const c = conn as Record<string, unknown>;
  const defaults = schemaDefaultsFor(conn);

  const differsFromDefault = (key: string): boolean => {
    const value = c[key];
    if (value === undefined) return false;
    return stableStringify(value) !== stableStringify(defaults[key]);
  };

  for (const key of ADVANCED_BOOL_KEYS) {
    if (differsFromDefault(key)) return true;
  }
  for (const key of ADVANCED_OBJECT_KEYS) {
    if (differsFromDefault(key)) return true;
  }
  for (const key of ADVANCED_SCALAR_KEYS) {
    if (key === "testAddress") continue;
    if (differsFromDefault(key)) return true;
  }
  if (typeof c.testAddress === "string" && c.testAddress !== "127.0.0.1") return true;
  return false;
}

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
  user-select: none;
  gap: 10px;
}
.skel-card-header:hover { background: #e9ecef; }
/* The toggle is a real button so it is keyboard-focusable; strip the native
   chrome so it still reads as a card header. */
.skel-card-header-toggle {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 10px;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.skel-card-header-toggle:focus-visible { outline: 2px solid #0066cc; outline-offset: 2px; }
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
.skel-advanced-toggle {
  margin-top: 8px;
  background: none;
  border: none;
  color: #0d6efd;
  font-size: 0.88rem;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 0;
}
.skel-advanced-toggle:hover { text-decoration: underline; }
.skel-advanced-hint {
  margin-top: 4px;
  font-size: 0.8rem;
  color: #5c6773;
  max-width: 560px;
}
.skel-intro {
  font-size: 0.86rem;
  color: #5c6773;
  margin: 0 0 14px;
  line-height: 1.4;
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

function ConnectionCard({
  conn,
  index,
  totalCount,
  expanded,
  onToggle,
  onChange,
  onRemove
}: ConnectionCardProps) {
  const isClient = conn.serverType !== "server";
  // Start expanded only when the connection already carries advanced options;
  // otherwise keep the form to the essentials so it is easy to approach.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(() => connectionUsesAdvanced(conn));
  const schema = buildWebappConnectionSchema(
    isClient,
    conn.protocolVersion,
    showAdvanced
  ) as RJSFSchema;
  const uiSchema = isClient ? uiSchemaClient : uiSchemaServer;
  const modeLabel = isClient ? "Client" : "Server";
  const displayName = (conn.name || `Connection ${index + 1}`).trim();

  function handleFormChange(e: ConnectionFormChangeEvent) {
    const next = e.formData;
    if (!next) {
      return;
    }
    if (next.serverType && next.serverType !== conn.serverType) {
      const base =
        next.serverType === "server"
          ? defaultServerConnection(next.name)
          : defaultClientConnection(next.name);
      const merged: ConnectionData = {
        ...base,
        _id: conn._id,
        connectionId: conn.connectionId || conn._id
      };
      for (const k of SHARED_FIELDS) {
        if (next[k] !== undefined) {
          (merged as Record<string, unknown>)[k] = next[k];
        }
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
    //
    // Merge only the keys the ACTIVE schema manages. In the basic (advanced
    // collapsed) view the form does not render advanced fields, so taking
    // `next` wholesale would discard the connection's hidden advanced settings.
    // Starting from `conn` and overlaying only managed keys preserves them.
    const managedKeys = Object.keys(
      (schema as { properties?: Record<string, unknown> }).properties || {}
    );
    const proposed: ConnectionData = { ...conn };
    const proposedRecord = proposed as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    for (const key of managedKeys) {
      if (key === "_id") {
        continue;
      }
      if (nextRecord[key] === undefined) {
        delete proposedRecord[key];
      } else {
        proposedRecord[key] = nextRecord[key];
      }
    }
    proposed._id = conn._id;
    proposed.connectionId =
      (typeof next.connectionId === "string" && next.connectionId.trim()) ||
      conn.connectionId ||
      conn._id;
    // Keep version-gated fields consistent with the selected protocol so the
    // field-preserving merge above can never leave a stale flag that the
    // backend validator rejects (which would make the connection unsaveable):
    //   • v1-only ping-monitor fields must be absent on v2/v3 clients, and
    //   • the v3-only codec flags (useValueDedup / useCompactDeltas) must be
    //     absent on v1 — otherwise a v3 → v1 downgrade carries them forward.
    const isClientNow = proposed.serverType !== "server";
    const protocolNow = Number(proposed.protocolVersion ?? 1);
    if (isClientNow && protocolNow >= 2) {
      delete proposed.testAddress;
      delete proposed.testPort;
      delete proposed.pingIntervalTime;
    }
    if (protocolNow < 2) {
      delete proposed.useValueDedup;
      delete proposed.useCompactDeltas;
    }
    const { _id: _aId, ...a } = proposed;
    const { _id: _bId, ...b } = conn;
    if (connectionsEqual(a, b)) {
      return;
    }
    onChange(proposed);
  }

  // Strip the frontend-only _id before passing to RJSF
  const { _id, ...formData } = conn;

  return (
    <div className="skel-card">
      {/*
        The expand/collapse control is a real <button>, and Remove is a sibling
        rather than a descendant. Previously the header was a div with
        role="button" but no tabIndex or key handler \u2014 so no keyboard-only
        operator could expand a connection card at all \u2014 and it nested an
        interactive <button> inside another button role, which is invalid ARIA.
      */}
      <div className="skel-card-header">
        <button
          type="button"
          className="skel-card-header-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className={`skel-badge ${isClient ? "skel-badge-client" : "skel-badge-server"}`}>
            {modeLabel}
          </span>
          <span className="skel-card-title">{displayName}</span>
          <span className="skel-expand-icon" aria-hidden="true">
            {expanded ? "\u25B2" : "\u25BC"}
          </span>
        </button>
        <button
          type="button"
          className="skel-btn-remove"
          disabled={totalCount <= 1}
          onClick={onRemove}
          title={totalCount <= 1 ? "Cannot remove the only connection" : "Remove this connection"}
        >
          Remove
        </button>
      </div>
      {expanded && (
        <div className="skel-card-body">
          {/* RJSF infers the Form's data generic from `formData`/`onChange`,
              which narrows it to ConnectionFormData. Under tsconfig strict mode
              that makes the default-generic (`any`) uiSchema/validator props
              incompatible. Cast these two props so the strict build passes
              without restructuring RJSF's generic plumbing. */}
          <Form
            schema={schema}
            uiSchema={uiSchema as UiSchema<ConnectionFormData>}
            formData={formData}
            validator={validator as typeof validator & ValidatorType<ConnectionFormData>}
            onChange={handleFormChange}
            onSubmit={() => {}}
            liveValidate={false}
          >
            {/* Hide the default submit button – saving is done from the outer toolbar */}
            <div />
          </Form>
          <button
            type="button"
            className="skel-advanced-toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▲ Hide advanced settings" : "▼ Show advanced settings"}
          </button>
          {!showAdvanced && (
            <div className="skel-advanced-hint">
              Compression, reliability, bonding, congestion control and per-path tuning are hidden.
              Defaults work for most setups — open advanced settings only if you need them.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

function PluginConfigurationPanelInner(_props: Record<string, unknown>) {
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
        if (!res.ok) {
          // Prefer the server's own explanation. A 403 here is the fail-closed
          // lockout (`requireManagementApiToken` on, no token set) and its body
          // says how to get back in; rendering "HTTP 403: Forbidden" instead
          // left the operator who just locked themselves out with no next step.
          throw new Error(await readErrorMessage(res, `HTTP ${res.status}: ${res.statusText}`));
        }
        const body = await res.json();
        if (!body.success) {
          throw new Error(body.error || "Failed to load configuration");
        }

        const cfg = body.configuration || {};
        let list: ConnectionData[];
        if (Array.isArray(cfg.connections) && cfg.connections.length > 0) {
          list = cfg.connections.map((c: Omit<ConnectionData, "_id">) =>
            withSchemaDefaults(withId(c))
          );
        } else if (cfg.serverType) {
          list = [withSchemaDefaults(withId(cfg))];
        } else {
          list = [defaultClientConnection()];
        }
        setConnections(list);
        setManagementApiToken(
          typeof cfg.managementApiToken === "string" ? cfg.managementApiToken : ""
        );
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
  const serverPorts = connections.filter((c) => c.serverType === "server").map((c) => c.udpPort);
  const duplicatePortSet = new Set(serverPorts.filter((p, i) => serverPorts.indexOf(p) !== i));

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
      setExpandedIndex((prevExpanded) =>
        prevExpanded !== null && prevExpanded >= idx && prevExpanded > 0
          ? prevExpanded - 1
          : prevExpanded
      );
      return next;
    });
    markDirty();
  }

  function toggleExpand(idx: number) {
    setExpandedIndex((prev) => (prev === idx ? null : idx));
  }

  const handleSave = useCallback(async () => {
    if (savingRef.current) {
      return;
    }
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
        setSaveStatus({
          type: "success",
          message: body.message || "Configuration saved. Plugin restarting..."
        });
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

      <p className="skel-intro">
        Add one connection per link — pick <strong>Server mode</strong> to receive data or{" "}
        <strong>Client mode</strong> to send it. Fill in the essentials (address, port, encryption
        key, protocol); both ends must use the same key and protocol. Extra tuning lives under{" "}
        <em>Advanced settings</em> on each connection and is safe to leave at the defaults.
      </p>

      {isDirty && saveStatus?.type !== "saving" && (
        <div className="skel-dirty-banner">
          <span>&#9888;</span>
          <span>You have unsaved changes.</span>
        </div>
      )}

      {saveStatus && (
        <div
          className={`skel-alert skel-alert-${saveStatus.type === "saving" ? "saving" : saveStatus.type === "success" ? "success" : "error"}`}
        >
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
            onChange={(e) => {
              setManagementApiToken(e.target.value);
              markDirty();
            }}
            autoComplete="new-password"
          />
          <div className="skel-field-desc">
            Shared secret to protect the management API endpoints. Strongly recommended for
            production. Can also be set via the <code>SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN</code>{" "}
            environment variable (env var takes priority). Leave empty to allow open access.
          </div>
        </div>
        <div className="skel-field-group">
          <label>
            <input
              type="checkbox"
              checked={requireManagementApiToken}
              onChange={(e) => {
                setRequireManagementApiToken(e.target.checked);
                markDirty();
              }}
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
              Port {conn.udpPort} is used by multiple server connections. Each server requires a
              unique port.
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

// Wrap the federated default export so a render-time crash inside the panel
// shows a recoverable fallback rather than breaking the SignalK admin host UI.
function PluginConfigurationPanel(props: Record<string, unknown>) {
  return (
    <ErrorBoundary>
      <PluginConfigurationPanelInner {...props} />
    </ErrorBoundary>
  );
}

export default PluginConfigurationPanel;
