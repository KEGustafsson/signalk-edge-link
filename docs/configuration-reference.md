# Signal K Edge Link — Configuration Reference

Every setting with its default, valid range and validation rule. Setup steps: [GUIDE.md quick start](GUIDE.md#5-quick-start--minimal-setup). Example files: [`samples/`](../samples/).

All tables use the same columns. "Both ends" means the client and the server of one connection must use the same value. For keys, `protocolVersion` and the authentication settings a mismatch drops every packet; the encoding settings below say what the receiver needs.

---

## Top-Level Plugin Fields

At the root of the plugin config, outside `connections[]`. Token behavior and the CLI are described in [management-tools.md](management-tools.md).

| Field                       | Type    | Default | Range           | Notes                                                                                                                                                                                                                                               |
| --------------------------- | ------- | ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections`               | array   | —       | at least 1 item | One entry per server or client connection. A legacy flat config (connection fields at the root, with `serverType`) is accepted as a single connection named `default`.                                                                              |
| `managementApiToken`        | string  | unset   | —               | Shared secret for the management API. The env var `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` takes precedence when both are set.                                                                                                                          |
| `requireManagementApiToken` | boolean | `false` | —               | `true`: management endpoints fail closed (HTTP 403) when no token is configured. Also set by env `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN=true`. An unrecognised value in either place is treated as `true`. `false` with no token: open access. |
| `schemaVersion`             | number  | `1`     | read-only       | Config schema version for migrations. Do not edit.                                                                                                                                                                                                  |

---

## Common Fields (Client and Server)

| Field                  | Type    | Default        | Range                   | Notes                                                                                                                                                                                                                                                       |
| ---------------------- | ------- | -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string  | `"connection"` | max 40 chars            | Label in the UI and logs. Its slug (lowercase, non-alphanumerics to `-`) is the instance ID used for runtime files, metric paths and notification paths; duplicates get `-1`, `-2`.                                                                         |
| `connectionId`         | string  | assigned       | max 80 chars            | Internal ID that matches a connection across saves. Assigned automatically and hidden in the form. Omit it in a hand-written config; an empty string fails validation.                                                                                      |
| `serverType`           | string  | `"client"`     | `"client"` / `"server"` | `"client"` sends, `"server"` receives. Legacy booleans are accepted: `true` = server, `false` = client.                                                                                                                                                     |
| `udpPort`              | integer | `4446`         | 1024–65535              | Both ends. Each server connection needs its own port.                                                                                                                                                                                                       |
| `secretKey`            | string  | required       | see notes               | AES-256 key: 32 printable ASCII characters, 64 hex characters, or base64 (standard or URL-safe) of 32 bytes. Both ends.                                                                                                                                     |
| `stretchAsciiKey`      | boolean | `false`        | —                       | Runs a 32-character ASCII key through PBKDF2-SHA256 (600,000 iterations). Hex and base64 keys are unaffected. Both ends.                                                                                                                                    |
| `protocolVersion`      | integer | `1`            | `1` / `3`               | `1` Basic, `3` Advanced. Aliases `"basic"` / `"advanced"` are accepted. Legacy `2` is accepted and converted to `3`. Both ends.                                                                                                                             |
| `authenticatedHeaders` | boolean | `true`         | —                       | v3. Adds a 16-byte HMAC tag to each DATA/METADATA packet binding the header (type, flags, sequence, length) to the encrypted payload. Both ends; set `false` on both only to talk to a peer that cannot enable it.                                          |
| `epochBoundAuth`       | boolean | `false`        | —                       | v3, requires `authenticatedHeaders`. Also binds the tag to the connection epoch from the HELLO handshake, so a replayed packet from a source address the receiver has never seen fails authentication. No extra bytes. Both ends, and both must run 4.0.0+. |
| `useMsgpack`           | boolean | `false`        | —                       | MessagePack instead of JSON, about 15–25% smaller. Basic (v1): set on both ends. Advanced (v3): the receiver reads the MessagePack flag in each packet header, so only the sender needs it.                                                                 |
| `usePathDictionary`    | boolean | `false`        | —                       | Sends Signal K paths as 2-byte numeric IDs, about 10–20% smaller. The receiver decodes numeric and plain paths alike, so only the sender needs it.                                                                                                          |

On a server, `useMsgpack` and `usePathDictionary` also set the encoding of outbound fleet data.

### Client-only sending options

Removed from server connections when the config is loaded. The server detects these encodings in each packet and has no matching setting.

| Field              | Type    | Default | Range                                 | Notes                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------- | ------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useValueDedup`    | boolean | `false` | —                                     | v3 only. Replaces a value identical to the last one sent for that path with the sentinel `{"$$": "dup"}`; the receiver restores it from its cache. A receiver that does not understand the sentinel injects it as the value. A genuine value of exactly that shape is sent verbatim but read as the marker. |
| `useCompactDeltas` | boolean | `false` | —                                     | v3 only, requires `useMsgpack`. Encodes each delta as a fixed 5-slot tuple, dropping repeated key names.                                                                                                                                                                                                    |
| `brotliQuality`    | integer | `6`     | 0–11                                  | Brotli level. 11 costs roughly 3–5× the CPU of 6. Peers need not match.                                                                                                                                                                                                                                     |
| `pathFilter`       | object  | —       | `{ allow: string[], deny: string[] }` | Paths to forward. Non-empty `allow` forwards only matching paths; `deny` is applied after `allow`. Filtered paths are dropped before any other processing. Empty strings are rejected.                                                                                                                      |
| `pathPrecision`    | object  | —       | path → integer 0–15                   | Decimal places per exact path, e.g. `{ "navigation.speedOverGround": 2 }`. Lossy: the receiver gets the rounded value. Unlisted paths keep full precision.                                                                                                                                                  |
| `pathThrottle`     | object  | —       | path → `{ minIntervalMs, deadband }`  | Per exact path. `minIntervalMs` (integer 0–3600000) drops values sent again within that time; `deadband` (number ≥ 0) drops numeric changes smaller than it. A value is sent only if both rules allow it. Unlisted paths are not throttled.                                                                 |

`pathFilter` patterns: `*` matches every path, `navigation.*` matches every path under `navigation.` (not `navigation` itself), anything else matches exactly. Mid-string wildcards such as `navigation.speed*` are not supported. `pathPrecision` and `pathThrottle` keys are exact paths, not globs. Use dotted paths for nested values, e.g. `navigation.position.latitude`.

---

## Client Transport Fields

| Field                 | Type    | Default       | Range          | Notes                                                                                                                                                                                                                                                          |
| --------------------- | ------- | ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `udpAddress`          | string  | `"127.0.0.1"` | —              | Server hostname or IP. Required on clients.                                                                                                                                                                                                                    |
| `helloMessageSender`  | integer | `60`          | 10–3600 s      | Seconds between HELLO messages, which keep NAT/firewall mappings open.                                                                                                                                                                                         |
| `heartbeatInterval`   | number  | `25000`       | 5000–120000 ms | v3. Milliseconds between HEARTBEAT packets for NAT keepalive and RTT. Keep it below the NAT's UDP mapping timeout (typically 30–120 s); fleet sharing depends on it. Client-only (removed from server connections).                                            |
| `enableNotifications` | boolean | `false`       | —              | Emits Signal K notifications for monitoring alerts (`notifications.signalk-edge-link.<instanceId>.<metric>`) and bonding failover (`notifications.signalk-edge-link.<instanceId>.linkFailover`).                                                               |
| `skipOwnData`         | boolean | `false`       | —              | Strips `networking.edgeLink.*` paths from forwarded data, to prevent loops in a chain. RTT paths (`networking.edgeLink[.<id>].rtt`, `networking.modem[.<id>].rtt`) are still forwarded. The v3 link telemetry the peer uses to report the link is always sent. |

---

## v1 Ping Monitor Fields (Client, Basic/v1 Only)

Required on v1 clients (`testAddress`, `testPort`). Rejected on v3 clients, and removed from a client when it is switched to v3.

| Field              | Type    | Default       | Range      | Notes                            |
| ------------------ | ------- | ------------- | ---------- | -------------------------------- |
| `testAddress`      | string  | `"127.0.0.1"` | —          | Host to probe, e.g. `8.8.8.8`.   |
| `testPort`         | integer | `80`          | 1–65535    | Port to probe, e.g. 53, 80, 443. |
| `pingIntervalTime` | number  | `1`           | 0.1–60 min | Minutes between probes.          |

---

## Reliability — Server Mode (Advanced/v3 Only)

Under `reliability` on a server connection.

| Field               | Type   | Default | Range        | Notes                                                                                                                             |
| ------------------- | ------ | ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `ackInterval`       | number | `100`   | 20–5000 ms   | How often the server sends a cumulative ACK.                                                                                      |
| `ackResendInterval` | number | `1000`  | 100–10000 ms | Resends the last ACK after this much silence, to recover from a lost ACK.                                                         |
| `nakTimeout`        | number | `100`   | 20–5000 ms   | Delay before sending a NAK for a detected gap.                                                                                    |
| `maxNakRounds`      | number | `5`     | 1–25         | NAKs per missing packet before the window moves past it. Keep above the client's `maxRetransmits`; a lost NAK still uses a round. |

---

## Reliability — Client Mode (Advanced/v3 Only)

Under `reliability` on a client connection. `retransmitMinAge` must be ≤ `retransmitMaxAge`.

| Field                     | Type    | Default  | Range          | Notes                                                                 |
| ------------------------- | ------- | -------- | -------------- | --------------------------------------------------------------------- |
| `retransmitQueueSize`     | number  | `5000`   | 100–50000      | Packets held for retransmission.                                      |
| `maxRetransmits`          | number  | `3`      | 1–20           | Attempts before a packet is dropped from the queue.                   |
| `retransmitMaxAge`        | number  | `120000` | 1000–300000 ms | Hard upper age limit for queue entries.                               |
| `retransmitMinAge`        | number  | `10000`  | 200–30000 ms   | Entries younger than this are never expired.                          |
| `retransmitRttMultiplier` | number  | `12`     | 2–20           | Per-entry expiry = current RTT × this.                                |
| `ackIdleDrainAge`         | number  | `20000`  | 500–30000 ms   | After this long without an ACK, entries expire more aggressively.     |
| `forceDrainAfterAckIdle`  | boolean | `false`  | —              | Clears the queue after `forceDrainAfterMs` without an ACK.            |
| `forceDrainAfterMs`       | number  | `45000`  | 2000–120000 ms | ACK silence that triggers the force drain.                            |
| `recoveryBurstEnabled`    | boolean | `true`   | —              | When ACKs resume after an outage, retransmits queued packets quickly. |
| `recoveryBurstSize`       | number  | `100`    | 10–1000        | Packets per recovery burst.                                           |
| `recoveryBurstIntervalMs` | number  | `200`    | 50–5000 ms     | Time between recovery bursts.                                         |
| `recoveryAckGapMs`        | number  | `4000`   | 500–120000 ms  | ACK silence needed before recovery bursts start.                      |

---

## Congestion Control (Client, Advanced/v3 Only)

Under `congestionControl`. Algorithm: [congestion-control.md](congestion-control.md). `minDeltaTimer` must be ≤ `maxDeltaTimer`.

| Field               | Type    | Default | Range         | Notes                                                                                    |
| ------------------- | ------- | ------- | ------------- | ---------------------------------------------------------------------------------------- |
| `enabled`           | boolean | `false` | —             | Adjusts the send interval (delta timer) automatically (AIMD).                            |
| `targetRTT`         | number  | `200`   | 50–2000 ms    | RTT above which the send rate is reduced. Set to the link's normal RTT.                  |
| `nominalDeltaTimer` | number  | `1000`  | 100–10000 ms  | Steady-state send interval. When unset at runtime, the `delta_timer.json` value is used. |
| `minDeltaTimer`     | number  | `100`   | 50–1000 ms    | Shortest allowed send interval.                                                          |
| `maxDeltaTimer`     | number  | `5000`  | 1000–30000 ms | Longest allowed send interval.                                                           |

---

## Connection Bonding (Client, Advanced/v3 Only)

Under `bonding`. Behavior: [bonding.md](bonding.md). Primary and backup must differ in address:port. Not allowed together with fleet sharing.

| Field                          | Type    | Default         | Range           | Notes                                                  |
| ------------------------------ | ------- | --------------- | --------------- | ------------------------------------------------------ |
| `enabled`                      | boolean | `false`         | —               | Turns on two-link bonding.                             |
| `mode`                         | string  | `"main-backup"` | `"main-backup"` | The only supported mode.                               |
| `primary.address`              | string  | `"127.0.0.1"`   | IP or hostname  | Primary link destination.                              |
| `primary.port`                 | integer | `4446`          | 1024–65535      | Primary link UDP port.                                 |
| `primary.interface`            | string  | —               | local IP        | Binds the outbound socket to this local interface.     |
| `backup.address`               | string  | `"127.0.0.1"`   | IP or hostname  | Backup link destination.                               |
| `backup.port`                  | integer | `4447`          | 1024–65535      | Backup link UDP port.                                  |
| `backup.interface`             | string  | —               | local IP        | Binds the outbound socket to this local interface.     |
| `failover.rttThreshold`        | number  | `500`           | 100–5000 ms     | Fails over when primary RTT exceeds this.              |
| `failover.lossThreshold`       | number  | `0.1`           | 0.01–0.5        | Fails over when primary loss ratio exceeds this.       |
| `failover.healthCheckInterval` | number  | `1000`          | 500–10000 ms    | Link health probe interval.                            |
| `failover.failbackDelay`       | number  | `30000`         | 5000–300000 ms  | Wait after the primary recovers before switching back. |
| `failover.heartbeatTimeout`    | number  | `5000`          | 1000–30000 ms   | A link with no response for this long is marked DOWN.  |

If `primary` or `backup` is missing at runtime, the client uses `udpAddress:udpPort` for the primary and `udpAddress:udpPort+1` for the backup.

---

## Alert Thresholds (Client, Advanced/v3 Only)

Under `alertThresholds`, one object per metric with `warning` and `critical`. `warning` must be ≤ `critical`. Ratio metrics take 0–1; the others must be > 0. Notifications are emitted only with `enableNotifications: true`, at `notifications.signalk-edge-link.<instanceId>.<metric>`.

| Metric           | Warning default | Critical default | Unit    |
| ---------------- | --------------- | ---------------- | ------- |
| `rtt`            | `300`           | `800`            | ms      |
| `packetLoss`     | `0.03`          | `0.1`            | ratio   |
| `retransmitRate` | `0.05`          | `0.15`           | ratio   |
| `jitter`         | `100`           | `300`            | ms      |
| `queueDepth`     | `100`           | `500`            | packets |

---

## Server-Specific Fields

| Field                        | Type    | Default | Range | Notes                                                                                                                                                                                        |
| ---------------------------- | ------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestFullStatusOnRestart` | boolean | `false` | —     | v3. On first contact after a server restart, the server sends each client a FULL_STATUS_REQUEST and the client replays its current Signal K state. The client replays at most once per 10 s. |

Server connections reject `congestionControl`, `bonding`, `alertThresholds` and `skipOwnData`, and drop the client-only fields above when the config is loaded.

---

## Fleet Sharing (Advanced/v3 only)

`fleetSharing` sends every client of one server the other clients' vessel data, over the link the client already opened. The server replies to the address and port the client's packets come from, so a vessel behind NAT needs no inbound port. A client never receives its own vessel. Both ends must enable it; with either end off, the link works as if the field were absent. Wire format: [protocol-v3-spec.md §15](protocol-v3-spec.md).

**NAT keepalive.** Fleet data reaches a vessel behind NAT only while the client's outbound packets keep its NAT mapping open. On an idle uplink those packets are the client's HEARTBEATs, so `heartbeatInterval` (default 25000 ms) must be shorter than the NAT's UDP mapping timeout. If the mapping moves to a new port, fleet data resumes after the client re-sends HELLO: after 30 s without an ACK, or 60 s without a fleet packet.

| Field                 | Mode   | Type    | Default                    | Range       | Notes                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------ | ------- | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | both   | boolean | `false`                    | —           | Server: share. Client: request.                                                                                                                                                                                                                                                                                                                           |
| `scope`               | server | string  | `"fleet"`                  | fleet / all | `fleet`: only vessels declared by clients of this server connection. `all`: every context in the server's tree, including AIS targets; the server's own vessel still only with `includeServerVessel`.                                                                                                                                                     |
| `includeServerVessel` | server | boolean | `false`                    | —           | Also share the server's own vessel (a hub that is itself a vessel).                                                                                                                                                                                                                                                                                       |
| `pathFilter`          | both   | object  | —                          | —           | `{ allow, deny }`, same pattern syntax as the connection `pathFilter`. Server: what is shared at all. Client: what this vessel asks for. The server applies both. `networking.edgeLink.*` is never shared. At most 32 patterns per list, 128 characters each; a client filter must also fit the encrypted HELLO field (validation says when it does not). |
| `maxBytesPerSec`      | both   | integer | server `8192`, client none | 256–1048576 | Fleet bytes per second per client. The client value is a requested ceiling; unset, the server's limit applies. The server uses the lower of the two. Over budget, only the newest value per path is sent. The server lowers a member's rate while its downlink loses packets and restores it when the loss stops (`fleet.minRateFactor`).                 |
| `batchIntervalMs`     | server | integer | `1000`                     | 100–10000   | How often coalesced fleet values are flushed.                                                                                                                                                                                                                                                                                                             |

Validation rejects `enabled: true` on `protocolVersion: 1`, on a client with `bonding.enabled`, and server-only keys (`scope`, `includeServerVessel`, `batchIntervalMs`) on a client.

Metadata (units, zones, display names) is sent with each path the first time a vessel receives it, and again when it changes.

Each client's own vessel ID (its `vessels.urn:…` context) is sent to the server encrypted inside HELLO. Data for that vessel is never sent back to it, and while fleet sharing is on, the server accepts a member's vessel only from that member's own session.

```json
{
  "serverType": "server",
  "udpPort": 4446,
  "protocolVersion": 3,
  "fleetSharing": { "enabled": true, "scope": "fleet", "maxBytesPerSec": 8192 }
}
```

```json
{
  "serverType": "client",
  "udpAddress": "hub.example.net",
  "udpPort": 4446,
  "protocolVersion": 3,
  "fleetSharing": { "enabled": true, "pathFilter": { "allow": ["navigation.*"] } }
}
```

A complete pair is in [`samples/v3-fleet-sharing.json`](../samples/v3-fleet-sharing.json).

**Every node must run 4.4.0 or later.** Earlier versions do not know `fleetSharing`: they drop it from the configuration when it is saved and show no Fleet card. A server without fleet sharing never answers the request, and the client reports `not-offered`.

**Relays.** A relay is one Signal K instance with a server connection and a client connection (see [Topologies](../README.md#topologies)). Each connection's `fleetSharing` applies to its own hop only:

- On the relay's **server** connection it shares the vessels connected to the relay with each other. With scope `fleet` that is only those vessels (plus the relay's own with `includeServerVessel`); with scope `all` it also shares every other vessel in the relay's tree, such as vessels the relay receives from upstream.
- On the relay's **client** connection it makes the relay a member of the upstream server's fleet, under the relay's own vessel ID. The relay receives the upstream fleet into its tree and does not send those vessels back upstream.
- The vessels behind the relay reach the upstream server as the relay's uplink data. They are not members there, so an upstream server with scope `fleet` does not share them with its other clients; scope `all` does. With scope `all`, the upstream server does not send the relay the vessels the relay itself uplinks, unless they are members of the upstream fleet.

---

## Runtime Configuration Files (Hot-Reload)

Client connections keep three JSON files that the dashboard and the API (`GET`/`POST /config/:filename`, see [api-reference.md](api-reference.md)) can change without a plugin restart. The plugin watches them (300 ms debounce) and reloads on change. Location:

```text
<signalk-data-dir>/plugin-config-data/signalk-edge-link/instances/<instanceId>/
```

`<instanceId>` is the slug of the connection `name`. Each file is created with the default shown below if it is missing.

### delta_timer.json

```json
{ "deltaTimer": 1000 }
```

| Field        | Type   | Default | Range        | Notes                                                                                                                                                                                                                                                  |
| ------------ | ------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deltaTimer` | number | `1000`  | 100–10000 ms | Batching and send interval. Out-of-range or missing values fall back to 1000 and are logged. With `congestionControl.enabled`, the controller changes the interval at runtime; `POST /delta-timer` sets a fixed value and pauses automatic adjustment. |

### subscription.json

Which Signal K paths are sent, and metadata streaming.

```json
{
  "context": "*",
  "subscribe": [{ "path": "navigation.*" }, { "path": "environment.wind.*" }],
  "meta": {
    "enabled": false,
    "intervalSec": 300,
    "includePathsMatching": null,
    "maxPathsPerPacket": 500
  }
}
```

| Field                       | Type         | Default             | Range         | Notes                                                                                                                                                               |
| --------------------------- | ------------ | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`                   | string       | `"*"`               | —             | `"*"` all vessels, `"vessels.self"` own vessel only.                                                                                                                |
| `subscribe`                 | array        | `[{ "path": "*" }]` | —             | `{ "path": "..." }` objects; `*` wildcards allowed.                                                                                                                 |
| `meta.enabled`              | boolean      | `false`             | —             | v3. Streams path metadata (units, descriptions, zones).                                                                                                             |
| `meta.intervalSec`          | number       | `300`               | 30–86400 s    | Full metadata snapshot interval.                                                                                                                                    |
| `meta.includePathsMatching` | string\|null | `null`              | max 256 chars | JavaScript regex; only matching paths are streamed. `null` = all subscribed paths. Patterns that do not compile or have a nested unbounded quantifier are rejected. |
| `meta.maxPathsPerPacket`    | number       | `500`               | 10–5000       | Paths per metadata snapshot packet.                                                                                                                                 |

### sentence_filter.json

Drops deltas from the listed NMEA 0183 sentence types before sending.

```json
{ "excludedSentences": ["GSV", "GSA", "VTG", "GLL"] }
```

| Field               | Type     | Default   | Range | Notes                                                                                                                                                                                                                 |
| ------------------- | -------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excludedSentences` | string[] | `["GSV"]` | —     | Sentence IDs, matched case-insensitively. Common choices: `GSV` (satellites in view, large and repetitive), `GSA` (DOP and active satellites), `VTG` (redundant if COG/SOG are sent), `GLL` (redundant with RMC/GGA). |

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
      "secretKey": "<64-char-hex-secret>",
      "protocolVersion": 1
    },
    {
      "name": "vessel-client",
      "serverType": "client",
      "udpAddress": "192.168.1.100",
      "udpPort": 4446,
      "secretKey": "<64-char-hex-secret>",
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
        "nakTimeout": 100,
        "maxNakRounds": 5
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

The validator runs on save and before a connection starts; the first violation is returned as an error. Besides the per-field ranges in the tables above:

- `serverType` must be `"server"` or `"client"`.
- `protocolVersion` must be 1 or 3 (or `"basic"` / `"advanced"`; legacy 2 becomes 3).
- `secretKey` must be one of the three accepted formats.
- No two server connections may share a `udpPort`.
- Clients require `udpAddress`; v1 clients also require `testAddress` and `testPort`.
- v3 clients must not include `testAddress`, `testPort` or `pingIntervalTime`.
- Server connections must not include `congestionControl`, `bonding`, `alertThresholds` or `skipOwnData`.
- `epochBoundAuth: true` requires `protocolVersion: 3` and `authenticatedHeaders` not `false`.
- `useValueDedup: true` and `useCompactDeltas: true` require `protocolVersion: 3`; `useCompactDeltas` also requires `useMsgpack: true`.
- `pathFilter` accepts only `allow` and `deny`; `pathThrottle` rules accept only `minIntervalMs` and `deadband`.
- Bonding: primary and backup must use different address:port pairs; `mode` must be `"main-backup"`.
- Reliability: `retransmitMinAge` ≤ `retransmitMaxAge`. Congestion control: `minDeltaTimer` ≤ `maxDeltaTimer`.
- Alert thresholds: only the five metrics listed; `warning` ≤ `critical`; ratio metrics 0–1, others > 0.
- Fleet sharing: see [Fleet Sharing](#fleet-sharing-advancedv3-only).

---

## Internal Constants

Defined in `src/foundation/constants.ts`. Not configurable; changing them needs a rebuild.

| Constant                     | Value    | Meaning                                         |
| ---------------------------- | -------- | ----------------------------------------------- |
| `MAX_SAFE_UDP_PAYLOAD`       | 1400 B   | UDP payload limit, to avoid fragmentation       |
| `BROTLI_QUALITY_HIGH`        | 6        | Default Brotli quality                          |
| `UDP_RETRY_MAX`              | 3        | Maximum UDP send retries                        |
| `UDP_RETRY_DELAY`            | 100 ms   | Base retry delay                                |
| `SMART_BATCH_SAFETY_MARGIN`  | 85%      | Target share of the payload limit per packet    |
| `SMART_BATCH_MAX_DELTAS`     | 50       | Maximum deltas per batch                        |
| `RATE_LIMIT_MAX_REQUESTS`    | 120      | Management API requests per minute per IP       |
| `BONDING_HEARTBEAT_TIMEOUT`  | 5000 ms  | Default for `failover.heartbeatTimeout`         |
| `MONITORING_ALERT_COOLDOWN`  | 60000 ms | Minimum time between repeated alerts            |
| `PACKET_CAPTURE_MAX_PACKETS` | 1000     | Packet capture buffer size                      |
| `FILE_WATCH_DEBOUNCE_DELAY`  | 300 ms   | Debounce for runtime configuration file changes |
