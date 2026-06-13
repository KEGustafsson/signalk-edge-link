# Signal K Edge Link

[![npm version](https://img.shields.io/npm/v/signalk-edge-link)](https://www.npmjs.com/package/signalk-edge-link)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Signal K Edge Link is a Signal K plugin that transfers vessel deltas between Signal K servers over encrypted UDP.

It is designed for links where latency, packet loss, and bandwidth usage matter (cellular, satellite, and other unstable WAN paths).

![Data Connector Concept](docs/assets/dataconnectorconcept.jpg)

## Why use it?

- **Secure transport** using AES-256-GCM
- **Bandwidth optimization** with Brotli compression (plus optional MessagePack and path dictionary)
- **Two operating modes**:
  - **Client**: subscribes to local deltas and sends packets
  - **Server**: receives packets, decrypts, and forwards to local Signal K
- **Advanced mode** features for difficult links:
  - ACK/NAK-based reliability
  - congestion control
  - optional primary/backup bonding
  - monitoring and alerting endpoints
  - values snapshot replay on subscribe, retry, and socket recovery
  - optional server-triggered full-state request on restart (`requestFullStatusOnRestart`)
  - Signal K path metadata transport (units, descriptions, zones)
- **Multi-connection support** on one Signal K instance

## How data flows

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

## Requirements

- Two Signal K instances (source and destination)
- UDP reachability from client to server on your chosen port
- Shared encryption key on both ends (32-character ASCII, 64-character hex, or 44-character base64)
- Node.js 20.9.0+ (if installing from source: dev dependencies including TypeScript are installed automatically via `npm install`)

## Installation

### Option A: Signal K Plugin Manager

Install **Signal K Edge Link** from your Signal K plugin catalog.

### Option B: Manual install from source

```bash
cd ~/.signalk/node_modules
git clone https://github.com/KEGustafsson/signalk-edge-link.git
cd signalk-edge-link
npm install
npm run build
```

Restart Signal K after installation.

## Quick start

### 1) Configure the destination (Server mode)

In Signal K Admin UI:

1. Open `Server -> Plugin Config -> Signal K Edge Link`
2. Click **Add Server**
3. Set:
   - `Connection Name` (for example `shore-server`)
   - `UDP Port` (default `4446`)
   - `Encryption Key` (same shared secret used by client)
   - `Protocol` — select **Advanced** (v3, recommended) for new deployments; select **Basic** (v1) only for stable local links
4. Save

### 2) Configure the source (Client mode)

On the sending Signal K instance:

1. Open `Server -> Plugin Config -> Signal K Edge Link`
2. Click **Add Client**
3. Set:
   - `Connection Name` (for example `vessel-client`)
   - `Server Address` (destination host/IP)
   - `UDP Port` (must match server)
   - `Encryption Key` (must match server)
   - `Protocol` — select **Advanced** (v3, recommended) for new deployments; select **Basic** (v1) only for stable local links
4. Save

### 3) Verify traffic

Open the runtime UI:

`http://<signalk-host>:3000/plugins/signalk-edge-link/`

Check that:

- client `Deltas Sent` increases
- server `Deltas Received` increases
- encryption/decryption errors remain stable at zero

## Protocol guidance

| Mode         | Numeric | Use when                                 | Notes                                                                    |
| ------------ | ------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| **Basic**    | v1      | stable local links, simplest setup       | lower overhead, no ACK/NAK reliability, no metadata transport            |
| **Advanced** | v3      | packet loss, variable latency, WAN links | retransmission, congestion control, bonding, metadata, HMAC control auth |

Use **Advanced** for any new deployment on a WAN or unreliable link. Use **Basic** only for stable local links where simplicity and minimum overhead matter.

## Runtime UI and API

- Runtime UI: `/plugins/signalk-edge-link/`
- API base path: `/plugins/signalk-edge-link`
- Default API rate limit: **120 requests/minute/IP**

Most used endpoints:

- `GET /metrics`
- `GET /network-metrics`
- `GET /monitoring/alerts`
- `GET /connections`
- `GET /instances`
- `GET /instances/:id`
- `GET /connections/:id/metrics`
- `GET /connections/:id/network-metrics`
- `GET /bonding`
- `POST /bonding`

For full endpoint details, use `docs/api-reference.md`

## Configuration model (summary)

Configuration is an array of independent connections:

```json
{
  "connections": [
    {
      "name": "shore-server",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "<32-byte key>",
      "protocolVersion": 3,
      "requestFullStatusOnRestart": false
    },
    {
      "name": "sat-client",
      "serverType": "client",
      "udpPort": 4447,
      "udpAddress": "10.0.0.1",
      "secretKey": "<32-byte key>",
      "protocolVersion": 3
    }
  ]
}
```

- Each connection runs independently.
- Legacy single-object config is auto-normalized to one connection.
- Client runtime JSON files (`delta_timer.json`, `subscription.json`, `sentence_filter.json`) are stored per connection and can be edited via API.
- `requestFullStatusOnRestart` (server mode, v2/v3, default `false`): when enabled, the server sends a `FULL_STATUS_REQUEST` to each client on first contact after a (re)start; the client immediately replays its complete values snapshot so the server rebuilds state without waiting for incremental deltas. Client-side rate-limited to 10 s to prevent replay floods across rapid restarts.

For complete setting definitions and ranges, use `docs/configuration-reference.md`.

Schema and migration helpers:

- The runtime schema is defined inline as `plugin.schema` in `src/index.ts`
  and served to the Signal K admin UI. `docs/configuration-reference.md` is
  the authoritative human-readable reference.
- `src/scripts/migrate-config.ts` (convert legacy flat config to `connections[]`)
- `npm run migrate:config -- <input.json> [output.json]`

## Security notes

- Uses AES-256-GCM authenticated encryption.
- Keys must match exactly and can be entered as 32-character ASCII, 64-character hex, or 44-character base64.
- Restrict UDP ingress to trusted source addresses whenever possible.

Example key generation:

```bash
openssl rand -hex 32
```

## Troubleshooting

Common checks:

- Verify `udpAddress`, `udpPort`, and `secretKey` match both ends.
- Confirm server UDP port is reachable and not already in use.
- If link quality is poor, switch to **Advanced** (`protocolVersion: 3`) when both peers can upgrade together.

**`testAddress is only supported on v1 clients` after upgrading to Advanced mode**

The fields `testAddress`, `testPort`, and `pingIntervalTime` belong to the Basic (v1) ping monitor and are not used by Advanced (v3) clients (which derive RTT from HEARTBEAT exchanges instead). If these fields are present in a connection with `protocolVersion: 3` the validator will reject the config.

Remove them from the affected connection:

```json
{
  "name": "my-client",
  "serverType": "client",
  "protocolVersion": 3,
  "udpAddress": "...",
  "heartbeatInterval": 25000
}
```

The plugin strips these fields automatically on startup, but if you see the error when saving via the SignalK admin UI you need to remove them from the stored config JSON manually once.

For issue-oriented diagnostics, use `docs/troubleshooting.md`.

## Developer commands

```bash
npm run build
npm run dev
npm test
npm run test:v2
npm run test:integration
npm run lint
npm run lint:fix
npm run cli -- help
npm run cli -- instances list --token=$EDGE_LINK_TOKEN --state=running --limit=10 --page=1 --format=table
npm run cli -- instances show alpha --token=$EDGE_LINK_TOKEN --format=table
npm run cli -- instances create --config ./new-instance.json --token=$EDGE_LINK_TOKEN
npm run cli -- instances update alpha --patch '{"udpAddress":"10.0.0.2"}' --token=$EDGE_LINK_TOKEN
npm run cli -- instances delete alpha --token=$EDGE_LINK_TOKEN
npm run cli -- bonding status --token=$EDGE_LINK_TOKEN --format=table
npm run cli -- bonding update --patch '{"failoverThreshold":300}' --token=$EDGE_LINK_TOKEN
npm run cli -- status --token=$EDGE_LINK_TOKEN --format=table
```

## Management API security

Set `managementApiToken` in plugin options (or the environment variable `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`). Protected routes include:

- `/instances`, `/bonding`, `/status`, `/plugin-config`
- `/config/*`, `/connections/:id/config/*`
- `/connections/:id/metrics`, `/connections/:id/network-metrics`
- `/connections/:id/bonding`, `/connections/:id/congestion`
- `/connections/:id/monitoring/*`, `/monitoring/alerts`
- `/capture/*`, `/delta-timer`

Send the token as either:

- `X-Edge-Link-Token: <token>`
- `Authorization: Bearer <token>`

CLI commands support `--token=<token>` or the `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` environment variable.

## Web UI token injection

Management pages automatically attach auth headers when a token is available. Token sources are checked in this order:

1. `window.__EDGE_LINK_AUTH__.token` — injected global (preferred for server-side injection)
2. URL query parameter `?edgeLinkToken=<token>`
3. `localStorage.setItem("signalkEdgeLinkManagementToken", "<token>")`

The UI sends both `X-Edge-Link-Token` and `Authorization: Bearer <token>` by default. Override with:

```javascript
window.__EDGE_LINK_AUTH__ = {
  token: "<token>",
  queryParam: "edgeLinkToken",
  localStorageKey: "signalkEdgeLinkManagementToken",
  headerMode: "both" // "both" | "authorization" | "x-edge-link-token"
};
```

## Documentation map

- `docs/README.md` (documentation index)
- `docs/architecture-overview.md` (system architecture and lifecycle)
- `docs/configuration-reference.md` (settings and defaults)
- `docs/api-reference.md`
- `docs/protocol-v2.md` (reliable protocol operational overview)
- `docs/protocol-v3-spec.md` (authenticated control-plane details)
- `docs/bonding.md` (bonding concepts and API usage)
- `docs/congestion-control.md` (congestion-control behavior and tuning)
- `docs/metrics.md` (metrics and monitoring reference)
- `docs/management-tools.md` (instance/bonding API + CLI operations)
- `docs/security.md` (security guidance and deployment hardening)
- `docs/performance-tuning.md` (deployment tuning recommendations by hardware profile)
- `docs/troubleshooting.md` (issue-oriented diagnostics)
- `samples/` (example JSON configurations for minimal/dev/v2-bonding setups)
- `grafana/dashboards/edge-link.json` (starter Grafana dashboard)
- `src/scripts/migrate-config.ts` (legacy config migration utility)
- `src/bin/edge-link-cli.ts` (CLI wrapper for migration and instance/bonding management)

## License

MIT. See `LICENSE`.
