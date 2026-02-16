import React, { useState, useEffect, useCallback } from "react"; // eslint-disable-line no-unused-vars

const API_BASE = "/plugins/signalk-edge-link";

// Field definitions keyed by property name
const baseFields = [
  {
    name: "serverType",
    label: "Operation Mode",
    description: "Select Server to receive data, or Client to send data",
    type: "select",
    options: [
      { value: "client", label: "Client Mode - Send Data" },
      { value: "server", label: "Server Mode - Receive Data" }
    ],
    defaultValue: "client"
  },
  {
    name: "udpPort",
    label: "UDP Port",
    description: "UDP port for data transmission (must match on both ends)",
    type: "number",
    min: 1024,
    max: 65535,
    defaultValue: 4446
  },
  {
    name: "secretKey",
    label: "Encryption Key",
    description: "32-character secret key (must match on both ends)",
    type: "password",
    minLength: 32,
    maxLength: 32
  },
  {
    name: "useMsgpack",
    label: "Use MessagePack",
    description:
      "Binary serialization for smaller payloads (must match on both ends)",
    type: "checkbox",
    defaultValue: false
  },
  {
    name: "usePathDictionary",
    label: "Use Path Dictionary",
    description:
      "Encode paths as numeric IDs for bandwidth savings (must match on both ends)",
    type: "checkbox",
    defaultValue: false
  },
  {
    name: "protocolVersion",
    label: "Protocol Version",
    description:
      "v1: encrypted UDP transmission. v2 adds: packet reliability (sequence tracking, ACK/NAK, retransmission), congestion control, connection bonding with failover, metrics/monitoring, and NAT keepalive. Must match on both ends.",
    type: "select",
    options: [
      { value: 1, label: "v1 - Standard encrypted UDP" },
      { value: 2, label: "v2 - Reliability, congestion control, bonding, metrics" }
    ],
    defaultValue: 1,
    numeric: true
  }
];

const clientFields = [
  {
    name: "udpAddress",
    label: "Server Address",
    description: "IP address or hostname of the SignalK server",
    type: "text",
    defaultValue: "127.0.0.1"
  },
  {
    name: "helloMessageSender",
    label: "Heartbeat Interval (seconds)",
    description: "How often to send heartbeat messages",
    type: "number",
    min: 10,
    max: 3600,
    defaultValue: 60
  },
  {
    name: "testAddress",
    label: "Connectivity Test Address",
    description: "Address to ping for network testing (e.g., 8.8.8.8)",
    type: "text",
    defaultValue: "127.0.0.1"
  },
  {
    name: "testPort",
    label: "Connectivity Test Port",
    description: "Port for connectivity test (80, 443, 53)",
    type: "number",
    min: 1,
    max: 65535,
    defaultValue: 80
  },
  {
    name: "pingIntervalTime",
    label: "Check Interval (minutes)",
    description: "How often to test network connectivity",
    type: "number",
    min: 0.1,
    max: 60,
    step: 0.1,
    defaultValue: 1
  }
];

const congestionFields = [
  {
    name: "enabled",
    label: "Enable Congestion Control",
    description: "Automatically adjust delta timer based on RTT and packet loss",
    type: "checkbox",
    defaultValue: false
  },
  {
    name: "targetRTT",
    label: "Target RTT (ms)",
    description: "RTT threshold above which send rate is reduced",
    type: "number",
    min: 50,
    max: 2000,
    defaultValue: 200
  },
  {
    name: "minDeltaTimer",
    label: "Minimum Delta Timer (ms)",
    description: "Fastest allowed send interval",
    type: "number",
    min: 50,
    max: 1000,
    defaultValue: 100
  },
  {
    name: "maxDeltaTimer",
    label: "Maximum Delta Timer (ms)",
    description: "Slowest allowed send interval",
    type: "number",
    min: 1000,
    max: 30000,
    defaultValue: 5000
  }
];

const bondingModes = [
  {
    value: "main-backup",
    label: "Main/Backup - Failover to backup when primary degrades"
  }
];

const linkFields = [
  {
    name: "address",
    label: "Server Address",
    type: "text",
    defaultValue: "127.0.0.1"
  },
  { name: "port", label: "UDP Port", type: "number", min: 1024, max: 65535 },
  {
    name: "interface",
    label: "Bind Interface (optional)",
    description: "Network interface IP to bind to",
    type: "text"
  }
];

const failoverFields = [
  {
    name: "rttThreshold",
    label: "RTT Threshold (ms)",
    description: "Failover when RTT exceeds this value",
    type: "number",
    min: 100,
    max: 5000,
    defaultValue: 500
  },
  {
    name: "lossThreshold",
    label: "Packet Loss Threshold",
    description: "Failover when loss exceeds this ratio (0.0 - 1.0)",
    type: "number",
    min: 0.01,
    max: 0.5,
    step: 0.01,
    defaultValue: 0.1
  },
  {
    name: "healthCheckInterval",
    label: "Health Check Interval (ms)",
    description: "How often to check link health",
    type: "number",
    min: 500,
    max: 10000,
    defaultValue: 1000
  },
  {
    name: "failbackDelay",
    label: "Failback Delay (ms)",
    description: "Wait time before switching back to primary after recovery",
    type: "number",
    min: 5000,
    max: 300000,
    defaultValue: 30000
  }
];

// Render a single form field based on its definition
function FormField({ field, value, onChange }) { // eslint-disable-line no-unused-vars
  const id = "field-" + field.name;

  if (field.type === "checkbox") {
    return (
      <div className="form-group" key={field.name}>
        <label>
          <input
            id={id}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(field.name, e.target.checked)}
          />{" "}
          {field.label}
        </label>
        {field.description && (
          <p className="field-description">{field.description}</p>
        )}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="form-group" key={field.name}>
        <label htmlFor={id}>{field.label}</label>
        <select
          id={id}
          className="form-control"
          value={value !== undefined && value !== null ? value : field.defaultValue || ""}
          onChange={(e) => {
            const val = e.target.value;
            onChange(field.name, field.numeric ? Number(val) : val);
          }}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {field.description && (
          <p className="field-description">{field.description}</p>
        )}
      </div>
    );
  }

  // text, number, password
  return (
    <div className="form-group" key={field.name}>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        className="form-control"
        type={field.type}
        value={value !== undefined && value !== null ? value : ""}
        min={field.min}
        max={field.max}
        step={field.step}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(e) => {
          const val = e.target.value;
          onChange(field.name, field.type === "number" ? (val === "" ? "" : Number(val)) : val);
        }}
      />
      {field.description && (
        <p className="field-description">{field.description}</p>
      )}
    </div>
  );
}

// Render a group of fields that map to a nested object
function FieldGroup({ title, description, fields, data, onChange }) { // eslint-disable-line no-unused-vars
  return (
    <fieldset className="field-group">
      <legend>{title}</legend>
      {description && <p className="field-description">{description}</p>}
      {fields.map((field) => (
        <FormField
          key={field.name}
          field={field}
          value={data ? data[field.name] : undefined}
          onChange={onChange}
        />
      ))}
    </fieldset>
  );
}

/**
 * Custom configuration panel for SignalK Data Connector plugin.
 * Fetches configuration from API and renders a dynamic form.
 */
function PluginConfigurationPanel() {
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);

  const isClientMode = formData.serverType !== "server";

  // Fetch configuration from API on mount
  useEffect(() => {
    let cancelled = false;
    fetch(API_BASE + "/plugin-config")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load: " + response.statusText);
        }
        return response.json();
      })
      .then((data) => {
        if (!cancelled && data.success && data.configuration) {
          setFormData(data.configuration);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Update a top-level field
  const handleFieldChange = useCallback((name, value) => {
    setFormData((prev) => {
      const next = Object.assign({}, prev);
      next[name] = value;
      return next;
    });
    setSaveStatus(null);
  }, []);

  // Update a nested field (e.g. congestionControl.enabled)
  const handleNestedChange = useCallback((section, name, value) => {
    setFormData((prev) => {
      const next = Object.assign({}, prev);
      next[section] = Object.assign({}, prev[section]);
      next[section][name] = value;
      return next;
    });
    setSaveStatus(null);
  }, []);

  // Update a doubly-nested field (e.g. bonding.primary.address)
  const handleDeepNestedChange = useCallback((section, subsection, name, value) => {
    setFormData((prev) => {
      const next = Object.assign({}, prev);
      next[section] = Object.assign({}, prev[section]);
      next[section][subsection] = Object.assign({}, (prev[section] || {})[subsection]);
      next[section][subsection][name] = value;
      return next;
    });
    setSaveStatus(null);
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      setSaveStatus({ type: "saving", message: "Saving..." });

      // Clean up client-only fields when in server mode
      const cleanedData = Object.assign({}, formData);
      if (cleanedData.serverType === "server") {
        delete cleanedData.udpAddress;
        delete cleanedData.helloMessageSender;
        delete cleanedData.testAddress;
        delete cleanedData.testPort;
        delete cleanedData.pingIntervalTime;
        delete cleanedData.congestionControl;
        delete cleanedData.bonding;
      }

      fetch(API_BASE + "/plugin-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanedData)
      })
        .then((response) => {
          return response.json().then((data) => {
            if (response.ok && data.success) {
              setSaveStatus({
                type: "success",
                message: data.message || "Configuration saved. Plugin restarting..."
              });
            } else {
              throw new Error(data.error || "Failed to save");
            }
          });
        })
        .catch((err) => {
          setSaveStatus({ type: "error", message: err.message });
        });
    },
    [formData]
  );

  if (loading) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        Loading configuration...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "20px", color: "#dc3545" }}>
        <h4>Error Loading Configuration</h4>
        <p>{error}</p>
      </div>
    );
  }

  const statusBg =
    saveStatus && saveStatus.type === "success"
      ? "#d4edda"
      : saveStatus && saveStatus.type === "error"
        ? "#f8d7da"
        : "#fff3cd";
  const statusColor =
    saveStatus && saveStatus.type === "success"
      ? "#155724"
      : saveStatus && saveStatus.type === "error"
        ? "#721c24"
        : "#856404";
  const statusBorder =
    saveStatus && saveStatus.type === "success"
      ? "#c3e6cb"
      : saveStatus && saveStatus.type === "error"
        ? "#f5c6cb"
        : "#ffeeba";

  return (
    <div className="signalk-edge-link-config">
      {saveStatus && (
        <div
          style={{
            padding: "10px 15px",
            marginBottom: "15px",
            borderRadius: "4px",
            backgroundColor: statusBg,
            color: statusColor,
            border: "1px solid " + statusBorder
          }}
        >
          {saveStatus.message}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <h3>SignalK Edge Link</h3>
        <p className="field-description">
          Configure encrypted UDP data transmission between SignalK units
        </p>

        {baseFields.map((field) => (
          <FormField
            key={field.name}
            field={field}
            value={formData[field.name]}
            onChange={handleFieldChange}
          />
        ))}

        {isClientMode &&
          clientFields.map((field) => (
            <FormField
              key={field.name}
              field={field}
              value={formData[field.name]}
              onChange={handleFieldChange}
            />
          ))}

        {isClientMode && (
          <FieldGroup
            title="Dynamic Congestion Control (v2 only)"
            description="Requires Protocol v2. AIMD algorithm to dynamically adjust send rate based on network conditions"
            fields={congestionFields}
            data={formData.congestionControl}
            onChange={(name, value) => {
              handleNestedChange("congestionControl", name, value);
            }}
          />
        )}

        {isClientMode && (
          <fieldset className="field-group">
            <legend>Connection Bonding (v2 only)</legend>
            <p className="field-description">
              Requires Protocol v2. Dual-link bonding with automatic failover
              between primary and backup connections
            </p>

            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={!!(formData.bonding && formData.bonding.enabled)}
                  onChange={(e) => {
                    handleNestedChange("bonding", "enabled", e.target.checked);
                  }}
                />{" "}
                Enable Connection Bonding
              </label>
              <p className="field-description">
                Enable dual-link bonding with automatic failover
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="field-bonding-mode">Bonding Mode</label>
              <select
                id="field-bonding-mode"
                className="form-control"
                value={
                  formData.bonding && formData.bonding.mode
                    ? formData.bonding.mode
                    : "main-backup"
                }
                onChange={(e) => {
                  handleNestedChange("bonding", "mode", e.target.value);
                }}
              >
                {bondingModes.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <FieldGroup
              title="Primary Link"
              description="Primary connection (e.g., LTE modem)"
              fields={linkFields.map((f) =>
                Object.assign({}, f, {
                  defaultValue: f.name === "port" ? 4446 : f.defaultValue
                })
              )}
              data={formData.bonding ? formData.bonding.primary : undefined}
              onChange={(name, value) => {
                handleDeepNestedChange("bonding", "primary", name, value);
              }}
            />

            <FieldGroup
              title="Backup Link"
              description="Backup connection (e.g., Starlink, satellite)"
              fields={linkFields.map((f) =>
                Object.assign({}, f, {
                  defaultValue: f.name === "port" ? 4447 : f.defaultValue
                })
              )}
              data={formData.bonding ? formData.bonding.backup : undefined}
              onChange={(name, value) => {
                handleDeepNestedChange("bonding", "backup", name, value);
              }}
            />

            <FieldGroup
              title="Failover Thresholds"
              description="Configure when failover is triggered"
              fields={failoverFields}
              data={formData.bonding ? formData.bonding.failover : undefined}
              onChange={(name, value) => {
                handleDeepNestedChange("bonding", "failover", name, value);
              }}
            />
          </fieldset>
        )}

        <button type="submit" className="btn btn-primary">
          Save Configuration
        </button>
      </form>

      <style>{"\
.signalk-edge-link-config {\
  width: 100%;\
}\
.signalk-edge-link-config h3 {\
  margin-top: 0;\
}\
.signalk-edge-link-config .form-group {\
  margin-bottom: 1rem;\
}\
.signalk-edge-link-config label {\
  font-weight: 600;\
  margin-bottom: 0.25rem;\
  display: block;\
}\
.signalk-edge-link-config .field-description {\
  font-size: 0.85rem;\
  color: #666;\
  margin-top: 0.25rem;\
  margin-bottom: 0.5rem;\
}\
.signalk-edge-link-config input,\
.signalk-edge-link-config select {\
  width: 100%;\
  padding: 0.5rem;\
  border: 1px solid #ccc;\
  border-radius: 4px;\
  font-size: 1rem;\
  box-sizing: border-box;\
}\
.signalk-edge-link-config input[type='checkbox'] {\
  width: auto;\
  margin-right: 0.5rem;\
}\
.signalk-edge-link-config .field-group {\
  border: 1px solid #ddd;\
  border-radius: 4px;\
  padding: 1rem;\
  margin-bottom: 1rem;\
}\
.signalk-edge-link-config .field-group legend {\
  font-weight: 600;\
  font-size: 1.05rem;\
  padding: 0 0.5rem;\
}\
.signalk-edge-link-config .btn-primary {\
  background-color: #007bff;\
  border-color: #007bff;\
  color: white;\
  padding: 0.5rem 1rem;\
  border-radius: 4px;\
  cursor: pointer;\
  font-size: 1rem;\
  margin-top: 1rem;\
}\
.signalk-edge-link-config .btn-primary:hover {\
  background-color: #0069d9;\
  border-color: #0062cc;\
}\
"}</style>
    </div>
  );
}

export default PluginConfigurationPanel;
