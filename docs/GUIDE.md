# Signal K Edge Link — Complete Guide

> Single authoritative reference for installation, configuration, all protocol versions, every tuning parameter, API endpoints, metrics, security, and developer internals.

![Data Connector Concept](assets/dataconnectorconcept.jpg)

---

## Table of Contents

1. [What It Does and Why](#1-what-it-does-and-why)
2. [System Architecture](#2-system-architecture)
3. [How Data Flows](#3-how-data-flows)
4. [Installation](#4-installation)
5. [Quick Start — Minimal Setup](#5-quick-start--minimal-setup)
6. [Protocol Versions In Depth](#6-protocol-versions-in-depth)
7. [Complete Configuration Reference](#7-complete-configuration-reference)
8. [Runtime Configuration Files (Hot-Reload)](#8-runtime-configuration-files-hot-reload)
9. [Congestion Control](#9-congestion-control)
10. [Connection Bonding (Dual-Link Failover)](#10-connection-bonding-dual-link-failover)
11. [Multi-Connection Setup](#11-multi-connection-setup)
12. [Encryption and Key Management](#12-encryption-and-key-management)
13. [Metrics Reference](#13-metrics-reference)
14. [REST API Reference](#14-rest-api-reference)
15. [Management API Auth and CLI](#15-management-api-auth-and-cli)
16. [Complete Example Configurations](#16-complete-example-configurations)
17. [Performance Tuning](#17-performance-tuning)
18. [Troubleshooting](#18-troubleshooting)
19. [Source Replication](#19-source-replication)
20. [Developer Reference](#20-developer-reference)

---

## 1. What It Does and Why

Signal K Edge Link transfers vessel navigation and sensor data between two Signal K server instances over encrypted UDP. It is built specifically for network paths where **bandwidth is limited, latency is variable, and packet loss happens** — cellular, satellite, and other WAN links.

### Why not use the built-in Signal K subscriptions?

Standard Signal K uses TCP/WebSocket subscriptions. These work well on reliable LAN connections but are poorly suited to:

- **Cellular roaming** — NAT mappings expire; connections drop silently
- **Satellite links** — High RTT and tiny bandwidth budgets; no adaptation
- **Multi-hop relay** — No mechanism to chain instances together
- **Bandwidth optimization** — No compression, no batching, no path deduplication

Signal K Edge Link solves each of these with UDP transport, Brotli compression, AES-256-GCM encryption, and (in v3, the Advanced mode) a reliability layer with ACK/NAK retransmission, congestion control, and dual-link failover.

### Protocol version at a glance

| Version           | Best for                                           | Key features                                                                                                                  |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **v1** (Basic)    | Stable local links, simplest setup                 | Encrypted UDP, Brotli compression. No retransmission or metrics.                                                              |
| **v3** (Advanced) | WAN / untrusted links (recommended for new setups) | v1 + ACK/NAK reliability, congestion control, bonding, rich monitoring, and HMAC-SHA256 authentication on all control packets |

**Recommendation:** Use **v3** for any new deployment; fall back to **v1** (Basic) only on trusted/private links where you want the absolute lowest overhead.

> **What happened to v2?** An earlier reliable-transport version (v2) used a CRC-only,
> unauthenticated control plane and was **removed in 3.0.0** because its control packets
> were forgeable. A stored `protocolVersion: 2` is accepted for config back-compat and
> silently coerced to `3`. Peers running pre-3.0.0 builds still speak v2 and cannot
> exchange data with v3 peers.

---

## 2. System Architecture

### Basic topology

```text
┌─────────────────────────────────┐           ┌─────────────────────────────────┐
│        VESSEL (at sea)          │           │        SHORE (server room)       │
│                                 │           │                                 │
│  ┌─────────────────────────┐    │           │    ┌─────────────────────────┐  │
│  │   Signal K Server       │    │           │    │   Signal K Server       │  │
│  │                         │    │           │    │                         │  │
│  │  ┌───────────────────┐  │    │  UDP/WAN  │    │  ┌───────────────────┐  │  │
│  │  │  Edge Link        │  │    │           │    │  │  Edge Link        │  │  │
│  │  │  CLIENT mode      │──┼────┼──────────►┼────┼──│  SERVER mode      │  │  │
│  │  │                   │  │    │ encrypted │    │  │                   │  │  │
│  │  │ • subscribes      │  │    │ compressed│    │  │ • receives        │  │  │
│  │  │ • batches deltas  │  │    │           │    │  │ • decrypts        │  │  │
│  │  │ • compresses      │  │    │           │    │  │ • injects deltas  │  │  │
│  │  │ • encrypts        │  │    │           │    │  │                   │  │  │
│  │  └───────────────────┘  │    │           │    │  └───────────────────┘  │  │
│  └─────────────────────────┘    │           │    └─────────────────────────┘  │
└─────────────────────────────────┘           └─────────────────────────────────┘
```

### Multi-hop / relay topology

One Signal K instance can run **both** a server and a client simultaneously — acting as a relay.

```text
  [Vessel A]                 [Relay / aggregator]              [Shore HQ]
  Client ─────UDP v3──────► Server  Client ─────UDP v3──────► Server
                             (relay instance)
  [Vessel B]
  Client ─────UDP v3──────►
```

### Dual-link (bonding) topology

```text
  [Vessel]                                      [Shore]
  Client                                        Server A (port 4446)
  ├─ Primary (LTE)    ─────UDP:4446───────────► (receives primary data)
  └─ Backup (Starlink)─────UDP:4447───────────► Server B (port 4447)
          ↑                                     (receives backup data)
     BondingManager
     monitors both links,
     switches on failure
```

---

## 3. How Data Flows

### Client outbound pipeline

```text
 Signal K local deltas
        │
        ▼
 ┌──────────────────┐
 │ Subscription     │  Subscribe to configured paths (or all paths)
 │ filter           │  Drop paths not in subscription.json
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ skipOwnData      │  (optional) Strip networking.edgeLink.* metrics
 │ filter           │  to avoid feedback loops
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Deduplication    │  1500 ms window — identical (context, source,
 │                  │  values) tuples sent only once per window
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Delta buffer     │  Accumulate deltas up to maxDeltasPerBatch
 │ + smart batching │  OR until deltaTimer fires (default 1000 ms)
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Serialize        │  JSON (default) or MessagePack (useMsgpack: true)
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Path dictionary  │  (optional) Replace long path strings with 2-byte
 │ encoding         │  numeric IDs — saves 10–20% per packet
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Brotli compress  │  Quality 6 — typically 5–21× compression ratio
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ AES-256-GCM      │  12-byte random IV prepended, 16-byte auth tag
 │ encrypt          │  appended → [IV][ciphertext][auth tag]
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Packet header    │  v3 only: prepend 15-byte binary header
 │ (v3)          │  with magic, version, type, flags, seq, CRC
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Retransmit queue │  v3: store copy for possible retransmission
 │ (v3)          │  (up to 5000 entries)
 └──────────┬───────┘
            │
            ▼
       UDP send ──────────────────────► remote server
```

### Server inbound pipeline

```text
       UDP receive ◄──────────────────── remote client
            │
            ▼
 ┌──────────────────┐
 │ Rate limit       │  v3: 200 DATA packets/sec per client IP
 │ per client       │  Prevents DoS; 5 sessions max per IP
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Parse header     │  v3: verify magic "SK", version, CRC-16
 │ (v3)          │  Silently discard on mismatch
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ AES-256-GCM      │  Verify auth tag — reject and count error
 │ decrypt          │  on authentication failure
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Brotli decompress│  Max 10 MB to prevent decompression bombs
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Path dictionary  │  (optional) Decode numeric IDs back to paths
 │ decode (v3)   │
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Deserialize      │  JSON.parse or MessagePack.decode
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Sequence check   │  v3: detect gaps, send NAK for missing seqs
 │ + ACK generation │  Send cumulative ACK every 100 ms
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Source normalize │  Resolve $source, strip edge-link internal refs,
 │                  │  split multi-source deltas
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ app.handleMessage│  Inject into local Signal K tree
 └──────────────────┘
```

---

## 4. Installation

### Option A — Signal K Plugin Manager (recommended for end users)

1. Open your Signal K server Admin UI (typically `http://your-signalk-host:3000`)
2. Navigate to **Server → Plugin Config**
3. Search for **Signal K Edge Link**
4. Click **Install**
5. Restart Signal K when prompted

### Option B — Manual install from source (developers)

```bash
cd ~/.signalk/node_modules
git clone https://github.com/KEGustafsson/signalk-edge-link.git
cd signalk-edge-link
npm install        # installs all dependencies including TypeScript
npm run build      # compiles TypeScript and builds the web UI
```

Restart Signal K after installation:

```bash
# systemd
sudo systemctl restart signalk
```

### Requirements

- Node.js 20.9.0 or later (`node --version`; matches `engines.node` in package.json / CI)
- UDP reachability from client to server on your chosen port
- Shared encryption key configured on both ends

---

## 5. Quick Start — Minimal Setup

### Step 1 — Configure the server (shore side)

On the **destination** Signal K instance:

1. Open **Server → Plugin Config → Signal K Edge Link**
2. Click **Add Connection**
3. Set **Connection Type** to **Server**
4. Fill in:

   | Field            | Value                            |
   | ---------------- | -------------------------------- |
   | Connection Name  | `shore-server`                   |
   | UDP Port         | `4446`                           |
   | Encryption Key   | `your-32-character-secret-key!!` |
   | Protocol Version | `3`                              |

5. Click **Save** and restart the plugin

### Step 2 — Configure the client (vessel side)

On the **source** Signal K instance:

1. Open **Server → Plugin Config → Signal K Edge Link**
2. Click **Add Connection**
3. Set **Connection Type** to **Client**
4. Fill in:

   | Field            | Value                            |
   | ---------------- | -------------------------------- |
   | Connection Name  | `vessel-client`                  |
   | Server Address   | `shore.example.com` (or IP)      |
   | UDP Port         | `4446`                           |
   | Encryption Key   | `your-32-character-secret-key!!` |
   | Protocol Version | `3`                              |

5. Click **Save** and restart the plugin

### Step 3 — Verify traffic

Open the runtime dashboard on either instance:

```text
http://<signalk-host>:3000/plugins/signalk-edge-link/
```

On the **client**, confirm `Deltas Sent` is increasing and encryption errors stays at 0.  
On the **server**, confirm `Deltas Received` is increasing and decryption errors stays at 0.

```bash
# API check
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq '{deltasSent:.stats.deltasSent,encErr:.stats.encryptionErrors}'
curl http://shore:3000/plugins/signalk-edge-link/metrics  | jq '{deltasRcvd:.stats.deltasReceived,decErr:.stats.encryptionErrors}'
```

---

## 6. Protocol Versions In Depth

### v1 — Simple Encrypted UDP

v1 is the simplest protocol. Every batch of deltas is compressed and encrypted and sent as a single UDP datagram. There is no reliability layer — lost packets are simply lost.

#### Wire format

```text
┌─────────────────────────────────────────────────────┐
│  [  12-byte random IV  ]                            │
│  [  AES-256-GCM ciphertext (Brotli-compressed       │
│     JSON or MessagePack delta batch)  ]             │
│  [  16-byte GCM auth tag  ]                         │
└─────────────────────────────────────────────────────┘
       Total overhead per packet: 28 bytes
```

The receiver identifies v1 packets because they **do not** start with the `SK` magic bytes used by v3.

#### When to use v1

- Stable, low-latency LAN connections
- When simplicity matters more than reliability
- When you need the absolute lowest overhead

#### v1 limitations

- No retransmission — packet loss is unrecovered
- No RTT measurement (uses external ping monitor instead)
- No congestion control or bonding
- Metadata transport requires a separate UDP port (`udpMetaPort`)

#### v1 configuration example

```json
{
  "connections": [
    {
      "name": "lan-link",
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

The `testAddress` / `testPort` / `pingIntervalTime` fields configure an external ping monitor for RTT estimation. These fields **must not** appear in v3 (Advanced) configs.

---

### v3 — Reliable, Authenticated Transport (Advanced)

v3 adds a 15-byte binary header to every packet, enabling sequence tracking, ACK/NAK retransmission, heartbeat-based RTT measurement, congestion control, and bonding. Every control packet additionally carries a 16-byte HMAC-SHA256 authentication tag keyed by the shared `secretKey`.

#### Packet header format

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Magic "SK" (0x534B)        |  Version(03)  |  Type         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Flags      |          Sequence Number (uint32, BE)          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Seq (cont.)  |       Payload Length (uint32, BE)             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| PLen (cont.)  |       CRC16-CCITT (bytes 0–12)  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Offset | Size | Field    | Description                                  |
| ------ | ---- | -------- | -------------------------------------------- |
| 0      | 2 B  | Magic    | `0x53 0x4B` ("SK") — identifies v3 packets   |
| 2      | 1 B  | Version  | `0x03` (v3)                                  |
| 3      | 1 B  | Type     | Packet type (see table below)                |
| 4      | 1 B  | Flags    | Feature flags (see table below)              |
| 5      | 4 B  | Sequence | Packet sequence number (uint32, big-endian)  |
| 9      | 4 B  | Length   | Payload length in bytes (uint32, big-endian) |
| 13     | 2 B  | CRC16    | CRC-CCITT checksum of header bytes 0–12      |

After the header comes the payload: `[12B IV][ciphertext][16B GCM auth tag]`

**Total overhead per packet: 15 (header) + 28 (crypto) = 43 bytes.**

#### Packet types

| Hex  | Name                | Direction       | Description                                            |
| ---- | ------------------- | --------------- | ------------------------------------------------------ |
| 0x01 | DATA                | Client → Server | Signal K delta batch (encrypted+compressed)            |
| 0x02 | ACK                 | Server → Client | Cumulative acknowledgement (4-byte sequence number)    |
| 0x03 | NAK                 | Server → Client | Negative acknowledgement (list of missing seq numbers) |
| 0x04 | HEARTBEAT           | Both directions | Keep-alive; used for RTT measurement                   |
| 0x05 | HELLO               | Client → Server | Session initiation with client metadata                |
| 0x06 | METADATA            | Client → Server | Signal K path metadata (units, descriptions, zones)    |
| 0x07 | META_REQUEST        | Server → Client | Server requests fresh metadata snapshot                |
| 0x08 | FULL_STATUS_REQUEST | Server → Client | Server requests full values snapshot replay            |

#### Feature flags (byte 4)

| Bit | Mask | Name            | Set when                         |
| --- | ---- | --------------- | -------------------------------- |
| 0   | 0x01 | COMPRESSED      | Payload is Brotli-compressed     |
| 1   | 0x02 | ENCRYPTED       | Payload is AES-256-GCM encrypted |
| 2   | 0x04 | MESSAGEPACK     | Payload is MessagePack-encoded   |
| 3   | 0x08 | PATH_DICTIONARY | Paths encoded as numeric IDs     |
| 4–7 | —    | Reserved        | Always 0                         |

Both peers must be configured identically for `useMsgpack` and `usePathDictionary`.

#### ACK/NAK handshake

```text
  Client                                 Server
    │                                      │
    │──── HELLO (version, clientId) ──────►│  Session established
    │                                      │
    │──── DATA (seq=0) ───────────────────►│
    │──── DATA (seq=1) ───────────────────►│
    │──── DATA (seq=2) ───────────────────►│
    │                                      │
    │◄─── ACK (cumSeq=2) ─────────────────│  All three received
    │                                      │
    │──── DATA (seq=3) ───────────────────►│
    │──── DATA (seq=5) ───────────────────►│  seq=4 lost in transit!
    │                                      │
    │◄─── NAK ([4]) ──────────────────────│  Gap detected
    │                                      │
    │──── DATA (seq=4, retransmit) ───────►│
    │                                      │
    │◄─── ACK (cumSeq=5) ─────────────────│  All caught up
    │                                      │
    │──── HEARTBEAT ──────────────────────►│  Keep-alive + RTT probe
    │◄─── HEARTBEAT ───────────────────────│
```

**Delivery guarantee:** > 99.9% at 5% random packet loss.

---

#### Authenticated control packets

Every **control packet** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST) carries a **16-byte HMAC-SHA256 authentication tag** appended after the payload:

| Packet    | Base payload      | On-the-wire payload                  |
| --------- | ----------------- | ------------------------------------ |
| ACK       | `uint32 ackedSeq` | `uint32 ackedSeq` + 16-byte HMAC tag |
| NAK       | N × `uint32 seq`  | N × `uint32 seq` + 16-byte HMAC tag  |
| HEARTBEAT | (empty)           | 16-byte HMAC tag only                |
| HELLO     | JSON payload      | JSON payload + 16-byte HMAC tag      |

The HMAC tag covers `header[0..12] ‖ payload`, keyed by the shared `secretKey`. The header CRC16 remains in place for fast corruption detection. DATA packets are unaffected — they are already authenticated by the AES-256-GCM auth tag.

#### Why this matters

Without control-packet authentication, any host that can reach the UDP port could forge a valid control packet:

- **Forged FULL_STATUS_REQUEST** — triggers a full snapshot replay (reflection amplifier)
- **Forged NAK** — causes spurious retransmissions
- **Forged HELLO** — creates a spurious server session

v3 closes all of these because forging requires knowledge of the shared secret. (This is why the earlier unauthenticated v2 control plane was removed in 3.0.0.)

#### Security comparison

| Property                      | v1 (Basic) | v3 (Advanced) |
| ----------------------------- | ---------- | ------------- |
| Data payload confidentiality  | ✓          | ✓             |
| Data payload integrity (GCM)  | ✓          | ✓             |
| Control packet authentication | —          | HMAC-SHA256 ✓ |
| Retransmission on loss        | —          | ✓             |
| Congestion control            | —          | ✓             |
| Bonding / failover            | —          | ✓             |
| Safe on untrusted networks    | partial    | **Yes**       |

**Both sides must run the same version. Upgrading one side without the other causes immediate link failure** — `malformedPackets` increments and no data flows.

#### v3 upgrade verification checklist

1. Set `protocolVersion: 3` on both client and server
2. Restart both peers simultaneously
3. Confirm data flow resumes — check `deltasSent` / `deltasReceived`
4. Confirm ACK/NAK traffic is present in `GET /metrics`
5. If the link does not recover, verify both sides use the same `protocolVersion` and `secretKey`

---

## 7. Complete Configuration Reference

Configuration lives in the plugin's settings under `connections` — an array where each entry is an independent link. A single node can have as many connections as needed. Legacy single-object flat config is automatically normalized to a one-item array on startup.

### 7.1 Top-level plugin fields

These sit outside `connections[]`, at the root of the plugin config:

| Field                       | Type    | Default | Description                                                                                                                                         |
| --------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managementApiToken`        | string  | `null`  | Shared secret protecting management API endpoints. Also set via env `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`.                                           |
| `requireManagementApiToken` | boolean | `false` | When `true`, management endpoints fail closed (HTTP 403) if no token is configured. Also via env `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN=true`. |

### 7.2 Common fields (client and server)

| Field                 | Type    | Default        | Description                                                                                                            |
| --------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                | string  | `"connection"` | Label shown in UI and logs. Used as directory name for runtime config files. Max 40 characters.                        |
| `serverType`          | string  | `"client"`     | `"client"` sends data; `"server"` receives data.                                                                       |
| `udpPort`             | integer | `4446`         | UDP port. Range 1024–65535. Must match on both ends.                                                                   |
| `udpMetaPort`         | integer | —              | Optional separate UDP port for v1 metadata packets. Ignored by v3 (which multiplex metadata on the main port).         |
| `secretKey`           | string  | — (required)   | AES-256 encryption key. Accepts 32-char ASCII, 64-char hex, or 44-char base64. Must match exactly on both ends.        |
| `stretchAsciiKey`     | boolean | `false`        | When `true`, runs a 32-char ASCII key through PBKDF2-SHA256 (600,000 iterations) before use. **Both ends must match.** |
| `protocolVersion`     | integer | `3`            | `1` (basic v1) or `3` (reliable v3). Legacy stored `2` is accepted and coerced to `3`; peers must match.               |
| `useMsgpack`          | boolean | `false`        | Serialize deltas as MessagePack instead of JSON. Saves ~15–25%. **Both ends must match.**                              |
| `usePathDictionary`   | boolean | `false`        | Replace Signal K path strings with 2-byte numeric IDs. Saves ~10–20%. **Both ends must match.**                        |
| `enableNotifications` | boolean | `false`        | Forward Signal K notification deltas over the link.                                                                    |
| `skipOwnData`         | boolean | `false`        | (Client only) Drop all `networking.edgeLink.*` metrics before forwarding — prevents feedback loops.                    |

### 7.3 Client transport fields

| Field                | Type    | Default       | Description                                                                                                               |
| -------------------- | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `udpAddress`         | string  | `"127.0.0.1"` | Hostname or IP address of the remote server. Required for client connections.                                             |
| `helloMessageSender` | integer | `60`          | Interval in **seconds** between HELLO keepalive messages. Keeps NAT/firewall mappings alive. Range 10–3600.               |
| `heartbeatInterval`  | integer | `25000`       | Interval in **ms** between HEARTBEAT probes (v3 only). Used for RTT measurement and NAT hole-punching. Range 1000–120000. |

### 7.4 v1 ping monitor fields (client, v1 only)

These fields **must not** appear in v3 configurations.

| Field              | Type    | Default       | Description                                       |
| ------------------ | ------- | ------------- | ------------------------------------------------- |
| `testAddress`      | string  | `"127.0.0.1"` | Host to probe for reachability (e.g., `8.8.8.8`). |
| `testPort`         | integer | `80`          | Port to probe (e.g., 53, 80, 443).                |
| `pingIntervalTime` | number  | `1`           | Probe frequency in **minutes**. Range 0.1–60.     |

### 7.5 Reliability — server mode (v3 only)

Nested under `reliability`:

| Field               | Type    | Default | Range (ms) | Description                                          |
| ------------------- | ------- | ------- | ---------- | ---------------------------------------------------- |
| `ackInterval`       | integer | `100`   | 20–5000    | How often the server emits a cumulative ACK.         |
| `ackResendInterval` | integer | `1000`  | 100–10000  | Re-send the last ACK after this interval of silence. |
| `nakTimeout`        | integer | `100`   | 20–5000    | Idle delay before sending NAK for a detected gap.    |

### 7.6 Reliability — client mode (v3 only)

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

### 7.7 Congestion control (client, v3 only)

Nested under `congestionControl`. See [Section 9](#9-congestion-control) for the full algorithm.

| Field               | Type    | Default | Range         | Description                                                                  |
| ------------------- | ------- | ------- | ------------- | ---------------------------------------------------------------------------- |
| `enabled`           | boolean | `false` | —             | Enable AIMD automatic delta timer adjustment.                                |
| `targetRTT`         | integer | `200`   | 50–2000 ms    | RTT above this level triggers rate reduction. Set to your link's normal RTT. |
| `nominalDeltaTimer` | integer | `1000`  | 100–10000 ms  | Starting send interval when congestion control is first enabled.             |
| `minDeltaTimer`     | integer | `100`   | 50–1000 ms    | Fastest allowed send rate.                                                   |
| `maxDeltaTimer`     | integer | `5000`  | 1000–30000 ms | Slowest allowed send rate under congestion.                                  |

### 7.8 Connection bonding (client, v3 only)

Nested under `bonding`. See [Section 10](#10-connection-bonding-dual-link-failover) for the full explanation.

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

### 7.9 Alert thresholds (client, v3 only)

Nested under `alertThresholds`. Each metric has `warning` and `critical` levels. When exceeded, a Signal K notification fires at `notifications.signalk-edge-link.<connectionName>.*`.

| Metric                            | Warning default | Critical default | Unit    |
| --------------------------------- | --------------- | ---------------- | ------- |
| `rtt.warning/critical`            | `300` / `800`   | ms               | ms      |
| `packetLoss.warning/critical`     | `0.03` / `0.10` | ratio 0–1        | ratio   |
| `retransmitRate.warning/critical` | `0.05` / `0.15` | ratio 0–1        | ratio   |
| `jitter.warning/critical`         | `100` / `300`   | ms               | ms      |
| `queueDepth.warning/critical`     | `100` / `500`   | packets          | packets |

### 7.10 Server-specific fields

| Field                        | Type    | Default | Description                                                                                                                                                                                                             |
| ---------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestFullStatusOnRestart` | boolean | `false` | (v3) When `true`, the server sends a FULL_STATUS_REQUEST to each client on first contact after a restart. The client replays its complete current Signal K state. Rate-limited to one replay per 10 seconds per client. |

### 7.11 Internal constants (source-level tuning)

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

---

## 8. Runtime Configuration Files (Hot-Reload)

Three JSON files can be edited or updated via the API **without restarting the plugin**. They are stored in:

```text
<signalk-data-dir>/plugin-config-data/signalk-edge-link/<connectionName>/
```

The plugin watches each file for changes (300 ms debounce) and reloads automatically. Access via:

- Per-connection: `GET|POST /plugins/signalk-edge-link/connections/:id/config/:filename`
- Legacy (first client): `GET|POST /plugins/signalk-edge-link/config/:filename`

### delta_timer.json

Overrides the delta send interval. When set, bypasses congestion control.

```json
{ "deltaTimer": 2000 }
```

| Field        | Type    | Default | Range        | Description                                                        |
| ------------ | ------- | ------- | ------------ | ------------------------------------------------------------------ |
| `deltaTimer` | integer | `1000`  | 100–10000 ms | Data batching interval. `null` or absent = use congestion control. |

Lower = more frequent sends, higher bandwidth, lower latency.  
Higher = less frequent sends, better compression ratio per packet.

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

**How metadata streaming works:** When enabled, the client forwards an initial full snapshot shortly after subscribing, coalesces live `updates[].meta[]` changes over a short debounce window, and re-broadcasts the full snapshot every `intervalSec`. A restarted server may also send `META_REQUEST` to demand an immediate snapshot.

**v1 caveat:** v1 has no packet-type byte, so metadata is transmitted on a separate UDP port (`udpMetaPort`). If `udpMetaPort` is not configured, metadata is a no-op on v1. v3 multiplex metadata on the main data port using packet type `0x06`.

### sentence_filter.json

Drops deltas originating from specific NMEA sentence types before forwarding. Useful on bandwidth-constrained links.

```json
{ "excludedSentences": ["GSV", "GSA", "VTG", "GLL"] }
```

| Field               | Type  | Description                                                       |
| ------------------- | ----- | ----------------------------------------------------------------- |
| `excludedSentences` | array | NMEA sentence type codes to drop (e.g. `"GSV"`, `"GSA"`, `"VTG"`) |

Common sentences to exclude: `GSV` (satellites in view — large, repetitive), `GSA` (DOP and active satellites), `VTG` (track/speed — redundant if COG/SOG forwarded separately), `GLL` (position — redundant with RMC/GGA).

---

## 9. Congestion Control

### Why it's needed

UDP has no built-in congestion feedback. Without adaptation, a fixed send rate on constrained links causes packet bursts, retransmit storms, and elevated latency.

### The AIMD algorithm

**Additive Increase, Multiplicative Decrease (AIMD)** — same class as TCP congestion control:

```text
Every 5 seconds, evaluate smoothed RTT and packet loss:

  ┌─────────────────────────────────────────────────────────────┐
  │  loss < 1% AND RTT < targetRTT     → deltaTimer × 0.95     │
  │                                      (5% faster)           │
  │  loss > 5% OR RTT > targetRTT×1.5  → deltaTimer × 1.50     │
  │                                      (50% slower)          │
  │  otherwise (moderate)              → no change             │
  │                                                             │
  │  Cap: max ±20% per step                                     │
  │  Inputs smoothed: value = 0.2 × new + 0.8 × prev (EMA)    │
  │  Bounds: minDeltaTimer ≤ timer ≤ maxDeltaTimer              │
  └─────────────────────────────────────────────────────────────┘
```

### Example timer behavior

```text
deltaTimer (ms)
 5000 ─────────────────────────────────────────────────── (max)
                                               ╭─ congestion spike ×1.5
 2000 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─╯
                                          ╭──╯
 1000 ──────────────────────────────╮────╯
                            ╭───────╯
  500 ──────────────────────╯  healthy ×0.95/step
  100 ─────────────────────────────────────────────── (min)
       t=0   t=5s  t=10s  t=15s  t=20s  t=25s  t=30s
```

### Worked example (targetRTT = 200 ms)

| Step  | RTT   | Loss | Decision                | Timer  |
| ----- | ----- | ---- | ----------------------- | ------ |
| t=0   | 45ms  | 0%   | Healthy                 | 950ms  |
| t=5s  | 55ms  | 0%   | Healthy                 | 903ms  |
| t=10s | 320ms | 0%   | Congested (RTT > 300ms) | 1354ms |
| t=15s | 280ms | 0%   | Neutral                 | 1354ms |
| t=20s | 90ms  | 0%   | Healthy                 | 1287ms |

### Configuration

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  }
}
```

### Checking state at runtime

```bash
curl http://localhost:3000/plugins/signalk-edge-link/congestion | jq .
```

```json
{
  "enabled": true,
  "manualMode": false,
  "currentDeltaTimer": 850,
  "avgRTT": 45.32,
  "avgLoss": 0.002,
  "targetRTT": 200,
  "minDeltaTimer": 100,
  "maxDeltaTimer": 5000,
  "adjustInterval": 5000,
  "maxAdjustment": 0.2
}
```

### Manual override

```bash
# Lock timer to 500 ms
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"value": 500}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer

# Re-enable automatic mode
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"mode": "auto"}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

### Tuning guide

| Symptom                         | Cause                                  | Fix                                              |
| ------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Timer always at `maxDeltaTimer` | `targetRTT` below link's actual RTT    | Increase `targetRTT` to match `avgRTT`           |
| Timer oscillates rapidly        | RTT hovering near threshold            | Increase `targetRTT` by 20–30% above typical RTT |
| Timer won't go below a value    | `minDeltaTimer` too high               | Lower `minDeltaTimer` (watch CPU)                |
| Controller not adapting         | `enabled: false` or `manualMode: true` | Check `GET /congestion`                          |

---

## 10. Connection Bonding (Dual-Link Failover)

### Failover state machine

```text
   ┌──────────────┐   RTT > rttThreshold
   │              │   OR loss > lossThreshold
   │   ACTIVE     │   OR link DOWN
   │   PRIMARY    ├─────────────────────────────────────────────►
   │              │
   └──────┬───────┘          ┌──────────────┐
          ▲                  │              │
          │                  │   ACTIVE     │
          │◄─────────────────┤   BACKUP     │
          │   ALL required:  │              │
          │   RTT < thresh×0.8               │
          │   loss < thresh×0.5              │
          │   failbackDelay elapsed          │
          │                  └──────────────┘
```

Health is monitored continuously via HEARTBEAT probes every `healthCheckInterval` (default 1000 ms). A link is marked DOWN after no response for `heartbeatTimeout` (default 5000 ms).

### Step-by-step configuration

**Vessel (client with bonding):**

```json
{
  "name": "vessel-bonded",
  "serverType": "client",
  "secretKey": "MySecretKey12345678901234567890",
  "protocolVersion": 3,
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "shore.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "shore.example.com",
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

**Shore (two server connections, one per port):**

```json
{
  "connections": [
    {
      "name": "shore-primary",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3
    },
    {
      "name": "shore-backup",
      "serverType": "server",
      "udpPort": 4447,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3
    }
  ]
}
```

### Threshold profiles

| Profile      | `rttThreshold` | `lossThreshold` | `failbackDelay` | When to use                            |
| ------------ | -------------- | --------------- | --------------- | -------------------------------------- |
| Aggressive   | 300 ms         | 5% (0.05)       | 15 s            | Stable backup, low-latency requirement |
| **Moderate** | **500 ms**     | **10% (0.10)**  | **30 s**        | **General offshore use (default)**     |
| Conservative | 800 ms         | 20% (0.20)      | 60 s            | Avoid flapping on variable links       |

### Monitoring and manual control

```bash
# Current bonding state
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .

# Manual failover (toggle primary ↔ backup)
curl -s -X POST -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding/failover | jq .

# Update thresholds
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"rttThreshold": 300, "lossThreshold": 0.05}' \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .
```

A Signal K notification fires at `notifications.signalk-edge-link.<connectionName>.linkFailover` (state `"alert"`, methods `visual` and `sound`) on every failover event.

---

## 11. Multi-Connection Setup

A single plugin instance runs multiple connections concurrently. Each runs independently with its own UDP socket, retransmit queue, congestion controller, and metrics.

### Example: relay node (one server + two clients)

```json
{
  "connections": [
    {
      "name": "from-vessel-a",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "KeyForVesselA1234567890123456",
      "protocolVersion": 3
    },
    {
      "name": "to-shore-hq",
      "serverType": "client",
      "udpAddress": "hq.example.com",
      "udpPort": 4450,
      "secretKey": "KeyForShoreHQ1234567890123456",
      "protocolVersion": 3
    },
    {
      "name": "to-backup-server",
      "serverType": "client",
      "udpAddress": "backup.example.com",
      "udpPort": 4451,
      "secretKey": "KeyForBackup123456789012345678",
      "protocolVersion": 3
    }
  ]
}
```

Each connection has its own encryption key, UDP port, retransmit queue, congestion state, metrics, alert thresholds, and runtime config files under `<dataDir>/signalk-edge-link/<connectionName>/`.

---

## 12. Encryption and Key Management

### Key formats

| Format             | Length | Example                                                             | Notes                                                       |
| ------------------ | ------ | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| **32-char ASCII**  | 32 B   | `MySecretKey12345678901234567890`                                   | Easy to type; use `stretchAsciiKey: true` for full security |
| **64-char hex**    | 32 B   | `a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1` | Full 256-bit entropy directly                               |
| **44-char base64** | 32 B   | `o/HitLXG8AmQEjRWeJCrzvEjRZVwmkrN5TI9Xabc12s=`                      | Full 256-bit entropy directly                               |

### Generating a secure key

```bash
# 64-character hex (recommended)
openssl rand -hex 32

# 44-character base64
openssl rand -base64 32

# 32-character ASCII (use with stretchAsciiKey: true)
openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
```

### Key stretching (stretchAsciiKey)

A 32-character ASCII key has ~208 bits of raw entropy. Setting `stretchAsciiKey: true` routes the key through **PBKDF2-SHA256** (600,000 iterations, salt `signalk-edge-link-v1`) before use, restoring full 256-bit AES strength.

**Both peers must have the same `stretchAsciiKey` setting.** A mismatch causes every packet to fail authentication silently.

### Security properties

| Property                      | Status     | Detail                                                                |
| ----------------------------- | ---------- | --------------------------------------------------------------------- |
| Data confidentiality          | ✓ Strong   | AES-256-GCM                                                           |
| Data integrity                | ✓ Strong   | GCM auth tag (16 bytes)                                               |
| Control packet authentication | v3 only    | HMAC-SHA256 on every control packet (v1 Basic has no control packets) |
| Forward secrecy               | ✗ None     | Same pre-shared key for lifetime of connection                        |
| Client authentication         | ✗ None     | Any holder of the key can connect                                     |
| Compression side-channel      | ✗ Low risk | Brotli before encryption — size observable                            |

### Key rotation procedure

There is no online key rotation. To rotate:

1. Update `secretKey` on both ends simultaneously
2. Restart the plugin on both ends
3. During the transition, packets encrypted with the old key are dropped

### Firewall hardening

```bash
# UFW — allow only from known vessel IP
ufw allow from <VESSEL_IP> to any port 4446 proto udp
ufw deny 4446/udp

# iptables
iptables -A INPUT -p udp --dport 4446 -s <VESSEL_IP> -j ACCEPT
iptables -A INPUT -p udp --dport 4446 -j DROP

# nftables
nft add rule inet filter input ip saddr <VESSEL_IP> udp dport 4446 accept
nft add rule inet filter input udp dport 4446 drop
```

If the vessel IP is dynamic (cellular), restrict by the operator's APN subnet, or deploy a VPN.

### Known limitations

- **No forward secrecy** — compromise of the key allows decryption of all captured past traffic
- **Compression side-channel** — CRIME/BREACH class; low risk for maritime telemetry
- **No client identity** — any party with the shared key can send and receive

---

## 13. Metrics Reference

Metrics are exposed via the REST API, Signal K paths, and Prometheus.

### 13.1 Core transport metrics

These counters and gauges appear in `GET /metrics` under `stats` and `bandwidth`.

| Metric                 | Unit    | Description                                                           |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `deltasSent`           | count   | Total Signal K delta batches sent (client mode)                       |
| `deltasReceived`       | count   | Total delta batches received and injected into Signal K (server mode) |
| `bandwidth.packetsOut` | count   | Total UDP packets sent                                                |
| `bandwidth.packetsIn`  | count   | Total UDP packets received                                            |
| `bytesOut`             | bytes   | Compressed + encrypted bytes sent                                     |
| `bytesIn`              | bytes   | Compressed + encrypted bytes received                                 |
| `bytesOutRaw`          | bytes   | Uncompressed payload bytes (before Brotli)                            |
| `compressionRatio`     | percent | `(1 − bytesOut / bytesOutRaw) × 100` — higher is better               |
| `rateOut`              | B/s     | Current outbound byte rate (smoothed)                                 |
| `rateIn`               | B/s     | Current inbound byte rate (smoothed)                                  |
| `avgPacketSize`        | bytes   | Mean UDP payload size after compression                               |
| `compressionErrors`    | count   | Brotli compress/decompress failures                                   |
| `encryptionErrors`     | count   | AES-GCM encrypt/decrypt failures (key mismatch shows up here)         |
| `udpSendErrors`        | count   | UDP socket send failures                                              |
| `udpRetries`           | count   | Packets that required at least one UDP retry                          |
| `subscriptionErrors`   | count   | Signal K subscription setup failures                                  |
| `malformedPackets`     | count   | Packets dropped due to invalid format or CRC mismatch                 |

**Interpretation:**

- `encryptionErrors > 0` almost always means the `secretKey` does not match between peers
- `compressionRatio` below 70% suggests short delta batches — increase `deltaTimer` for better batching
- `malformedPackets > 0` with no key change usually means a protocol version mismatch

### 13.2 Reliability metrics (v3 only)

From `GET /metrics` under `networkQuality`:

| Metric                | Unit  | Description                                                      |
| --------------------- | ----- | ---------------------------------------------------------------- |
| `acksSent`            | count | ACK packets sent by the server                                   |
| `naksSent`            | count | NAK packets sent to request retransmission                       |
| `retransmissions`     | count | Data packets retransmitted after a NAK or timeout                |
| `duplicatePackets`    | count | Packets received with a seq number already seen (safely dropped) |
| `dataPacketsReceived` | count | Total data packets accepted (excludes duplicates)                |

**Interpretation:**

- `retransmissions / dataPacketsReceived` < 1% is healthy
- Rising `naksSent` with low `acksSent` indicates one-way UDP — check bidirectional reachability
- `duplicatePackets > 0` is normal on unreliable links; duplicates are safely discarded

### 13.3 Link quality metrics

Returned by `GET /network-metrics` and embedded in `GET /metrics` under `networkQuality`:

| Metric           | Unit  | Typical range | Warning  | Critical | Description                                      |
| ---------------- | ----- | ------------- | -------- | -------- | ------------------------------------------------ |
| `rtt`            | ms    | 10–200 ms     | > 300 ms | > 800 ms | Round-trip time from heartbeat probes            |
| `jitter`         | ms    | 0–50 ms       | > 100 ms | > 300 ms | RTT variance (standard deviation)                |
| `packetLoss`     | ratio | 0–0.02        | > 0.03   | > 0.10   | Fraction of packets lost in recent window        |
| `retransmitRate` | ratio | 0–0.02        | > 0.05   | > 0.15   | Fraction of sent packets that were retransmitted |
| `queueDepth`     | count | 0–20          | > 100    | > 500    | Pending retransmissions in send queue            |
| `linkQuality`    | 0–100 | 85–100        | < 70     | < 50     | Composite score (RTT + loss + jitter + queue)    |

**linkQuality score bands:**

| Score  | Status    | Implication                                         |
| ------ | --------- | --------------------------------------------------- |
| 90–100 | Excellent | Low RTT, minimal loss                               |
| 70–89  | Good      | Acceptable for most use cases                       |
| 50–69  | Degraded  | Congestion control and bonding failover recommended |
| < 50   | Poor      | High loss or latency; data delivery unreliable      |

### 13.4 Smart batching metrics

From `GET /metrics` under `smartBatching` (client mode only):

| Metric              | Unit  | Description                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `earlySends`        | count | Batches sent before `deltaTimer` because the packet reached the size limit |
| `timerSends`        | count | Batches sent on the normal timer cadence                                   |
| `oversizedPackets`  | count | Packets that exceeded `MAX_SAFE_UDP_PAYLOAD` (should always be 0)          |
| `avgBytesPerDelta`  | bytes | Average compressed size per delta object                                   |
| `maxDeltasPerBatch` | count | Largest batch seen in the current session                                  |

**Interpretation:**

- `earlySends / (earlySends + timerSends)` > 20% means you are generating data faster than the current `deltaTimer` can drain — increase `deltaTimer` or filter more paths
- `oversizedPackets > 0` is a bug unless you have modified `MAX_SAFE_UDP_PAYLOAD`

### 13.5 Error categories

The `errorCounts` object in `GET /status` groups errors for rapid triage:

| Category             | Description                          |
| -------------------- | ------------------------------------ |
| `udpSendErrors`      | Socket-level send failures           |
| `compressionErrors`  | Brotli codec errors                  |
| `encryptionErrors`   | AES-GCM authentication or key errors |
| `subscriptionErrors` | Signal K subscription failures       |

`recentErrors` provides the last few timestamped error entries for quick inspection without consulting server logs.

### 13.6 Bonding metrics

When bonding is enabled, per-link metrics are included in `GET /bonding`:

| Metric               | Description                                   |
| -------------------- | --------------------------------------------- |
| `rtt` (per link)     | Heartbeat-measured RTT for each link          |
| `loss` (per link)    | Packet loss rate for each link                |
| `quality` (per link) | Composite quality score (0–100) for each link |
| `heartbeatsSent`     | Probe count since startup                     |
| `heartbeatResponses` | Responses received (diff = missed probes)     |

### 13.7 Management API auth telemetry

`GET /status` and `GET /metrics` include a `managementAuth` block **only when a `managementApiToken` is configured** (in open-access mode it is omitted, and `/prometheus` likewise omits the management-auth metrics):

| Field      | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `total`    | Total management auth decisions since route registration                |
| `allowed`  | Decisions that allowed the request                                      |
| `denied`   | Decisions that rejected the request                                     |
| `byReason` | Counts by bounded reason: `open_access`, `valid_token`, `invalid_token` |
| `byAction` | Counts by bounded route action: `status.read`, `metrics.read`, etc.     |

Intentionally excluded: token values, transport secrets, client addresses, user agents, raw request paths.

### 13.8 Signal K paths published

| Signal K path                                   | Type         | Unit    | Description                    |
| ----------------------------------------------- | ------------ | ------- | ------------------------------ |
| `networking.modem.rtt`                          | number       | seconds | v1 external ping RTT           |
| `networking.edgeLink.rtt`                       | number       | ms      | v3 heartbeat RTT               |
| `networking.edgeLink.jitter`                    | number       | ms      | RTT variance                   |
| `networking.edgeLink.packetLoss`                | number       | ratio   | Packet loss (0–1)              |
| `networking.edgeLink.linkQuality`               | number       | 0–100   | Composite link quality         |
| `networking.edgeLink.queueDepth`                | number       | packets | Retransmit queue depth         |
| `networking.edgeLink.retransmissions`           | number       | count   | Retransmitted packets          |
| `networking.edgeLink.sequenceNumber`            | number       | —       | Last published sequence number |
| `networking.edgeLink.bandwidth.upload`          | number       | B/s     | Outbound throughput            |
| `networking.edgeLink.bandwidth.download`        | number       | B/s     | Inbound throughput             |
| `networking.edgeLink.packetsPerSecond.sent`     | number       | pkt/s   | Outbound packet rate           |
| `networking.edgeLink.packetsPerSecond.received` | number       | pkt/s   | Inbound packet rate            |
| `networking.edgeLink.compressionRatio`          | number       | ratio   | Compression ratio              |
| `networking.edgeLink.activeLink`                | string       | —       | Active bonded link name        |
| `networking.edgeLink.links.<link>.status`       | string       | —       | Per-link status                |
| `networking.edgeLink.links.<link>.rtt`          | number       | ms      | Per-link RTT                   |
| `networking.edgeLink.links.<link>.loss`         | number       | ratio   | Per-link loss ratio            |
| `networking.edgeLink.links.<link>.quality`      | number       | 0–100   | Per-link quality score         |
| `notifications.signalk-edge-link.<name>.*`      | notification | —       | Alert events                   |

When an instance ID is configured, the `networking.edgeLink.*` paths are namespaced as `networking.edgeLink.<instanceId>.*`.

### 13.9 Prometheus metrics

Full list exported by `GET /prometheus`:

| Metric                                             | Type    | Description                                                                                                                                                    |
| -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signalk_edge_link_uptime_seconds`                 | gauge   | Plugin uptime                                                                                                                                                  |
| `signalk_edge_link_deltas_sent_total`              | counter | Total deltas sent                                                                                                                                              |
| `signalk_edge_link_deltas_received_total`          | counter | Total deltas received                                                                                                                                          |
| `signalk_edge_link_udp_send_errors_total`          | counter | UDP send errors                                                                                                                                                |
| `signalk_edge_link_bytes_out_total`                | counter | Compressed bytes sent                                                                                                                                          |
| `signalk_edge_link_bytes_in_total`                 | counter | Compressed bytes received                                                                                                                                      |
| `signalk_edge_link_bytes_out_raw_total`            | counter | Raw bytes sent (before compression)                                                                                                                            |
| `signalk_edge_link_packets_out_total`              | counter | Packets sent                                                                                                                                                   |
| `signalk_edge_link_packets_in_total`               | counter | Packets received                                                                                                                                               |
| `signalk_edge_link_bandwidth_rate_out_bytes`       | gauge   | Outbound bytes/s                                                                                                                                               |
| `signalk_edge_link_bandwidth_rate_in_bytes`        | gauge   | Inbound bytes/s                                                                                                                                                |
| `signalk_edge_link_compression_ratio_percent`      | gauge   | Compression ratio                                                                                                                                              |
| `signalk_edge_link_rtt_milliseconds`               | gauge   | Round-trip time                                                                                                                                                |
| `signalk_edge_link_jitter_milliseconds`            | gauge   | Jitter                                                                                                                                                         |
| `signalk_edge_link_retransmissions_total`          | counter | Retransmissions                                                                                                                                                |
| `signalk_edge_link_queue_depth`                    | gauge   | Retransmit queue depth                                                                                                                                         |
| `signalk_edge_link_packet_loss_rate`               | gauge   | Packet loss ratio                                                                                                                                              |
| `signalk_edge_link_link_quality_score`             | gauge   | Link quality (0–100)                                                                                                                                           |
| `signalk_edge_link_bonding_active_link`            | gauge   | Active link indicator (1=primary, 2=backup)                                                                                                                    |
| `signalk_edge_link_bonding_link_rtt_milliseconds`  | gauge   | Per-link RTT (label: `link`)                                                                                                                                   |
| `signalk_edge_link_bonding_link_loss_rate`         | gauge   | Per-link loss (label: `link`)                                                                                                                                  |
| `signalk_edge_link_bonding_link_quality`           | gauge   | Per-link quality (label: `link`)                                                                                                                               |
| `signalk_edge_link_management_auth_requests_total` | counter | Management auth decisions (labels: `decision`, `reason`, `action`). Exported **only when a `managementApiToken` is configured** (omitted in open-access mode). |

Per-instance transport metrics include a `mode` label (`"client"` or `"server"`).

**Prometheus scrape configuration:**

```yaml
scrape_configs:
  - job_name: "signalk-edge-link"
    scrape_interval: 15s
    metrics_path: "/plugins/signalk-edge-link/prometheus"
    static_configs:
      - targets: ["signalk-server:3000"]
```

Build a Grafana dashboard from the Prometheus metrics exposed at `/prometheus` (no dashboard JSON is bundled with the plugin).

---

## 14. REST API Reference

**Base path:** `/plugins/signalk-edge-link`  
**Rate limit:** 120 requests/minute/IP → HTTP 429  
**API version tracked (current: 3.0.1)** — for endpoint changes between releases, see `docs/pr-records/`

### 14.1 Core data endpoints

#### GET /metrics

Returns comprehensive real-time statistics. Available in client and server mode.

```json
{
  "uptime": { "milliseconds": 3600000, "formatted": "1h 0m 0s" },
  "mode": "client",
  "stats": {
    "deltasSent": 12345,
    "deltasReceived": 0,
    "udpSendErrors": 0,
    "compressionErrors": 0,
    "encryptionErrors": 0
  },
  "status": { "readyToSend": true, "deltasBuffered": 5 },
  "bandwidth": {
    "bytesOut": 524288,
    "bytesOutRaw": 10485760,
    "packetsOut": 1234,
    "rateOut": 145.6,
    "compressionRatio": 95.0,
    "avgPacketSize": 425,
    "history": []
  },
  "smartBatching": {
    "earlySends": 50,
    "timerSends": 1184,
    "oversizedPackets": 0,
    "avgBytesPerDelta": 180,
    "maxDeltasPerBatch": 6
  },
  "networkQuality": {
    "rtt": 45,
    "jitter": 12,
    "retransmissions": 3,
    "queueDepth": 0,
    "acksSent": 0,
    "naksSent": 0,
    "linkQuality": 92
  },
  "sourceReplication": {
    "metrics": { "upserts": 42, "noops": 101, "missingIdentity": 2, "conflicts": 7 }
  },
  "managementAuth": {
    "total": 42,
    "allowed": 40,
    "denied": 2,
    "byReason": { "open_access": 10, "valid_token": 30, "invalid_token": 2 }
  }
}
```

#### GET /network-metrics

Current network quality. Available in client and server mode.

```json
{
  "rtt": 45,
  "jitter": 12,
  "retransmissions": 3,
  "queueDepth": 0,
  "acksSent": 0,
  "naksSent": 0,
  "linkQuality": 92,
  "timestamp": 1707321234567
}
```

#### GET /sources

Server source-replication entries. Auth required (`sources.read`).

```json
{
  "schemaVersion": 1,
  "size": 2,
  "sources": [
    {
      "identity": { "label": "N2K depth", "type": "NMEA2000" },
      "firstSeenAt": "2026-04-27T00:00:00.000Z",
      "lastSeenAt": "2026-04-27T00:00:01.000Z",
      "provenance": { "lastUpdatedBy": "source" },
      "metadata": {}
    }
  ]
}
```

`GET /metrics` includes only `sourceReplication.metrics` counters. `GET /sources` returns the full registry. See [Section 19](#19-source-replication) for the schema contract.

#### GET /paths

Signal K path dictionary with categorized paths.

```json
{
  "total": 172,
  "categories": {
    "navigation": { "paths": ["navigation.position", "..."] },
    "environment": { "paths": ["environment.wind.speedApparent", "..."] }
  }
}
```

### 14.2 Configuration endpoints

#### GET /config/:filename

Read a runtime config file. Valid filenames: `delta_timer.json`, `subscription.json`, `sentence_filter.json`. Client mode only.

#### POST /config/:filename

Update a runtime config file. Changes take effect immediately via hot-reload. Client mode only. Body: JSON. Returns `200` on success.

#### GET /plugin-config

Read current plugin configuration. `secretKey` values are redacted as `[redacted]`.

```json
{
  "success": true,
  "configuration": {
    "connections": [
      { "name": "shore-server", "serverType": "server", "udpPort": 4446, "secretKey": "[redacted]" }
    ]
  }
}
```

#### POST /plugin-config

Update plugin configuration. Triggers a plugin restart to apply changes.

Required per connection: `serverType`, `udpPort`, `secretKey`.  
Additional required for client mode: `udpAddress`.  
Submitting `[redacted]` for `secretKey` keeps the stored secret unchanged for that connection slot.

```json
{ "success": true, "message": "Configuration saved. Plugin restarting...", "restarting": true }
```

**Errors:** `400` validation failure, `503` restart handler unavailable.

#### GET /plugin-schema

Returns the RJSF-compatible JSON schema for the plugin configuration UI.

### 14.3 Congestion control endpoints

#### GET /congestion

Current congestion control state. Client mode only. (Response shown in [Section 9](#9-congestion-control).)

#### POST /delta-timer

Manually set or clear the delta timer. Client mode only.

```json
{ "value": 500 }
```

Value: 100–10000 ms. Re-enable auto mode: `{ "mode": "auto" }`.

```json
{ "deltaTimer": 500, "mode": "manual" }
```

### 14.4 Bonding endpoints

#### GET /bonding

Current bonding state including per-link health. Client mode only (when bonding enabled).

```json
{
  "enabled": true,
  "mode": "main-backup",
  "activeLink": "primary",
  "lastFailoverTime": 0,
  "failoverThresholds": { "rttThreshold": 500, "lossThreshold": 0.1, "failbackDelay": 30000 },
  "links": {
    "primary": {
      "status": "active",
      "rtt": 45,
      "loss": 0.01,
      "quality": 95,
      "heartbeatsSent": 120,
      "heartbeatResponses": 118
    },
    "backup": {
      "status": "standby",
      "rtt": 120,
      "loss": 0.02,
      "quality": 85,
      "heartbeatsSent": 120,
      "heartbeatResponses": 116
    }
  }
}
```

#### POST /bonding/failover

Manually trigger failover (toggle primary ↔ backup). Client mode only.

```json
{ "success": true, "activeLink": "backup" }
```

#### POST /bonding

Update failover threshold settings across all bonding-enabled instances. Unsupported keys or out-of-range values return `400`.

### 14.5 Monitoring endpoints

#### GET /monitoring/packet-loss

Packet loss heatmap (5-second buckets, 60 buckets = 5 minutes).

```json
{
  "heatmap": [{ "timestamp": 1707321230000, "total": 100, "lost": 2, "lossRate": 0.02 }],
  "summary": { "overallLossRate": 0.01, "maxLossRate": 0.05, "trend": "stable" }
}
```

Trend values: `"stable"`, `"improving"`, `"worsening"`.

#### GET /monitoring/path-latency

Per-path latency with percentile statistics. Query param: `limit` (default 20).

```json
{
  "paths": [
    {
      "path": "navigation.position",
      "sampleCount": 50,
      "avg": 1.23,
      "p50": 1.1,
      "p95": 3.2,
      "p99": 4.8,
      "lastUpdate": 1707321234567
    }
  ]
}
```

#### GET /monitoring/retransmissions

Retransmission rate time series. Query param: `limit`.

```json
{
  "chartData": [
    {
      "timestamp": 1707321230000,
      "rate": 0.02,
      "retransmitsPerSec": 1.5,
      "periodPackets": 100,
      "periodRetransmissions": 2
    }
  ],
  "summary": { "avgRate": 0.015, "maxRate": 0.05, "currentRate": 0.02 }
}
```

#### GET /monitoring/alerts

Current alert thresholds and any active alerts.

```json
{
  "thresholds": {
    "rtt": { "warning": 300, "critical": 800 },
    "packetLoss": { "warning": 0.03, "critical": 0.1 }
  },
  "activeAlerts": {
    "rtt": { "metric": "rtt", "level": "warning", "value": 350, "threshold": 300 }
  }
}
```

#### POST /monitoring/alerts

Update alert thresholds. Changes take effect immediately; persisted to plugin options within 1 second.

```json
{ "metric": "rtt", "warning": 200, "critical": 600 }
```

Alert cooldown is 60 seconds. Notifications fire at `notifications.signalk-edge-link.<instanceId>.<metric>`.

#### GET /monitoring/inspector

Packet-inspector statistics — a plain JSON snapshot returned by `GET` (there is no WebSocket/live-stream endpoint).

```json
{ "enabled": true, "packetsInspected": 5000, "clientsConnected": 1 }
```

#### GET /prometheus

Prometheus text format. See [Section 13.9](#139-prometheus-metrics) for full metric list.

### 14.6 Packet capture endpoints

#### POST /capture/start / POST /capture/stop

Start or stop packet capture. Packets stored in circular buffer (max 1000 packets).

#### GET /capture

Capture statistics: `{ "enabled": true, "captured": 500, "dropped": 0, "buffered": 500 }`

#### GET /capture/export

Export as `.pcap` file (libpcap format, DLT_USER0 link type). Open in Wireshark.

### 14.7 Status and instance management endpoints

Auth behavior for all endpoints in this section: if `managementApiToken` is configured, a valid token must be provided. Headers accepted: `X-Edge-Link-Token`, `Authorization: Bearer`, `X-Management-Token` (legacy). Returns `401` on invalid token, `403` when token is required but not configured.

#### GET /status

Aggregated health summary across all running instances.

```json
{
  "healthyInstances": 1,
  "totalInstances": 2,
  "instances": [
    {
      "id": "shore-server",
      "name": "Shore Server",
      "healthy": true,
      "status": "Server listening on port 4446",
      "lastError": null,
      "errorCounts": { "udpSendErrors": 0 },
      "recentErrors": []
    }
  ],
  "managementAuth": { "total": 42, "allowed": 40, "denied": 2 }
}
```

**Errors:** `401` unauthorized, `503` when plugin not started.

#### GET /instances

Lists instance records with optional state filtering and pagination.

Query params: `state` (e.g., `running`), `limit`, `page`.

Without `limit`: returns a plain array. With `limit`: returns `{ items, pagination }`.

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "protocolVersion": 3,
    "state": "Ready",
    "currentLink": "primary",
    "metrics": { "deltasSent": 1234, "deltasReceived": 0, "udpSendErrors": 0 }
  }
]
```

**Errors:** `400` invalid pagination values, `401` unauthorized.

#### GET /instances/:id

Detailed runtime, network, bonding, metrics, and config view for one instance.

```json
{
  "id": "shore-server",
  "name": "Shore Server",
  "mode": "server",
  "protocolVersion": 3,
  "state": "Server listening on port 4446",
  "readyToSend": true,
  "currentLink": "primary",
  "network": { "rtt": 0, "jitter": 0, "packetLoss": 0 },
  "metrics": { "deltasSent": 1234, "deltasReceived": 0 },
  "bonding": { "enabled": false },
  "config": {
    "name": "Shore Server",
    "serverType": "server",
    "udpPort": 4446,
    "secretKey": "[redacted]"
  }
}
```

**Errors:** `401` unauthorized, `404` instance not found.

#### POST /instances

Create a new instance. Triggers a plugin restart. Returns `201` on success.

Required fields: `name`, `serverType`, `udpPort`, `secretKey`.  
Additional required for client: `udpAddress`.

**Errors:** `400` validation failure, `401` unauthorized, `503` restart handler unavailable.

#### PUT /instances/:id

Patch one instance configuration. Triggers a plugin restart. Returns `200` on success.

Updatable: `name`, `protocolVersion`, `useMsgpack`, `usePathDictionary`, `enableNotifications`, `udpAddress`, `helloMessageSender`, `reliability`, `congestionControl`, `bonding`, `alertThresholds`.

**Not updatable via this endpoint:** `serverType`, `udpPort`, `secretKey`.

**Errors:** `400` (unsupported field, validation), `401`, `404`, `503`.

#### DELETE /instances/:id

Delete an instance. Triggers a plugin restart.

**Errors:** `400` if this would leave zero configured instances, `401`, `404`, `503`.

#### GET /connections

List all active connections with status.

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "type": "server",
    "port": 4446,
    "protocolVersion": 3,
    "status": "Server listening on port 4446",
    "healthy": true
  }
]
```

### 14.8 Per-connection endpoints

These mirror the global endpoints but are scoped to a specific connection. `:id` is the slugified connection name (e.g., `shore-server`).

| Endpoint                                          | Auth                         | Available in |
| ------------------------------------------------- | ---------------------------- | ------------ |
| `GET /connections/:id/metrics`                    | `connection-monitoring.read` | Both         |
| `GET /connections/:id/network-metrics`            | `connection-monitoring.read` | Both         |
| `GET /connections/:id/bonding`                    | `connection-bonding.read`    | Client only  |
| `GET /connections/:id/congestion`                 | `connection-monitoring.read` | Client only  |
| `GET /connections/:id/monitoring/alerts`          | `connection-monitoring.read` | Both         |
| `GET /connections/:id/monitoring/packet-loss`     | `connection-monitoring.read` | Both         |
| `GET /connections/:id/monitoring/retransmissions` | `connection-monitoring.read` | Both         |
| `GET /connections/:id/config/:filename`           | `connection-config.read`     | Client only  |
| `POST /connections/:id/config/:filename`          | `connection-config.update`   | Client only  |

Response shapes are identical to the corresponding global endpoint.

---

## 15. Management API Auth and CLI

### Authentication

Management endpoints require a token when `managementApiToken` is configured:

```bash
# Via header (recommended)
curl -H "X-Edge-Link-Token: $TOKEN" ...

# Via Authorization header
curl -H "Authorization: Bearer $TOKEN" ...
```

Set the token in plugin configuration or via environment variable:

```bash
export SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN="your-long-random-token"
```

### Web UI token injection

Token sources checked in priority order:

1. `window.__EDGE_LINK_AUTH__.token` — server-side injection (preferred)
2. URL query parameter `?edgeLinkToken=<token>` — **disabled by default**; opt in with `includeTokenInQuery: true`. Generally avoid: tokens in URLs leak via history, access logs, and `Referer` headers.
3. `localStorage.getItem("signalkEdgeLinkManagementToken")`

Override the injection object:

```javascript
window.__EDGE_LINK_AUTH__ = {
  token: "your-token",
  headerMode: "both" // "both" | "authorization" | "x-edge-link-token"
};
```

### CLI tool

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

# Bonding status
npm run cli -- bonding status --token=$TOKEN --format=table

# Update bonding thresholds
npm run cli -- bonding update --patch '{"failoverThreshold":300}' --token=$TOKEN

# Overall plugin status
npm run cli -- status --token=$TOKEN --format=table
```

### Config migration (legacy to connections[] format)

```bash
npm run migrate:config -- old-config.json new-config.json
```

---

## 16. Complete Example Configurations

### Example 1 — Minimal v1 (stable LAN)

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

### Example 2 — Production v3 server (shore side)

```json
{
  "managementApiToken": "long-random-management-token-here",
  "requireManagementApiToken": true,
  "connections": [
    {
      "name": "shore-prod",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1",
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

### Example 3 — Production v3 client with congestion control (vessel side)

```json
{
  "managementApiToken": "long-random-management-token-here",
  "connections": [
    {
      "name": "vessel-prod",
      "serverType": "client",
      "udpAddress": "shore.example.com",
      "udpPort": 4446,
      "secretKey": "a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1",
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

### Example 4 — Dual-link bonding (LTE primary + Starlink backup)

**Vessel (client with bonding):**

```json
{
  "connections": [
    {
      "name": "vessel-bonded",
      "serverType": "client",
      "secretKey": "a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1",
      "protocolVersion": 3,
      "useMsgpack": true,
      "usePathDictionary": true,
      "skipOwnData": true,
      "congestionControl": {
        "enabled": true,
        "targetRTT": 400,
        "minDeltaTimer": 500,
        "maxDeltaTimer": 8000
      },
      "bonding": {
        "enabled": true,
        "mode": "main-backup",
        "primary": {
          "address": "shore.example.com",
          "port": 4446,
          "interface": "192.168.1.100"
        },
        "backup": {
          "address": "shore.example.com",
          "port": 4447,
          "interface": "10.0.0.100"
        },
        "failover": {
          "rttThreshold": 800,
          "lossThreshold": 0.15,
          "healthCheckInterval": 1000,
          "failbackDelay": 60000,
          "heartbeatTimeout": 8000
        }
      }
    }
  ]
}
```

**Shore (two server connections):**

```json
{
  "managementApiToken": "long-random-management-token-here",
  "connections": [
    {
      "name": "shore-lte",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1",
      "protocolVersion": 3,
      "requestFullStatusOnRestart": true
    },
    {
      "name": "shore-starlink",
      "serverType": "server",
      "udpPort": 4447,
      "secretKey": "a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1",
      "protocolVersion": 3,
      "requestFullStatusOnRestart": true
    }
  ]
}
```

---

## 17. Performance Tuning

### Compression and batching data

| Batch size | Raw JSON | After Brotli | Ratio | Bytes/delta |
| ---------- | -------- | ------------ | ----- | ----------- |
| 1 delta    | 221 B    | 193 B        | 1.1×  | 193 B       |
| 5 deltas   | 1.1 KB   | 227 B        | 5.0×  | 45 B        |
| 10 deltas  | 2.3 KB   | 253 B        | 9.1×  | 25 B        |
| 20 deltas  | 4.5 KB   | 341 B        | 13.6× | 17 B        |
| 50 deltas  | 11.3 KB  | 537 B        | 21.6× | 11 B        |

Larger batches = better compression. Increase `deltaTimer` on bandwidth-constrained links.

### Processing latency per stage

| Stage           | p50      | p95      | p99      |
| --------------- | -------- | -------- | -------- |
| Serialize       | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt         | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build    | 0.001 ms | 0.002 ms | 0.009 ms |

Compression dominates. High delta rates on constrained hardware → increase `deltaTimer`.

### Deployment profiles

#### Raspberry Pi 3/4 (vessel, constrained CPU)

```json
{
  "useMsgpack": true,
  "usePathDictionary": true,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 300,
    "minDeltaTimer": 250,
    "maxDeltaTimer": 5000
  }
}
```

- `deltaTimer` ≥ 250 ms to limit Brotli frequency
- Monitor RSS: normal 30–80 MB; investigate if > 150 MB

#### x86 / ARM64 shore server

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 100,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 2000
  }
}
```

- Low `deltaTimer` (100–250 ms) for low-latency feeds on stable LAN-speed links

#### Satellite link (high-latency, low-bandwidth)

```json
{
  "useMsgpack": true,
  "usePathDictionary": true,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 800,
    "minDeltaTimer": 2000,
    "maxDeltaTimer": 10000
  }
}
```

Also add `sentence_filter.json` excluding `GSV`, `GSA`, `VTG`.

- High `deltaTimer` (2000–5000 ms) maximizes compression ratio
- `targetRTT: 800` prevents constant congestion decisions on a high-RTT link

### Tuning summary table

| Link type      | `deltaTimer` | `useMsgpack` | `usePathDictionary` | `targetRTT` |
| -------------- | ------------ | ------------ | ------------------- | ----------- |
| Local LAN      | 100–250 ms   | optional     | optional            | 50 ms       |
| LTE (good)     | 250–500 ms   | yes          | yes                 | 150–200 ms  |
| LTE (variable) | 500–1000 ms  | yes          | yes                 | 300 ms      |
| Satellite      | 2000–5000 ms | yes          | yes                 | 700–1000 ms |
| Starlink       | 500–1000 ms  | yes          | yes                 | 200–400 ms  |

### Memory bounds reference

| Buffer               | Maximum                |
| -------------------- | ---------------------- |
| Retransmit queue     | 5000 packets           |
| Monitoring heatmap   | 60 buckets             |
| Path latency tracker | 200 paths × 50 samples |
| Retransmit history   | 120 entries            |
| Bandwidth history    | 60 entries             |
| Delta buffer         | 1000 deltas            |

---

## 18. Troubleshooting

### Quick diagnostic checklist

1. Both ends running same plugin version? (`npm list signalk-edge-link`)
2. Encryption keys identical on both sides? (32 ASCII, 64 hex, or 44 base64)
3. UDP port open in firewall? (`ufw status` or `iptables -L`)
4. Plugin enabled in Signal K Admin UI?
5. Node.js ≥ 20.9.0? (`node --version`)

### Encryption / decryption errors

| Symptom                                            | Cause                 | Fix                                                                    |
| -------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `Unsupported state or unable to authenticate data` | Key mismatch          | Verify keys are identical, same format, same `stretchAsciiKey` setting |
| `Secret key must be exactly 32 characters`         | Wrong key length      | Use 32 ASCII chars, 64 hex chars, or 44 base64 chars                   |
| `Key lacks sufficient diversity`                   | Key too simple        | Use `openssl rand -hex 32`                                             |
| Persistent errors after key change                 | One end not restarted | Restart plugin on both ends                                            |

### Connection errors

| Symptom                                       | Cause                              | Fix                                                  |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `ECONNREFUSED`                                | Server not listening or wrong port | Verify server running; check `udpPort` matches       |
| `ENETUNREACH`                                 | No route to host                   | Check network connectivity                           |
| `testAddress is only supported on v1 clients` | v1-only fields in v3 config        | Remove `testAddress`, `testPort`, `pingIntervalTime` |
| `Invalid magic bytes`                         | v1 client sending to v3 server     | Set same `protocolVersion` on both ends              |
| Protocol version mismatch warning             | Mismatched `protocolVersion`       | Set same version on both ends and restart            |

### No data flowing

```bash
# Client: is it sending anything?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq '{sent:.stats.deltasSent,err:.stats.encryptionErrors,ready:.status.readyToSend}'

# Server: is it receiving anything?
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq '{rcvd:.stats.deltasReceived,err:.stats.encryptionErrors}'
```

### Bonding not failing over

| Symptom                     | Check                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Failover not triggering     | Verify `bonding.enabled: true`; check backup is not `"down"` in `GET /bonding`            |
| Backup shows `"down"`       | Ensure UDP is allowed bidirectionally; server must echo HEARTBEAT probes                  |
| Frequent failover/failback  | Increase `failbackDelay` (try 60 s); increase `rttThreshold`                              |
| `POST /bonding` returns 400 | Check field names and ranges against [Section 7.8](#78-connection-bonding-client-v3-only) |

### Congestion control not adapting

| Symptom                        | Check                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Timer stays at `maxDeltaTimer` | `targetRTT` is below link's actual RTT — increase it                                      |
| Timer not moving at all        | Verify `congestionControl.enabled: true`; check `GET /congestion` for `manualMode: false` |
| Timer oscillates rapidly       | RTT hovering near `targetRTT` — increase `targetRTT` by 20–30%                            |

### Poor compression ratio

- Increase `deltaTimer` (more deltas per batch = better ratio)
- Enable `useMsgpack: true` and `usePathDictionary: true`
- Add `sentence_filter.json` to exclude high-frequency NMEA sentences
- Verify `oversizedPackets` counter stays 0

### Installation issues

- Plugin not loading: run `npm install && npm run build` in the plugin directory; check Node.js version
- Web UI blank: run `npm run build`; verify `public/` directory exists; clear browser cache

### Debug commands

```bash
H=http://localhost:3000/plugins/signalk-edge-link
TOKEN="your-token"

curl -s -H "X-Edge-Link-Token: $TOKEN" $H/metrics | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/network-metrics | jq .
curl -s $H/congestion | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/bonding | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/monitoring/alerts | jq .
curl -s $H/prometheus
curl -s -X POST -H "X-Edge-Link-Token: $TOKEN" $H/capture/start
curl -o capture.pcap $H/capture/export
```

### Getting help

1. Enable debug logging in Signal K plugin settings
2. Collect `GET /metrics` and `GET /network-metrics` output
3. Include your configuration (redact the `secretKey`)
4. Open an issue at https://github.com/KEGustafsson/signalk-edge-link/issues

---

## 19. Source Replication

The server maintains a normalized source-registry replica built from client-provided update metadata. It tracks the origin of every Signal K data source across all connected clients.

### Schema version 1 contract

**Required identity fields:**

- `identity.label`
- `identity.type`

**Optional identity fields:**

- `identity.src`, `identity.instance`, `identity.pgn`, `identity.deviceId`

**Timestamps:**

- `firstSeenAt`, `lastSeenAt`, `lastUpdatedAt`

**Provenance:**

- `provenance.lastUpdatedBy`
- `provenance.sourceClientInstanceId`
- `provenance.updateTimestamp`

**Diagnostics / raw retention:**

- `raw.source`, `raw.$source`
- `mergeHash` — deterministic no-op deduplication hash

### Canonicalization rules

- Registry key is derived deterministically from sanitized identity fields:
  - `source-ref:$source` when `$source` is present
  - otherwise `source-identity:<sha256(canonical-identity)>` where canonical identity is derived from `identity.type/label/src/instance/pgn/deviceId`
- Source payload fields are preserved as provided by the client
- Legacy `$source` values are retained as-is

### Merge policy

- Field-level merge is deterministic
- Empty/undefined incoming fields never clear non-empty existing fields
- Conflicting values resolved by latest update timestamp (fallback to current time)
- Identical post-merge state is deduped via `mergeHash` and counted as no-op in `metrics.noops`

### Backward compatibility

Legacy compatibility lookups are preserved in API responses:

- `legacy.byLabel[label]` → `canonicalKey`
- `legacy.bySourceRef[$source]` → `canonicalKey`

### API exposure

```bash
# Full source registry snapshot
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/sources | jq .

# Metrics counters only (from /metrics)
curl http://localhost:3000/plugins/signalk-edge-link/metrics | jq .sourceReplication.metrics
```

Source replication is populated from normal DATA delta ingest (`update.source` / `$source`). It does not depend on optional metadata packet streaming.

---

## 20. Developer Reference

### Build and test

```bash
npm run build          # TypeScript compile + webpack (web UI)
npm run dev            # Watch mode (TypeScript)
npm test               # All unit tests
npm run test:v2        # reliable-transport (v3) protocol tests
npm run test:integration  # End-to-end pipeline tests
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run migrate:config -- <input.json> [output.json]
npm run cli -- help
```

### Source file map

| File / directory                                    | Purpose                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/index.ts`                                      | Plugin entry point; instance registry, schema wiring, route registration             |
| `src/app/connection.ts`                             | Single connection runtime factory and lifecycle coordination                         |
| `src/app/connection/`                               | Start/stop, client/server startup, socket recovery, and lifecycle helper modules     |
| `src/foundation/types/`                             | TypeScript interfaces: Delta, ConnectionConfig, metrics, InstanceState               |
| `src/foundation/constants.ts`                       | Tuning constants (MTU, buffer sizes, timeouts, retry counts)                         |
| `src/foundation/config-io.ts`                       | Load/save runtime JSON config files                                                  |
| `src/app/config/watcher.ts`                         | File system watcher; debounce and reload on modification                             |
| `src/foundation/circular-buffer.ts`                 | Fixed-size circular buffer for metrics history                                       |
| `src/connection-config.ts`                          | Configuration validation, sanitization, and legacy protocol coercion                 |
| `src/transport/pipeline/factory.ts`                 | Selects pipeline based on `serverType` and effective `protocolVersion`               |
| `src/transport/pipeline/v1.ts`                      | v1 protocol: compress → encrypt → send (client); receive → decrypt → inject (server) |
| `src/transport/pipeline/reliable-client.ts`         | v3 client: packet building, retransmit queue, ACK/NAK handling, congestion hook      |
| `src/transport/pipeline/reliable-server.ts`         | v3 server: packet parsing, per-client sessions, ACK/NAK generation                   |
| `src/codec/compression.ts`                          | Shared Brotli helpers                                                                |
| `src/codec/packet/` and `src/codec/packet-codec.ts` | v3 packet header encode/decode, auth, CRC, payload parsing                           |
| `src/transport/reliability/retransmit-queue.ts`     | Bounded queue for retransmit candidates; timeout-based eviction                      |
| `src/transport/reliability/sequence.ts`             | Sequence number tracking, gap detection, NAK scheduling (server side)                |
| `src/transport/congestion.ts`                       | AIMD congestion control; adjusts delta timer every 5 s based on RTT/loss             |
| `src/transport/bonding.ts`                          | Primary/backup link health monitoring; automatic failover/failback                   |
| `src/codec/crypto.ts`                               | AES-256-GCM encrypt/decrypt; PBKDF2 key derivation; HMAC (v3)                        |
| `src/codec/delta-sanitizer.ts`                      | Strip own telemetry; validate paths; normalize outbound deltas                       |
| `src/codec/path-dictionary.ts`                      | Bidirectional Signal K path ↔ 2-byte numeric ID encoding                             |
| `src/codec/metadata-codec.ts`                       | Collect/diff Signal K path metadata; package for transmission                        |
| `src/codec/values-snapshot.ts`                      | Capture full current Signal K state for FULL_STATUS_REQUEST replay                   |
| `src/domain/source-registry.ts`                     | Server-side registry tracking source identities across clients                       |
| `src/codec/source-dispatch.ts`                      | Normalize delta source references for correct Signal K routing                       |
| `src/domain/metrics/registry.ts`                    | Per-instance metrics accumulation                                                    |
| `src/transport/metrics/publisher.ts`                | Publish link metrics to Signal K (`networking.edgeLink.*`)                           |
| `src/domain/metrics/prometheus.ts`                  | Prometheus metrics exporter                                                          |
| `src/domain/monitoring/`                            | Packet loss heatmap, path latency tracking, packet capture, alert thresholds         |
| `src/routes.ts`                                     | Route dispatcher; management auth; rate limiting                                     |
| `src/routes/metrics.ts`                             | `/metrics`, `/network-metrics`, `/prometheus`                                        |
| `src/routes/config.ts`                              | `/plugin-config`, `/connections/:id/config/*`                                        |
| `src/routes/connections.ts`                         | `/connections`, `/instances`                                                         |
| `src/routes/control.ts`                             | `/bonding/failover`, `/delta-timer`                                                  |
| `src/routes/monitoring.ts`                          | `/monitoring/alerts`, packet capture                                                 |
| `src/bin/edge-link-cli.ts`                          | CLI tool: instance/bonding management, config migration                              |
| `src/scripts/migrate-config.ts`                     | Migrate legacy flat config to `connections[]` format                                 |
| `src/shared/connection-schema.ts`                   | Single source of truth for plugin config schema                                      |
| `src/webapp/`                                       | React management UI source (compiled to `public/`)                                   |

### Key functions

| Function                        | File                  | What it does                                                                     |
| ------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `processDelta()`                | `instance.ts`         | Receives a raw Signal K delta; filters, deduplicates, buffers, triggers batching |
| `flushDeltaBatch()`             | `instance.ts`         | Takes buffered deltas, serializes, compresses, encrypts, sends via pipeline      |
| `sendDelta()`                   | `reliable-client.ts`  | v3: builds DATA packet, adds to retransmit queue, sends via UDP                  |
| `parsePacket()`                 | `reliable-server.ts`  | v3: validates header, decrypts, dispatches by packet type                        |
| `onDataPacket()`                | `reliable-server.ts`  | Processes a decrypted DATA payload: sequence tracking, delta injection, ACK      |
| `normalizeKey()`                | `crypto.ts`           | Converts any of the three key formats to a raw 32-byte Buffer                    |
| `encodeDelta()`                 | `pathDictionary.ts`   | Replaces Signal K path strings with numeric IDs in a delta                       |
| `decodeDelta()`                 | `pathDictionary.ts`   | Reverses path dictionary encoding back to path strings                           |
| `RetransmitQueue.add()`         | `retransmit-queue.ts` | Stores a packet copy for potential retransmission                                |
| `RetransmitQueue.acknowledge()` | `retransmit-queue.ts` | Removes all entries up to the cumulative ACK sequence                            |

### Configuration validation rules

The validator (`src/connection-config.ts`) enforces:

- `serverType` must be `"server"` or `"client"`
- `udpPort` must be an integer 1024–65535
- `secretKey` must match one of the three accepted formats
- `protocolVersion` must be 1 (Basic) or 3 (Advanced); a legacy `2` is accepted and coerced to `3`
- Server connections must not include `congestionControl`, `bonding`, `alertThresholds`, or `skipOwnData`
- v3 clients must not include `testAddress`, `testPort`, or `pingIntervalTime`
- Bonding: primary and backup must have different address:port pairs
- Reliability values must be within documented ranges
- Alert thresholds: `warning` ≤ `critical`; ratio metrics 0–1

### Protocol v3 technical specification

For the exact wire-level specification including METADATA envelope schema, source snapshot variant, v1 metadata port details, and the full sequence number semantics, see `docs/protocol-v3-spec.md`.
