# Signal K Edge Link v2.0 - Configuration Reference

## Plugin Configuration

The plugin is configured through the Signal K Admin UI at **Plugin Config > Signal K Edge Link**, or via the REST API at `POST /plugins/signalk-edge-link/plugin-config`.

## Common Settings (All Modes)

| Setting | JSON Key | Type | Default | Range | Description |
|---------|----------|------|---------|-------|-------------|
| Operation Mode | `serverType` | string | `"client"` | `"server"`, `"client"` | Server receives data, Client sends data |
| UDP Port | `udpPort` | number | `4446` | 1024 - 65535 | Must match on both ends |
| Encryption Key | `secretKey` | string | - | 32 characters | Must match on both ends, min 8 unique chars |
| Use MessagePack | `useMsgpack` | boolean | `false` | - | Binary serialization (must match both ends) |
| Use Path Dictionary | `usePathDictionary` | boolean | `false` | - | Path encoding (must match both ends) |

## Client Mode Settings

These settings are only available when `serverType` is `"client"`.

### Network

| Setting | JSON Key | Type | Default | Range | Description |
|---------|----------|------|---------|-------|-------------|
| Server Address | `udpAddress` | string | `"127.0.0.1"` | valid IP/hostname | Server to send data to |
| Heartbeat Interval | `helloMessageSender` | integer | `60` | 10 - 3600 s | Keep-alive message frequency |
| Test Address | `testAddress` | string | `"127.0.0.1"` | valid IP/hostname | Ping target for RTT monitoring |
| Test Port | `testPort` | number | `80` | 1 - 65535 | TCP port for connectivity test |
| Check Interval | `pingIntervalTime` | number | `1` | 0.1 - 60 min | Network test frequency |

### Dynamic Congestion Control

Configuration key: `congestionControl`

| Setting | JSON Key | Type | Default | Range | Description |
|---------|----------|------|---------|-------|-------------|
| Enable | `enabled` | boolean | `false` | - | Activate AIMD algorithm |
| Target RTT | `targetRTT` | number | `200` | 50 - 2000 ms | RTT above this triggers rate decrease |
| Min Delta Timer | `minDeltaTimer` | number | `100` | 50 - 1000 ms | Fastest send interval |
| Max Delta Timer | `maxDeltaTimer` | number | `5000` | 1000 - 30000 ms | Slowest send interval |

**Example:**

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  }
}
```

**How it works:** The AIMD algorithm monitors RTT and packet loss. When the network is healthy (loss < 1%, RTT < target), it decreases the delta timer by 5% (sends faster). When congestion is detected (loss > 5% or RTT > 1.5x target), it increases the timer by 50% (sends slower). Adjustments occur every 5 seconds and are limited to 20% change per step.

### Connection Bonding

Configuration key: `bonding`

| Setting | JSON Key | Type | Default | Range | Description |
|---------|----------|------|---------|-------|-------------|
| Enable | `enabled` | boolean | `false` | - | Activate dual-link bonding |
| Mode | `mode` | string | `"main-backup"` | `"main-backup"` | Bonding operating mode |

#### Primary Link

Configuration key: `bonding.primary`

| Setting | JSON Key | Type | Default | Description |
|---------|----------|------|---------|-------------|
| Address | `address` | string | `"127.0.0.1"` | Server IP/hostname for primary link |
| Port | `port` | number | `4446` | UDP port for primary link |
| Interface | `interface` | string | (none) | Bind to specific network interface IP |

#### Backup Link

Configuration key: `bonding.backup`

| Setting | JSON Key | Type | Default | Description |
|---------|----------|------|---------|-------------|
| Address | `address` | string | `"127.0.0.1"` | Server IP/hostname for backup link |
| Port | `port` | number | `4447` | UDP port for backup link |
| Interface | `interface` | string | (none) | Bind to specific network interface IP |

#### Failover Thresholds

Configuration key: `bonding.failover`

| Setting | JSON Key | Type | Default | Range | Description |
|---------|----------|------|---------|-------|-------------|
| RTT Threshold | `rttThreshold` | number | `500` | 100 - 5000 ms | Failover when RTT exceeds this |
| Loss Threshold | `lossThreshold` | number | `0.1` | 0.01 - 0.5 | Failover when loss exceeds this ratio |
| Health Check Interval | `healthCheckInterval` | number | `1000` | 500 - 10000 ms | Link health check frequency |
| Failback Delay | `failbackDelay` | number | `30000` | 5000 - 300000 ms | Wait time before returning to primary |

**Example (LTE + Starlink):**

```json
{
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "cloud-server.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "cloud-server.example.com",
      "port": 4447,
      "interface": "10.0.0.100"
    },
    "failover": {
      "rttThreshold": 500,
      "lossThreshold": 0.10,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000
    }
  }
}
```

## Runtime Configuration Files

These JSON files are stored in the plugin data directory and support hot-reload (changes take effect automatically without restart).

### delta_timer.json

Controls the data collection interval.

```json
{
  "deltaTimer": 1000
}
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `deltaTimer` | number | `1000` | 100 - 10000 ms | Data batching interval |

Lower values = more frequent sends, higher bandwidth, lower latency.
Higher values = less frequent sends, better compression ratio.

### subscription.json

Controls which Signal K paths are transmitted.

```json
{
  "context": "*",
  "subscribe": [
    { "path": "navigation.*" },
    { "path": "environment.wind.*" },
    { "path": "electrical.batteries.*" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `context` | string | Signal K context filter (`"*"` = all vessels) |
| `subscribe` | array | Array of path subscription objects |
| `subscribe[].path` | string | Signal K path pattern (supports `*` wildcard) |

### sentence_filter.json

Excludes NMEA sentences from transmission to reduce bandwidth.

```json
{
  "sentences": ["GSV", "GSA", "VTG"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sentences` | array | NMEA sentence types to filter out |

Common sentences to filter:
- `GSV` - GPS satellites in view (large, repetitive)
- `GSA` - GPS DOP and active satellites
- `VTG` - Track and ground speed (redundant with COG/SOG)

## Alert Thresholds

Alert thresholds are configured via the REST API at `POST /plugins/signalk-edge-link/monitoring/alerts`.

### Default Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| RTT (ms) | 300 | 800 |
| Packet Loss (ratio) | 0.03 | 0.10 |
| Retransmit Rate (ratio) | 0.05 | 0.15 |
| Jitter (ms) | 100 | 300 |
| Queue Depth | 100 | 500 |

Alerts emit Signal K notifications at `notifications.signalk-edge-link.<metric>` with `state` set to `"warn"` or `"alert"`. Alert cooldown is 60 seconds.

## Internal Constants

These constants are defined in `lib/constants.js` and control internal behavior. They are not configurable via the UI but can be modified in the source code.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_SAFE_UDP_PAYLOAD` | 1400 bytes | MTU limit for UDP packets |
| `BROTLI_QUALITY_HIGH` | 10 | Brotli compression quality |
| `UDP_RETRY_MAX` | 3 | Max UDP send retries |
| `UDP_RETRY_DELAY` | 100 ms | Base retry delay |
| `SMART_BATCH_SAFETY_MARGIN` | 85% | Target % of MTU |
| `SMART_BATCH_MAX_DELTAS` | 50 | Max deltas per batch |
| `RATE_LIMIT_MAX_REQUESTS` | 20 | API rate limit per minute per IP |
| `BONDING_HEARTBEAT_TIMEOUT` | 5000 ms | Link marked DOWN after this |
| `MONITORING_ALERT_COOLDOWN` | 60000 ms | Alert cooldown period |
| `PACKET_CAPTURE_MAX_PACKETS` | 1000 | Max packets in capture buffer |

## Complete Example Configuration

```json
{
  "serverType": "client",
  "udpPort": 4446,
  "secretKey": "K9#mP2$nQ7@rS4%tU6^vW8*xY3!zA5&",
  "useMsgpack": true,
  "usePathDictionary": true,
  "udpAddress": "cloud-server.example.com",
  "helloMessageSender": 60,
  "testAddress": "8.8.8.8",
  "testPort": 443,
  "pingIntervalTime": 1,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  },
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "cloud-server.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "cloud-server.example.com",
      "port": 4447,
      "interface": "10.0.0.100"
    },
    "failover": {
      "rttThreshold": 500,
      "lossThreshold": 0.10,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000
    }
  }
}
```
