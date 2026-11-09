# Signal K Edge Link — Connection Bonding

> Primary/backup failover between two UDP links. Client connections in Advanced (v3) mode only. Field defaults and ranges are in [configuration-reference.md](configuration-reference.md#connection-bonding-client-advancedv3-only).

---

## Overview

A bonded client opens two UDP sockets, primary and backup, each optionally bound to its own local interface (for example LTE and Starlink). Data goes out on the active link only. Every `healthCheckInterval` (default 1000 ms) the client sends a heartbeat probe on both links; the server connection on each port echoes it. The client switches to the backup when the primary degrades, and back when the primary has recovered.

Bonding cannot be combined with fleet sharing on the same client connection: validation rejects it with `fleetSharing is not supported together with bonding`.

---

## Link Health

| Measure | How it is computed                                                                         |
| ------- | ------------------------------------------------------------------------------------------ |
| RTT     | Probe round trip, smoothed: `0.2 × new + 0.8 × previous` (the first sample is taken as is) |
| Loss    | Share of failures among the last 10 completed probes; see below                            |
| Quality | `GET /bonding`: `60 × (1 − loss) + 40 × max(0, 1 − RTT / 1000)`, rounded, 0–100            |
| Status  | `active`, `standby`, `down`, or `unknown` before startup                                   |

A probe completes when its response arrives or when it is found unanswered after `heartbeatTimeout` (default 5000 ms); probes still in flight are not counted. Expiry is checked only when the next probe is sent, every `healthCheckInterval`, so a response that arrives after `heartbeatTimeout` but before that check still counts as answered. Until the first probe completes, loss is `1 − responses / sent`, so a link reports 100% loss after its first unanswered probe.

A link is marked `down` when more than 3 probes have been sent and none has been answered for `heartbeatTimeout`. A link that has never answered is marked `down` on the fourth probe, about 4 s after start with the default `healthCheckInterval`. It returns to `active` or `standby` on the next valid response. A socket error also marks the link `down`; the socket is recreated after 5 s and the link set to `standby` before any probe has been answered, so `standby` right after a recovery does not mean the link has replied.

Probes are `HBPROBE` packets with an 8-byte truncated HMAC-SHA256 tag keyed by `secretKey`. The server drops probes that fail verification (counted in `malformedPackets`) and the client drops unverified responses, so both server connections must use the client's `secretKey` and `stretchAsciiKey` setting.

---

## Failover and Failback

```text
          primary DOWN (immediately), or
          RTT > rttThreshold or loss > lossThreshold
          (after the primary has been active for 5 s);
          backup not DOWN
 PRIMARY ─────────────────────────────────────────────► BACKUP
 ACTIVE  ◄───────────────────────────────────────────── ACTIVE
          failbackDelay since the failover elapsed, and
          primary not DOWN, and
          RTT < rttThreshold × 0.8, and
          loss < lossThreshold × 0.5
```

- Automatic failover never switches to a backup that is `down`. A manual switch with `POST /bonding/failover` does not check link status; check `GET /bonding` first.
- The 5 s minimum on the primary (from startup or the last failback) stops a primary near the threshold from flapping on every health check. A `down` primary skips it.
- `failbackDelay` (default 30000 ms) is counted from the moment of failover.
- With `enableNotifications: true` on the client connection, each switch in either direction sets `notifications.signalk-edge-link.<instanceId>.linkFailover` (or `notifications.signalk-edge-link.linkFailover` without an instance ID) to state `alert`, methods `visual` and `sound`, message `Link switched: <from> to <to>`. A failover is also logged as an error: `[FAILOVER] Switching from primary to backup link`.

---

## Configuration

Vessel (client):

```json
{
  "name": "vessel-bonded",
  "serverType": "client",
  "udpAddress": "shore.example.com",
  "udpPort": 4446,
  "secretKey": "<64-hex-key>",
  "protocolVersion": 3,
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": { "address": "shore.example.com", "port": 4446, "interface": "192.168.1.100" },
    "backup": { "address": "shore.example.com", "port": 4447, "interface": "10.0.0.100" },
    "failover": {
      "rttThreshold": 500,
      "lossThreshold": 0.1,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000,
      "heartbeatTimeout": 5000
    }
  }
}
```

`udpAddress` and `udpPort` are required even with bonding. If `primary` is omitted at runtime, the client uses `udpAddress`:`udpPort`; if `backup` is omitted, `udpAddress`:`udpPort + 1`. `main-backup` is the only mode.

Shore: two independent server connections with the same key, one per port:

```json
{
  "connections": [
    {
      "name": "shore-primary",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "<64-hex-key>",
      "protocolVersion": 3
    },
    {
      "name": "shore-backup",
      "serverType": "server",
      "udpPort": 4447,
      "secretKey": "<64-hex-key>",
      "protocolVersion": 3
    }
  ]
}
```

### Threshold profiles

| Profile      | `rttThreshold` | `lossThreshold` | `failbackDelay` | When to use                            |
| ------------ | -------------- | --------------- | --------------- | -------------------------------------- |
| Aggressive   | 300 ms         | 0.05            | 15 s            | Stable backup, low-latency requirement |
| **Moderate** | **500 ms**     | **0.10**        | **30 s**        | **General offshore use (defaults)**    |
| Conservative | 800 ms         | 0.20            | 60 s            | Avoid flapping on variable links       |

---

## Monitoring and Manual Control

All three routes need the management token when one is set ([management-tools.md](management-tools.md)).

```bash
H=http://localhost:3000/plugins/signalk-edge-link

# Current state of every connection
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/bonding | jq .

# Manual switch (primary → backup, or backup → primary)
curl -s -X POST -H "X-Edge-Link-Token: $TOKEN" $H/bonding/failover | jq .

# Change thresholds on every bonded connection
curl -s -X POST -H "Content-Type: application/json" -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"rttThreshold": 300, "lossThreshold": 0.05}' $H/bonding | jq .
```

- `POST /bonding` changes are in memory on every bonded connection and apply at the next health check; a new `healthCheckInterval` is stored but the running probe timer keeps its old interval, and a restart reloads the configured value. To change the interval, change the connection config.
- `POST /bonding/failover` acts on the first client connection; `POST /connections/:id/bonding/failover` acts on one connection.

Accepted keys, status codes and response shapes: [api-reference.md](api-reference.md#bonding-endpoints).

### GET /bonding response

`GET /bonding` covers every connection and wraps each connection's bonding state in `instances[].state`:

```json
{
  "totalInstances": 1,
  "bondingEnabledInstances": 1,
  "instances": [
    {
      "id": "vessel-bonded",
      "name": "vessel-bonded",
      "enabled": true,
      "state": {
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
            "address": "shore.example.com",
            "port": 4446,
            "status": "active",
            "rtt": 45,
            "loss": 0,
            "quality": 98,
            "heartbeatsSent": 120,
            "heartbeatResponses": 118
          }
        }
      }
    }
  ]
}
```

`links.backup` has the same fields as `links.primary`. In `GET /bonding` a connection without bonding has `"enabled": false` and `"state": null`. `GET /connections/:id/bonding` returns the `state` object of that one connection, or `{ "enabled": false }` without bonding (404 for a server connection). Full route reference: [api-reference.md](api-reference.md#bonding-endpoints), [per-connection endpoints](api-reference.md#per-connection-endpoints). `heartbeatsSent − heartbeatResponses` counts unanswered probes, including those still in flight, so it can be nonzero on a healthy link.

### Signal K paths published

| Path                                       | Description              |
| ------------------------------------------ | ------------------------ |
| `networking.edgeLink.activeLink`           | Active link name         |
| `networking.edgeLink.links.<link>.status`  | Link status              |
| `networking.edgeLink.links.<link>.rtt`     | Link RTT (ms)            |
| `networking.edgeLink.links.<link>.loss`    | Link loss ratio          |
| `networking.edgeLink.links.<link>.quality` | Link quality score 0–100 |

`<link>` is `primary` or `backup`. With an instance ID the paths are `networking.edgeLink.<instanceId>.*`. The published `quality` uses the general link-quality score with jitter and retransmit rate set to 0, `40 × (1 − loss) + 30 × max(0, 1 − RTT / 1000) + 30`, so it differs from the `quality` in `GET /bonding`.
