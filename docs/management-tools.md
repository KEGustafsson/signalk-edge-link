# Signal K Edge Link — Management Tools

> Management API authentication and CLI operations.

---

## Authentication

Management endpoints require a token when `managementApiToken` is configured in plugin settings:

```bash
# Via X-Edge-Link-Token header (recommended)
curl -H "X-Edge-Link-Token: $TOKEN" http://localhost:3000/plugins/signalk-edge-link/status

# Via Authorization Bearer header
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/plugins/signalk-edge-link/status
```

Set the token in plugin configuration or via environment variable:

```bash
export SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN="your-long-random-token"
```

When `requireManagementApiToken: true` is set, management endpoints fail closed (HTTP 403) if no token is configured.

### HTTP error codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 401  | Invalid or missing token                                              |
| 403  | Token required but not configured (`requireManagementApiToken: true`) |
| 429  | Rate limit exceeded (120 req/min/IP)                                  |
| 503  | Plugin not started                                                    |

---

## Web UI Token Injection

Token sources checked in priority order:

1. `window.__EDGE_LINK_AUTH__.token` — server-side injection (preferred)
2. URL query parameter `?edgeLinkToken=<token>` — **dev/debug only; tokens in URLs leak via browser history and server logs**
3. `localStorage.getItem("signalkEdgeLinkManagementToken")`

Override the injection object:

```javascript
window.__EDGE_LINK_AUTH__ = {
  token: "your-token",
  headerMode: "both" // "both" | "authorization" | "x-edge-link-token"
};
```

---

## CLI Tool

The `edge-link-cli` tool (available as `npm run cli --`) provides command-line access to instance and bonding management.

### Instance operations

```bash
# List running instances
npm run cli -- instances list --token=$TOKEN --state=running --format=table

# Show one instance
npm run cli -- instances show vessel-client --token=$TOKEN --format=table

# Create from JSON file
npm run cli -- instances create --config ./my-connection.json --token=$TOKEN

# Update a field
npm run cli -- instances update vessel-client \
  --patch '{"udpAddress":"10.0.0.2"}' --token=$TOKEN

# Delete
npm run cli -- instances delete vessel-client --token=$TOKEN
```

### Bonding operations

```bash
# Bonding status
npm run cli -- bonding status --token=$TOKEN --format=table

# Update bonding thresholds
npm run cli -- bonding update --patch '{"failoverThreshold":300}' --token=$TOKEN
```

### Plugin status

```bash
# Overall plugin status
npm run cli -- status --token=$TOKEN --format=table
```

---

## Config Migration

Convert a legacy flat-object config to the `connections[]` array format:

```bash
npm run migrate:config -- old-config.json new-config.json
```

---

## Auth Telemetry

`GET /status` and `GET /metrics` include a `managementAuth` block for auditing:

| Field      | Description                                                     |
| ---------- | --------------------------------------------------------------- |
| `total`    | Total management auth decisions since route registration        |
| `allowed`  | Decisions that allowed the request                              |
| `denied`   | Decisions that rejected the request                             |
| `byReason` | Counts by reason: `open_access`, `valid_token`, `invalid_token` |
| `byAction` | Counts by route action: `status.read`, `metrics.read`, etc.     |

Intentionally excluded: token values, transport secrets, client addresses, user agents, raw request paths.

---

## Related

- Full REST API reference: [api-reference.md](api-reference.md)
- Security hardening: [security.md](security.md)
