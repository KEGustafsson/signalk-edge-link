# Signal K Edge Link — Configuration Reference

> Complete settings reference with defaults and valid ranges.
> For quick-start examples, see the [GUIDE.md quick start](GUIDE.md#5-quick-start--minimal-setup).

---

## Top-Level Plugin Fields

These sit outside `connections[]`, at the root of the plugin config:

| Field                       | Type    | Default | Description                                                                                                                                         |
| --------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managementApiToken`        | string  | `null`  | Shared secret protecting management API endpoints. Also set via env `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`.                                           |
| `requireManagementApiToken` | boolean | `false` | When `true`, management endpoints fail closed (HTTP 403) if no token is configured. Also via env `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN=true`. |

---

## Common Fields (Client and Server)

| Field                  | Type    | Default        | Description                                                                                                                                                                                                                                                   |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string  | `"connection"` | Label shown in UI and logs. Used as directory name for runtime config files. Max 40 characters.                                                                                                                                                               |
| `serverType`           | string  | `"client"`     | `"client"` sends data; `"server"` receives data.                                                                                                                                                                                                              |
| `udpPort`              | integer | `4446`         | UDP port. Range 1024–65535. Must match on both ends.                                                                                                                                                                                                          |
| `udpMetaPort`          | integer | —              | Optional separate UDP port for v1 metadata packets. Ignored by v3 (which multiplexes metadata on the main port).                                                                                                                                              |
| `secretKey`            | string  | — (required)   | AES-256 encryption key. Accepts 32-char ASCII, 64-char hex, or base64 (standard or URL-safe). Must match exactly on both ends.                                                                                                                                |
| `stretchAsciiKey`      | boolean | `false`        | When `true`, runs a 32-char ASCII key through PBKDF2-SHA256 (600,000 iterations) before use. **Both ends must match.**                                                                                                                                        |
| `authenticatedHeaders` | boolean | `false`        | v3 only. When `true`, each DATA/METADATA packet carries a 16-byte HMAC tag binding the header (type/flags/sequence/length) to the encrypted payload, so an on-path attacker cannot tamper with header fields. Adds 16 bytes/packet. **Both ends must match.** |
| `protocolVersion`      | integer | `1`            | `1` (Basic) or `3` (Advanced). Must match on both ends. Accepts `"basic"`/`"advanced"` string aliases.                                                                                                                                                        |
| `useMsgpack`           | boolean | `false`        | Serialize deltas as MessagePack instead of JSON. Saves ~15–25%. **Both ends must match.**                                                                                                                                                                     |
| `usePathDictionary`    | boolean | `false`        | Replace Signal K path strings with 2-byte numeric IDs. Saves ~10–20%. **Both ends must match.**                                                                                                                                                               |
| `enableNotifications`  | boolean | `false`        | Forward Signal K notification deltas over the link.                                                                                                                                                                                                           |
| `skipOwnData`          | boolean | `false`        | (Client only) Drop all `networking.edgeLink.*` metrics before forwarding — prevents feedback loops.                                                                                                                                                           |

---

## Client Transport Fields

| Field                | Type    | Default       | Description                                                                                                                        |
| -------------------- | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `udpAddress`         | string  | `"127.0.0.1"` | Hostname or IP address of the remote server. Required for client connections.                                                      |
| `helloMessageSender` | integer | `60`          | Interval in **seconds** between HELLO keepalive messages. Keeps NAT/firewall mappings alive. Range 10–3600.                        |
| `heartbeatInterval`  | integer | `25000`       | Interval in **ms** between HEARTBEAT probes (Advanced/v3 only). Used for RTT measurement and NAT hole-punching. Range 1000–120000. |

---

## v1 Ping Monitor Fields (Client, Basic/v1 Only)

These fields **must not** appear in Advanced/v3 configurations.

| Field              | Type    | Default       | Description                                       |
| ------------------ | ------- | ------------- | ------------------------------------------------- |
| `testAddress`      | string  | `"127.0.0.1"` | Host to probe for reachability (e.g., `8.8.8.8`). |
| `testPort`         | integer | `80`          | Port to probe (e.g., 53, 80, 443).                |
| `pingIntervalTime` | number  | `1`           | Probe frequency in **minutes**. Range 0.1–60.     |

---

## Reliability — Server Mode (Advanced/v3 Only)

Nested under `reliability`:

| Field               | Type    | Default | Range (ms) | Description                                          |
| ------------------- | ------- | ------- | ---------- | ---------------------------------------------------- |
| `ackInterval`       | integer | `100`   | 20–5000    | How often the server emits a cumulative ACK.         |
| `ackResendInterval` | integer | `1000`  | 100–10000  | Re-send the last ACK after this interval of silence. |
| `nakTimeout`        | integer | `100`   | 20–5000    | Idle delay before sending NAK for a detected gap.    |

---

## Reliability — Client Mode (Advanced/v3 Only)

Nested under `reliability`:

| Field                     | Type    | Default  | Range       | Description                                                        |
| ------------------------- | ------- | -------- | ----------- | ------------------------------------------------------------------ |
| `retransmitQueueSize`     | integer | `5000`   | 100–50000   | Maximum packets held in the retransmit queue.                      |
| `maxRetransmits`          | integer | `3`      | 1–20        | Give up retransmitting after this many attempts.                   |
| `retransmitMaxAge`        | integer | `120000` | 1000–300000 | Hard upper bound in ms on retransmit queue entries.                |
| `retransmitMinAge`        | integer | `10000`  | 200–30000   | Never evict entries newer than this.                               |
| `retransmitRttMultiplier` | number  | `12`     | 2–20        | Scale factor applied to current RTT to compute per-entry timeout.  |
| `ackIdleDrainAge`         | integer | `20000`  | 500–30000   | If no ACK for this long, start expiring entries more aggressively. |
| `forceDrainAfterAckIdle`  | boolean | `false`  | —           | Force-clear queue after `forceDrainAfterMs` of ACK silence.        |
| `forceDrainAfterMs`       | integer | `45000`  | 2000–120000 | Duration of ACK silence that triggers a force drain.               |
| `recoveryBurstEnabled`    | boolean | `true`   | —           | When ACKs resume after a gap, rapidly retransmit queued packets.   |
| `recoveryBurstSize`       | integer | `100`    | 10–1000     | Maximum packets to retransmit per recovery burst cycle.            |
| `recoveryBurstIntervalMs` | integer | `200`    | 50–5000     | Interval between recovery burst cycles in ms.                      |
| `recoveryAckGapMs`        | integer | `4000`   | 500–120000  | Minimum ACK silence before triggering fast recovery bursts.        |

---

## Congestion Control (Client, Advanced/v3 Only)

Nested under `congestionControl`. See [congestion-control.md](congestion-control.md) for the full algorithm.

| Field               | Type    | Default | Range         | Description                                                                  |
| ------------------- | ------- | ------- | ------------- | ---------------------------------------------------------------------------- |
| `enabled`           | boolean | `false` | —             | Enable AIMD automatic delta timer adjustment.                                |
| `targetRTT`         | integer | `200`   | 50–2000 ms    | RTT above this level triggers rate reduction. Set to your link's normal RTT. |
| `nominalDeltaTimer` | integer | `1000`  | 100–10000 ms  | Starting send interval when congestion control is first enabled.             |
| `minDeltaTimer`     | integer | `100`   | 50–1000 ms    | Fastest allowed send rate.                                                   |
| `maxDeltaTimer`     | integer | `5000`  | 1000–30000 ms | Slowest allowed send rate under congestion.                                  |

---

## Connection Bonding (Client, Advanced/v3 Only)

Nested under `bonding`. See [bonding.md](bonding.md) for the full explanation.

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

## Alert Thresholds (Client, Advanced/v3 Only)

Nested under `alertThresholds`. Each metric has `warning` and `critical` levels. When exceeded, a Signal K notification fires at `notifications.signalk-edge-link.<connectionName>.*`.

| Metric                            | Warning default | Critical default | Unit    |
| --------------------------------- | --------------- | ---------------- | ------- |
| `rtt.warning/critical`            | `300` / `800`   | —                | ms      |
| `packetLoss.warning/critical`     | `0.03` / `0.10` | —                | ratio   |
| `retransmitRate.warning/critical` | `0.05` / `0.15` | —                | ratio   |
| `jitter.warning/critical`         | `100` / `300`   | —                | ms      |
| `queueDepth.warning/critical`     | `100` / `500`   | —                | packets |

---

## Server-Specific Fields

| Field                        | Type    | Default | Description                                                                                                                                                                                                                      |
| ---------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestFullStatusOnRestart` | boolean | `false` | (Advanced/v3) When `true`, the server sends a FULL_STATUS_REQUEST to each client on first contact after a restart. The client replays its complete current Signal K state. Rate-limited to one replay per 10 seconds per client. |

---

## Runtime Configuration Files (Hot-Reload)

Three JSON files can be edited or updated via the API **without restarting the plugin**. Stored in:

```text
<signalk-data-dir>/plugin-config-data/signalk-edge-link/<connectionName>/
```

The plugin watches each file for changes (300 ms debounce) and reloads automatically.

### delta_timer.json

Overrides the delta send interval. When set, bypasses congestion control.

```json
{ "deltaTimer": 2000 }
```

| Field        | Type    | Default | Range        | Description                                                        |
| ------------ | ------- | ------- | ------------ | ------------------------------------------------------------------ |
| `deltaTimer` | integer | `1000`  | 100–10000 ms | Data batching interval. `null` or absent = use congestion control. |

### subscription.json

Controls which Signal K paths are transmitted, and optionally enables metadata streaming.

```json
{
  "context": "*",
  "subscribe": [
    { "path": "navigation.*" },
    { "path": "environment.wind.*" },
    { "path": "electrical.batteries.*" }
  ],
  "meta": {
    "enabled": false,
    "intervalSec": 300,
    "includePathsMatching": null,
    "maxPathsPerPacket": 500
  }
}
```

| Field                       | Type         | Default | Description                                                                                  |
| --------------------------- | ------------ | ------- | -------------------------------------------------------------------------------------------- |
| `context`                   | string       | `"*"`   | Signal K context filter (`"*"` = all vessels, `"vessels.self"` = own vessel only)            |
| `subscribe`                 | array        | —       | Array of `{ "path": "..." }` objects. Supports `*` wildcard.                                 |
| `meta.enabled`              | boolean      | `false` | Enable Signal K path metadata streaming (units, descriptions, zones).                        |
| `meta.intervalSec`          | integer      | `300`   | Full snapshot re-broadcast interval in seconds. Range 30–86400.                              |
| `meta.includePathsMatching` | string\|null | `null`  | Optional JavaScript regex — only matching paths are streamed. `null` = all subscribed paths. |
| `meta.maxPathsPerPacket`    | integer      | `500`   | Chunk size for snapshot packets. Range 10–5000.                                              |

### sentence_filter.json

Drops deltas originating from specific NMEA sentence types before forwarding.

```json
{ "excludedSentences": ["GSV", "GSA", "VTG", "GLL"] }
```

Common sentences to exclude: `GSV` (satellites in view — large, repetitive), `GSA` (DOP and active satellites), `VTG` (track/speed — redundant if COG/SOG forwarded separately), `GLL` (position — redundant with RMC/GGA).

---

## Example Configurations

### Minimal Basic (v1) — stable LAN

```json
{
  "connections": [
    {
      "name": "shore-server",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 1
    },
    {
      "name": "vessel-client",
      "serverType": "client",
      "udpAddress": "192.168.1.100",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 1,
      "testAddress": "8.8.8.8",
      "testPort": 53,
      "pingIntervalTime": 1
    }
  ]
}
```

### Production Advanced (v3) server

```json
{
  "managementApiToken": "long-random-management-token-here",
  "requireManagementApiToken": true,
  "connections": [
    {
      "name": "shore-prod",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "<64-char-hex-secret>",
      "protocolVersion": 3,
      "requestFullStatusOnRestart": true,
      "reliability": {
        "ackInterval": 100,
        "ackResendInterval": 1000,
        "nakTimeout": 100
      }
    }
  ]
}
```

### Production Advanced (v3) client with congestion control

```json
{
  "connections": [
    {
      "name": "vessel-prod",
      "serverType": "client",
      "udpAddress": "shore.example.com",
      "udpPort": 4446,
      "secretKey": "<64-char-hex-secret>",
      "protocolVersion": 3,
      "useMsgpack": true,
      "usePathDictionary": true,
      "skipOwnData": true,
      "heartbeatInterval": 25000,
      "reliability": {
        "retransmitQueueSize": 5000,
        "maxRetransmits": 3,
        "retransmitMaxAge": 120000,
        "recoveryBurstEnabled": true,
        "recoveryBurstSize": 100
      },
      "congestionControl": {
        "enabled": true,
        "targetRTT": 300,
        "minDeltaTimer": 250,
        "maxDeltaTimer": 5000
      },
      "alertThresholds": {
        "rtt": { "warning": 400, "critical": 900 },
        "packetLoss": { "warning": 0.05, "critical": 0.15 }
      }
    }
  ]
}
```

---

## Validation Rules

The configuration validator enforces:

- `serverType` must be `"server"` or `"client"`
- `udpPort` must be an integer 1024–65535
- `secretKey` must match one of the three accepted formats
- `protocolVersion` must be 1 or 3 (or `"basic"`/`"advanced"`)
- Server connections must not include `congestionControl`, `bonding`, `alertThresholds`, or `skipOwnData`
- Advanced/v3 clients must not include `testAddress`, `testPort`, or `pingIntervalTime`
- Basic/v1 clients must not include `heartbeatInterval`
- Bonding: primary and backup must have different address:port pairs
- Reliability values must be within documented ranges
- Alert thresholds: `warning` ≤ `critical`; ratio metrics 0–1

---

## Internal Constants

Defined in `src/foundation/constants.ts`. Not configurable via UI; require a source rebuild.

| Constant                     | Value    | Description                                        |
| ---------------------------- | -------- | -------------------------------------------------- |
| `MAX_SAFE_UDP_PAYLOAD`       | 1400 B   | MTU limit for UDP packets                          |
| `BROTLI_QUALITY_HIGH`        | 6        | Compression quality (~90% of max at ~10% CPU cost) |
| `UDP_RETRY_MAX`              | 3        | Max UDP send retries                               |
| `UDP_RETRY_DELAY`            | 100 ms   | Base retry delay                                   |
| `SMART_BATCH_SAFETY_MARGIN`  | 85%      | Target % of MTU per packet                         |
| `SMART_BATCH_MAX_DELTAS`     | 50       | Max deltas per batch                               |
| `RATE_LIMIT_MAX_REQUESTS`    | 120      | API rate limit per minute per IP                   |
| `BONDING_HEARTBEAT_TIMEOUT`  | 5000 ms  | Link marked DOWN after this of no response         |
| `MONITORING_ALERT_COOLDOWN`  | 60000 ms | Alert cooldown period                              |
| `PACKET_CAPTURE_MAX_PACKETS` | 1000     | Max packets in capture buffer                      |
