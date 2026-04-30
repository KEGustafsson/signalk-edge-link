# Management Tools (API + CLI)

This guide covers runtime management workflows for multi-instance operation.

## API base

All examples assume the plugin REST API is mounted under `/plugins/signalk-edge-link`.

## Authentication

If `managementApiToken` is configured (or `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` is set), include one of:

- `X-Edge-Link-Token: <token>`
- `Authorization: Bearer <token>`

When a token is configured, management/configuration/control endpoints return `401`
without a valid token. This includes `/instances`, `/bonding`, `/status`,
`/plugin-config`, `/config/*`, `/connections/:id/config/*`, `/monitoring/alerts`,
`/capture/*`, and `/delta-timer`.

If `requireManagementApiToken` or `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` requires token auth but no token is configured, protected management routes return `403` with configuration guidance.

CLI note: `--token` sends both `X-Edge-Link-Token` and `Authorization: Bearer <token>` for compatibility with reverse proxies.

### Web UI token entry

The bundled management UI (`src/webapp` and plugin configuration panel) can attach management tokens automatically.

Supported token sources (checked in priority order):

1. `window.__EDGE_LINK_AUTH__.token` (injected global)
2. URL query parameter `?edgeLinkToken=<token>` (name configurable)
3. Browser localStorage key `signalkEdgeLinkManagementToken` (name configurable)

By default, UI requests send both headers when a token is available:

- `X-Edge-Link-Token: <token>`
- `Authorization: Bearer <token>`

Optional runtime override:

```javascript
window.__EDGE_LINK_AUTH__ = {
  token: "<token>",
  queryParam: "edgeLinkToken",
  localStorageKey: "signalkEdgeLinkManagementToken",
  headerMode: "both" // both | authorization | x-edge-link-token
};
```

When token validation fails, the UI reports `Management token required/invalid.` to help operators distinguish auth failures from generic load/save issues.

For local static preview/testing of the built UI, serve the repository root and open `/public/index.html` (for example `python -m http.server 8001` then browse `http://localhost:8001/public/index.html`) so asset paths resolve consistently.

## Instance management

The examples below use `$EDGE_LINK_TOKEN` for the management token. Omit the `-H "X-Edge-Link-Token: ..."` header if no token is configured.

### List instances

```sh
curl -s \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/instances
```

### List with filters/pagination

```sh
curl -s \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  "http://localhost:3000/plugins/signalk-edge-link/instances?state=running&limit=10&page=1"
```

### Show one instance

```sh
curl -s \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/instances/<id>
```

### Create instance

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"name":"backup","serverType":"client","udpPort":4447,"secretKey":"0123456789abcdef0123456789abcdef"}' \
  http://localhost:3000/plugins/signalk-edge-link/instances
```

### Update instance

```sh
curl -s -X PUT \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"protocolVersion":2,"useMsgpack":true}' \
  http://localhost:3000/plugins/signalk-edge-link/instances/<id>
```

### Delete instance

```sh
curl -s -X DELETE \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/instances/<id>
```

## Bonding management

### View status

```sh
curl -s \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding
```

### Update thresholds

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"rttThreshold":250,"lossThreshold":0.1,"heartbeatTimeout":1200}' \
  http://localhost:3000/plugins/signalk-edge-link/bonding
```

## Status and error summaries

### Aggregated status

```sh
curl -s \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/status
```

Returns per-instance health, status text, error counters, and recent error entries.

The response also includes `managementAuth`, a route-level aggregate of allowed and denied management auth decisions. Use the `byReason` and `byAction` counts to spot missing tokens, invalid tokens, or open-access deployments without exposing token values or client identity details.

### Auth telemetry in Prometheus

Prometheus scrapes include:

```text
signalk_edge_link_management_auth_requests_total{decision="allowed",reason="valid_token",action="status.read"} 1
```

The counter is global for the management API and is emitted once per scrape. Labels are bounded to `decision`, `reason`, and route action strings.

## CLI workflows

Use the packaged CLI (or `npm run cli -- ...`). You can pass `--token=<token>` or set `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`. `instances list` additionally supports `--state`, `--limit`, and `--page`.

```sh
edge-link-cli instances list --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN --state=running --limit=10 --page=1 --format=table
edge-link-cli instances show <id> --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN --format=table
edge-link-cli instances create --config ./instance.json --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN
edge-link-cli instances update <id> --patch '{"protocolVersion":2}' --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN
edge-link-cli instances delete <id> --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN
edge-link-cli bonding status --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN --format=table
edge-link-cli bonding update --patch '{"rttThreshold":250}' --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN
edge-link-cli status --baseUrl=http://localhost:3000/plugins/signalk-edge-link --token=$EDGE_LINK_TOKEN --format=table
```

## Security guidance

- Place the management API behind Signal K authentication.
- Restrict access to trusted operator networks.
- Audit management route usage in your reverse proxy / API gateway logs.
- Monitor `managementAuth` or `signalk_edge_link_management_auth_requests_total` for denied management access attempts.
