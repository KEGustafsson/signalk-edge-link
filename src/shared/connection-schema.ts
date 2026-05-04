/**
 * Single source of truth for the connection configuration schema.
 *
 * Both the backend `plugin.schema` in `src/index.ts` (used by Signal K's
 * default admin UI and served via the `/plugin-schema` route for default
 * extraction) and the frontend RJSF form in
 * `src/webapp/components/PluginConfigurationPanel.tsx` consume the fragments
 * exported here. Adding or editing a connection field must happen in this
 * module; the two consumers then render it identically.
 *
 * The fragments are typed as plain `Record<string, unknown>` so they can be
 * imported by both the server-side TypeScript build and the webapp build
 * without pulling `@rjsf/utils` into the server bundle. The webapp casts
 * results to `RJSFSchema` at call sites.
 */

import { PBKDF2_ITERATIONS } from "./crypto-constants";

export type SchemaFragment = Record<string, unknown>;

// ── Common (client + server) ──────────────────────────────────────────────────

export const commonConnectionProperties: Record<string, SchemaFragment> = {
  name: {
    type: "string",
    title: "Connection Name",
    description:
      "Human-readable label for this connection (e.g. 'Shore Server', 'Sat Client'). Used to namespace config files and Signal K metrics paths.",
    default: "connection",
    maxLength: 40
  },
  serverType: {
    type: "string",
    title: "Operation Mode",
    description: "Select Server to receive data, or Client to send data.",
    default: "client",
    oneOf: [
      { const: "server", title: "Server Mode – Receive Data" },
      { const: "client", title: "Client Mode – Send Data" }
    ]
  },
  udpPort: {
    type: "number",
    title: "UDP Port",
    description: "UDP port for data transmission (must match on both ends).",
    default: 4446,
    minimum: 1024,
    maximum: 65535
  },
  udpMetaPort: {
    type: "integer",
    title: "v1 Metadata UDP Port",
    description: "Optional separate UDP port for v1 metadata packets; ignored by v2/v3.",
    minimum: 1024,
    maximum: 65535
  },
  secretKey: {
    type: "string",
    title: "Encryption Key",
    description:
      "32-byte secret key: 32-character ASCII, 64-character hex, or 44-character base64.",
    minLength: 32,
    maxLength: 64,
    pattern: "^(?:.{32}|[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$"
  },
  stretchAsciiKey: {
    type: "boolean",
    title: "Stretch 32-char ASCII Key (PBKDF2)",
    description: `When the secretKey is 32-character ASCII, route it through PBKDF2-SHA256 (${PBKDF2_ITERATIONS.toLocaleString("en-US")} iterations) to raise it to full 256-bit AES strength. Hex and base64 keys are unaffected. BOTH ENDS OF THE CONNECTION MUST USE THE SAME SETTING — otherwise authentication will fail and every packet will be dropped.`,
    default: false
  },
  useMsgpack: {
    type: "boolean",
    title: "Use MessagePack",
    description: "Binary serialization for smaller payloads (must match on both ends).",
    default: false
  },
  usePathDictionary: {
    type: "boolean",
    title: "Use Path Dictionary",
    description: "Encode paths as numeric IDs for bandwidth savings (must match on both ends).",
    default: false
  },
  protocolVersion: {
    type: "number",
    title: "Protocol Version",
    description:
      "v1: encrypted UDP. v2 adds reliable delivery and metrics. v3 keeps the v2 data path and authenticates control packets (ACK/NAK/HEARTBEAT/HELLO). Must match on both ends.",
    default: 1,
    oneOf: [
      { const: 1, title: "v1 – Standard encrypted UDP" },
      { const: 2, title: "v2 – Reliability, congestion control, bonding, metrics" },
      { const: 3, title: "v3 - v2 features with authenticated control packets" }
    ]
  }
};

// ── Client-only transport / reachability fields ───────────────────────────────

/**
 * v1-only ping monitor fields. v2/v3 derive RTT from HEARTBEAT/ACK exchanges
 * inside the reliable pipeline, so the external ping monitor (and these
 * fields) is not used for protocolVersion >= 2.
 */
export const v1ClientPingProperties: Record<string, SchemaFragment> = {
  testAddress: {
    type: "string",
    title: "Connectivity Test Address (v1 only)",
    description: "Host used for reachability checks (e.g. 8.8.8.8). v1 only.",
    default: "127.0.0.1"
  },
  testPort: {
    type: "number",
    title: "Connectivity Test Port (v1 only)",
    description: "Port used for reachability checks (e.g. 53, 80, or 443). v1 only.",
    default: 80,
    minimum: 1,
    maximum: 65535
  },
  pingIntervalTime: {
    type: "number",
    title: "Check Interval (minutes, v1 only)",
    description: "Frequency of network reachability checks. v1 only.",
    default: 1,
    minimum: 0.1,
    maximum: 60
  }
};

export const clientTransportProperties: Record<string, SchemaFragment> = {
  udpAddress: {
    type: "string",
    title: "Server Address",
    description: "IP address or hostname of the remote Signal K endpoint.",
    default: "127.0.0.1"
  },
  helloMessageSender: {
    type: "integer",
    title: "Heartbeat Interval (seconds)",
    description: "Send periodic heartbeat messages to keep NAT/firewall mappings alive.",
    default: 60,
    minimum: 10,
    maximum: 3600
  },
  heartbeatInterval: {
    type: "number",
    title: "NAT Keepalive Heartbeat Interval (ms)",
    description:
      "v2/v3 only. How often to send UDP heartbeat packets for NAT traversal. Typical NAT timeouts range from 30s to 120s.",
    default: 25000,
    minimum: 5000,
    maximum: 120000
  }
};

// ── v2/v3 reliability (client pipeline — retransmit queue) ────────────────────

export const clientReliabilityProperty: SchemaFragment = {
  type: "object",
  title: "Reliability Settings (v2/v3 only)",
  description:
    "Requires Protocol v2 or v3. Controls retransmit queue behavior and packet retry limits.",
  properties: {
    retransmitQueueSize: {
      type: "number",
      title: "Retransmit Queue Size",
      description: "Maximum number of sent packets stored for potential retransmission.",
      default: 5000,
      minimum: 100,
      maximum: 50000
    },
    maxRetransmits: {
      type: "number",
      title: "Max Retransmit Attempts",
      description: "Maximum resend attempts before a packet is dropped from the retransmit queue.",
      default: 3,
      minimum: 1,
      maximum: 20
    },
    retransmitMaxAge: {
      type: "number",
      title: "Retransmit Max Age (ms)",
      description: "Expire stale unacknowledged packets older than this age.",
      default: 120000,
      minimum: 1000,
      maximum: 300000
    },
    retransmitMinAge: {
      type: "number",
      title: "Retransmit Min Age (ms)",
      description: "Minimum packet age before expiration is allowed.",
      default: 10000,
      minimum: 200,
      maximum: 30000
    },
    retransmitRttMultiplier: {
      type: "number",
      title: "RTT Expiry Multiplier",
      description: "Dynamic expiry age = RTT × this multiplier.",
      default: 12,
      minimum: 2,
      maximum: 20
    },
    ackIdleDrainAge: {
      type: "number",
      title: "ACK Idle Drain Age (ms)",
      description: "If ACKs are idle longer than this, expiry becomes more aggressive.",
      default: 20000,
      minimum: 500,
      maximum: 30000
    },
    forceDrainAfterAckIdle: {
      type: "boolean",
      title: "Force Drain After ACK Idle",
      description: "When enabled, clear retransmit queue if no ACKs arrive for too long.",
      default: false
    },
    forceDrainAfterMs: {
      type: "number",
      title: "Force Drain Timeout (ms)",
      description: "ACK idle duration before force-draining retransmit queue to zero.",
      default: 45000,
      minimum: 2000,
      maximum: 120000
    },
    recoveryBurstEnabled: {
      type: "boolean",
      title: "Recovery Burst Enabled",
      description: "When ACKs return after outage, rapidly retransmit queued packets to catch up.",
      default: true
    },
    recoveryBurstSize: {
      type: "number",
      title: "Recovery Burst Size",
      description: "Max queued packets to retransmit per recovery burst cycle.",
      default: 100,
      minimum: 10,
      maximum: 1000
    },
    recoveryBurstIntervalMs: {
      type: "number",
      title: "Recovery Burst Interval (ms)",
      description: "Interval between recovery burst cycles while backlog exists.",
      default: 200,
      minimum: 50,
      maximum: 5000
    },
    recoveryAckGapMs: {
      type: "number",
      title: "Recovery ACK Gap (ms)",
      description: "Minimum ACK silence before triggering fast recovery bursts.",
      default: 4000,
      minimum: 500,
      maximum: 120000
    }
  }
};

// ── v2/v3 reliability (server pipeline — ACK/NAK timing) ──────────────────────

export const serverReliabilityProperty: SchemaFragment = {
  type: "object",
  title: "Reliability Settings (v2/v3 only)",
  description: "Requires Protocol v2 or v3. Controls ACK/NAK timing for reliable delivery.",
  properties: {
    ackInterval: {
      type: "number",
      title: "ACK Interval (ms)",
      description: "How often server sends cumulative ACK updates.",
      default: 100,
      minimum: 20,
      maximum: 5000
    },
    ackResendInterval: {
      type: "number",
      title: "ACK Resend Interval (ms)",
      description: "Re-send duplicate ACK periodically to recover from lost ACK packets.",
      default: 1000,
      minimum: 100,
      maximum: 10000
    },
    nakTimeout: {
      type: "number",
      title: "NAK Timeout (ms)",
      description: "Delay before requesting retransmission for missing sequence numbers.",
      default: 100,
      minimum: 20,
      maximum: 5000
    }
  }
};

// ── v2/v3 congestion control (client) ─────────────────────────────────────────

export const congestionControlProperty: SchemaFragment = {
  type: "object",
  title: "Dynamic Congestion Control (v2/v3 only)",
  description:
    "Requires Protocol v2 or v3. AIMD algorithm to dynamically adjust send rate based on network conditions.",
  properties: {
    enabled: {
      type: "boolean",
      title: "Enable Congestion Control",
      description: "Automatically adjust delta timer based on RTT and packet loss.",
      default: false
    },
    targetRTT: {
      type: "number",
      title: "Target RTT (ms)",
      description: "RTT threshold above which send rate is reduced.",
      default: 200,
      minimum: 50,
      maximum: 2000
    },
    nominalDeltaTimer: {
      type: "number",
      title: "Nominal Delta Timer (ms)",
      description: "Preferred steady-state send interval.",
      default: 1000,
      minimum: 100,
      maximum: 10000
    },
    minDeltaTimer: {
      type: "number",
      title: "Minimum Delta Timer (ms)",
      description: "Fastest allowed send interval.",
      default: 100,
      minimum: 50,
      maximum: 1000
    },
    maxDeltaTimer: {
      type: "number",
      title: "Maximum Delta Timer (ms)",
      description: "Slowest allowed send interval.",
      default: 5000,
      minimum: 1000,
      maximum: 30000
    }
  }
};

// ── v2/v3 connection bonding (client) ─────────────────────────────────────────

export const bondingProperty: SchemaFragment = {
  type: "object",
  title: "Connection Bonding (v2/v3 only)",
  description:
    "Requires Protocol v2 or v3. Dual-link bonding with automatic failover between primary and backup connections.",
  properties: {
    enabled: {
      type: "boolean",
      title: "Enable Connection Bonding",
      description: "Enable dual-link bonding with automatic failover.",
      default: false
    },
    mode: {
      type: "string",
      title: "Bonding Mode",
      description: "Bonding operating mode.",
      default: "main-backup",
      oneOf: [
        {
          const: "main-backup",
          title: "Main/Backup – Failover to backup when primary degrades"
        }
      ]
    },
    primary: {
      type: "object",
      title: "Primary Link",
      description: "Primary connection (e.g. LTE modem).",
      properties: {
        address: { type: "string", title: "Server Address", default: "127.0.0.1" },
        port: {
          type: "number",
          title: "UDP Port",
          default: 4446,
          minimum: 1024,
          maximum: 65535
        },
        interface: {
          type: "string",
          title: "Bind Interface (optional)",
          description: "Network interface IP to bind to."
        }
      }
    },
    backup: {
      type: "object",
      title: "Backup Link",
      description: "Backup connection (e.g. Starlink, satellite).",
      properties: {
        address: { type: "string", title: "Server Address", default: "127.0.0.1" },
        port: {
          type: "number",
          title: "UDP Port",
          default: 4447,
          minimum: 1024,
          maximum: 65535
        },
        interface: {
          type: "string",
          title: "Bind Interface (optional)",
          description: "Network interface IP to bind to."
        }
      }
    },
    failover: {
      type: "object",
      title: "Failover Thresholds",
      description: "Configure when failover is triggered.",
      properties: {
        rttThreshold: {
          type: "number",
          title: "RTT Threshold (ms)",
          default: 500,
          minimum: 100,
          maximum: 5000
        },
        lossThreshold: {
          type: "number",
          title: "Packet Loss Threshold (0-1)",
          default: 0.1,
          minimum: 0.01,
          maximum: 0.5
        },
        healthCheckInterval: {
          type: "number",
          title: "Health Check Interval (ms)",
          default: 1000,
          minimum: 500,
          maximum: 10000
        },
        failbackDelay: {
          type: "number",
          title: "Failback Delay (ms)",
          default: 30000,
          minimum: 5000,
          maximum: 300000
        },
        heartbeatTimeout: {
          type: "number",
          title: "Heartbeat Timeout (ms)",
          default: 5000,
          minimum: 1000,
          maximum: 30000
        }
      }
    }
  }
};

// ── Client-only notifications toggle ──────────────────────────────────────────

export const enableNotificationsProperty: SchemaFragment = {
  type: "boolean",
  title: "Enable Signal K Notifications",
  description: "Emit Signal K notifications for alerts and failover events.",
  default: false
};

// ── Client-only: skip forwarding plugin-generated data ────────────────────────

export const skipOwnDataProperty: SchemaFragment = {
  type: "boolean",
  title: "Skip Plugin's Own Data",
  description:
    "Do not forward data this plugin publishes locally over the link. Strips entries under 'networking.edgeLink.*' and the v1 RTT path 'networking.modem.rtt' / 'networking.modem.<id>.rtt'; other 'networking.modem.*' paths from external providers are left intact. Also suppresses the v2/v3 client telemetry packet that mirrors local link metrics to the receiver.",
  default: false
};

// ── v2/v3 monitoring alert thresholds (client) ────────────────────────────────

export const alertThresholdsProperty: SchemaFragment = {
  type: "object",
  title: "Monitoring Alert Thresholds (v2/v3 only)",
  description: "Customize warning/critical thresholds for network monitoring alerts.",
  properties: {
    rtt: {
      type: "object",
      title: "RTT Thresholds",
      properties: {
        warning: { type: "number", title: "Warning RTT (ms)", default: 300 },
        critical: { type: "number", title: "Critical RTT (ms)", default: 800 }
      }
    },
    packetLoss: {
      type: "object",
      title: "Packet Loss Thresholds",
      properties: {
        warning: { type: "number", title: "Warning Loss Ratio", default: 0.03 },
        critical: { type: "number", title: "Critical Loss Ratio", default: 0.1 }
      }
    },
    retransmitRate: {
      type: "object",
      title: "Retransmit Rate Thresholds",
      properties: {
        warning: { type: "number", title: "Warning Retransmit Ratio", default: 0.05 },
        critical: { type: "number", title: "Critical Retransmit Ratio", default: 0.15 }
      }
    },
    jitter: {
      type: "object",
      title: "Jitter Thresholds",
      properties: {
        warning: { type: "number", title: "Warning Jitter (ms)", default: 100 },
        critical: { type: "number", title: "Critical Jitter (ms)", default: 300 }
      }
    },
    queueDepth: {
      type: "object",
      title: "Queue Depth Thresholds",
      properties: {
        warning: { type: "number", title: "Warning Queue Depth", default: 100 },
        critical: { type: "number", title: "Critical Queue Depth", default: 500 }
      }
    }
  }
};

// ── Builder consumed by the backend (`plugin.schema` in src/index.ts) ─────────

/**
 * Build the `connections[]` item schema used by Signal K's default admin UI
 * and served via `GET /plugin-schema`. Client-only fields live under
 * `dependencies.serverType.oneOf` so they appear only in client mode.
 */
export function buildConnectionItemSchema(): SchemaFragment {
  return {
    type: "object",
    title: "Connection",
    required: ["serverType", "udpPort", "secretKey"],
    properties: { ...commonConnectionProperties },
    dependencies: {
      serverType: {
        oneOf: [
          {
            properties: {
              serverType: { enum: ["server"] },
              reliability: serverReliabilityProperty
            }
          },
          {
            properties: {
              serverType: { enum: ["client"] },
              ...clientTransportProperties,
              ...v1ClientPingProperties,
              reliability: clientReliabilityProperty,
              congestionControl: congestionControlProperty,
              bonding: bondingProperty,
              enableNotifications: enableNotificationsProperty,
              skipOwnData: skipOwnDataProperty,
              alertThresholds: alertThresholdsProperty
            },
            // testAddress/testPort/pingIntervalTime are validated as v1-only by
            // validateConnectionConfig — they are exposed in the schema so
            // legacy v1 clients can still set them, but they are not required
            // because v2/v3 clients omit them entirely.
            required: ["udpAddress"]
          }
        ]
      }
    }
  };
}

// ── Builder consumed by the webapp (PluginConfigurationPanel.tsx) ─────────────

/**
 * Build the flat per-connection schema consumed by the webapp RJSF form.
 * Unlike the backend variant this is a flat object that is rebuilt whenever
 * the user toggles `serverType` or `protocolVersion` so RJSF re-renders with
 * the right subset of fields.
 */
export function buildWebappConnectionSchema(
  isClient: boolean,
  protocolVersion: number | undefined
): SchemaFragment {
  const isReliableProtocol = Number(protocolVersion) >= 2;
  const props: Record<string, SchemaFragment> = { ...commonConnectionProperties };
  const required = ["serverType", "udpPort", "secretKey"];

  if (isClient) {
    Object.assign(props, clientTransportProperties);
    props.enableNotifications = enableNotificationsProperty;
    props.skipOwnData = skipOwnDataProperty;
    required.push("udpAddress");
    if (isReliableProtocol) {
      props.reliability = clientReliabilityProperty;
      props.congestionControl = congestionControlProperty;
      props.bonding = bondingProperty;
      props.alertThresholds = alertThresholdsProperty;
    } else {
      // v1 client only: external ping monitor for RTT. v2/v3 measures RTT
      // via HEARTBEAT, so these fields are removed entirely from the schema.
      Object.assign(props, v1ClientPingProperties);
      required.push("testAddress", "testPort");
    }
  } else if (isReliableProtocol) {
    props.reliability = serverReliabilityProperty;
  }

  return { type: "object", required, properties: props };
}
