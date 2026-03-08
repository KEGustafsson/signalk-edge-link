// eslint-disable-next-line no-unused-vars
import React, { useState, useEffect, useCallback, useRef } from "react";
// eslint-disable-next-line no-unused-vars
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { apiFetch, getTokenHelpText, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "../utils/apiFetch";

const API_BASE = "/plugins/signalk-edge-link";

// ── Stable ID helper ──────────────────────────────────────────────────────────
// Each connection object carries a frontend-only `_id` for use as React key.
// It is stripped before the array is POSTed to the backend.

let _idSeq = 0;
function makeId() { return `skel-${Date.now()}-${++_idSeq}`; }

// ── Default config factories ──────────────────────────────────────────────────

function defaultClientConnection(name) {
  return {
    _id: makeId(),
    name: name || "client",
    serverType: "client",
    udpPort: 4446,
    secretKey: "",
    useMsgpack: false,
    usePathDictionary: false,
    enableNotifications: false,
    protocolVersion: 1,
    udpAddress: "127.0.0.1",
    helloMessageSender: 60,
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1
  };
}

function defaultServerConnection(name) {
  return {
    _id: makeId(),
    name: name || "server",
    serverType: "server",
    udpPort: 4446,
    secretKey: "",
    useMsgpack: false,
    usePathDictionary: false,
    enableNotifications: false,
    protocolVersion: 1
  };
}

/** Attach a stable _id to loaded connections that don't already have one. */
function withId(conn) {
  return conn._id ? conn : { ...conn, _id: makeId() };
}

// ── Schema builders ───────────────────────────────────────────────────────────

const commonProperties = {
  name: {
    type: "string",
    title: "Connection Name",
    description: "Human-readable label for this connection (e.g. 'Shore Server', 'Sat Client')",
    default: "connection",
    maxLength: 40
  },
  serverType: {
    type: "string",
    title: "Operation Mode",
    description: "Server: receive incoming data.  Client: send data to a server.",
    default: "client",
    oneOf: [
      { const: "server", title: "Server – Receive Data" },
      { const: "client", title: "Client – Send Data" }
    ]
  },
  udpPort: {
    type: "number",
    title: "UDP Port",
    description: "UDP port for data transmission (must match on both ends)",
    default: 4446,
    minimum: 1024,
    maximum: 65535
  },
  secretKey: {
    type: "string",
    title: "Encryption Key",
    description: "32-byte secret key: 32-character ASCII, 64-character hex, or 44-character base64",
    minLength: 32,
    maxLength: 64,
    pattern: "^(?:.{32}|[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$"
  },
  useMsgpack: {
    type: "boolean",
    title: "Use MessagePack",
    description: "Binary serialization for smaller payloads (must match on both ends)",
    default: false
  },
  usePathDictionary: {
    type: "boolean",
    title: "Use Path Dictionary",
    description: "Encode paths as numeric IDs for bandwidth savings (must match on both ends)",
    default: false
  },
  enableNotifications: {
    type: "boolean",
    title: "Enable Signal K Notifications",
    description: "Emit Signal K notifications for alerts/failover events.",
    default: false
  },
  protocolVersion: {
    type: "number",
    title: "Protocol Version",
    description: "v1: encrypted UDP. v2 adds reliable delivery and metrics. v3 keeps the v2 data path and authenticates control packets (ACK/NAK/HEARTBEAT/HELLO). Must match on both ends.",
    default: 1,
    oneOf: [
      { const: 1, title: "v1 – Standard encrypted UDP" },
      { const: 2, title: "v2 – Reliability, congestion control, bonding, metrics" },
      { const: 3, title: "v3 - v2 features with authenticated control packets" }
    ]
  }
};

const clientProperties = {
  udpAddress: {
    type: "string",
    title: "Server Address",
    description: "Required. IP address or hostname of the remote SignalK endpoint.",
    default: "127.0.0.1"
  },
  helloMessageSender: {
    type: "integer",
    title: "Heartbeat Interval (seconds)",
    description: "Optional tuning. Send periodic heartbeat messages to keep NAT/firewall mappings alive.",
    default: 60,
    minimum: 10,
    maximum: 3600
  },
  testAddress: {
    type: "string",
    title: "Connectivity Test Address",
    description: "Required. Host used for reachability checks (for example 8.8.8.8).",
    default: "127.0.0.1"
  },
  testPort: {
    type: "number",
    title: "Connectivity Test Port",
    description: "Required. Port used for reachability checks (for example 53, 80, or 443).",
    default: 80,
    minimum: 1,
    maximum: 65535
  },
  pingIntervalTime: {
    type: "number",
    title: "Check Interval (minutes)",
    description: "Optional tuning. Frequency of network reachability checks.",
    default: 1,
    minimum: 0.1,
    maximum: 60
  },
  reliability: {
    type: "object",
    title: "Reliability Settings",
    description: "Advanced. Requires Protocol v2 or v3. Controls retransmit queue behavior and retry limits.",
    properties: {
      retransmitQueueSize: {
        type: "number", title: "Retransmit Queue Size",
        description: "Maximum sent packets stored for potential retransmission",
        default: 5000, minimum: 100, maximum: 50000
      },
      maxRetransmits: {
        type: "number", title: "Max Retransmit Attempts",
        description: "Maximum resend attempts before a packet is dropped",
        default: 3, minimum: 1, maximum: 20
      },
      retransmitMaxAge: {
        type: "number", title: "Retransmit Max Age (ms)",
        description: "Expire unacknowledged packets older than this",
        default: 120000, minimum: 1000, maximum: 300000
      },
      retransmitMinAge: {
        type: "number", title: "Retransmit Min Age (ms)",
        description: "Minimum packet age before expiration is allowed",
        default: 10000, minimum: 200, maximum: 30000
      },
      retransmitRttMultiplier: {
        type: "number", title: "RTT Expiry Multiplier",
        description: "Dynamic expiry age = RTT × this multiplier",
        default: 12, minimum: 2, maximum: 20
      },
      ackIdleDrainAge: {
        type: "number", title: "ACK Idle Drain Age (ms)",
        description: "When ACKs are idle beyond this, expiry becomes aggressive",
        default: 20000, minimum: 500, maximum: 30000
      },
      forceDrainAfterAckIdle: {
        type: "boolean", title: "Force Drain After ACK Idle",
        description: "Clear retransmit queue if no ACKs arrive for too long",
        default: false
      },
      forceDrainAfterMs: {
        type: "number", title: "Force Drain Timeout (ms)",
        description: "ACK idle duration before force-draining retransmit queue",
        default: 45000, minimum: 2000, maximum: 120000
      },
      recoveryBurstEnabled: {
        type: "boolean", title: "Recovery Burst Enabled",
        description: "Rapidly retransmit queued packets when ACKs return after outage",
        default: true
      },
      recoveryBurstSize: {
        type: "number", title: "Recovery Burst Size",
        description: "Max queued packets to retransmit per recovery burst cycle",
        default: 100, minimum: 10, maximum: 1000
      },
      recoveryBurstIntervalMs: {
        type: "number", title: "Recovery Burst Interval (ms)",
        description: "Interval between recovery burst cycles",
        default: 200, minimum: 50, maximum: 5000
      },
      recoveryAckGapMs: {
        type: "number", title: "Recovery ACK Gap (ms)",
        description: "Minimum ACK silence before triggering fast recovery",
        default: 4000, minimum: 500, maximum: 120000
      }
    }
  },
  congestionControl: {
    type: "object",
    title: "Dynamic Congestion Control",
    description: "Advanced. Requires Protocol v2 or v3. AIMD logic can adapt send rate based on RTT and packet loss.",
    properties: {
      enabled: {
        type: "boolean", title: "Enable Congestion Control",
        description: "Automatically adjust delta timer based on network conditions",
        default: false
      },
      targetRTT: {
        type: "number", title: "Target RTT (ms)",
        description: "Send rate is reduced when RTT exceeds this threshold",
        default: 200, minimum: 50, maximum: 2000
      },
      nominalDeltaTimer: {
        type: "number", title: "Nominal Delta Timer (ms)",
        description: "Preferred steady-state send interval",
        default: 1000, minimum: 100, maximum: 10000
      },
      minDeltaTimer: {
        type: "number", title: "Minimum Delta Timer (ms)",
        description: "Fastest allowed send interval",
        default: 100, minimum: 50, maximum: 1000
      },
      maxDeltaTimer: {
        type: "number", title: "Maximum Delta Timer (ms)",
        description: "Slowest allowed send interval",
        default: 5000, minimum: 1000, maximum: 30000
      }
    }
  },
  bonding: {
    type: "object",
    title: "Connection Bonding",
    description: "Advanced. Requires Protocol v2 or v3. Configure dual-link operation with automatic failover.",
    properties: {
      enabled: {
        type: "boolean", title: "Enable Connection Bonding",
        description: "Enable dual-link bonding with automatic failover",
        default: false
      },
      mode: {
        type: "string", title: "Bonding Mode", default: "main-backup",
        oneOf: [{ const: "main-backup", title: "Main/Backup – Failover to backup when primary degrades" }]
      },
      primary: {
        type: "object", title: "Primary Link",
        description: "Primary connection (e.g. LTE modem)",
        properties: {
          address: { type: "string", title: "Server Address", default: "127.0.0.1" },
          port: { type: "number", title: "UDP Port", default: 4446, minimum: 1024, maximum: 65535 },
          interface: { type: "string", title: "Bind Interface (optional)", description: "Network interface IP to bind to" }
        }
      },
      backup: {
        type: "object", title: "Backup Link",
        description: "Backup connection (e.g. Starlink, satellite)",
        properties: {
          address: { type: "string", title: "Server Address", default: "127.0.0.1" },
          port: { type: "number", title: "UDP Port", default: 4447, minimum: 1024, maximum: 65535 },
          interface: { type: "string", title: "Bind Interface (optional)", description: "Network interface IP to bind to" }
        }
      },
      failover: {
        type: "object", title: "Failover Thresholds",
        properties: {
          rttThreshold: { type: "number", title: "RTT Threshold (ms)", default: 500, minimum: 100, maximum: 5000 },
          lossThreshold: { type: "number", title: "Loss Threshold (0-1)", default: 0.1, minimum: 0.01, maximum: 0.5 },
          healthCheckInterval: { type: "number", title: "Health Check Interval (ms)", default: 1000, minimum: 500, maximum: 10000 },
          failbackDelay: { type: "number", title: "Failback Delay (ms)", default: 30000, minimum: 5000, maximum: 300000 },
          heartbeatTimeout: { type: "number", title: "Heartbeat Timeout (ms)", default: 5000, minimum: 1000, maximum: 30000 }
        }
      }
    }
  },
  alertThresholds: {
    type: "object",
    title: "Monitoring Alert Thresholds",
    description: "Advanced. Customize warning/critical thresholds used by v2 monitoring.",
    properties: {
      rtt: {
        type: "object", title: "RTT Thresholds",
        properties: {
          warning: { type: "number", title: "Warning RTT (ms)", default: 300 },
          critical: { type: "number", title: "Critical RTT (ms)", default: 800 }
        }
      },
      packetLoss: {
        type: "object", title: "Packet Loss Thresholds",
        properties: {
          warning: { type: "number", title: "Warning Loss Ratio", default: 0.03 },
          critical: { type: "number", title: "Critical Loss Ratio", default: 0.10 }
        }
      },
      retransmitRate: {
        type: "object", title: "Retransmit Rate Thresholds",
        properties: {
          warning: { type: "number", title: "Warning Retransmit Ratio", default: 0.05 },
          critical: { type: "number", title: "Critical Retransmit Ratio", default: 0.15 }
        }
      },
      jitter: {
        type: "object", title: "Jitter Thresholds",
        properties: {
          warning: { type: "number", title: "Warning Jitter (ms)", default: 100 },
          critical: { type: "number", title: "Critical Jitter (ms)", default: 300 }
        }
      },
      queueDepth: {
        type: "object", title: "Queue Depth Thresholds",
        properties: {
          warning: { type: "number", title: "Warning Queue Depth", default: 100 },
          critical: { type: "number", title: "Critical Queue Depth", default: 500 }
        }
      }
    }
  }
};

const serverProperties = {
  reliability: {
    type: "object",
    title: "Reliability Settings",
    description: "Requires Protocol v2 or v3. Controls ACK/NAK timing for reliable delivery.",
    properties: {
      ackInterval: {
        type: "number", title: "ACK Interval (ms)",
        description: "How often server sends cumulative ACK updates",
        default: 100, minimum: 20, maximum: 5000
      },
      ackResendInterval: {
        type: "number", title: "ACK Resend Interval (ms)",
        description: "Re-send duplicate ACK periodically to recover from lost ACK packets",
        default: 1000, minimum: 100, maximum: 10000
      },
      nakTimeout: {
        type: "number", title: "NAK Timeout (ms)",
        description: "Delay before requesting retransmission for missing sequence numbers",
        default: 100, minimum: 20, maximum: 5000
      }
    }
  }
};

const CLIENT_V2_SETTING_KEYS = ["reliability", "congestionControl", "bonding", "alertThresholds", "enableNotifications"];
const SERVER_V2_SETTING_KEYS = ["reliability"];

function buildSchema(isClient, protocolVersion) {
  const isReliableProtocol = Number(protocolVersion) >= 2;
  const props = { ...commonProperties };
  const required = ["serverType", "udpPort", "secretKey"];
  if (isClient) {
    Object.assign(props, clientProperties);
    required.push("udpAddress", "testAddress", "testPort");
    if (!isReliableProtocol) {
      for (const key of CLIENT_V2_SETTING_KEYS) {
        delete props[key];
      }
    }
  } else {
    Object.assign(props, serverProperties);
    delete props.enableNotifications;
    if (!isReliableProtocol) {
      for (const key of SERVER_V2_SETTING_KEYS) {
        delete props[key];
      }
    }
  }
  return { type: "object", required, properties: props };
}

const uiSchemaClient = {
  "ui:order": [
    "name", "serverType", "udpAddress", "udpPort", "secretKey", "protocolVersion",
    "useMsgpack", "usePathDictionary", "testAddress", "testPort", "pingIntervalTime",
    "helloMessageSender", "reliability", "congestionControl", "bonding", "enableNotifications", "alertThresholds"
  ],
  secretKey: { "ui:widget": "password", "ui:help": "Use 32-character ASCII, 64-character hex, or 44-character base64" },
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

const uiSchemaServer = {
  "ui:order": [
    "name", "serverType", "udpPort", "secretKey", "useMsgpack", "usePathDictionary",
    "protocolVersion", "reliability"
  ],
  secretKey: { "ui:widget": "password", "ui:help": "Use 32-character ASCII, 64-character hex, or 44-character base64" },
  serverType: { "ui:widget": "select" }
};

// Shared fields preserved when the user toggles server ↔ client mode
const SHARED_FIELDS = ["name", "udpPort", "secretKey", "useMsgpack", "usePathDictionary", "enableNotifications", "protocolVersion"];

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

// eslint-disable-next-line no-unused-vars
function ConnectionCard({ conn, index, totalCount, expanded, onToggle, onChange, onRemove }) {
  const isClient = conn.serverType !== "server";
  const schema = buildSchema(isClient, conn.protocolVersion);
  const uiSchema = isClient ? uiSchemaClient : uiSchemaServer;
  const modeLabel = isClient ? "Client" : "Server";
  const displayName = (conn.name || `Connection ${index + 1}`).trim();

  // When the user changes serverType inside the form, strip fields that don't
  // belong to the new mode so stale data never carries over.
  const handleFormChange = useCallback(({ formData: next }) => {
    if (next.serverType !== conn.serverType) {
      const base = next.serverType === "server"
        ? defaultServerConnection(next.name)
        : defaultClientConnection(next.name);
      const merged = { ...base, _id: conn._id };
      for (const k of SHARED_FIELDS) {
        if (next[k] !== undefined) { merged[k] = next[k]; }
      }
      merged.serverType = next.serverType;
      onChange(merged);
    } else {
      onChange({ ...next, _id: conn._id });
    }
  }, [conn.serverType, conn._id, onChange]);

  // Strip the frontend-only _id before passing to RJSF – it is not in the
  // schema and must not leak into the form data that RJSF manages.
  const { _id, ...formData } = conn;
  void _id;

  return (
    <div className="skel-card">
      <div className="skel-card-header" onClick={onToggle} role="button" aria-expanded={expanded}>
        <span className={`skel-badge ${isClient ? "skel-badge-client" : "skel-badge-server"}`}>
          {modeLabel}
        </span>
        <span className="skel-card-title">{displayName}</span>
        <span className="skel-expand-icon">{expanded ? "▲" : "▼"}</span>
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

function PluginConfigurationPanel(_props) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null); // { type, message }
  const [expandedIndex, setExpandedIndex] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const tokenHelpText = getTokenHelpText();

  // Synchronous save lock prevents double-submits even if React batching delays
  // the button's disabled state update (M2 fix).
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
        let list;
        if (Array.isArray(cfg.connections) && cfg.connections.length > 0) {
          list = cfg.connections.map(withId);
        } else if (cfg.serverType) {
          // Legacy flat config – wrap as single-item array
          list = [withId(cfg)];
        } else {
          list = [defaultClientConnection()];
        }
        setConnections(list);
        setExpandedIndex(0);
        setIsDirty(false);
      } catch (err) {
        setLoadError(err.message);
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
  const markDirty = useCallback(() => {
    setIsDirty(true);
    setSaveStatus(null);
  }, []);

  const updateConnection = useCallback((idx, data) => {
    setConnections((prev) => prev.map((c, i) => (i === idx ? data : c)));
    markDirty();
  }, [markDirty]);

  const addServer = useCallback(() => {
    setConnections((prev) => {
      const next = [...prev, defaultServerConnection(`server-${prev.length + 1}`)];
      setExpandedIndex(next.length - 1);
      return next;
    });
    markDirty();
  }, [markDirty]);

  const addClient = useCallback(() => {
    setConnections((prev) => {
      const next = [...prev, defaultClientConnection(`client-${prev.length + 1}`)];
      setExpandedIndex(next.length - 1);
      return next;
    });
    markDirty();
  }, [markDirty]);

  const removeConnection = useCallback((idx) => {
    setConnections((prev) => prev.filter((_, i) => i !== idx));
    setExpandedIndex((prev) => (prev >= idx && prev > 0 ? prev - 1 : prev));
    markDirty();
  }, [markDirty]);

  const toggleExpand = useCallback((idx) => {
    setExpandedIndex((prev) => (prev === idx ? null : idx));
  }, []);

  const handleSave = useCallback(async () => {
    // Synchronous guard (M2 fix) – prevents concurrent saves even before React
    // re-renders to set saveStatus to "saving".
    if (savingRef.current) { return; }
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
      // Strip the frontend-only _id before sending to the backend
      const payload = connections.map(({ _id, ...rest }) => rest);
      const res = await apiFetch(`${API_BASE}/plugin-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connections: payload })
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
    } catch (err) {
      setSaveStatus({ type: "error", message: err.message });
    } finally {
      savingRef.current = false;
    }
  }, [connections, duplicatePortSet]);

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

      {/* M3: unsaved changes banner */}
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

      {/* H3: use conn._id as stable React key instead of array index */}
      {connections.map((conn, idx) => (
        <div key={conn._id}>
          <ConnectionCard
            conn={conn}
            index={idx}
            totalCount={connections.length}
            expanded={expandedIndex === idx}
            onToggle={() => toggleExpand(idx)}
            onChange={(data) => updateConnection(idx, data)}
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
          disabled={saveStatus && saveStatus.type === "saving"}
        >
          {isDirty ? "Save Changes" : "Save Configuration"}
        </button>
        <span style={{ fontSize: "0.85rem", color: "#6c757d" }}>
          {connections.length} connection{connections.length !== 1 ? "s" : ""}
          {" · "}
          {connections.filter((c) => c.serverType === "server").length} server
          {connections.filter((c) => c.serverType === "server").length !== 1 ? "s" : ""}
          {", "}
          {connections.filter((c) => c.serverType !== "server").length} client
          {connections.filter((c) => c.serverType !== "server").length !== 1 ? "s" : ""}
        </span>
        <span style={{ fontSize: "0.8rem", color: "#6c757d", flexBasis: "100%" }}>
          {tokenHelpText}
        </span>
      </div>
    </div>
  );
}

export default PluginConfigurationPanel;
