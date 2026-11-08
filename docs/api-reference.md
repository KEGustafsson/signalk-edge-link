# Signal K Edge Link — REST API Reference

> **Base path:** `/plugins/signalk-edge-link`  
> **Rate limit:** 120 requests/minute/IP → HTTP 429  
> **API version tracked (current: 4.4.0)** — see CHANGELOG.md for endpoint changes between releases

---

## Conventions

Every route goes through the management-auth check. It requires a token once `managementApiToken` (or `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`) is set, or when `requireManagementApiToken` is on; otherwise requests pass as open access. Token headers and setup: [management-tools.md](management-tools.md#authentication).

The top-level JSON endpoints (`/metrics`, `/network-metrics`, `/monitoring/*`, `/capture*`) report the **first instance** only. Client-only singleton routes (`/config/:filename`, `/congestion`, `/delta-timer`, `/bonding/failover`) use the first **client** instance. `/prometheus`, `/status`, `/bonding`, `/connections` and `/instances` cover all instances. For one connection in a multi-instance setup use [`/connections/:id/...`](#per-connection-endpoints).

Errors are JSON `{ "error": "<message>" }`. `/plugin-config` routes also set `"success": false`; `/config/:filename` returns the error object alone.

| Code | When                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | Validation failure                                                                                                                                                                                         |
| 401  | Missing or invalid token: `Unauthorized management API request`                                                                                                                                            |
| 403  | Token required but none configured (`requireManagementApiToken: true`); or a bodyless POST with `Sec-Fetch-Site` other than `same-origin`/`same-site`/`none`                                               |
| 404  | Instance/connection not found; `Not available in server mode` on client-only routes when no client instance exists                                                                                         |
| 415  | JSON POST/PUT without `Content-Type: application/json`; bodyless POST (`/capture/start`, `/capture/stop`, `/bonding/failover`, `/connections/:id/bonding/failover`) with a form content type               |
| 429  | Rate limit exceeded: `Too many requests, please try again later`                                                                                                                                           |
| 500  | Handler error                                                                                                                                                                                              |
| 503  | `Plugin not started`; the subsystem the route needs is not initialized; or the auth check could not read the plugin configuration (`Management API temporarily unavailable: unable to read configuration`) |

### Endpoint index

The auth action is the `action` label in `managementAuth.byAction` and `signalk_edge_link_management_auth_requests_total`.

| Method | Path                          | Auth action                            | Mode   |
| ------ | ----------------------------- | -------------------------------------- | ------ |
| GET    | `/metrics`                    | `metrics.read`                         | Both   |
| GET    | `/network-metrics`            | `network-metrics.read`                 | Both   |
| GET    | `/prometheus`                 | `prometheus.read`                      | Both   |
| GET    | `/sources`                    | `sources.read`                         | Both   |
| GET    | `/paths`                      | `paths.read`                           | Both   |
| GET    | `/config/:filename`           | `config-file.read`                     | Client |
| POST   | `/config/:filename`           | `config-file.update`                   | Client |
| GET    | `/plugin-config`              | `config.read`                          | Both   |
| POST   | `/plugin-config`              | `config.update`                        | Both   |
| GET    | `/plugin-schema`              | `plugin-schema.read`                   | Both   |
| GET    | `/congestion`                 | `congestion.read`                      | Client |
| POST   | `/delta-timer`                | `delta-timer.update`                   | Client |
| GET    | `/bonding`                    | `bonding.read`                         | Both   |
| POST   | `/bonding`                    | `bonding.update`                       | Both   |
| POST   | `/bonding/failover`           | `bonding.failover`                     | Client |
| GET    | `/monitoring/packet-loss`     | `monitoring.read`                      | Both   |
| GET    | `/monitoring/path-latency`    | `monitoring.read`                      | Both   |
| GET    | `/monitoring/retransmissions` | `monitoring.read`                      | Both   |
| GET    | `/monitoring/alerts`          | `monitoring.alerts.read`               | Both   |
| POST   | `/monitoring/alerts`          | `monitoring.alerts.update`             | Both   |
| GET    | `/monitoring/inspector`       | `monitoring.inspector.read`            | Both   |
| GET    | `/monitoring/simulation`      | `monitoring.simulation.read`           | Both   |
| GET    | `/capture`                    | `capture.read`                         | Both   |
| POST   | `/capture/start`              | `capture.update`                       | Both   |
| POST   | `/capture/stop`               | `capture.update`                       | Both   |
| GET    | `/capture/export`             | `capture.export`                       | Both   |
| GET    | `/status`                     | `status.read`                          | Both   |
| GET    | `/connections`                | `connections.list`                     | Both   |
| GET    | `/instances`                  | `instances.list`                       | Both   |
| GET    | `/instances/:id`              | `instances.show`                       | Both   |
| POST   | `/instances`                  | `instances.create`                     | Both   |
| PUT    | `/instances/:id`              | `instances.update`                     | Both   |
| DELETE | `/instances/:id`              | `instances.delete`                     | Both   |
| \*     | `/connections/:id/...`        | see [below](#per-connection-endpoints) |        |

---

## Core Data Endpoints

### GET /metrics

Full statistics for the first instance. Top-level keys:

| Key                 | Content                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `uptime`            | `milliseconds`, `seconds`, `formatted` (`"1h 0m 0s"`)                                                       |
| `mode`              | `"client"` or `"server"`                                                                                    |
| `protocolVersion`   | Configured protocol version (default 1)                                                                     |
| `stats`             | Counters and `errorCounts` — [metrics.md](metrics.md#core-transport-metrics)                                |
| `status`            | `readyToSend`, `deltasBuffered`                                                                             |
| `bandwidth`         | Byte/packet counters, rates, `*Formatted` strings, metadata counters, `history` (last 30 samples)           |
| `pathStats`         | Top 50 paths by bytes, each with `percentage`                                                               |
| `pathCategories`    | Path category definitions                                                                                   |
| `smartBatching`     | Batching counters; `null` in server mode — [metrics.md](metrics.md#smart-batching-metrics)                  |
| `networkQuality`    | Link quality — [metrics.md](metrics.md#link-quality-metrics); server adds `lastRemoteUpdate`                |
| `recentErrors`      | Last 10 `{ category, message, timestamp }`                                                                  |
| `lastError`         | `{ message, timestamp, timeAgo }` or `null`                                                                 |
| `sourceReplication` | `{ metrics: { upserts, noops, missingIdentity, conflicts }, registry: null }`, or `null` without a registry |
| `fleet`             | Fleet counters once fleet sharing has started, else `null` — [metrics.md](metrics.md#fleet-sharing-metrics) |
| `managementAuth`    | Only when a management token is configured — [metrics.md](metrics.md#management-api-auth-telemetry)         |

```json
{
  "uptime": { "milliseconds": 3600000, "seconds": 3600, "formatted": "1h 0m 0s" },
  "mode": "client",
  "protocolVersion": 3,
  "stats": { "deltasSent": 12345, "encryptionErrors": 0, "errorCounts": { "udpSend": 0 } },
  "status": { "readyToSend": true, "deltasBuffered": 5 },
  "bandwidth": {
    "bytesOut": 524288,
    "bytesOutRaw": 10485760,
    "rateOut": 145,
    "compressionRatio": 95
  },
  "smartBatching": { "earlySends": 50, "timerSends": 1184, "maxDeltasPerBatch": 6 },
  "networkQuality": { "rtt": 45, "jitter": 12, "linkQuality": 92, "dataSource": "local" },
  "fleet": null
}
```

`GET /connections/:id/metrics` returns these keys for one connection, adds `instanceId`, and never includes `managementAuth`.

### GET /network-metrics

`networkQuality` for the first instance plus `timestamp`: `rtt`, `jitter`, `packetLoss`, `retransmissions`, `queueDepth`, `retransmitRate`, `acksSent`, `naksSent`, `activeLink`, `dataSource` (`"local"` or `"remote-client"`), `linkQuality`, and on a server `lastRemoteUpdate`.

`rtt`, `jitter` and `linkQuality` are **absent**, not zero, until the link has been measured (a client's first timed ACK; on a server, client telemetry carrying an RTT). The same gate applies to `networkQuality` in `/metrics` and to the `signalk_edge_link_rtt_milliseconds`, `signalk_edge_link_jitter_milliseconds` and `signalk_edge_link_link_quality_score` series in `/prometheus`. Other fields may also be absent; see [metrics.md](metrics.md#link-quality-metrics).

### GET /sources

Server source-replication registry. Uses the first server instance with a registry, else the first instance; without a registry it returns `{ "schemaVersion": 1, "size": 0, "sources": [], "legacy": { "byLabel": {}, "bySourceRef": {} } }`. Field definitions: [metrics.md](metrics.md#source-replication-metrics).

```json
{
  "schemaVersion": 1,
  "size": 1,
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

Path dictionary: `{ "total": 172, "categories": { "navigation": { "prefix": "navigation", "paths": ["navigation.position", "..."] } } }`.

---

## Configuration Endpoints

| Endpoint                 | Behavior                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /config/:filename`  | Read `delta_timer.json`, `subscription.json` or `sentence_filter.json`. Other names → `400 Invalid filename`. `503 Plugin not fully initialized` before the files exist. |
| `POST /config/:filename` | Write one of those files (JSON body, validated per file); hot-reloaded. Returns `{ "success": true }`.                                                                   |
| `GET /plugin-config`     | `{ "success": true, "configuration": {...} }` with every `secretKey` and `managementApiToken` replaced by `[redacted]`.                                                  |
| `POST /plugin-config`    | Replace the whole plugin configuration (see below).                                                                                                                      |
| `GET /plugin-schema`     | `{ "schema": <RJSF schema>, "currentMode": "client" \| "server" \| "unknown" }`.                                                                                         |

### POST /plugin-config

Body: `{ "connections": [...] }` (at least one entry) or a single legacy connection object with top-level `serverType`. Each connection is validated (`serverType`, `udpPort`, `secretKey`; client also `udpAddress`) and server ports must be unique. A connection without `connectionId` gets one generated.

| Field                       | Handling                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `secretKey: "[redacted]"`   | Keeps the stored key, matched by `connectionId` or name/serverType/udpPort; `400` if no stored key matches |
| `managementApiToken`        | Omitted or `[redacted]` keeps the stored token; a non-empty string replaces it; `""` clears it             |
| `requireManagementApiToken` | Kept from stored config unless a boolean is sent                                                           |
| `schemaVersion`             | Integer from 1 to the current version, else `400`; omitted keeps the stored value                          |

```json
{ "success": true, "message": "Configuration saved. Plugin restarting...", "restarting": true }
```

Without a restart handler the config is saved and the response is `"Configuration saved. Restart plugin to apply changes."` with `"restarting": false`. With neither handler: `503`. Save failure: `500 Failed to save configuration`.

---

## Congestion Control Endpoints

### GET /congestion

Congestion-control state of the first client instance. Fields: [congestion-control.md](congestion-control.md).

### POST /delta-timer

Set the delta timer manually (`value`, 100–10000 ms) or return to automatic control.

```json
{ "value": 500 }
```

Response: `{ "deltaTimer": 500, "mode": "manual" }`. `{ "mode": "auto" }` returns `{ "deltaTimer": <current>, "mode": "auto" }`. A non-number `value` or one outside the range returns `400`.

---

## Bonding Endpoints

| Endpoint                 | Behavior                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /bonding`           | `{ totalInstances, bondingEnabledInstances, instances: [{ id, name, enabled, state }] }`; `state` is the bonding state ([bonding.md](bonding.md#monitoring-and-manual-control)) or `null`.                                                         |
| `POST /bonding`          | Update failover thresholds on every bonding-enabled instance. Keys: `rttThreshold`, `lossThreshold`, `healthCheckInterval`, `failbackDelay`, `heartbeatTimeout` (non-negative numbers). Other keys or values → `400`; no bonding instance → `503`. |
| `POST /bonding/failover` | Toggle primary ↔ backup on the first client instance. No body. `503` when bonding is not enabled.                                                                                                                                                  |

`POST /bonding` response: `{ "success": true, "updated": { "rttThreshold": 300 }, "instances": [{ "id": "...", "thresholds": {...} }] }`.

`POST /bonding/failover` response:

```json
{ "success": true, "activeLink": "backup", "links": { "primary": {}, "backup": {} } }
```

---

## Monitoring Endpoints

| Endpoint                          | Query                                 | Response                                                                                                                                                                               |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /monitoring/packet-loss`     | —                                     | `heatmap[]` of `{ timestamp, total, lost, lossRate }` (5 s buckets, 60 buckets = 5 min); `summary` with `overallLossRate`, `maxLossRate`, `trend` (`stable`, `improving`, `worsening`) |
| `GET /monitoring/path-latency`    | `limit` (default 20, 1–1000)          | `paths[]` of `{ path, sampleCount, avg, p50, p95, p99, lastUpdate }`                                                                                                                   |
| `GET /monitoring/retransmissions` | `limit` (1–1000; default all history) | `chartData[]` of `{ timestamp, rate, retransmitsPerSec, periodPackets, periodRetransmissions }`; `summary` with `avgRate`, `maxRate`, `currentRate`                                    |
| `GET /monitoring/alerts`          | —                                     | `thresholds` and `activeAlerts` (example below)                                                                                                                                        |
| `POST /monitoring/alerts`         | —                                     | Update one threshold (below)                                                                                                                                                           |
| `GET /monitoring/inspector`       | —                                     | `{ enabled, packetsInspected, clientsConnected }`. A JSON snapshot; there is no WebSocket/live-stream endpoint.                                                                        |
| `GET /monitoring/simulation`      | —                                     | Always `{ "enabled": false }`; network simulation is a test-harness facility with no runtime toggle.                                                                                   |

Monitoring trackers, alerts and packet capture exist only on v2/v3 client instances. Elsewhere the read routes return empty data (`heatmap: []`, `paths: []`, `chartData: []`, `thresholds: {}`) rather than an error.

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

```json
{ "metric": "rtt", "warning": 200, "critical": 600 }
```

`metric` must be one of `rtt`, `packetLoss`, `retransmitRate`, `jitter`, `queueDepth`. At least one of `warning`/`critical` (finite numbers) is required, and the effective `warning` must not exceed `critical`. Response: `{ "success": true, "thresholds": {...} }`. The change applies immediately and is persisted to plugin options within 1 second. Default thresholds, cooldown and notification paths: [metrics.md](metrics.md#alerts).

---

## Packet Capture Endpoints

| Endpoint                                     | Behavior                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /capture/start` / `POST /capture/stop` | No body. Returns `{ "success": true, "enabled": true \| false }`. Circular buffer of at most 1000 packets.                                        |
| `GET /capture`                               | `{ "enabled": true, "captured": 500, "dropped": 0, "buffered": 500, "maxPackets": 1000 }`                                                         |
| `GET /capture/export`                        | `.pcap` download (`application/vnd.tcpdump.pcap`, libpcap, link type DLT_USER0 = 147), filename `edge-link-capture-<ms>.pcap`. Open in Wireshark. |

Start, stop and export return `503 Packet capture not initialized` when capture is unavailable.

---

## Status and Instance Management Endpoints

Token headers accepted: `X-Edge-Link-Token`, `Authorization: Bearer`, `X-Management-Token` (legacy).

### GET /status

Health summary across all instances. `healthy` is false when `status` matches `error`, `fail` or `stopped`. `recentErrors` holds the last 5 entries.

```json
{
  "healthyInstances": 1,
  "totalInstances": 1,
  "instances": [
    {
      "id": "shore-server",
      "name": "Shore Server",
      "healthy": true,
      "status": "Server listening on port 4446",
      "lastError": null,
      "lastErrorTime": null,
      "errorCounts": { "udpSend": 0, "encryption": 0 },
      "recentErrors": []
    }
  ],
  "managementAuth": { "total": 42, "allowed": 40, "denied": 2 }
}
```

`managementAuth` is present only when a token is configured. `errorCounts` keys: [metrics.md](metrics.md#error-categories).

### GET /connections

All instances: `[{ id, name, type, port, protocolVersion, status, healthy, readyToSend }]`, `type` being `"client"` or `"server"`.

### GET /instances

Query: `state` (case-insensitive match on the status string), `limit`, `page` (decimal digits only, a positive safe integer; `0`, `1.0`, `1e2` and `-1` return `400`). Without `limit` the response is a plain array; with `limit` it is `{ items, pagination: { page, limit, total, totalPages } }`.

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "protocolVersion": 3,
    "state": "Server listening on port 4446",
    "currentLink": "primary",
    "metrics": {
      "deltasSent": 0,
      "deltasReceived": 1234,
      "udpSendErrors": 0,
      "duplicatePackets": 0
    }
  }
]
```

### GET /instances/:id

One instance: `id`, `name`, `mode`, `protocolVersion`, `state`, `readyToSend`, `currentLink`, `network` (`rtt`, `jitter`, `packetLoss`, `retransmissions`, `queueDepth`, `dataSource`), `metrics` (as in `/instances`), `bonding` (bonding state, or `{ "enabled": false }`), and `config` with `secretKey` and `managementApiToken` shown as `[redacted]`. `404` if the id is unknown.

`network.rtt` and `network.jitter` are absent until the link has been measured, as on `/network-metrics`.

### POST /instances, PUT /instances/:id, DELETE /instances/:id

Each change rewrites `connections[]` and restarts the plugin. Success: `{ "success": true }` (`201` for POST, `200` otherwise).

| Endpoint                | Rules                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /instances`       | Full connection object; `name` required, plus `serverType`, `udpPort`, `secretKey` (client: `udpAddress`). Server ports must be unique.                                                                                                                                                                                                                                                       |
| `PUT /instances/:id`    | Patch with at least one of `name`, `protocolVersion`, `useMsgpack`, `usePathDictionary`, `enableNotifications`, `udpAddress`, `helloMessageSender`, `reliability`, `congestionControl`, `bonding`, `alertThresholds`. `serverType`, `udpPort`, `secretKey` and any other field (including `testAddress`, `testPort`, `pingIntervalTime`) → `400`; change those through `POST /plugin-config`. |
| `DELETE /instances/:id` | `400 At least one instance must remain configured` when deleting the last instance.                                                                                                                                                                                                                                                                                                           |

Errors: `400` validation, `404` unknown id, `503 Runtime restart handler unavailable`, `500 Internal server error` (detail is logged, not returned).

---

## Per-Connection Endpoints

Scoped to one connection. `:id` is the slugified connection name (e.g. `shore-server`); an unknown id returns `404 Connection '<id>' not found`, and client-only routes return `404 Not available in server mode` for a server connection.

| Endpoint                                          | Auth action                   | Mode   | Response                                                                                               |
| ------------------------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `GET /connections/:id/metrics`                    | `connection-monitoring.read`  | Both   | Same as `GET /metrics` (without `managementAuth`)                                                      |
| `GET /connections/:id/network-metrics`            | `connection-monitoring.read`  | Both   | Differs from `/network-metrics`, see below                                                             |
| `GET /connections/:id/bonding`                    | `connection-bonding.read`     | Client | Bonding state, or `{ "enabled": false }`                                                               |
| `GET /connections/:id/congestion`                 | `connection-monitoring.read`  | Client | Same as `GET /congestion`                                                                              |
| `GET /connections/:id/monitoring/alerts`          | `connection-monitoring.read`  | Both   | Same as `GET /monitoring/alerts`                                                                       |
| `GET /connections/:id/monitoring/packet-loss`     | `connection-monitoring.read`  | Both   | Same as `GET /monitoring/packet-loss`                                                                  |
| `GET /connections/:id/monitoring/retransmissions` | `connection-monitoring.read`  | Both   | Same as `GET /monitoring/retransmissions` (same `limit`)                                               |
| `GET /connections/:id/config/:filename`           | `connection-config.read`      | Client | Same as `GET /config/:filename`                                                                        |
| `POST /connections/:id/config/:filename`          | `connection-config.update`    | Client | Same as `POST /config/:filename`                                                                       |
| `POST /connections/:id/bonding/failover`          | `connection-bonding.failover` | Client | Same as `POST /bonding/failover`; the only way to fail over one connection in a multi-connection setup |

`GET /connections/:id/network-metrics` returns `instanceId`, `rtt`, `jitter`, `packetLoss`, `retransmissions`, `queueDepth`, `retransmitRate`, `activeLink`, `dataSource`, `lastUpdate`, `hasQualityBasis` and `timestamp`. It has no `linkQuality`, `acksSent` or `naksSent`. `rtt` and `jitter` are absent until the link has been measured, as on `/network-metrics`.
