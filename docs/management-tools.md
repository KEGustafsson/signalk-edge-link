# Signal K Edge Link — Management Tools

> Management API authentication and CLI operations.

---

## Authentication

Management endpoints require a token when one is configured. Sources, highest precedence first:

1. Environment variable `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`
2. Plugin setting `managementApiToken`

The environment variable must be set for the Signal K server process before it starts; exporting it in your own shell only gives the `curl` examples below the value. Once the server has a token, a request without one returns HTTP 401.

```bash
export SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN="your-long-random-token"

# X-Edge-Link-Token header (recommended)
curl -H "X-Edge-Link-Token: $SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN" http://localhost:3000/plugins/signalk-edge-link/status

curl -H "Authorization: Bearer $SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN" http://localhost:3000/plugins/signalk-edge-link/status
```

`X-Management-Token` is accepted as a legacy header. Tokens are compared with a timing-safe SHA-256 digest comparison.

With no token configured, requests are allowed as open access. Setting `requireManagementApiToken: true` (or `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN=true`) makes endpoints fail closed with HTTP 403 until a token is configured; an unrecognised value for either is treated as `true`. If the auth configuration cannot be read, requests are denied.

Once a token is configured, every route requires it, including the read-only ones that dashboards and scrapers poll (`/metrics`, `/network-metrics`, `/prometheus`, `/status`, `/monitoring/*`). Update anything that polls the plugin, Prometheus scrape configs included; see [metrics.md](metrics.md#prometheus-scrape-configuration).

### HTTP error codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 401  | Invalid or missing token                                              |
| 403  | Token required but not configured (`requireManagementApiToken: true`) |
| 429  | Rate limit exceeded (120 req/min/IP)                                  |
| 503  | Plugin not started                                                    |

Full list: [api-reference.md](api-reference.md#conventions).

---

## Web UI Token Injection

The web UI's `apiFetch` checks token sources in this order:

1. `window.__EDGE_LINK_AUTH__.token` — server-side injection (preferred)
2. URL query parameter `?edgeLinkToken=<token>` — **disabled by default.** Tokens in URLs leak via browser history, proxy logs and `Referer` headers, so this source is ignored unless `includeTokenInQuery: true` is set. Dev/debug only.
3. `localStorage.getItem("signalkEdgeLinkManagementToken")`

```javascript
window.__EDGE_LINK_AUTH__ = {
  token: "your-token",
  headerMode: "both" // "both" | "authorization" | "x-edge-link-token"
};
```

`headerMode` picks the headers sent: `both` (default), `authorization` (Bearer only) or `x-edge-link-token`. `queryParam` and `localStorageKey` override the query parameter and storage key names.

---

## CLI Tool

`edge-link-cli` (run as `npm run cli --`) wraps the instance, bonding and status endpoints. Common options:

| Option                 | Default                                           |
| ---------------------- | ------------------------------------------------- |
| `--baseUrl=<url>`      | `http://localhost:3000/plugins/signalk-edge-link` |
| `--token=<token>`      | `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`              |
| `--format=json\|table` | `json` (list/show/status commands)                |

The CLI sends the token in both `X-Edge-Link-Token` and `Authorization: Bearer`, and warns on stderr when sending it over `http://` to a non-local host.

```bash
# Instances (GET/POST/PUT/DELETE /instances)
npm run cli -- instances list --state=Connected --limit=10 --page=1 --format=table
npm run cli -- instances show vessel-client --format=table
npm run cli -- instances create --config ./my-connection.json
npm run cli -- instances update vessel-client --patch '{"udpAddress":"10.0.0.2"}'
npm run cli -- instances delete vessel-client

# Bonding (GET/POST /bonding)
npm run cli -- bonding status --format=table
npm run cli -- bonding update --patch '{"rttThreshold":300}'

# Aggregated status (GET /status)
npm run cli -- status --format=table
```

`instances update` accepts only the fields listed for [`PUT /instances/:id`](api-reference.md#post-instances-put-instancesid-delete-instancesid); `bonding update` accepts only the fields listed for [`POST /bonding`](api-reference.md#bonding-endpoints).

---

## Config Migration

Convert a legacy flat-object config to the `connections[]` array format. Without an output path the input file is overwritten.

```bash
npm run migrate:config -- old-config.json new-config.json
```

---

## Auth Telemetry

`GET /status` and `GET /metrics` include a `managementAuth` block **only when a management token is configured** (`managementApiToken` or `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`). Fields, reasons and the Prometheus series: [metrics.md](metrics.md#management-api-auth-telemetry).

---

## Related

- Full REST API reference: [api-reference.md](api-reference.md)
- Security hardening: [security.md](security.md)
