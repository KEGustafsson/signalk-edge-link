import React, { useState, useEffect, useCallback } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";

const API_BASE = "/plugins/signalk-edge-link";

// Base schema properties shared between server and client modes
const baseProperties = {
  serverType: {
    type: "string",
    title: "Operation Mode",
    description: "Select Server to receive data, or Client to send data",
    default: "client",
    oneOf: [
      { const: "server", title: "Server Mode - Receive Data" },
      { const: "client", title: "Client Mode - Send Data" }
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
    description: "32-character secret key (must match on both ends)",
    minLength: 32,
    maxLength: 32
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
  protocolVersion: {
    type: "number",
    title: "Protocol Version",
    description: "v1: encrypted UDP transmission. v2 adds: packet reliability (sequence tracking, ACK/NAK, retransmission), congestion control, connection bonding with failover, metrics/monitoring, and NAT keepalive. Must match on both ends.",
    default: 1,
    oneOf: [
      { const: 1, title: "v1 - Standard encrypted UDP" },
      { const: 2, title: "v2 - Reliability, congestion control, bonding, metrics" }
    ]
  }
};

// Client-only properties
const clientProperties = {
  udpAddress: {
    type: "string",
    title: "Server Address",
    description: "IP address or hostname of the SignalK server",
    default: "127.0.0.1"
  },
  helloMessageSender: {
    type: "integer",
    title: "Heartbeat Interval (seconds)",
    description: "How often to send heartbeat messages",
    default: 60,
    minimum: 10,
    maximum: 3600
  },
  testAddress: {
    type: "string",
    title: "Connectivity Test Address",
    description: "Address to ping for network testing (e.g., 8.8.8.8)",
    default: "127.0.0.1"
  },
  testPort: {
    type: "number",
    title: "Connectivity Test Port",
    description: "Port for connectivity test (80, 443, 53)",
    default: 80,
    minimum: 1,
    maximum: 65535
  },
  pingIntervalTime: {
    type: "number",
    title: "Check Interval (minutes)",
    description: "How often to test network connectivity",
    default: 1,
    minimum: 0.1,
    maximum: 60
  },
  congestionControl: {
    type: "object",
    title: "Dynamic Congestion Control (v2 only)",
    description: "Requires Protocol v2. AIMD algorithm to dynamically adjust send rate based on network conditions",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable Congestion Control",
        description: "Automatically adjust delta timer based on RTT and packet loss",
        default: false
      },
      targetRTT: {
        type: "number",
        title: "Target RTT (ms)",
        description: "RTT threshold above which send rate is reduced",
        default: 200,
        minimum: 50,
        maximum: 2000
      },
      minDeltaTimer: {
        type: "number",
        title: "Minimum Delta Timer (ms)",
        description: "Fastest allowed send interval",
        default: 100,
        minimum: 50,
        maximum: 1000
      },
      maxDeltaTimer: {
        type: "number",
        title: "Maximum Delta Timer (ms)",
        description: "Slowest allowed send interval",
        default: 5000,
        minimum: 1000,
        maximum: 30000
      }
    }
  },
  bonding: {
    type: "object",
    title: "Connection Bonding (v2 only)",
    description: "Requires Protocol v2. Dual-link bonding with automatic failover between primary and backup connections",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable Connection Bonding",
        description: "Enable dual-link bonding with automatic failover",
        default: false
      },
      mode: {
        type: "string",
        title: "Bonding Mode",
        description: "Bonding operating mode",
        default: "main-backup",
        oneOf: [
          { const: "main-backup", title: "Main/Backup - Failover to backup when primary degrades" }
        ]
      },
      primary: {
        type: "object",
        title: "Primary Link",
        description: "Primary connection (e.g., LTE modem)",
        properties: {
          address: {
            type: "string",
            title: "Server Address",
            description: "IP address or hostname of the server for primary link",
            default: "127.0.0.1"
          },
          port: {
            type: "number",
            title: "UDP Port",
            description: "UDP port for primary link",
            default: 4446,
            minimum: 1024,
            maximum: 65535
          },
          interface: {
            type: "string",
            title: "Bind Interface (optional)",
            description: "Network interface IP to bind to (e.g., 192.168.1.100)"
          }
        }
      },
      backup: {
        type: "object",
        title: "Backup Link",
        description: "Backup connection (e.g., Starlink, satellite)",
        properties: {
          address: {
            type: "string",
            title: "Server Address",
            description: "IP address or hostname of the server for backup link",
            default: "127.0.0.1"
          },
          port: {
            type: "number",
            title: "UDP Port",
            description: "UDP port for backup link",
            default: 4447,
            minimum: 1024,
            maximum: 65535
          },
          interface: {
            type: "string",
            title: "Bind Interface (optional)",
            description: "Network interface IP to bind to (e.g., 10.0.0.100)"
          }
        }
      },
      failover: {
        type: "object",
        title: "Failover Thresholds",
        description: "Configure when failover is triggered",
        properties: {
          rttThreshold: {
            type: "number",
            title: "RTT Threshold (ms)",
            description: "Failover when RTT exceeds this value",
            default: 500,
            minimum: 100,
            maximum: 5000
          },
          lossThreshold: {
            type: "number",
            title: "Packet Loss Threshold",
            description: "Failover when loss exceeds this ratio (0.0 - 1.0)",
            default: 0.1,
            minimum: 0.01,
            maximum: 0.5
          },
          healthCheckInterval: {
            type: "number",
            title: "Health Check Interval (ms)",
            description: "How often to check link health",
            default: 1000,
            minimum: 500,
            maximum: 10000
          },
          failbackDelay: {
            type: "number",
            title: "Failback Delay (ms)",
            description: "Wait time before switching back to primary after recovery",
            default: 30000,
            minimum: 5000,
            maximum: 300000
          }
        }
      }
    }
  }
};

// Generate schema based on current mode
function getSchema(isClientMode) {
  const properties = { ...baseProperties };
  const required = ["serverType", "udpPort", "secretKey"];

  if (isClientMode) {
    Object.assign(properties, clientProperties);
    required.push("udpAddress", "testAddress", "testPort");
  }

  return {
    type: "object",
    title: "SignalK Edge Link",
    description: "Configure encrypted UDP data transmission between SignalK units",
    required,
    properties
  };
}

// UI Schema for field ordering and styling
const uiSchema = {
  "ui:order": [
    "serverType",
    "udpPort",
    "secretKey",
    "useMsgpack",
    "usePathDictionary",
    "protocolVersion",
    "udpAddress",
    "helloMessageSender",
    "testAddress",
    "testPort",
    "pingIntervalTime",
    "congestionControl",
    "bonding"
  ],
  secretKey: {
    "ui:widget": "password",
    "ui:help": "Must be exactly 32 characters long"
  },
  serverType: {
    "ui:widget": "select"
  }
};

/**
 * Custom configuration panel for SignalK Data Connector plugin
 * Fetches configuration from API and renders dynamic form
 */
function PluginConfigurationPanel(_props) {
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);

  // Determine if we're in client mode
  const isClientMode = formData.serverType !== "server";

  // Generate schema based on current mode
  const schema = getSchema(isClientMode);

  // Fetch configuration from API on mount
  useEffect(() => {
    async function fetchConfig() {
      try {
        const response = await fetch(`${API_BASE}/plugin-config`);
        if (!response.ok) {
          throw new Error(`Failed to load: ${response.statusText}`);
        }
        const data = await response.json();
        if (data.success && data.configuration) {
          setFormData(data.configuration);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchConfig();
  }, []);

  // Handle form changes
  const handleChange = useCallback(({ formData: newFormData }) => {
    setFormData(newFormData);
    setSaveStatus(null);
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(async ({ formData: submittedData }) => {
    setSaveStatus({ type: "saving", message: "Saving..." });

    // Clean up client-only fields when in server mode
    const cleanedData = { ...submittedData };
    if (cleanedData.serverType === "server") {
      delete cleanedData.udpAddress;
      delete cleanedData.helloMessageSender;
      delete cleanedData.testAddress;
      delete cleanedData.testPort;
      delete cleanedData.pingIntervalTime;
      delete cleanedData.congestionControl;
      delete cleanedData.bonding;
    }

    try {
      const response = await fetch(`${API_BASE}/plugin-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanedData)
      });
      const data = await response.json();

      if (response.ok && data.success) {
        setSaveStatus({
          type: "success",
          message: data.message || "Configuration saved. Plugin restarting..."
        });
      } else {
        throw new Error(data.error || "Failed to save");
      }
    } catch (err) {
      setSaveStatus({ type: "error", message: err.message });
    }
  }, []);

  if (loading) {
    return <div style={{ padding: "20px", textAlign: "center" }}>Loading configuration...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: "20px", color: "#dc3545" }}>
        <h4>Error Loading Configuration</h4>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="signalk-edge-link-config">
      {saveStatus && (
        <div
          style={{
            padding: "10px 15px",
            marginBottom: "15px",
            borderRadius: "4px",
            backgroundColor:
              saveStatus.type === "success"
                ? "#d4edda"
                : saveStatus.type === "error"
                  ? "#f8d7da"
                  : "#fff3cd",
            color:
              saveStatus.type === "success"
                ? "#155724"
                : saveStatus.type === "error"
                  ? "#721c24"
                  : "#856404",
            border: `1px solid ${
              saveStatus.type === "success"
                ? "#c3e6cb"
                : saveStatus.type === "error"
                  ? "#f5c6cb"
                  : "#ffeeba"
            }`
          }}
        >
          {saveStatus.message}
        </div>
      )}
      <Form
        schema={schema}
        uiSchema={uiSchema}
        formData={formData}
        validator={validator}
        onChange={handleChange}
        onSubmit={handleSubmit}
        liveValidate={false}
      >
        <button type="submit" className="btn btn-primary">
          Save Configuration
        </button>
      </Form>
      <style>{`
        .signalk-edge-link-config {
          width: 100%;
        }
        .signalk-edge-link-config .form-group {
          margin-bottom: 1rem;
        }
        .signalk-edge-link-config label {
          font-weight: 600;
          margin-bottom: 0.25rem;
          display: block;
        }
        .signalk-edge-link-config .help-block,
        .signalk-edge-link-config .field-description {
          font-size: 0.85rem;
          color: #666;
          margin-top: 0.25rem;
        }
        .signalk-edge-link-config input,
        .signalk-edge-link-config select {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 1rem;
        }
        .signalk-edge-link-config input[type="checkbox"] {
          width: auto;
        }
        .signalk-edge-link-config .btn-primary {
          background-color: #007bff;
          border-color: #007bff;
          color: white;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
          margin-top: 1rem;
        }
        .signalk-edge-link-config .btn-primary:hover {
          background-color: #0069d9;
          border-color: #0062cc;
        }
        .signalk-edge-link-config .text-danger {
          color: #dc3545;
          font-size: 0.85rem;
        }
      `}</style>
    </div>
  );
}

export default PluginConfigurationPanel;
