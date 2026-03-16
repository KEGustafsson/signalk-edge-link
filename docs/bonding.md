# Bonding guide

Bonding provides resilience by automatically switching between multiple network paths when link quality degrades. It is designed for vessels that have more than one uplink available — for example, LTE and Starlink — so that navigation data keeps flowing even when the primary link fails.

## How it works

Bonding operates in **main-backup** mode. The primary link is always preferred; the backup link is kept warm (monitored via heartbeat probes) and activated only on failover.

### Health checks

The bonding manager sends heartbeat probes over each link at `healthCheckInterval` (default 1000 ms). The server echoes each probe back. The client measures RTT from each probe round-trip.

A link is considered **down** if no heartbeat response is received within `heartbeatTimeout` (default 5000 ms).

### Failover decision

Failover from primary to backup is triggered when the primary link meets either condition:

- RTT exceeds `rttThreshold` (default 500 ms), **or**
- Packet loss exceeds `lossThreshold` (default 0.10 = 10%)

Failover to backup only happens if the backup link is healthy (status `standby`, not `down`).

### Failback hysteresis

To prevent flapping, returning to the primary link requires stricter conditions:

- Primary RTT < `rttThreshold × 0.8`, **and**
- Primary loss < `lossThreshold × 0.5`

These must both be true for a sustained period before failback occurs. The `failbackDelay` (default 30000 ms) adds an additional hold-off after the primary appears healthy before the switch is made.

## Configuration

Bonding is configured under the `bonding` key of a client connection.

```json
{
  "name": "sat-client",
  "serverType": "client",
  "udpPort": 4446,
  "secretKey": "...",
  "protocolVersion": 3,
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "shore-server.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "shore-server.example.com",
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

The server side needs two independent listeners — one on each port — pointing to the same shore-side Signal K instance. Each client connection maps to exactly one server port.

For complete field reference and ranges, see `docs/configuration-reference.md` → **Connection Bonding**.

## Threshold profiles

Choose a profile based on how much link instability is acceptable before failover:

| Profile       | `rttThreshold` | `lossThreshold` | `failbackDelay` | Use case                                      |
| ------------- | -------------- | --------------- | --------------- | --------------------------------------------- |
| Aggressive    | 300 ms         | 0.05 (5%)       | 15 000 ms       | Low-latency requirement, stable backup link   |
| Moderate      | 500 ms         | 0.10 (10%)      | 30 000 ms       | General offshore use (default)                |
| Conservative  | 800 ms         | 0.20 (20%)      | 60 000 ms       | Avoid flapping on links with high variability |

Start with the **Moderate** profile and monitor `GET /bonding` for failover frequency. If the link switches too often, move toward Conservative.

## API endpoints

### GET /bonding

Returns the current bonding state including per-link health.

```sh
curl -s -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .
```

Example response:

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
      "address": "shore-server.example.com",
      "port": 4446,
      "status": "active",
      "rtt": 42,
      "loss": 0.01,
      "quality": 97,
      "heartbeatsSent": 240,
      "heartbeatResponses": 238
    },
    "backup": {
      "address": "shore-server.example.com",
      "port": 4447,
      "status": "standby",
      "rtt": 118,
      "loss": 0.02,
      "quality": 88,
      "heartbeatsSent": 240,
      "heartbeatResponses": 235
    }
  }
}
```

### POST /bonding/failover

Manually forces a switch to the other link (toggles primary ↔ backup).

```sh
curl -s -X POST \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding/failover | jq .
```

### POST /bonding

Updates failover threshold settings across all bonding-enabled instances.

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"rttThreshold": 300, "lossThreshold": 0.05, "failbackDelay": 15000}' \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .
```

Unsupported keys or out-of-range values return `400`.

## Troubleshooting

| Symptom                             | Check                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Failover not triggering             | Verify `bonding.enabled: true`; check backup link status is not `"down"` in `GET /bonding`     |
| Backup link shows `"down"`          | Ensure UDP traffic is allowed bidirectionally; server must echo heartbeat probes                |
| Frequent failover/failback (flap)   | Increase `failbackDelay` and/or `rttThreshold`; check both link RTTs in metrics                |
| `POST /bonding` rejected with `400` | Verify payload keys match supported fields; check numeric ranges in configuration-reference.md  |

See `docs/troubleshooting.md` → **Bonding Issues** for detailed diagnostics.

## Related docs

- `docs/configuration-reference.md` — complete bonding field reference
- `docs/protocol-v2.md` — reliability model that bonding builds on
- `docs/congestion-control.md` — companion adaptive behavior
- `docs/api-reference.md` — full bonding endpoint specification
