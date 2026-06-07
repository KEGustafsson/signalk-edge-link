# 04 — External Contracts (must be preserved exactly)

These are consumed by SignalK admin, Grafana, CLI users, and existing peers.
A rewrite that changes any of these breaks deployments. Each route below
keeps its **path, method, auth action, status codes, and response shape**.

## 1. HTTP API

Base path: `/plugins/signalk-edge-link`. Auth + rate-limit apply per §1.4.

### 1.1 Metrics & status (`routes/metrics.ts`, `routes.ts`)

| Method | Path               | Auth action            | Codes                                |
| ------ | ------------------ | ---------------------- | ------------------------------------ |
| GET    | `/metrics`         | `metrics.read`         | 200, 503                             |
| GET    | `/network-metrics` | `network-metrics.read` | 200, 503                             |
| GET    | `/prometheus`      | `prometheus.read`      | 200, 503 (text/plain; version=0.0.4) |
| GET    | `/sources`         | `sources.read`         | 200, 500, 503                        |
| GET    | `/status`          | `status.read`          | 200, 503                             |

### 1.2 Control (`routes/control.ts`)

| Method | Path                | Auth action          | Codes         |
| ------ | ------------------- | -------------------- | ------------- |
| GET    | `/congestion`       | `congestion.read`    | 200, 404, 503 |
| POST   | `/delta-timer`      | `delta-timer.update` | 200, 400, 503 |
| GET    | `/bonding`          | `bonding.read`       | 200, 503      |
| POST   | `/bonding`          | `bonding.update`     | 200, 400, 503 |
| POST   | `/bonding/failover` | `bonding.failover`   | 200, 404, 503 |

### 1.3 Config (`routes/config.ts`)

| Method | Path                | Auth action          | Codes                         |
| ------ | ------------------- | -------------------- | ----------------------------- |
| GET    | `/paths`            | `paths.read`         | 200                           |
| GET    | `/plugin-config`    | `config.read`        | 200, 500 (secretKey redacted) |
| POST   | `/plugin-config`    | `config.update`      | 200, 400, 500                 |
| GET    | `/plugin-schema`    | `plugin-schema.read` | 200                           |
| GET    | `/config/:filename` | `config-file.read`   | 200, 400, 503, 500            |
| POST   | `/config/:filename` | `config-file.update` | 200, 400, 503, 500            |

`:filename` ∈ {`delta_timer.json`, `subscription.json`,
`sentence_filter.json`} only.

### 1.4 Connections / instances (`routes/connections.ts`)

| Method | Path                                | Auth action                   | Codes                                      |
| ------ | ----------------------------------- | ----------------------------- | ------------------------------------------ |
| GET    | `/connections`                      | `connections.list`            | 200                                        |
| GET    | `/instances`                        | `instances.list`              | 200, 400 (supports `?state=&limit=&page=`) |
| GET    | `/instances/:id`                    | `instances.show`              | 200, 404                                   |
| POST   | `/instances`                        | `instances.create`            | 201, 400, 500                              |
| PUT    | `/instances/:id`                    | `instances.update`            | 200, 400, 404, 500                         |
| DELETE | `/instances/:id`                    | `instances.delete`            | 200, 404, 500                              |
| GET    | `/connections/:id/metrics`          | `connection-monitoring.read`  | 200, 404                                   |
| GET    | `/connections/:id/network-metrics`  | `connection-monitoring.read`  | 200, 404                                   |
| GET    | `/connections/:id/bonding`          | `connection-bonding.read`     | 200, 404                                   |
| GET    | `/connections/:id/congestion`       | `connection-monitoring.read`  | 200, 404, 503                              |
| GET    | `/connections/:id/config/:filename` | `connection-config.read`      | 200, 400, 404, 500                         |
| POST   | `/connections/:id/config/:filename` | `connection-config.update`    | 200, 400, 404, 500                         |
| POST   | `/connections/:id/bonding/failover` | `connection-bonding.failover` | 200, 404, 503                              |

PUT mutable fields only: `name, protocolVersion, useMsgpack,
usePathDictionary, enableNotifications, udpAddress, helloMessageSender,
reliability, congestionControl, bonding, alertThresholds`.

### 1.5 Monitoring (`routes/monitoring.ts`)

| Method | Path                                          | Auth action                  | Codes                                        |
| ------ | --------------------------------------------- | ---------------------------- | -------------------------------------------- |
| GET    | `/monitoring/packet-loss`                     | `monitoring.read`            | 200, 500                                     |
| GET    | `/monitoring/path-latency`                    | `monitoring.read`            | 200, 500 (`?limit=`)                         |
| GET    | `/monitoring/retransmissions`                 | `monitoring.read`            | 200, 500 (`?limit=`)                         |
| GET    | `/monitoring/alerts`                          | `monitoring.alerts.read`     | 200, 500                                     |
| POST   | `/monitoring/alerts`                          | `monitoring.alerts.update`   | 200, 400, 500, 503                           |
| GET    | `/monitoring/inspector`                       | `monitoring.inspector.read`  | 200, 500                                     |
| GET    | `/monitoring/simulation`                      | `monitoring.simulation.read` | 200, 500                                     |
| GET    | `/capture`                                    | `capture.read`               | 200, 500                                     |
| POST   | `/capture/start`                              | `capture.update`             | 200, 500, 503                                |
| POST   | `/capture/stop`                               | `capture.update`             | 200, 500, 503                                |
| GET    | `/capture/export`                             | `capture.export`             | 200, 500, 503 (application/vnd.tcpdump.pcap) |
| GET    | `/connections/:id/monitoring/alerts`          | `connection-monitoring.read` | 200, 404                                     |
| GET    | `/connections/:id/monitoring/packet-loss`     | `connection-monitoring.read` | 200, 404                                     |
| GET    | `/connections/:id/monitoring/retransmissions` | `connection-monitoring.read` | 200, 404                                     |

### 1.6 Auth & rate limiting

- Header: `X-Edge-Link-Token` (preferred) OR `Authorization: Bearer <token>`.
- Token: `managementApiToken` option → `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`
  env. Compare via `crypto.timingSafeEqual` on SHA-256(token).
- If no token configured: open access UNLESS `requireManagementApiToken:
true` (then 401). This back-compat behavior must be preserved.
- Rate limit: 120 req / 60s per IP (`RATE_LIMIT_MAX_REQUESTS`,
  `RATE_LIMIT_WINDOW`); 429 on exceed. Per-IP key (X-Forwarded-For aware).
- Management-auth telemetry snapshot (exposed in `/status` and `/metrics`):
  `{total, allowed, denied, byReason, byAction{...}}`. The full set of 36
  auth action strings is the contract — enumerate in `interface/api/auth.ts`
  and assert with a test.

## 2. Plugin config schema

Root (`plugin.schema`):
`{schemaVersion (ro, default 1), managementApiToken?, requireManagementApiToken? (default false), connections[] (minItems 1)}`.

Connection item — common (all modes):
`name (≤40, default "connection")`, `serverType ("server"|"client")`,
`udpPort (1024–65535, default 4446)`, `secretKey (32 ASCII / 64 hex / 44
base64, pattern-validated)`, `stretchAsciiKey (bool)`, `useMsgpack`,
`useValueDedup`, `useCompactDeltas (requires useMsgpack)`, `pathFilter
{allow[],deny[]}`, `brotliQuality (0–11, default 6)`, `pathPrecision
{path:int 0–15}`, `pathThrottle {path:{minIntervalMs,deadband}}`,
`usePathDictionary`, `protocolVersion (accepts 1|2|3 + "basic"/"advanced"
for back-compat; normalized to numeric 1|3 — 2→3; UI shows "Basic"(1) /
"Advanced"(3); default 1 — see §2.1)`.

Client-only: `udpAddress (default 127.0.0.1)`, `helloMessageSender (10–3600s,
default 60)`, `heartbeatInterval (5000–120000ms, default 25000)`,
`testAddress`/`testPort`/`pingIntervalTime` (v1 only),
`reliability {…}` (v3), `congestionControl {…}` (v3),
`bonding {enabled, mode "main-backup", primary/backup {address,port,
interface?}, failover {…}}` (v3), `enableNotifications`, `skipOwnData`,
`alertThresholds {rtt,packetLoss,retransmitRate,jitter,queueDepth →
{warning,critical}}`.

Server-only: `requestFullStatusOnRestart (v3, default false)`,
`reliability {ackInterval, ackResendInterval, nakTimeout}` (v3).

Protocol constraints: v1 forbids reliability/congestion/bonding/
alertThresholds; v3 forbids the v1 ping-monitor fields
(`testAddress/testPort/pingIntervalTime`). The plugin strips ping fields on
startup; validator rejects them on v3 save.

> This schema is the single source of truth (doc 02 `app/config/schema.ts`)
> feeding the SignalK admin form, HTTP validation, CLI, and the webapp RJSF
> form. A parity test (`config-docs-parity`) keeps docs in sync.

### 2.1 v2 → v3 config compatibility (decisions, doc 08 Q1/Q3)

**Configs are backwards compatible — no operator edits required.** A stored
`protocolVersion: 2` (or `3`) resolves to **v3** at load; a stored `1` stays
v1. v3 retains every v2 feature (reliability, congestion, bonding, metadata,
snapshot replay) plus authenticated control packets — there is no feature
loss, only the forgeable CRC control plane is gone.

**User-facing naming (decision, doc 08 Q8): v1 = "Basic", v3 = "Advanced".**
The UI and human-facing config/docs use these friendly labels; the code and
the canonical stored value stay numeric (`1` / `3`).

Rules:

- **Accepted input values:** numbers `1`, `2`, `3` AND the string aliases
  `"basic"` and `"advanced"`. The sanitizer/normalizer maps:
  - `1` / `"basic"` → v1,
  - `2` / `3` / `"advanced"` → v3 (the `2 → 3` coercion),

  alongside the existing legacy normalizations (single-object →
  `connections[]`, boolean `serverType` → string). Normalization is the only
  effect; the connection otherwise loads unchanged and starts normally.

- **Canonical stored value is numeric** (`1` or `3`). String aliases exist so
  hand-edited configs can read naturally; on save the UI writes the numeric
  value.
- **Admin UI / schema** offers two choices for NEW selections — `Basic`
  (value `1`) and `Advanced` (value `3`) — via JSON Schema `enum: [1,3]` +
  `enumNames: ["Basic","Advanced"]` (RJSF `ui:` labels). The validator still
  ACCEPTS a stored `2` and the string aliases so existing saved configs never
  error.
- **`migrate-config`** bumps `protocolVersion: 2 → 3` in its output (no
  longer just a warning) and may normalize string aliases to numeric.
- A connection loaded as `2` (or `"advanced"`) emits a one-time info log
  noting it is running as v3 / "Advanced".

**Wire-level (runtime) is still v3-only and breaking for un-upgraded peers:**
once a node runs 3.0.0, it speaks v3 on the wire (HMAC control). An incoming
packet with version byte `0x02` is rejected (doc 03). So a peer still running
an older release configured for v2 will not interop — both ends must be on
3.0.0 (which auto-resolves their `2` configs to v3) or both on v1. Document
in the migration guide and CHANGELOG as the 3.0.0 breaking change.

## 3. CLI surface (`bin/edge-link-cli.ts`)

```
migrate-config <input.json> [output.json]
instances list   [--state=] [--limit=] [--page=] [--format=json|table]
instances show <id> [--format=]
instances create --config <path.json>
instances update <id> --patch '{...}'
instances delete <id>
bonding status   [--format=]
bonding update   --patch '{...}'
status           [--format=]
global flags: --baseUrl (default http://localhost:3000/plugins/signalk-edge-link)
              --token   (env SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN)
              --format  (json|table, default json)
```

`migrate-config` detects legacy flat config (root `serverType`/`udpPort`/
`secretKey`), wraps into `connections[]`, preserves non-connection fields,
bumps any `protocolVersion: 2 → 3` (§2.1), validates, writes 2-space JSON +
trailing newline. Token resolution: env → arg → default; string
"undefined"/"null" normalized to null.

## 4. Per-connection runtime config files

`delta_timer.json`, `subscription.json`, `sentence_filter.json` — stored
per connection under `instances/{instanceId}/`; legacy root-level files are
migrated up (v0→v1). Read/written via the config routes. `subscription.json`
also carries the optional `meta` block parsed by `parseMetaConfig`.

## 5. Metrics / Prometheus (Grafana contract)

Prometheus metric names (prefix `signalk_edge_link_`) are an external
contract — Grafana dashboards depend on them. The registry maps internal
counters to these exact names. Families (non-exhaustive list mirrored from
`prometheus.ts`):

- Gauges: `uptime_seconds`, `bandwidth_rate_out_bytes`,
  `bandwidth_rate_in_bytes`, `compression_ratio_percent`,
  `rtt_milliseconds`, `jitter_milliseconds`, `queue_depth`, `ready_to_send`,
  `deltas_buffered`, `packet_loss_rate`, `link_quality_score`,
  `retransmit_rate`, `smart_batch_avg_bytes_per_delta`, `alert_<name>`,
  `bonding_active_link`, `bonding_link_status`,
  `bonding_link_rtt_milliseconds`, `bonding_link_loss_rate`,
  `bonding_link_quality`.
- Counters: `deltas_sent_total`, `deltas_received_total`,
  `data_packets_received_total`, `rate_limited_packets_total`,
  `dropped_delta_batches_total`, `dropped_deltas_total`,
  `suppressed_outbound_duplicates_total`,
  `suppressed_outbound_duplicates_by_path_total`,
  `udp_send_errors_total`, `udp_retries_total`, `compression_errors_total`,
  `encryption_errors_total`, `subscription_errors_total`,
  `malformed_packets_total`, `errors_by_category_total`,
  `bytes_out_total`, `bytes_in_total`, `bytes_out_raw_total`,
  `bytes_in_raw_total`, `packets_out_total`, `packets_in_total`,
  `metadata_*_total`, `retransmissions_total`, `acks_sent_total`,
  `naks_sent_total`, `smart_batch_*_total`.
- Base labels: `mode` (server/client), `instance` (id when multi-instance).

SignalK published paths (`metrics-publisher.ts`) under
`networking.edgeLink.*`: `.rtt`, `.jitter`, `.packetLoss`,
`.bandwidth.upload|download`, `.packetsPerSecond.sent|received`,
`.retransmissions`, `.sequenceNumber`, `.queueDepth`, `.linkQuality`,
`.activeLink`, `.compressionRatio`, `.links.<name>.{rtt,loss,status,
quality}`. Source label `signalk-edge-link`. Link-quality weighting:
loss 40% / rtt 30% / jitter 20% / retransmit 10%, clamped 0–100.

The full `Metrics` object shape (consumed by `/metrics` and the UI) is in
`foundation/types/metrics.ts`; preserve every field name.

## 6. Webapp

### 6.1 Build / federation (`webpack.config.js`)

- `ModuleFederationPlugin` exposes `./PluginConfigurationPanel` via
  `remoteEntry.js`; React/react-dom shared (`strictVersion: true`). Output
  to `public/`. CSS extracted in production; icons copied. This federation
  contract (remote name, exposed module, shared singletons) must be
  preserved so the SignalK admin can mount the config panel.

### 6.2 Runtime UI surface to reproduce

Tabs/views (today built by the 2341-line string engine):

- Connection tabs (multi-instance selector when >1 connection).
- Server view: Status, Bandwidth Monitor, Path Analytics, Alerts, Plugin
  Configuration.
- Client view: Delta Timer, Subscription, Sentence Filter, Bandwidth
  Monitor, Path Analytics, Network Quality, Bonding, Alerts, Capture, Plugin
  Configuration.
- Metrics refresh: 15s polling.

### 6.3 Target component decomposition (React 18)

`App` → `ConnectionTabs` → (`ServerDashboard` | `ClientDashboard`) composed
of presentational cards: `StatusCard`, `BandwidthCard`, `PathAnalyticsCard`,
`NetworkQualityCard`, `BondingCard`, `AlertsCard`, `CaptureCard`,
`ConfigFileEditor`, `PluginConfigForm` (RJSF / `@rjsf/*`, kept — doc 08 Q4).
Hooks: `useApi` (wraps `apiFetch`), `useMetricsPolling`, `useAuthToken`,
`useConnections`. The 40+ `renderX` string helpers become these components;
`escapeHtml`/`innerHTML` disappear (React escapes by default → removes the
XSS surface).

The protocol selector in `PluginConfigForm` presents two options labeled
**"Basic"** (v1) and **"Advanced"** (v3) — driven by the schema's
`enumNames` (doc 08 Q8); it writes numeric `1`/`3`. Anywhere the UI shows a
connection's protocol (dashboards, instance lists, status) it displays
Basic/Advanced, not the raw number.

### 6.4 Auth token injection (preserve)

`apiFetch` sends `X-Edge-Link-Token` and/or `Authorization: Bearer`. Token
sources in order: `window.__EDGE_LINK_AUTH__.token` → URL query (opt-in via
`includeTokenInQuery`) → `localStorage["signalkEdgeLinkManagementToken"]`.
`headerMode` ∈ {both, authorization, x-edge-link-token}.

## 7. SignalK plugin lifecycle contract

`createPlugin(app)` returns `{id, name, description, schema,
registerWithRouter(router), start(options), stop()}`. These are SignalK
contracts and keep their semantics. Today `plugin._currentOptions` and
`plugin._restartPlugin` are read by routes — the rewrite replaces that with
explicit accessors on `ConnectionManager`/plugin, but the observable
start/stop/restart behavior is unchanged.
