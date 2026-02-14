# Signal K Edge Link v2.0 - API Reference

All REST API endpoints are served under the base path `/plugins/signalk-edge-link/`.

All endpoints are rate-limited to **20 requests per minute per IP address**. Exceeding this limit returns HTTP 429.

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
    "serverType": "client",
    "udpPort": 4446,
    "secretKey": "...",
    "useMsgpack": false,
    "usePathDictionary": true
  }
}
```

---

### POST /plugin-config

Update plugin configuration. Triggers a plugin restart to apply changes.

**Available in:** Client and Server mode

**Content-Type:** `application/json`

**Required fields:** `serverType`, `udpPort`, `secretKey`

**Additional required fields (client mode):** `udpAddress`, `testAddress`, `testPort`

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
    "packetLoss": { "warning": 0.03, "critical": 0.10 },
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

## Prometheus Endpoint

### GET /prometheus

Returns metrics in Prometheus text exposition format for scraping.

**Available in:** Client and Server mode

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

**Exported metrics (30+):**

| Metric | Type | Description |
|--------|------|-------------|
| `signalk_edge_link_uptime_seconds` | gauge | Plugin uptime |
| `signalk_edge_link_deltas_sent_total` | counter | Total deltas sent |
| `signalk_edge_link_deltas_received_total` | counter | Total deltas received |
| `signalk_edge_link_udp_send_errors_total` | counter | UDP send errors |
| `signalk_edge_link_bytes_out_total` | counter | Compressed bytes sent |
| `signalk_edge_link_bytes_in_total` | counter | Compressed bytes received |
| `signalk_edge_link_bytes_out_raw_total` | counter | Raw bytes sent |
| `signalk_edge_link_packets_out_total` | counter | Packets sent |
| `signalk_edge_link_packets_in_total` | counter | Packets received |
| `signalk_edge_link_bandwidth_rate_out_bytes` | gauge | Outbound bytes/s |
| `signalk_edge_link_bandwidth_rate_in_bytes` | gauge | Inbound bytes/s |
| `signalk_edge_link_compression_ratio_percent` | gauge | Compression ratio |
| `signalk_edge_link_rtt_milliseconds` | gauge | Round-trip time |
| `signalk_edge_link_jitter_milliseconds` | gauge | Jitter |
| `signalk_edge_link_retransmissions_total` | counter | Retransmissions |
| `signalk_edge_link_queue_depth` | gauge | Retransmit queue depth |
| `signalk_edge_link_packet_loss_rate` | gauge | Packet loss ratio |
| `signalk_edge_link_link_quality_score` | gauge | Link quality (0-100) |
| `signalk_edge_link_bonding_active_link` | gauge | Active link (1/2) |
| `signalk_edge_link_bonding_link_rtt_milliseconds` | gauge | Per-link RTT |
| `signalk_edge_link_bonding_link_loss_rate` | gauge | Per-link loss |
| `signalk_edge_link_bonding_link_quality` | gauge | Per-link quality |

All metrics include a `mode` label (`"client"` or `"server"`). Bonding metrics include a `link` label (`"primary"` or `"backup"`).

**Prometheus configuration example:**

```yaml
scrape_configs:
  - job_name: 'signalk-edge-link'
    scrape_interval: 15s
    metrics_path: '/plugins/signalk-edge-link/prometheus'
    static_configs:
      - targets: ['signalk-server:3000']
```
