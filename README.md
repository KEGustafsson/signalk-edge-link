# Signal K Edge Link

Signal K Edge Link is a Signal K plugin for sending vessel data over secure UDP between two Signal K servers.

- Client mode: collects local deltas and sends them out
- Server mode: receives, decrypts, and forwards into local Signal K
- Protocol v2 adds reliability, congestion control, bonding, and detailed monitoring

![Data Connector Concept](doc/dataconnectorconcept.jpg)

## What This Solves

Use this plugin when you need to move Signal K data over unstable links (cellular, satellite, offshore WAN) where low latency and bandwidth efficiency matter.

Key capabilities:

- AES-256-GCM authenticated encryption
- Brotli compression
- Optional MessagePack and path dictionary encoding
- Protocol v2 ACK/NAK retransmission
- Dynamic congestion control
- Primary/backup link bonding with failover
- Built-in metrics, alerts, and packet capture endpoints

## Architecture At A Glance

```text
Client Signal K
  -> subscribe + batch deltas
  -> optional path dictionary + MessagePack
  -> Brotli compress
  -> AES-256-GCM encrypt
  -> UDP send

Server Signal K
  <- UDP receive
  <- AES-256-GCM decrypt
  <- Brotli decompress
  <- optional MessagePack + path decode
  <- inject into local Signal K
```

## Prerequisites

- Two Signal K instances (source + destination)
- UDP reachability from client to server on your configured port
- One shared 32-character secret key on both ends
- For source installs: Node.js 16+

## Installation

### Option A: Plugin manager

If your Signal K setup exposes this plugin in the plugin catalog, install it there.

### Option B: Manual install from source

```bash
cd ~/.signalk/node_modules

git clone https://github.com/KEGustafsson/signalk-edge-link.git
cd signalk-edge-link
npm install
npm run build
```

Restart Signal K after install.

## Quick Start (Recommended)

### 1. Configure destination (Server mode)

In Signal K Admin UI:

- Open `Server -> Plugin Config -> Signal K Edge Link`
- Set `Operation Mode` to `Server`
- Set `UDP Port` (default `4446`)
- Set `Encryption Key` (exactly 32 chars)
- Set `Protocol Version` (`2` recommended)
- Save

### 2. Configure source (Client mode)

On the sending Signal K instance:

- Open `Server -> Plugin Config -> Signal K Edge Link`
- Set `Operation Mode` to `Client`
- Set same `UDP Port`
- Set same `Encryption Key`
- Set `Server Address` to destination host/IP
- Set `Protocol Version` (`2` recommended)
- Save

### 3. Verify data flow

Open web app:

`http://<signalk-host>:3000/plugins/signalk-edge-link/`

Then confirm:

- Client shows `Deltas Sent` increasing
- Server shows `Deltas Received` increasing
- No growing encryption/decryption errors

## Web UI Guide

The runtime web app is available at:

`/plugins/signalk-edge-link/`

### Available in both modes

- Full Plugin Configuration (advanced JSON editor using `/plugin-config`)
- Network quality, bandwidth, path analytics
- Performance metrics
- Monitoring and alert status (v2)

### Client-only sections

- `delta_timer.json` editor
- `subscription.json` editor
- `sentence_filter.json` editor
- Congestion control panel (v2)
- Bonding panel + manual failover trigger (v2)

## Configuration Model

There are two configuration layers:

1. Plugin configuration
- Stored by Signal K plugin options
- Read/write endpoint: `/plugins/signalk-edge-link/plugin-config`
- Saving usually restarts plugin to apply changes

2. Client runtime JSON files (hot-reload)
- `delta_timer.json`
- `subscription.json`
- `sentence_filter.json`
- Read/write endpoint: `/plugins/signalk-edge-link/config/:filename`
- Client mode only

## Core Parameters

### Common (client + server)

| Key | Required | Notes |
|---|---|---|
| `serverType` | yes | `server` or `client` |
| `udpPort` | yes | `1024-65535` |
| `secretKey` | yes | exactly 32 chars, at least 8 unique chars |
| `protocolVersion` | no | `1` or `2` |
| `useMsgpack` | no | must match both ends |
| `usePathDictionary` | no | must match both ends |

### Client-required

| Key | Required | Notes |
|---|---|---|
| `udpAddress` | yes | destination server host/IP |
| `testAddress` | yes | RTT test target |
| `testPort` | yes | `1-65535` |
| `helloMessageSender` | no | heartbeat interval seconds (`10-3600`) |
| `pingIntervalTime` | no | connectivity check minutes (`0.1-60`) |

### v2 tuning groups

- `reliability` (client and server mode variants)
- `congestionControl` (client)
- `bonding` (client)
- `alertThresholds` (client)

Tip: start with defaults and tune only if metrics indicate problems.

### Runtime file examples (client mode)

`delta_timer.json`

```json
{
  "deltaTimer": 1000
}
```

`subscription.json`

```json
{
  "context": "*",
  "subscribe": [
    { "path": "*" }
  ]
}
```

`sentence_filter.json`

```json
{
  "excludedSentences": ["GSV"]
}
```

## Protocol Version Choice

| Version | When to use | Notes |
|---|---|---|
| v1 | stable local links, simplest setup | lower protocol overhead, no ACK/NAK reliability layer |
| v2 | packet loss, variable latency, WAN links | adds retransmission, congestion control, bonding, richer monitoring |

## High Packet Loss Guidance

For unstable networks, use this baseline:

1. Set `protocolVersion` to `2` on both ends.
2. Leave `reliability` defaults first, then tune only if needed.
3. Enable `congestionControl.enabled = true` on client if loss/RTT spikes under load.
4. If you have two links (for example LTE + satellite), enable `bonding.enabled = true`.
5. Use these endpoints to validate behavior:
- `/plugins/signalk-edge-link/metrics`
- `/plugins/signalk-edge-link/monitoring/packet-loss`
- `/plugins/signalk-edge-link/monitoring/retransmissions`
- `/plugins/signalk-edge-link/congestion`
- `/plugins/signalk-edge-link/bonding`

Practical tuning direction:

- Frequent queue exhaustion: increase `reliability.retransmitQueueSize`
- Packets dropped too early: raise `reliability.retransmitMaxAge`
- Slow recovery after outage: increase `reliability.recoveryBurstSize`
- Link saturation signs: enable congestion control or increase delta timer

## REST API Quick Reference

All API routes are under:

`/plugins/signalk-edge-link`

Current rate limit: 120 requests/minute/IP.

### Configuration

- `GET /plugin-config`
- `POST /plugin-config`
- `GET /plugin-schema`
- `GET /config/:filename` (client mode only)
- `POST /config/:filename` (client mode only)

### Runtime and monitoring

- `GET /metrics`
- `GET /network-metrics`
- `GET /monitoring/alerts`
- `POST /monitoring/alerts`
- `GET /monitoring/packet-loss`
- `GET /monitoring/retransmissions`
- `GET /monitoring/path-latency`
- `GET /monitoring/inspector`
- `GET /monitoring/simulation`

### v2 control and diagnostics

- `GET /congestion` (client)
- `POST /delta-timer` (client)
- `GET /bonding` (client)
- `POST /bonding/failover` (client)
- `GET /prometheus`
- `GET /capture`
- `POST /capture/start`
- `POST /capture/stop`
- `GET /capture/export`

## Security Notes

- Encryption is AES-256-GCM with auth tag verification
- If keys mismatch, packets are rejected
- Use strong random keys and rotate periodically
- Keep UDP ingress restricted to trusted source addresses where possible

Generate a 32-character key example:

```bash
openssl rand -base64 32 | cut -c1-32
```

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| No data on server | wrong IP/port/key | verify `udpAddress`, `udpPort`, `secretKey` on both ends |
| Auth/decrypt errors | key mismatch | set identical 32-char key |
| No `/config/*` access | running server mode | this endpoint is client mode only |
| Frequent packet loss | unstable link or too aggressive send rate | use protocol v2, enable congestion control, tune reliability |
| UI missing updates | stale frontend bundle | rebuild plugin (`npm run build`) and reload |
| Port bind failure | port in use or permission issue | choose free UDP port `>=1024` |

## Developer Commands

```bash
npm run build           # production web assets to public/
npm run dev             # webpack watch
npm test                # full test suite
npm run test:v2         # v2-focused tests
npm run test:integration
npm run lint
npm run lint:fix
```

## Project Layout

- `index.js` plugin entry + schema + lifecycle
- `lib/` protocol, crypto, metrics, monitoring, routes
- `src/components/PluginConfigurationPanel.jsx` Admin UI config panel
- `src/webapp/` runtime web UI
- `docs/` protocol/API/config/troubleshooting references

## Additional Docs

- `docs/api-reference.md`
- `docs/configuration-reference.md`
- `docs/protocol-v2-spec.md`
- `docs/troubleshooting.md`
- `docs/migration/v1-to-v2.md`
- `CHANGELOG.md`

## License

MIT. See `LICENSE`.
