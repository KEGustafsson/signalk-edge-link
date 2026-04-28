# Signal K Edge Link API Reference (current: 2.1.1)

This reference tracks the **current release line**. For endpoint additions/removals between minor or beta releases, see `docs/pr-records/` for change history.

All REST API endpoints are served under the base path `/plugins/signalk-edge-link/`.

All endpoints are rate-limited to **120 requests per minute per IP address**. Exceeding this limit returns HTTP 429.

## Core Endpoints

### GET /metrics

Returns comprehensive real-time statistics and performance data.

**Available in:** Client and Server mode

**Response:**

```json
{
  "uptime": {
    "milliseconds": 3600000,
    "seconds": 3600,
    "formatted": "1h 0m 0s"
  },
  "mode": "client",
  "stats": {
    "deltasSent": 12345,
    "deltasReceived": 0,
    "udpSendErrors": 0,
    "udpRetries": 2,
    "compressionErrors": 0,
    "encryptionErrors": 0,
    "subscriptionErrors": 0
  },
  "status": {
    "readyToSend": true,
    "deltasBuffered": 5
  },
  "bandwidth": {
    "bytesOut": 524288,
    "bytesIn": 1024,
    "bytesOutRaw": 10485760,
    "bytesInRaw": 0,
    "bytesOutFormatted": "512.00 KB",
    "bytesInFormatted": "1.00 KB",
    "packetsOut": 1234,
    "packetsIn": 100,
    "rateOut": 145.6,
    "rateIn": 0.28,
    "rateOutFormatted": "145.60 B/s",
    "rateInFormatted": "0.28 B/s",
    "compressionRatio": 95.0,
    "avgPacketSize": 425,
    "avgPacketSizeFormatted": "425 B",
    "history": []
  },
  "pathStats": [],
  "smartBatching": {
    "earlySends": 50,
    "timerSends": 1184,
    "oversizedPackets": 0,
    "avgBytesPerDelta": 180,
    "maxDeltasPerBatch": 6
  },
  "networkQuality": {
    "rtt": 45,
    "jitter": 12,
    "retransmissions": 3,
    "queueDepth": 0,
    "acksSent": 0,
    "naksSent": 0,
    "linkQuality": 92
  },
  "sourceReplication": {
    "metrics": {
      "upserts": 42,
      "noops": 101,
      "missingIdentity": 2,
      "conflicts": 7
    },
    "registry": null
  },
  "lastError": null
}
```

---

### GET /network-metrics

Returns current network quality metrics including link quality score.

**Available in:** Client and Server mode

**Response:**

```json
{
  "rtt": 45,
  "jitter": 12,
  "retransmissions": 3,
  "queueDepth": 0,
  "acksSent": 0,
  "naksSent": 0,
  "linkQuality": 92,
  "timestamp": 1707321234567
}
```

---

### GET /sources

Returns server source-replication entries (schema v1) with identity, timing, and provenance fields.

**Available in:** Client and Server mode (typically meaningful in server mode)
**Auth required:** Yes (`sources.read`, enforced by `managementAuthMiddleware("sources.read")`)

**Response:**

```json
{
  "schemaVersion": 1,
  "size": 2,
  "sources": [
    {
      "identity": {
        "label": "N2K depth",
        "type": "NMEA2000"
      },
      "firstSeenAt": "2026-04-27T00:00:00.000Z",
      "lastSeenAt": "2026-04-27T00:00:01.000Z",
      "provenance": {
        "lastUpdatedBy": "source"
      },
      "metadata": {}
    }
  ]
}
```

`GET /metrics` includes only `sourceReplication.metrics` counters (`upserts`, `noops`, `missingIdentity`, `conflicts`).

For full field definitions and compatibility shapes, see `docs/source-replication-schema.md`.
Route implementation details: `src/routes/metrics.ts`.

Source replication in this endpoint is driven by normal DATA delta ingest (`update.source`/`$source`) and does not depend on optional metadata packet streaming being enabled.

---

### GET /paths

Returns the Signal K path dictionary with categorized paths.

**Available in:** Client and Server mode

**Response:**

```json
{
  "total": 172,
  "categories": {
    "navigation": {
      "prefix": "navigation",
      "paths": ["navigation.position", "navigation.courseOverGroundTrue", "..."]
    },
    "environment": {
      "prefix": "environment",
      "paths": ["environment.wind.speedApparent", "..."]
    }
  }
}
```

---

## Configuration Endpoints

### GET /config/:filename

Read a configuration file. Valid filenames: `delta_timer.json`, `subscription.json`, `sentence_filter.json`.

**Available in:** Client mode only

**Response:** The JSON contents of the configuration file.

---

### POST /config/:filename

Update a configuration file. Changes take effect immediately via hot-reload.

**Available in:** Client mode only

**Content-Type:** `application/json`

**Body:** The new configuration data as JSON.

**Response:** `200 OK` on success, `500` on failure.

---

### GET /plugin-config

Read current plugin configuration.

**Available in:** Client and Server mode

**Response:**

```json
{
  "success": true,
  "configuration": {
    "connections": [
      {
        "name": "shore-server",
        "serverType": "server",
        "udpPort": 4446,
        "secretKey": "[redacted]"
      }
    ]
  }
}
```

`GET /plugin-config` redacts stored `secretKey` values as `[redacted]`.

---

### POST /plugin-config

Update plugin configuration. Triggers a plugin restart to apply changes.

**Available in:** Client and Server mode

**Content-Type:** `application/json`

**Body format (preferred — connections array):**

```json
{
  "connections": [
    {
      "name": "shore-server",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "..."
    },
    {
      "name": "sat-client",
      "serverType": "client",
      "udpPort": 4447,
      "secretKey": "...",
      "udpAddress": "10.0.0.1",
      "testAddress": "8.8.8.8",
      "testPort": 53
    }
  ]
}
```

**Body format (legacy — flat single connection, auto-normalised to array):**

```json
{
  "serverType": "client",
  "udpPort": 4446,
  "secretKey": "...",
  "udpAddress": "192.168.1.100",
  "testAddress": "8.8.8.8",
  "testPort": 53
}
```

**Required per connection:** `serverType`, `udpPort`, `secretKey`

`secretKey` accepts the same formats as runtime crypto: 32-character ASCII,
64-character hex, or 44-character base64. Submitting `[redacted]` keeps the
stored secret for an existing connection slot unchanged.

**Additional required (client mode):** `udpAddress`, `testAddress`, `testPort`

**Response:**

```json
{
  "success": true,
  "message": "Configuration saved. Plugin restarting...",
  "restarting": true
}
```

---

### GET /plugin-schema

Returns the RJSF-compatible JSON schema for the plugin configuration UI.

**Available in:** Client and Server mode

---

## Congestion Control Endpoints

### GET /congestion

Returns the current congestion control state.

**Available in:** Client mode only

**Response:**

```json
{
  "enabled": true,
  "manualMode": false,
  "currentDeltaTimer": 850,
  "avgRTT": 45.32,
  "avgLoss": 0.002,
  "targetRTT": 200,
  "minDeltaTimer": 100,
  "maxDeltaTimer": 5000,
  "adjustInterval": 5000,
  "maxAdjustment": 0.2
}
```

---

### POST /delta-timer

Manually set the delta timer value (disables congestion control auto-adjustment), or re-enable automatic mode.

**Available in:** Client mode only

**Content-Type:** `application/json`

**Manual override:**

```json
{ "value": 500 }
```

Value must be between 100 and 10,000 ms.

**Re-enable auto mode:**

```json
{ "mode": "auto" }
```

**Response:**

```json
{
  "deltaTimer": 500,
  "mode": "manual"
}
```

---

## Connection Bonding Endpoints

### GET /bonding

Returns current bonding state including per-link health.

**Available in:** Client mode only (when bonding is enabled)

**Response:**

```json
{
  "enabled": true,
  "mode": "main-backup",
  "activeLink": "primary",
  "lastFailoverTime": 0,
  "failoverThresholds": {
    "rttThreshold": 500,
    "lossThreshold": 0.1,
    "healthCheckInterval": 1000,
    "failbackDelay": 30000,
    "heartbeatTimeout": 5000
  },
  "links": {
    "primary": {
      "address": "192.168.1.100",
      "port": 4446,
      "status": "active",
      "rtt": 45,
      "loss": 0.01,
      "quality": 95,
      "heartbeatsSent": 120,
      "heartbeatResponses": 118
    },
    "backup": {
      "address": "10.0.0.100",
      "port": 4447,
      "status": "standby",
      "rtt": 120,
      "loss": 0.02,
      "quality": 85,
      "heartbeatsSent": 120,
      "heartbeatResponses": 116
    }
  }
}
```

---

### POST /bonding/failover

Manually trigger failover to the other link (toggles between primary/backup).

**Available in:** Client mode only (when bonding is enabled)

**Response:**

```json
{
  "success": true,
  "activeLink": "backup",
  "links": { "...per-link health data..." }
}
```

---

## Monitoring Endpoints

### GET /monitoring/packet-loss

Returns packet loss heatmap data for visualization. Data is organized in time buckets (default 5-second intervals, 60 buckets).

**Available in:** Client and Server mode

**Response:**

```json
{
  "heatmap": [
    { "timestamp": 1707321230000, "total": 100, "lost": 2, "lossRate": 0.02 },
    { "timestamp": 1707321235000, "total": 95, "lost": 0, "lossRate": 0 }
  ],
  "summary": {
    "overallLossRate": 0.01,
    "maxLossRate": 0.05,
    "trend": "stable",
    "bucketCount": 45
  }
}
```

Trend values: `"stable"`, `"improving"`, `"worsening"`

---

### GET /monitoring/path-latency

Returns per-path latency tracking data with percentile statistics.

**Available in:** Client and Server mode

**Query parameters:**

- `limit` (optional, default 20): Maximum paths to return

**Response:**

```json
{
  "paths": [
    {
      "path": "navigation.position",
      "sampleCount": 50,
      "avg": 1.23,
      "min": 0.5,
      "max": 5.2,
      "p50": 1.1,
      "p95": 3.2,
      "p99": 4.8,
      "lastUpdate": 1707321234567
    }
  ]
}
```

---

### GET /monitoring/retransmissions

Returns retransmission rate chart data (time series).

**Available in:** Client and Server mode

**Query parameters:**

- `limit` (optional): Maximum entries to return

**Response:**

```json
{
  "chartData": [
    {
      "timestamp": 1707321230000,
      "rate": 0.02,
      "retransmitsPerSec": 1.5,
      "periodPackets": 100,
      "periodRetransmissions": 2
    }
  ],
  "summary": {
    "avgRate": 0.015,
    "maxRate": 0.05,
    "currentRate": 0.02,
    "entries": 45
  }
}
```

---

### GET /monitoring/alerts

Returns current alert thresholds and any active alerts.

**Available in:** Client and Server mode

**Response:**

```json
{
  "thresholds": {
    "rtt": { "warning": 300, "critical": 800 },
    "packetLoss": { "warning": 0.03, "critical": 0.1 },
    "retransmitRate": { "warning": 0.05, "critical": 0.15 },
    "jitter": { "warning": 100, "critical": 300 },
    "queueDepth": { "warning": 100, "critical": 500 }
  },
  "activeAlerts": {
    "rtt": {
      "metric": "rtt",
      "level": "warning",
      "value": 350,
      "threshold": 300,
      "timestamp": 1707321234567
    }
  }
}
```

---

### POST /monitoring/alerts

Update alert thresholds for a specific metric.

**Available in:** Client and Server mode

**Content-Type:** `application/json`

**Body:**

```json
{
  "metric": "rtt",
  "warning": 200,
  "critical": 600
}
```

**Response:**

```json
{
  "success": true,
  "thresholds": { "...updated thresholds..." }
}
```

---

### GET /monitoring/inspector

Returns packet inspector statistics (WebSocket live inspector).

**Available in:** Client and Server mode

**Response:**

```json
{
  "enabled": true,
  "packetsInspected": 5000,
  "clientsConnected": 1
}
```

---

### GET /monitoring/simulation

Returns current network simulation state (testing mode only).

**Available in:** Client and Server mode

---

## Packet Capture Endpoints

### GET /capture

Returns packet capture statistics.

**Available in:** Client and Server mode

**Response:**

```json
{
  "enabled": true,
  "captured": 500,
  "dropped": 0,
  "buffered": 500
}
```

---

### POST /capture/start

Start packet capture. Packets are stored in a circular buffer (max 1,000 packets).

**Available in:** Client and Server mode

---

### POST /capture/stop

Stop packet capture.

**Available in:** Client and Server mode

---

### GET /capture/export

Export captured packets as a `.pcap` file (libpcap format).

**Available in:** Client and Server mode

**Content-Type:** `application/vnd.tcpdump.pcap`

The file can be opened in Wireshark or similar packet analysis tools. Uses DLT_USER0 link type.

---

## Multi-Connection Endpoints

These endpoints are used when more than one connection is configured. Each `:id` is the slugified connection name (e.g. `shore-server`, `sat-client`).

## Management & Instance Lifecycle Endpoints

These endpoints are intended for operator workflows (inventory, lifecycle changes, and fleet health rollups).

Authentication behavior for all endpoints in this section:

- **Auth required:** Conditional. If `managementApiToken` (or `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`) is configured, requests must include a valid token.
- **Accepted token headers:**
  - `X-Edge-Link-Token: <token>`
  - `Authorization: Bearer <token>`
  - `X-Management-Token: <token>` (backward-compatible alias)
- **Auth error:** `401 Unauthorized` with `{ "error": "Unauthorized management API request" }`.

For CLI-focused operational examples, see `docs/management-tools.md` (`Status and error summaries`, `Instance management`, and `CLI workflows`).

---

### GET /status

Aggregated health summary across all currently running instances.

**Available in:** Client and Server mode (requires at least one started instance)

**Auth required:** Conditional management token (see section auth notes above)

**Query parameters:** None

**Success response (`200 OK`):**

```json
{
  "healthyInstances": 1,
  "totalInstances": 2,
  "instances": [
    {
      "id": "shore-server",
      "name": "Shore Server",
      "healthy": true,
      "status": "Server listening on port 4446",
      "lastError": null,
      "lastErrorTime": null,
      "errorCounts": {
        "udpSendErrors": 0,
        "compressionErrors": 0
      },
      "recentErrors": []
    }
  ]
}
```

**Representative errors:**

- `401` when token validation fails (if token auth is enabled).
- `503` when plugin instances are not started:

```json
{ "error": "Plugin not started" }
```

**Operational examples:** See `docs/management-tools.md` → **Status and error summaries** and **CLI workflows**.

---

### GET /instances

Lists instance records with optional state filtering and optional pagination.

**Available in:** Client and Server mode

**Auth required:** Conditional management token (see section auth notes above)

**Query parameters:**

- `state` (optional, string): exact (case-insensitive) match against runtime state text (for example `running`).
- `limit` (optional, integer > 0): enables paginated output when provided.
- `page` (optional, integer > 0, default `1` when `limit` is provided): page number.

**Response shapes:**

- Without `limit`: returns a plain array.
- With `limit`: returns `{ items, pagination }`.

**Success response (non-paginated, `200 OK`):**

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "protocolVersion": 3,
    "state": "Ready",
    "currentLink": "primary",
    "metrics": {
      "deltasSent": 1234,
      "deltasReceived": 0,
      "udpSendErrors": 0,
      "duplicatePackets": 0
    }
  }
]
```

**Success response (paginated, `200 OK`):**

```json
{
  "items": [
    {
      "id": "shore-server",
      "name": "Shore Server",
      "protocolVersion": 3,
      "state": "Ready",
      "currentLink": "primary",
      "metrics": {
        "deltasSent": 1234,
        "deltasReceived": 0,
        "udpSendErrors": 0,
        "duplicatePackets": 0
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

**Representative errors:**

- `400` invalid pagination values:
  - `{ "error": "limit must be a positive integer" }`
  - `{ "error": "page must be a positive integer" }`
- `401` unauthorized when token auth is enabled and token is missing/invalid.

**Operational examples:** See `docs/management-tools.md` → **Instance management** (`List instances`, `List with filters/pagination`) and **CLI workflows**.

---

### GET /instances/:id

Returns detailed runtime, network, bonding, metrics, and effective config view for one instance.

**Available in:** Client and Server mode

**Auth required:** Conditional management token (see section auth notes above)

**Path parameters:**

- `id` (required): slugified instance name.

**Success response (`200 OK`):**

```json
{
  "id": "shore-server",
  "name": "Shore Server",
  "mode": "server",
  "protocolVersion": 3,
  "state": "Server listening on port 4446",
  "readyToSend": true,
  "currentLink": "primary",
  "network": {
    "rtt": 0,
    "jitter": 0,
    "packetLoss": 0,
    "retransmissions": 0,
    "queueDepth": 0,
    "dataSource": "local"
  },
  "metrics": {
    "deltasSent": 1234,
    "deltasReceived": 0,
    "udpSendErrors": 0,
    "duplicatePackets": 0
  },
  "bonding": { "enabled": false },
  "config": {
    "name": "Shore Server",
    "serverType": "server",
    "udpPort": 4446,
    "secretKey": "[redacted]"
  }
}
```

**Representative errors:**

- `401` unauthorized when token auth is enabled and token is missing/invalid.
- `404` when id is unknown:

```json
{ "error": "Instance 'shore-server' not found" }
```

**Operational examples:** See `docs/management-tools.md` → **Instance management** (`Show one instance`) and **CLI workflows**.

---

### POST /instances

Creates a new instance entry and restarts plugin runtime with the updated `connections` set.

**Available in:** Client and Server mode

**Auth required:** Conditional management token (see section auth notes above)

**Content-Type:** `application/json`

**Body schema:** Connection object validated with the same rules as plugin configuration connections.

- Required fields:
  - `name` (string, max 40 chars)
  - `serverType` (`"server"` or `"client"`)
  - `udpPort` (integer, 1024-65535)
  - `secretKey` (runtime-supported key format)
- Additional required for `serverType: "client"`:
  - `udpAddress` (string)
  - `testAddress` (string)
  - `testPort` (integer, 1-65535)
- Optional mutable config fields are the same family used in plugin config (for example `protocolVersion`, `useMsgpack`, `reliability`, `bonding`, `congestionControl`, `alertThresholds`).

**Success response (`201 Created`):**

```json
{ "success": true }
```

**Representative errors:**

- `400` malformed/invalid body or validation failure, for example:
  - `{ "error": "Request body must be a JSON object" }`
  - `{ "error": "Missing required field 'name'" }`
  - `{ "error": "udpPort must be an integer between 1024 and 65535" }`
- `401` unauthorized when token auth is enabled and token is missing/invalid.
- `503` restart handler unavailable (`{ "error": "Runtime restart handler unavailable" }`).

**Operational examples:** See `docs/management-tools.md` → **Instance management** (`Create instance`) and **CLI workflows**.

---

### PUT /instances/:id

Patches one existing instance configuration and restarts plugin runtime.

**Available in:** Client and Server mode

**Auth required:** Conditional management token (see section auth notes above)

**Content-Type:** `application/json`

**Path parameters:**

- `id` (required): slugified instance name.

**Body schema:** JSON object with at least one supported mutable field.

- Updatable keys:
  - `name`, `protocolVersion`, `useMsgpack`, `usePathDictionary`, `enableNotifications`
  - `udpAddress`, `helloMessageSender`, `testAddress`, `testPort`, `pingIntervalTime`
  - `reliability`, `congestionControl`, `bonding`, `alertThresholds`
- Not updatable via this endpoint: `serverType`, `udpPort`, `secretKey`

**Success response (`200 OK`):**

```json
{ "success": true }
```

**Representative errors:**

- `400` invalid patch payload, for example:
  - `{ "error": "Request body must include at least one field to update" }`
  - `{ "error": "Field 'secretKey' is not updatable via /instances/:id" }`
  - `{ "error": "Field 'foo' is not supported for /instances/:id updates" }`
- `401` unauthorized when token auth is enabled and token is missing/invalid.
- `404` instance/config missing:
  - `{ "error": "Instance '<id>' not found" }`
  - `{ "error": "Configuration for instance '<id>' not found" }`
- `503` restart handler unavailable.

**Operational examples:** See `docs/management-tools.md` → **Instance management** (`Update instance`) and **CLI workflows**.

---

### DELETE /instances/:id

Deletes an existing instance from persisted connections and restarts runtime.

**Available in:** Client and Server mode

**Auth required:** Conditional management token (see section auth notes above)

**Path parameters:**

- `id` (required): slugified instance name.

**Success response (`200 OK`):**

```json
{ "success": true }
```

**Representative errors:**

- `401` unauthorized when token auth is enabled and token is missing/invalid.
- `404` when instance id or stored config record is not found.
- `400` if deletion would leave zero configured instances:

```json
{ "error": "At least one instance must remain configured" }
```

- `503` restart handler unavailable.

**Operational examples:** See `docs/management-tools.md` → **Instance management** (`Delete instance`) and **CLI workflows**.

---

### GET /connections

List all active connections with status.

**Available in:** Client and Server mode

**Response:**

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "type": "server",
    "port": 4446,
    "protocolVersion": 3,
    "status": "Server listening on port 4446",
    "healthy": true,
    "readyToSend": true
  },
  {
    "id": "sat-client",
    "name": "Sat Client",
    "type": "client",
    "port": 4447,
    "protocolVersion": 3,
    "status": "Ready",
    "healthy": true,
    "readyToSend": true
  }
]
```

---

### GET /connections/:id/metrics

Returns metrics for a specific connection instance.

**Available in:** Client and Server mode

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same fields as `GET /metrics`, plus `instanceId` and `mode`.

---

### GET /connections/:id/network-metrics

Returns network quality metrics for a specific connection.

**Available in:** Client and Server mode

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same fields as `GET /network-metrics`, plus `instanceId`.

---

### GET /connections/:id/bonding

Returns bonding state for a specific client connection.

**Available in:** Client mode only

**Auth required:** Yes (`connection-bonding.read`)

**Response:** Same as `GET /bonding`.

---

### GET /connections/:id/congestion

Returns congestion control state for a specific client connection.

**Available in:** Client mode only

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same as `GET /congestion`.

---

### GET /connections/:id/monitoring/alerts

Returns alert thresholds and active alerts for a specific connection instance.

**Available in:** Client and Server mode

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same as `GET /monitoring/alerts`.

---

### GET /connections/:id/monitoring/packet-loss

Returns packet-loss heatmap data for a specific connection instance.

**Available in:** Client and Server mode

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same as `GET /monitoring/packet-loss`.

---

### GET /connections/:id/monitoring/retransmissions

Returns retransmission chart data for a specific connection instance.

**Available in:** Client and Server mode

**Auth required:** Yes (`connection-monitoring.read`)

**Response:** Same as `GET /monitoring/retransmissions`.

---

### GET /connections/:id/config/:filename

Read a runtime config file for a specific client connection.

**Available in:** Client mode only

**Auth required:** Yes (`connection-config.read`)

**Response:** The JSON contents of the configuration file.

---

### POST /connections/:id/config/:filename

Update a runtime config file for a specific client connection.

**Available in:** Client mode only

**Auth required:** Yes (`connection-config.update`)

**Content-Type:** `application/json`

**Response:** `200 OK` on success.

---

## Prometheus Endpoint

### GET /prometheus

Returns metrics in Prometheus text exposition format for scraping.

**Available in:** Client and Server mode

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

**Exported metrics (30+):**

| Metric                                            | Type    | Description               |
| ------------------------------------------------- | ------- | ------------------------- |
| `signalk_edge_link_uptime_seconds`                | gauge   | Plugin uptime             |
| `signalk_edge_link_deltas_sent_total`             | counter | Total deltas sent         |
| `signalk_edge_link_deltas_received_total`         | counter | Total deltas received     |
| `signalk_edge_link_udp_send_errors_total`         | counter | UDP send errors           |
| `signalk_edge_link_bytes_out_total`               | counter | Compressed bytes sent     |
| `signalk_edge_link_bytes_in_total`                | counter | Compressed bytes received |
| `signalk_edge_link_bytes_out_raw_total`           | counter | Raw bytes sent            |
| `signalk_edge_link_packets_out_total`             | counter | Packets sent              |
| `signalk_edge_link_packets_in_total`              | counter | Packets received          |
| `signalk_edge_link_bandwidth_rate_out_bytes`      | gauge   | Outbound bytes/s          |
| `signalk_edge_link_bandwidth_rate_in_bytes`       | gauge   | Inbound bytes/s           |
| `signalk_edge_link_compression_ratio_percent`     | gauge   | Compression ratio         |
| `signalk_edge_link_rtt_milliseconds`              | gauge   | Round-trip time           |
| `signalk_edge_link_jitter_milliseconds`           | gauge   | Jitter                    |
| `signalk_edge_link_retransmissions_total`         | counter | Retransmissions           |
| `signalk_edge_link_queue_depth`                   | gauge   | Retransmit queue depth    |
| `signalk_edge_link_packet_loss_rate`              | gauge   | Packet loss ratio         |
| `signalk_edge_link_link_quality_score`            | gauge   | Link quality (0-100)      |
| `signalk_edge_link_bonding_active_link`           | gauge   | Active link (1/2)         |
| `signalk_edge_link_bonding_link_rtt_milliseconds` | gauge   | Per-link RTT              |
| `signalk_edge_link_bonding_link_loss_rate`        | gauge   | Per-link loss             |
| `signalk_edge_link_bonding_link_quality`          | gauge   | Per-link quality          |

All metrics include a `mode` label (`"client"` or `"server"`). Bonding metrics include a `link` label (`"primary"` or `"backup"`).

**Prometheus configuration example:**

```yaml
scrape_configs:
  - job_name: "signalk-edge-link"
    scrape_interval: 15s
    metrics_path: "/plugins/signalk-edge-link/prometheus"
    static_configs:
      - targets: ["signalk-server:3000"]
```
