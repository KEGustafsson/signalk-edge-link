# Signal K Edge Link — Connection Bonding

> Primary/backup dual-link failover for high-availability links. Advanced (v3) only.

---

## Overview

Bonding runs **two simultaneous UDP links** (primary and backup) between the client and a pair of server connections. The BondingManager monitors both links continuously via HEARTBEAT probes and automatically switches traffic to the backup link when the primary degrades beyond configured thresholds.

---

## Failover State Machine

```text
   ┌──────────────┐   RTT > rttThreshold
   │              │   OR loss > lossThreshold
   │   ACTIVE     │   OR link DOWN
   │   PRIMARY    ├─────────────────────────────────────────────►
   │              │
   └──────┬───────┘          ┌──────────────┐
          ▲                  │              │
          │                  │   ACTIVE     │
          │◄─────────────────┤   BACKUP     │
          │   ALL required:  │              │
          │   RTT < thresh×0.8               │
          │   loss < thresh×0.5              │
          │   failbackDelay elapsed          │
          │                  └──────────────┘
```

Health is monitored continuously via HEARTBEAT probes every `healthCheckInterval` (default 1000 ms). A link is marked DOWN after no response for `heartbeatTimeout` (default 5000 ms).

A Signal K notification fires at `notifications.signalk-edge-link.<connectionName>.linkFailover` (state `"alert"`, methods `visual` and `sound`) on every failover event.

---

## Configuration

### Vessel (client with bonding)

```json
{
  "name": "vessel-bonded",
  "serverType": "client",
  "secretKey": "MySecretKey12345678901234567890",
  "protocolVersion": 3,
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "shore.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "shore.example.com",
      "port": 4447,
      "interface": "10.0.0.100"
    },
    "failover": {
      "rttThreshold": 500,
      "lossThreshold": 0.1,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000
    }
  }
}
```

### Shore (two independent server connections)

```json
{
  "connections": [
    {
      "name": "shore-primary",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3
    },
    {
      "name": "shore-backup",
      "serverType": "server",
      "udpPort": 4447,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3
    }
  ]
}
```

### Bonding configuration fields

| Field                          | Type    | Default         | Range             | Description                                            |
| ------------------------------ | ------- | --------------- | ----------------- | ------------------------------------------------------ |
| `enabled`                      | boolean | `false`         | —                 | Activate dual-link bonding.                            |
| `mode`                         | string  | `"main-backup"` | `"main-backup"`   | Only main-backup mode is supported.                    |
| `primary.address`              | string  | `"127.0.0.1"`   | valid IP/hostname | Primary link destination.                              |
| `primary.port`                 | integer | `4446`          | 1024–65535        | Primary link UDP port.                                 |
| `primary.interface`            | string  | —               | valid IP          | Bind outbound socket to this local interface IP.       |
| `backup.address`               | string  | `"127.0.0.1"`   | valid IP/hostname | Backup link destination.                               |
| `backup.port`                  | integer | `4447`          | 1024–65535        | Backup link UDP port.                                  |
| `backup.interface`             | string  | —               | valid IP          | Bind outbound socket to this local interface IP.       |
| `failover.rttThreshold`        | integer | `500`           | 100–5000 ms       | Failover when primary RTT exceeds this.                |
| `failover.lossThreshold`       | number  | `0.10`          | 0.01–0.5          | Failover when primary loss exceeds this ratio.         |
| `failover.healthCheckInterval` | integer | `1000`          | 500–10000 ms      | Link health probe frequency.                           |
| `failover.failbackDelay`       | integer | `30000`         | 5000–300000 ms    | Hold-off after primary recovers before switching back. |
| `failover.heartbeatTimeout`    | integer | `5000`          | 1000–30000 ms     | Link marked DOWN after no response for this long.      |

---

## Threshold Profiles

| Profile      | `rttThreshold` | `lossThreshold` | `failbackDelay` | When to use                            |
| ------------ | -------------- | --------------- | --------------- | -------------------------------------- |
| Aggressive   | 300 ms         | 5% (0.05)       | 15 s            | Stable backup, low-latency requirement |
| **Moderate** | **500 ms**     | **10% (0.10)**  | **30 s**        | **General offshore use (default)**     |
| Conservative | 800 ms         | 20% (0.20)      | 60 s            | Avoid flapping on variable links       |

---

## Monitoring and Manual Control

```bash
# Current bonding state
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .

# Manual failover (toggle primary ↔ backup)
curl -s -X POST -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding/failover | jq .

# Update thresholds
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"rttThreshold": 300, "lossThreshold": 0.05}' \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .
```

### GET /bonding response

```json
{
  "enabled": true,
  "mode": "main-backup",
  "activeLink": "primary",
  "lastFailoverTime": 0,
  "failoverThresholds": { "rttThreshold": 500, "lossThreshold": 0.1, "failbackDelay": 30000 },
  "links": {
    "primary": {
      "status": "active",
      "rtt": 45,
      "loss": 0.01,
      "quality": 95,
      "heartbeatsSent": 120,
      "heartbeatResponses": 118
    },
    "backup": {
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

### Signal K paths published

| Path                                          | Description                      |
| --------------------------------------------- | -------------------------------- |
| `networking.edgeLink.bonding.activeLink`      | `"primary"` or `"backup"`        |
| `networking.edgeLink.bonding.primary.rtt`     | Primary link RTT (ms)            |
| `networking.edgeLink.bonding.primary.loss`    | Primary link loss ratio          |
| `networking.edgeLink.bonding.primary.quality` | Primary link quality score 0–100 |
| `networking.edgeLink.bonding.backup.rtt`      | Backup link RTT (ms)             |
| `networking.edgeLink.bonding.backup.loss`     | Backup link loss ratio           |
| `networking.edgeLink.bonding.backup.quality`  | Backup link quality score 0–100  |
