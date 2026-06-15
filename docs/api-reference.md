# Signal K Edge Link — REST API Reference

> **Base path:** `/plugins/signalk-edge-link`  
> **Rate limit:** 120 requests/minute/IP → HTTP 429  
> **API version tracked (current: 3.0.0)** — for endpoint changes between releases, see `docs/pr-records/`

---

## Core Data Endpoints

> **Multi-instance note:** the top-level JSON endpoints below (`/metrics`,
> `/network-metrics`, the `/monitoring/*` and `/capture` routes, etc.) report the
> **first instance** only — they are legacy/single-instance views. `/prometheus`
> aggregates across all instances. For multi-instance deployments use the
> per-connection endpoints under [`/connections/:id/...`](#per-connection-endpoints).

### GET /metrics

Returns comprehensive real-time statistics. Available in client and server mode.

```json
{
  "uptime": { "milliseconds": 3600000, "formatted": "1h 0m 0s" },
  "mode": "client",
  "stats": {
    "deltasSent": 12345,
    "deltasReceived": 0,
    "udpSendErrors": 0,
    "compressionErrors": 0,
    "encryptionErrors": 0
  },
  "status": { "readyToSend": true, "deltasBuffered": 5 },
  "bandwidth": {
    "bytesOut": 524288,
    "bytesOutRaw": 10485760,
    "packetsOut": 1234,
    "rateOut": 145.6,
    "compressionRatio": 95.0,
    "avgPacketSize": 425,
    "history": []
  },
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
    "metrics": { "upserts": 42, "noops": 101, "missingIdentity": 2, "conflicts": 7 }
  },
  "managementAuth": {
    "total": 42,
    "allowed": 40,
    "denied": 2,
    "byReason": { "open_access": 10, "valid_token": 30, "invalid_token": 2 }
  }
}
```

> The `managementAuth` block is present **only when a `managementApiToken` is
> configured**. In open-access mode it is omitted from `/status` and `/metrics`,
> and the equivalent management-auth metrics are omitted from `/prometheus`.

### GET /network-metrics

Current network quality. Available in client and server mode.

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

### GET /sources

Server source-replication entries. Auth required (`sources.read`).

```json
{
  "schemaVersion": 1,
  "size": 2,
  "sources": [
    {
      "identity": { "label": "N2K depth", "type": "NMEA2000" },
      "firstSeenAt": "2026-04-27T00:00:00.000Z",
      "lastSeenAt": "2026-04-27T00:00:01.000Z",
      "provenance": { "lastUpdatedBy": "source" },
      "metadata": {}
    }
  ]
}
```

### GET /paths

Signal K path dictionary with categorized paths.

```json
{
  "total": 172,
  "categories": {
    "navigation": { "paths": ["navigation.position", "..."] },
    "environment": { "paths": ["environment.wind.speedApparent", "..."] }
  }
}
```

---

## Configuration Endpoints

### GET /config/:filename

Read a runtime config file. Valid filenames: `delta_timer.json`, `subscription.json`, `sentence_filter.json`. Client mode only.

### POST /config/:filename

Update a runtime config file. Changes take effect immediately via hot-reload. Client mode only. Body: JSON. Returns `200` on success.

### GET /plugin-config

Read current plugin configuration. `secretKey` values are redacted as `[redacted]`.

```json
{
  "success": true,
  "configuration": {
    "connections": [
      { "name": "shore-server", "serverType": "server", "udpPort": 4446, "secretKey": "[redacted]" }
    ]
  }
}
```

### POST /plugin-config

Update plugin configuration. Triggers a plugin restart to apply changes.

Required per connection: `serverType`, `udpPort`, `secretKey`.  
Additional required for client mode: `udpAddress`.  
Submitting `[redacted]` for `secretKey` keeps the stored secret unchanged.

```json
{ "success": true, "message": "Configuration saved. Plugin restarting...", "restarting": true }
```

**Errors:** `400` validation failure, `503` restart handler unavailable.

### GET /plugin-schema

Returns the RJSF-compatible JSON schema for the plugin configuration UI.

---

## Congestion Control Endpoints

### GET /congestion

Current congestion control state. Client mode only. See [congestion-control.md](congestion-control.md) for field descriptions.

### POST /delta-timer

Manually set or clear the delta timer. Client mode only.

```json
{ "value": 500 }
```

Value: 100–10000 ms. Re-enable auto mode: `{ "mode": "auto" }`.

Response: `{ "deltaTimer": 500, "mode": "manual" }`

---

## Bonding Endpoints

### GET /bonding

Current bonding state including per-link health. Client mode only (when bonding enabled). See [bonding.md](bonding.md#monitoring-and-manual-control) for full response shape.

### POST /bonding/failover

Manually trigger failover (toggle primary ↔ backup). Client mode only.

```json
{ "success": true, "activeLink": "backup" }
```

### POST /bonding

Update failover threshold settings across all bonding-enabled instances. Unsupported keys or out-of-range values return `400`.

---

## Monitoring Endpoints

### GET /monitoring/packet-loss

Packet loss heatmap (5-second buckets, 60 buckets = 5 minutes).

```json
{
  "heatmap": [{ "timestamp": 1707321230000, "total": 100, "lost": 2, "lossRate": 0.02 }],
  "summary": { "overallLossRate": 0.01, "maxLossRate": 0.05, "trend": "stable" }
}
```

Trend values: `"stable"`, `"improving"`, `"worsening"`.

### GET /monitoring/path-latency

Per-path latency with percentile statistics. Query param: `limit` (default 20).

```json
{
  "paths": [
    {
      "path": "navigation.position",
      "sampleCount": 50,
      "avg": 1.23,
      "p50": 1.1,
      "p95": 3.2,
      "p99": 4.8,
      "lastUpdate": 1707321234567
    }
  ]
}
```

### GET /monitoring/retransmissions

Retransmission rate time series. Query param: `limit`.

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
  "summary": { "avgRate": 0.015, "maxRate": 0.05, "currentRate": 0.02 }
}
```

### GET /monitoring/alerts

Current alert thresholds and any active alerts.

```json
{
  "thresholds": {
    "rtt": { "warning": 300, "critical": 800 },
    "packetLoss": { "warning": 0.03, "critical": 0.1 }
  },
  "activeAlerts": {
    "rtt": { "metric": "rtt", "level": "warning", "value": 350, "threshold": 300 }
  }
}
```

### POST /monitoring/alerts

Update alert thresholds. Changes take effect immediately; persisted to plugin options within 1 second.

```json
{ "metric": "rtt", "warning": 200, "critical": 600 }
```

Alert cooldown is 60 seconds. Notifications fire at `notifications.signalk-edge-link.<instanceId>.<metric>`.

### GET /monitoring/inspector

Returns packet-inspector statistics (a plain JSON snapshot from a `GET`; there is no WebSocket/live-stream endpoint).

```json
{ "enabled": true, "packetsInspected": 5000, "clientsConnected": 1 }
```

### GET /prometheus

Prometheus text format. See [metrics.md](metrics.md#prometheus-metrics) for full metric list.

---

## Packet Capture Endpoints

### POST /capture/start / POST /capture/stop

Start or stop packet capture. Packets stored in circular buffer (max 1000 packets).

### GET /capture

Capture statistics: `{ "enabled": true, "captured": 500, "dropped": 0, "buffered": 500 }`

### GET /capture/export

Export as `.pcap` file (libpcap format, DLT_USER0 link type). Open in Wireshark.

---

## Status and Instance Management Endpoints

Auth behavior: if `managementApiToken` is configured, a valid token must be provided. Headers accepted: `X-Edge-Link-Token`, `Authorization: Bearer`, `X-Management-Token` (legacy). Returns `401` on invalid token, `403` when token is required but not configured.

### GET /status

Aggregated health summary across all running instances.

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
      "errorCounts": { "udpSendErrors": 0 },
      "recentErrors": []
    }
  ],
  "managementAuth": { "total": 42, "allowed": 40, "denied": 2 }
}
```

**Errors:** `401` unauthorized, `403` token required but not configured (`requireManagementApiToken: true`), `503` when plugin not started.

### GET /instances

Lists instance records with optional state filtering and pagination.

Query params: `state` (e.g., `running`), `limit`, `page`.

Without `limit`: returns a plain array. With `limit`: returns `{ items, pagination }`.

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "protocolVersion": 3,
    "state": "Ready",
    "currentLink": "primary",
    "metrics": { "deltasSent": 1234, "deltasReceived": 0, "udpSendErrors": 0 }
  }
]
```

**Errors:** `400` invalid pagination values, `401` unauthorized.

### GET /instances/:id

Detailed runtime, network, bonding, metrics, and config view for one instance.

```json
{
  "id": "shore-server",
  "name": "Shore Server",
  "mode": "server",
  "protocolVersion": 3,
  "state": "Server listening on port 4446",
  "readyToSend": true,
  "currentLink": "primary",
  "network": { "rtt": 0, "jitter": 0, "packetLoss": 0 },
  "metrics": { "deltasSent": 1234, "deltasReceived": 0 },
  "bonding": { "enabled": false },
  "config": {
    "name": "Shore Server",
    "serverType": "server",
    "udpPort": 4446,
    "secretKey": "[redacted]"
  }
}
```

**Errors:** `401` unauthorized, `404` instance not found.

### POST /instances

Create a new instance. Triggers a plugin restart. Returns `201` on success.

Required fields: `name`, `serverType`, `udpPort`, `secretKey`.  
Additional required for client: `udpAddress`.

**Errors:** `400` validation failure, `401` unauthorized, `503` restart handler unavailable.

### PUT /instances/:id

Patch one instance configuration. Triggers a plugin restart. Returns `200` on success.

Updatable: `name`, `protocolVersion`, `useMsgpack`, `usePathDictionary`, `enableNotifications`, `udpAddress`, `helloMessageSender`, `reliability`, `congestionControl`, `bonding`, `alertThresholds`.

**Not updatable via this endpoint:** `serverType`, `udpPort`, `secretKey`. Any other field (including `udpMetaPort`, `testAddress`, `testPort`, and `pingIntervalTime`) is rejected with `400`; change those by replacing the full configuration via `POST /plugin-config`.

**Errors:** `400` (unsupported field, validation), `401`, `404`, `503`.

### DELETE /instances/:id

Delete an instance. Triggers a plugin restart.

**Errors:** `400` if this would leave zero configured instances, `401`, `404`, `503`.

### GET /connections

List all active connections with status.

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "type": "server",
    "port": 4446,
    "protocolVersion": 3,
    "status": "Server listening on port 4446",
    "healthy": true
  }
]
```

---

## Per-Connection Endpoints

These mirror the global endpoints but are scoped to a specific connection. `:id` is the slugified connection name (e.g., `shore-server`).

| Endpoint                                          | Auth                         | Available in |
| ------------------------------------------------- | ---------------------------- | ------------ |
| `GET /connections/:id/metrics`                    | `connection-monitoring.read` | Both         |
| `GET /connections/:id/network-metrics`            | `connection-monitoring.read` | Both         |
| `GET /connections/:id/bonding`                    | `connection-bonding.read`    | Client only  |
| `GET /connections/:id/congestion`                 | `connection-monitoring.read` | Client only  |
| `GET /connections/:id/monitoring/alerts`          | `connection-monitoring.read` | Both         |
| `GET /connections/:id/monitoring/packet-loss`     | `connection-monitoring.read` | Both         |
| `GET /connections/:id/monitoring/retransmissions` | `connection-monitoring.read` | Both         |
| `GET /connections/:id/config/:filename`           | `connection-config.read`     | Client only  |
| `POST /connections/:id/config/:filename`          | `connection-config.update`   | Client only  |

Response shapes are identical to the corresponding global endpoint.
