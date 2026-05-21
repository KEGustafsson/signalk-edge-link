# Signal K Edge Link — Complete Guide

> One document covering installation, configuration, all protocol versions, every tuning parameter, security, monitoring, and developer internals.

![Data Connector Concept](assets/dataconnectorconcept.jpg)

---

## Table of Contents

1. [What It Does and Why](#1-what-it-does-and-why)
2. [System Architecture](#2-system-architecture)
3. [How Data Flows](#3-how-data-flows)
4. [Installation](#4-installation)
5. [Quick Start — Minimal Setup](#5-quick-start--minimal-setup)
6. [Protocol Versions In Depth](#6-protocol-versions-in-depth)
   - [v1 — Simple Encrypted UDP](#v1--simple-encrypted-udp)
   - [v2 — Reliable Transport](#v2--reliable-transport)
   - [v3 — Authenticated Control Packets](#v3--authenticated-control-packets)
7. [Complete Configuration Reference](#7-complete-configuration-reference)
8. [Runtime Configuration Files (Hot-Reload)](#8-runtime-configuration-files-hot-reload)
9. [Congestion Control](#9-congestion-control)
10. [Connection Bonding (Dual-Link Failover)](#10-connection-bonding-dual-link-failover)
11. [Multi-Connection Setup](#11-multi-connection-setup)
12. [Encryption and Key Management](#12-encryption-and-key-management)
13. [Monitoring and Metrics](#13-monitoring-and-metrics)
14. [Management API and CLI](#14-management-api-and-cli)
15. [Complete Example Configurations](#15-complete-example-configurations)
16. [Performance Tuning](#16-performance-tuning)
17. [Troubleshooting](#17-troubleshooting)
18. [Developer Reference](#18-developer-reference)

---

## 1. What It Does and Why

Signal K Edge Link transfers vessel navigation and sensor data between two Signal K server instances over encrypted UDP. It is built specifically for network paths where **bandwidth is limited, latency is variable, and packet loss happens** — cellular, satellite, and other WAN links.

### Why not use the built-in Signal K subscriptions?

Standard Signal K uses TCP/WebSocket subscriptions. These work well on reliable LAN connections but are poorly suited to:

- **Cellular roaming** — NAT mappings expire; connections drop silently
- **Satellite links** — High RTT and tiny bandwidth budgets; no adaptation
- **Multi-hop relay** — No mechanism to chain instances together
- **Bandwidth optimization** — No compression, no batching, no path deduplication

Signal K Edge Link solves each of these by combining UDP transport with Brotli compression, AES-256-GCM encryption, and (in v2/v3) a reliability layer with ACK/NAK retransmission, congestion control, and dual-link failover.

### Protocol version at a glance

| Version | Best for                                      | Key features                                                              |
|---------|-----------------------------------------------|---------------------------------------------------------------------------|
| **v1**  | Stable local links, simplest setup            | Encrypted UDP, Brotli compression. No retransmission or metrics.          |
| **v2**  | WAN links with packet loss or variable latency | v1 + ACK/NAK reliability, congestion control, bonding, rich monitoring    |
| **v3**  | Untrusted WAN links (recommended for new setups) | v2 + HMAC-SHA256 authentication on all control packets                   |

**Recommendation:** Use **v3** for any new deployment. Fall back to v2 only when you need backward compatibility with an existing v2 peer that cannot be upgraded.

---

## 2. System Architecture

### Basic topology

```
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

One Signal K instance can run **both** a server and a client simultaneously — acting as a relay that receives data from one vessel and forwards it to a central aggregator.

```
  [Vessel A]                 [Relay / aggregator]              [Shore HQ]
  Client ─────UDP v3──────► Server  Client ─────UDP v3──────► Server
                             (relay instance)
  [Vessel B]
  Client ─────UDP v3──────►
```

Each connection runs independently. A single plugin process supports up to as many connections as you configure.

### Dual-link (bonding) topology

When a vessel has two uplinks (e.g., LTE + Starlink), bonding keeps data flowing even when the primary link fails:

```
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

```
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
 │ Packet header    │  v2/v3 only: prepend 15-byte binary header
 │ (v2/v3)          │  with magic, version, type, flags, seq, CRC
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Retransmit queue │  v2/v3: store copy for possible retransmission
 │ (v2/v3)          │  (up to 5000 entries)
 └──────────┬───────┘
            │
            ▼
       UDP send ──────────────────────► remote server
```

### Server inbound pipeline

```
       UDP receive ◄──────────────────── remote client
            │
            ▼
 ┌──────────────────┐
 │ Rate limit       │  v2/v3: 200 DATA packets/sec per client IP
 │ per client       │  Prevents DoS; 5 sessions max per IP
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Parse header     │  v2/v3: verify magic "SK", version, CRC-16
 │ (v2/v3)          │  Silently discard on mismatch
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
 │ decode (v2/v3)   │
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Deserialize      │  JSON.parse or MessagePack.decode
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Sequence check   │  v2/v3: detect gaps, send NAK for missing seqs
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

# or via Signal K Admin UI: Server → Restart
```

### Requirements

- Node.js 16 or later (`node --version`)
- UDP reachability from client to server on your chosen port
- Shared encryption key configured on both ends

---

## 5. Quick Start — Minimal Setup

This section walks through the simplest possible deployment: one vessel sending data to one shore server.

### Step 1 — Configure the server (shore side)

On the **destination** Signal K instance:

1. Open **Server → Plugin Config → Signal K Edge Link**
2. Click **Add Connection**
3. Set **Connection Type** to **Server**
4. Fill in:

   | Field             | Value                            |
   |-------------------|----------------------------------|
   | Connection Name   | `shore-server`                   |
   | UDP Port          | `4446`                           |
   | Encryption Key    | `your-32-character-secret-key!!` |
   | Protocol Version  | `3`                              |

5. Click **Save** and restart the plugin

### Step 2 — Configure the client (vessel side)

On the **source** Signal K instance:

1. Open **Server → Plugin Config → Signal K Edge Link**
2. Click **Add Connection**
3. Set **Connection Type** to **Client**
4. Fill in:

   | Field             | Value                            |
   |-------------------|----------------------------------|
   | Connection Name   | `vessel-client`                  |
   | Server Address    | `shore.example.com` (or IP)      |
   | UDP Port          | `4446`                           |
   | Encryption Key    | `your-32-character-secret-key!!` |
   | Protocol Version  | `3`                              |

5. Click **Save** and restart the plugin

### Step 3 — Verify traffic

Open the runtime dashboard on either instance:

```
http://<signalk-host>:3000/plugins/signalk-edge-link/
```

On the **client**, confirm:
- **Deltas Sent** counter is increasing
- **Encryption errors** stays at 0

On the **server**, confirm:
- **Deltas Received** counter is increasing
- **Decryption errors** stays at 0

You can also use the API to check:

```bash
# Client side
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq .

# Server side
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq .
```

---

## 6. Protocol Versions In Depth

### v1 — Simple Encrypted UDP

v1 is the simplest protocol. Every batch of deltas is compressed and encrypted and sent as a single UDP datagram. There is no reliability layer — lost packets are simply lost.

#### Wire format

```
┌─────────────────────────────────────────────────────┐
│  [  12-byte random IV  ]                            │
│  [  AES-256-GCM ciphertext (Brotli-compressed       │
│     JSON or MessagePack delta batch)  ]             │
│  [  16-byte GCM auth tag  ]                         │
└─────────────────────────────────────────────────────┘
       Total overhead per packet: 28 bytes
```

The receiver identifies v1 packets because they **do not** start with the `SK` magic bytes used by v2/v3.

#### When to use v1

- Stable, low-latency LAN connections (vessel ↔ router ↔ NAS)
- When simplicity matters more than reliability
- When you need the absolute lowest overhead

#### v1 limitations

- No retransmission — packet loss is unrecovered
- No RTT measurement (uses external ping monitor instead)
- No congestion control or bonding
- No metadata transport
- No monitoring beyond basic counters

#### v1 configuration example

```json
{
  "connections": [{
    "name": "lan-link",
    "serverType": "client",
    "udpAddress": "192.168.1.100",
    "udpPort": 4446,
    "secretKey": "MySecretKey12345678901234567890",
    "protocolVersion": 1,
    "testAddress": "8.8.8.8",
    "testPort": 53,
    "pingIntervalTime": 1
  }]
}
```

The `testAddress` / `testPort` / `pingIntervalTime` fields configure an external **ping monitor** that measures reachability and RTT by probing a remote host. This is how v1 gets its RTT estimate. These fields **must not** appear in v2/v3 configs.

---

### v2 — Reliable Transport

v2 adds a 15-byte binary header to every packet, enabling sequence tracking, ACK/NAK retransmission, heartbeat-based RTT measurement, congestion control, and bonding.

#### Packet header format

```
 Byte offset:  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14
              ┌───┬───┬───┬───┬───┬───────────────────┬───────────────────┬───────┐
              │'S'│'K'│ver│typ│flg│   Sequence (u32)   │  Payload len (u32)│ CRC16 │
              └───┴───┴───┴───┴───┴───────────────────┴───────────────────┴───────┘
                                                                          └──2 B──┘
 Field sizes:   2B      1B  1B  1B          4B                   4B

 Magic:  0x53 0x4B ("SK") — identifies v2/v3 packets
 ver:    0x02 (v2) or 0x03 (v3)
 typ:    Packet type (see table below)
 flg:    Feature flags (see table below)
 seq:    Packet sequence number, uint32 big-endian, wraps at 0xFFFFFFFF
 len:    Payload length in bytes, uint32 big-endian
 CRC16:  CRC-CCITT over header bytes 0–12
```

After the header comes the payload — the encrypted+compressed delta batch:

```
Header (15B) + [12B IV][ciphertext][16B auth tag]
              └─────────── payload ──────────────┘
Total overhead per packet: 15 + 28 = 43 bytes
```

#### Packet types

| Hex  | Name                  | Direction       | Description                                            |
|------|-----------------------|-----------------|--------------------------------------------------------|
| 0x01 | DATA                  | Client → Server | Signal K delta batch (encrypted+compressed)            |
| 0x02 | ACK                   | Server → Client | Cumulative acknowledgement (4-byte sequence number)    |
| 0x03 | NAK                   | Server → Client | Negative acknowledgement (list of missing seq numbers) |
| 0x04 | HEARTBEAT             | Both directions | Keep-alive; used for RTT measurement                   |
| 0x05 | HELLO                 | Client → Server | Session initiation with client metadata                |
| 0x06 | METADATA              | Client → Server | Signal K path metadata (units, descriptions, zones)    |
| 0x07 | META_REQUEST          | Server → Client | Server requests fresh metadata snapshot                |
| 0x08 | FULL_STATUS_REQUEST   | Server → Client | Server requests full values snapshot replay            |

#### Feature flags (byte 4)

| Bit | Mask | Name              | Set when                              |
|-----|------|-------------------|---------------------------------------|
| 0   | 0x01 | COMPRESSED        | Payload is Brotli-compressed          |
| 1   | 0x02 | ENCRYPTED         | Payload is AES-256-GCM encrypted      |
| 2   | 0x04 | MESSAGEPACK       | Payload is MessagePack-encoded        |
| 3   | 0x08 | PATH_DICTIONARY   | Paths encoded as numeric IDs          |
| 4-7 | —    | Reserved          | Always 0                              |

Both peers must be configured identically for `useMsgpack` and `usePathDictionary` — a mismatch causes decoding failures.

#### ACK/NAK handshake

The following shows how reliability works end-to-end:

```
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
    │◄─── NAK ([4]) ──────────────────────│  Gap detected: seq 4 missing
    │                                      │
    │──── DATA (seq=4, retransmit) ───────►│
    │                                      │
    │◄─── ACK (cumSeq=5) ─────────────────│  All caught up
    │                                      │
    │──── HEARTBEAT ──────────────────────►│  Keep-alive + RTT probe
    │◄─── HEARTBEAT ───────────────────────│
```

**Delivery guarantee:** > 99.9% at 5% random packet loss.

#### v2 configuration example

```json
{
  "connections": [{
    "name": "wan-client",
    "serverType": "client",
    "udpAddress": "shore.example.com",
    "udpPort": 4446,
    "secretKey": "MySecretKey12345678901234567890",
    "protocolVersion": 2,
    "heartbeatInterval": 25000,
    "reliability": {
      "retransmitQueueSize": 5000,
      "maxRetransmits": 3
    },
    "congestionControl": {
      "enabled": true,
      "targetRTT": 200
    }
  }]
}
```

---

### v3 — Authenticated Control Packets

v3 is identical to v2 in data path and wire format. The only difference is that **control packets** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST) carry a **16-byte HMAC-SHA256 authentication tag** instead of a plain CRC16.

#### Why this matters

In v2, any host that can reach the UDP port can forge a valid control packet. This creates real attack vectors:

- **Forged FULL_STATUS_REQUEST** — triggers a full snapshot replay, usable as a reflection amplifier
- **Forged NAK** — causes the client to retransmit potentially large amounts of data
- **Forged HELLO** — creates a spurious session entry on the server

v3 closes all of these because forging a control packet requires knowing the shared secret.

#### Security comparison

| Property                      | v1  | v2  | v3  |
|-------------------------------|-----|-----|-----|
| Data payload confidentiality  | ✓   | ✓   | ✓   |
| Data payload integrity (GCM)  | ✓   | ✓   | ✓   |
| Control packet authentication | —   | CRC only (forgeable) | HMAC-SHA256 ✓ |
| Retransmission on loss        | —   | ✓   | ✓   |
| Congestion control            | —   | ✓   | ✓   |
| Bonding / failover            | —   | ✓   | ✓   |
| Safe on untrusted networks    | partial | **No** | **Yes** |

**Use v3 for any connection exposed to the public internet or untrusted networks.**

The plugin emits a startup warning when a v2 connection is configured with a publicly reachable port.

#### v3 configuration example

```json
{
  "connections": [
    {
      "name": "shore-server",
      "serverType": "server",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3
    },
    {
      "name": "vessel-client",
      "serverType": "client",
      "udpAddress": "shore.example.com",
      "udpPort": 4446,
      "secretKey": "MySecretKey12345678901234567890",
      "protocolVersion": 3,
      "heartbeatInterval": 25000
    }
  ]
}
```

---

## 7. Complete Configuration Reference

Configuration lives in the plugin's settings under `connections` — an array where each entry is an independent link.

### 7.1 Common fields (client and server)

| Field                | Type    | Default       | Description |
|----------------------|---------|---------------|-------------|
| `name`               | string  | `"connection"` | Label shown in UI and logs. Used as directory name for runtime config files. Max 40 characters. |
| `serverType`         | string  | `"client"`    | `"client"` sends data; `"server"` receives data. |
| `udpPort`            | integer | `4446`        | UDP port. Range 1024–65535. Must match on both ends. |
| `secretKey`          | string  | — (required)  | AES-256 encryption key. Accepts 32-char ASCII, 64-char hex, or 44-char base64. Must match exactly on both ends. |
| `stretchAsciiKey`    | boolean | `false`       | When `true`, runs a 32-char ASCII key through PBKDF2-SHA256 (600,000 iterations) before use. Increases security of short ASCII keys. **Both ends must match.** |
| `protocolVersion`    | integer | `2`           | `1`, `2`, or `3`. Must match on both ends. |
| `useMsgpack`         | boolean | `false`       | Serialize deltas as MessagePack instead of JSON. Saves ~15–25%. **Both ends must match.** |
| `usePathDictionary`  | boolean | `false`       | Replace Signal K path strings with 2-byte numeric IDs. Saves ~10–20%. **Both ends must match.** |
| `enableNotifications`| boolean | `false`       | Forward Signal K notification deltas over the link. |
| `skipOwnData`        | boolean | `false`       | (Client only) Drop all `networking.edgeLink.*` metrics before forwarding — prevents feedback loops when a server-side Edge Link publishes metrics back to its Signal K tree. |

### 7.2 Client transport fields

| Field                | Type    | Default       | Description |
|----------------------|---------|---------------|-------------|
| `udpAddress`         | string  | `"127.0.0.1"` | Hostname or IP address of the remote server. Required for client connections. |
| `helloMessageSender` | integer | `60`          | Interval in **seconds** between HELLO keepalive messages. Keeps NAT/firewall mappings alive. Range 10–3600. |
| `heartbeatInterval`  | integer | `25000`       | Interval in **ms** between HEARTBEAT probes (v2/v3 only). Used for RTT measurement and NAT hole-punching. Range 1000–120000. |

### 7.3 v1 ping monitor fields (client, v1 only)

These fields configure an external reachability check for RTT estimation. They are **only valid with `protocolVersion: 1`** and must be removed when upgrading to v2/v3.

| Field              | Type    | Default       | Description |
|--------------------|---------|---------------|-------------|
| `testAddress`      | string  | `"127.0.0.1"` | Host to probe for reachability (e.g., `8.8.8.8`). |
| `testPort`         | integer | `80`          | Port to probe (e.g., 53, 80, 443). |
| `pingIntervalTime` | number  | `1`           | Probe frequency in **minutes**. Range 0.1–60. |

### 7.4 Reliability — server mode (v2/v3 only)

Nested under `reliability`:

| Field               | Type    | Default | Range (ms)   | Description |
|---------------------|---------|---------|--------------|-------------|
| `ackInterval`       | integer | `100`   | 20–5000      | How often the server emits a cumulative ACK. Lower = faster acknowledgement but more ACK traffic. |
| `ackResendInterval` | integer | `1000`  | 100–10000    | Re-send the last ACK after this interval of silence. Handles lost ACK packets. |
| `nakTimeout`        | integer | `100`   | 20–5000      | Idle delay before sending NAK for a detected gap. A small delay catches out-of-order delivery before requesting retransmit. |

### 7.5 Reliability — client mode (v2/v3 only)

Nested under `reliability`:

| Field                    | Type    | Default   | Range        | Description |
|--------------------------|---------|-----------|--------------|-------------|
| `retransmitQueueSize`    | integer | `5000`    | 100–50000    | Maximum packets held in the retransmit queue. Each entry is one UDP payload (~1400 bytes). |
| `maxRetransmits`         | integer | `3`       | 1–20         | Give up retransmitting a packet after this many attempts. |
| `retransmitMaxAge`       | integer | `120000`  | 1000–300000  | Hard upper bound in ms on retransmit queue entries. Old entries are evicted even if not ACK'd. |
| `retransmitMinAge`       | integer | `10000`   | 200–30000    | Never evict an entry newer than this. Prevents race where a packet is evicted before its first retransmit window. |
| `retransmitRttMultiplier`| number  | `12`      | 2–20         | Scale factor applied to the current RTT to compute per-entry timeout. Higher = more tolerant of high-RTT links. |
| `ackIdleDrainAge`        | integer | `20000`   | 500–30000    | If no ACK has arrived for this long, start expiring queue entries more aggressively. |
| `forceDrainAfterAckIdle` | boolean | `false`   | —            | When `true`, force-clear the retransmit queue after `forceDrainAfterMs` of ACK silence. Prevents memory growth on completely dead links. |
| `forceDrainAfterMs`      | integer | `45000`   | 2000–120000  | Duration of ACK silence that triggers a force drain. Only used when `forceDrainAfterAckIdle` is `true`. |
| `recoveryBurstEnabled`   | boolean | `true`    | —            | When ACKs resume after a gap, rapidly retransmit queued packets. |
| `recoveryBurstSize`      | integer | `100`     | 10–1000      | Maximum packets to retransmit per recovery burst cycle. |
| `recoveryBurstIntervalMs`| integer | `200`     | 50–5000      | Interval between recovery burst cycles in ms. |
| `recoveryAckGapMs`       | integer | `4000`    | 500–120000   | Minimum ACK silence before triggering fast recovery bursts. |

### 7.6 Congestion control (client, v2/v3 only)

Nested under `congestionControl`. See [Section 9](#9-congestion-control) for the full algorithm explanation.

| Field              | Type    | Default | Range          | Description |
|--------------------|---------|---------|----------------|-------------|
| `enabled`          | boolean | `false` | —              | Enable AIMD automatic delta timer adjustment. |
| `targetRTT`        | integer | `200`   | 50–2000 ms     | RTT above this level triggers rate reduction. Set to your link's normal RTT. |
| `nominalDeltaTimer`| integer | `1000`  | 100–10000 ms   | Starting send interval when congestion control is first enabled. |
| `minDeltaTimer`    | integer | `100`   | 50–1000 ms     | Fastest allowed send rate. |
| `maxDeltaTimer`    | integer | `5000`  | 1000–30000 ms  | Slowest allowed send rate under congestion. |

### 7.7 Connection bonding (client, v2/v3 only)

Nested under `bonding`. See [Section 10](#10-connection-bonding-dual-link-failover) for the full explanation.

```
bonding
├── enabled          (boolean, default false)
├── mode             ("main-backup")
├── primary
│   ├── address      (string, IP or hostname)
│   ├── port         (integer, 1024–65535)
│   └── interface    (string, optional — bind to specific local IP)
├── backup
│   ├── address      (string, IP or hostname)
│   ├── port         (integer, 1024–65535)
│   └── interface    (string, optional)
└── failover
    ├── rttThreshold        (integer ms, default 500)
    ├── lossThreshold       (number 0–1, default 0.10)
    ├── healthCheckInterval (integer ms, default 1000)
    ├── failbackDelay       (integer ms, default 30000)
    └── heartbeatTimeout    (integer ms, default 5000)
```

**Failover triggers** (any condition met): primary RTT > `rttThreshold` OR primary loss > `lossThreshold` OR primary link DOWN.

**Failback requires** (all conditions): primary RTT < `rttThreshold × 0.8` AND primary loss < `lossThreshold × 0.5` AND `failbackDelay` ms has elapsed.

### 7.8 Alert thresholds (client, v2/v3 only)

Nested under `alertThresholds`. Each metric has a `warning` and `critical` level. When exceeded, a Signal K notification fires at `notifications.signalk-edge-link.<connectionName>.*`.

| Metric            | Warning default | Critical default | Unit    |
|-------------------|----------------|-----------------|---------|
| `rtt.warning`     | `300`          | `800`           | ms      |
| `packetLoss.warning` | `0.03`      | `0.10`          | ratio 0–1 |
| `retransmitRate.warning` | `0.05` | `0.15`          | ratio 0–1 |
| `jitter.warning`  | `100`          | `300`           | ms      |
| `queueDepth.warning` | `100`       | `500`           | packets |

### 7.9 Server-specific fields

| Field                        | Type    | Default | Description |
|------------------------------|---------|---------|-------------|
| `requestFullStatusOnRestart` | boolean | `false` | (v2/v3) When `true`, the server sends a FULL_STATUS_REQUEST to each client on first contact after a restart. The client replays its complete current Signal K state so the server can rebuild without waiting for incremental updates. Rate-limited to one replay per 10 seconds per client. |

### 7.10 Top-level plugin fields

These sit outside `connections[]`, at the root of the plugin config:

| Field                          | Type    | Default | Description |
|--------------------------------|---------|---------|-------------|
| `managementApiToken`           | string  | `null`  | Shared secret protecting management API endpoints. Can also be set via env `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`. |
| `requireManagementApiToken`    | boolean | `false` | When `true`, management endpoints fail closed (HTTP 403) if no token is configured. Also settable via env `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN=true`. |

---

## 8. Runtime Configuration Files (Hot-Reload)

Three JSON files can be edited or updated via the API **without restarting the plugin**. They are stored in:

```
<signalk-data-dir>/plugin-config-data/signalk-edge-link/<connectionName>/
```

The plugin watches each file for changes (300 ms debounce) and reloads automatically.

### delta_timer.json — override send interval

Bypasses congestion control and fixes the delta send interval to a specific value.

```json
{
  "deltaTimerMs": 2000
}
```

Set `deltaTimerMs` to `null` or delete the file to return to automatic/congestion-control mode.

**Also settable via API:**
```bash
# Set manual timer to 500 ms
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"value": 500}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer

# Re-enable automatic mode
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"mode": "auto"}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

### subscription.json — filter which paths are forwarded

Limits forwarding to specific Signal K contexts and paths. Without this file, all subscribed deltas are forwarded.

```json
{
  "context": "vessels.self",
  "paths": [
    "navigation.position",
    "navigation.speedOverGround",
    "navigation.courseOverGroundTrue",
    "environment.outside.temperature",
    "propulsion.port.*",
    "electrical.batteries.*"
  ]
}
```

Wildcards (`*`) are supported at the end of a path segment.

### sentence_filter.json — exclude NMEA sentence types

Drops deltas originating from specific NMEA sentence types before they are forwarded. Useful for high-frequency sentences that consume bandwidth without adding navigation value.

```json
{
  "excludedSentences": ["GSV", "GSA", "VTG", "GLL"]
}
```

Common sentences to exclude on bandwidth-constrained links:
- `GSV` — GPS satellites in view (high frequency, rarely needed remotely)
- `GSA` — GPS DOP and active satellites
- `GLL` — Geographic position (redundant if forwarding GGA or RMC)
- `VTG` — Track and ground speed (redundant if forwarding SOG/COG separately)

---

## 9. Congestion Control

### Why it's needed

UDP provides no feedback about network congestion. Without adaptation, a fixed send rate causes packet bursts that overwhelm constrained links, leading to retransmit storms that amplify congestion further. Congestion control prevents this by continuously adjusting the delta send interval based on live link quality.

### The AIMD algorithm

**Additive Increase, Multiplicative Decrease (AIMD)** — the same class of algorithm used by TCP:

```
Every 5 seconds, evaluate smoothed RTT and packet loss:

  ┌─────────────────────────────────────────────────────────────┐
  │                        AIMD Decision                        │
  │                                                             │
  │  loss < 1% AND RTT < targetRTT     → deltaTimer × 0.95     │
  │                                      (5% faster)           │
  │                                                             │
  │  loss > 5% OR RTT > targetRTT×1.5  → deltaTimer × 1.50     │
  │                                      (50% slower)          │
  │                                                             │
  │  otherwise (moderate)              → no change             │
  │                                                             │
  │  Cap: max ±20% per step                                     │
  │  Bounds: minDeltaTimer ≤ timer ≤ maxDeltaTimer              │
  └─────────────────────────────────────────────────────────────┘

  Inputs smoothed via EMA: value = 0.2 × new + 0.8 × prev
```

### Example timer behavior over time

```
deltaTimer
(ms)
 5000 ─────────────────────────────────────────────────────
                                               ╭─ congestion event
 2000 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─╯
                                          ╭──╯
 1000 ──────────────────────────────╮────╯
                            ╭───────╯
  500 ──────────────────────╯
  100 ─────────────────────────────────────────────── (min)

       t=0   t=5s  t=10s  t=15s  t=20s  t=25s  t=30s

 Scenario:
 t=0: timer=1000ms, healthy link → 950ms
 t=5s: still healthy → 902ms → 857ms → ...
 t=20s: congestion spike (loss>5%) → 1354ms
 t=25s: partial recovery → holds
 t=30s: healthy again → starts decreasing
```

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

### Checking congestion state

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

### Tuning guide

| Symptom | Cause | Fix |
|---------|-------|-----|
| Timer always at `maxDeltaTimer` | `targetRTT` below your link's actual RTT | Increase `targetRTT` to match observed `avgRTT` |
| Timer oscillates rapidly | Link RTT crosses targetRTT threshold frequently | Increase `targetRTT` by 20–30% above typical RTT |
| Timer won't go below a certain value | `minDeltaTimer` too high for your hardware | Lower `minDeltaTimer` (watch CPU usage) |
| Congestion control not adapting fast enough | Long evaluation interval | Default 5s is usually fine; contact issues are network-side |

---

## 10. Connection Bonding (Dual-Link Failover)

Bonding keeps data flowing when the primary link fails by automatically switching to a backup link. It is designed for vessels with two uplinks — for example, LTE (primary) and Starlink (backup).

### How the failover state machine works

```
   ┌─────────────────────────────────────────────────────────────┐
   │                    Bonding State Machine                    │
   │                                                             │
   │   ┌──────────────┐   RTT > rttThreshold                    │
   │   │              │   OR loss > lossThreshold               │
   │   │   ACTIVE     │   OR link DOWN                          │
   │   │   PRIMARY    ├────────────────────────────────────────►│
   │   │              │                                         │
   │   └──────┬───────┘          ┌──────────────┐              │
   │          ▲                  │              │              │
   │          │                  │   ACTIVE     │              │
   │          │◄─────────────────┤   BACKUP     │              │
   │          │   ALL required:  │              │              │
   │          │   • RTT < threshold × 0.8       │              │
   │          │   • loss < threshold × 0.5      │              │
   │          │   • failbackDelay elapsed        │              │
   │          │                  └──────────────┘              │
   └─────────────────────────────────────────────────────────────┘
```

Health is monitored continuously via HEARTBEAT probes sent every `healthCheckInterval` (default 1000 ms). A link is marked DOWN after no response for `heartbeatTimeout` (default 5000 ms).

### Step-by-step configuration

**Vessel side (client with bonding):**

```json
{
  "name": "vessel-bonded",
  "serverType": "client",
  "udpPort": 4446,
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
      "lossThreshold": 0.10,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000,
      "heartbeatTimeout": 5000
    }
  }
}
```

**Shore side (two server connections):**

The shore-side Signal K needs two separate server connections — one for each port:

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

| Profile      | `rttThreshold` | `lossThreshold` | `failbackDelay` | When to use |
|--------------|---------------|----------------|----------------|-------------|
| Aggressive   | 300 ms        | 5% (0.05)      | 15 s           | Low-latency requirement, stable backup link |
| **Moderate** | **500 ms**    | **10% (0.10)** | **30 s**       | **General offshore use (default)** |
| Conservative | 800 ms        | 20% (0.20)     | 60 s           | Avoid flapping on variable links |

Start with **Moderate** and adjust based on how often you see failovers.

### Monitoring bonding state

```bash
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding | jq .
```

```json
{
  "enabled": true,
  "mode": "main-backup",
  "activeLink": "primary",
  "lastFailoverTime": 0,
  "links": {
    "primary": {
      "status": "active",
      "rtt": 42,
      "loss": 0.01,
      "quality": 97
    },
    "backup": {
      "status": "standby",
      "rtt": 118,
      "loss": 0.02,
      "quality": 88
    }
  }
}
```

### Manual failover

```bash
# Switch to the other link
curl -s -X POST \
  -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/bonding/failover | jq .
```

### Signal K notification on failover

When failover occurs, a notification fires at:
`notifications.signalk-edge-link.<connectionName>.linkFailover`

with `state: "alert"` and both `visual` and `sound` methods.

---

## 11. Multi-Connection Setup

A single plugin instance can run multiple connections concurrently. Each runs independently with its own UDP socket, retransmit queue, congestion controller, and metrics.

### Example: one server + two clients

A relay or aggregator might receive from one vessel and send to two different shore destinations:

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

Each connection has:
- Its own encryption key (they can differ)
- Its own UDP port (they must not share ports within the same protocol type)
- Its own retransmit queue and congestion state
- Its own metrics and alert thresholds
- Its own runtime config files under `<dataDir>/signalk-edge-link/<connectionName>/`

---

## 12. Encryption and Key Management

### Key formats

Three formats are accepted. All produce a 256-bit AES key:

| Format          | Length       | Example                                                              | Notes |
|-----------------|--------------|----------------------------------------------------------------------|-------|
| **32-char ASCII** | 32 bytes    | `MySecretKey12345678901234567890`                                    | Easiest to type; use `stretchAsciiKey: true` for full security |
| **64-char hex**   | 32 bytes    | `a3f1e2d4b5c6078901234567890abcdef1234567890abcdef1234567890abcde1` | Full 256-bit entropy directly |
| **44-char base64**| 32 bytes    | `o/HitLXG8AmQEjRWeJCrzvEjRZVwmkrN5TI9Xabc12s=`                    | Full 256-bit entropy directly |

### Generating a secure key

```bash
# 64-character hex key (recommended)
openssl rand -hex 32

# 44-character base64 key
openssl rand -base64 32

# 32-character ASCII key (use stretchAsciiKey: true with this)
openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
```

### Key stretching (stretchAsciiKey)

A 32-character ASCII key has at most ~208 bits of raw entropy (not all 256 bits are used, due to printable ASCII range). Setting `stretchAsciiKey: true` routes the key through **PBKDF2-SHA256** (600,000 iterations, salt `signalk-edge-link-v1`) before use as the AES key. This restores full 256-bit AES strength and makes offline brute-force very expensive.

```json
{
  "secretKey": "MySecretKey12345678901234567890",
  "stretchAsciiKey": true
}
```

**Both peers must have the same `stretchAsciiKey` setting.** A mismatch causes every packet to fail authentication and be dropped silently.

The derived key is cached per process — no steady-state performance penalty.

### Security properties and limitations

| Property                      | Status   | Details |
|-------------------------------|----------|---------|
| Data confidentiality          | ✓ Strong | AES-256-GCM |
| Data integrity                | ✓ Strong | GCM auth tag (16 bytes) |
| Replay protection             | ✓ Partial | Sequence numbers + duplicate detection |
| Control packet authentication | v3 only  | HMAC-SHA256; v2 uses CRC only |
| Forward secrecy               | ✗ None   | No key agreement; same key for all time |
| Client authentication         | ✗ None   | Any holder of the key can connect |
| Compression side-channel      | ✗ Low risk | Brotli before encryption — size observable |

### Key rotation

There is no online key rotation. To rotate:

1. Update `secretKey` on both ends simultaneously
2. Restart the plugin on both ends
3. During the transition window, packets encrypted with the old key will be dropped

### Firewall hardening

Restrict UDP ingress to known source addresses when possible:

```bash
# UFW — allow only from known vessel IP
ufw allow from <VESSEL_IP> to any port 4446 proto udp
ufw deny 4446/udp

# iptables
iptables -A INPUT -p udp --dport 4446 -s <VESSEL_IP> -j ACCEPT
iptables -A INPUT -p udp --dport 4446 -j DROP
```

If the vessel IP is dynamic (cellular), restrict by the operator's APN subnet, or deploy a VPN to provide a stable peer address.

---

## 13. Monitoring and Metrics

### Signal K paths published by the plugin

The plugin publishes link telemetry to the local Signal K tree under `networking.edgeLink.*`:

| Signal K path                                    | Type           | Unit    | Description |
|--------------------------------------------------|----------------|---------|-------------|
| `networking.modem.rtt`                           | number         | seconds | v1 external ping RTT |
| `networking.edgeLink.rtt`                        | number         | ms      | v2/v3 heartbeat RTT |
| `networking.edgeLink.jitter`                     | number         | ms      | RTT variance |
| `networking.edgeLink.packetLoss`                 | number         | ratio   | Packet loss (0–1) |
| `networking.edgeLink.retransmitRate`             | number         | ratio   | Retransmit rate (0–1) |
| `networking.edgeLink.linkQuality`                | number         | 0–100   | Composite link quality score |
| `networking.edgeLink.queueDepth`                 | number         | packets | Retransmit queue depth |
| `networking.edgeLink.throughput.out`             | number         | bytes/s | Outbound throughput |
| `networking.edgeLink.throughput.in`              | number         | bytes/s | Inbound throughput |
| `networking.edgeLink.bonding.activeLink`         | string         | —       | `"primary"` or `"backup"` |
| `notifications.signalk-edge-link.<name>.*`       | notification   | —       | Alert events |

### HTTP API endpoints

**Base path:** `http://<host>:3000/plugins/signalk-edge-link`

**Default rate limit:** 120 requests/minute/IP

| Method | Endpoint                              | Description |
|--------|---------------------------------------|-------------|
| GET    | `/metrics`                            | All connections: deltas, bytes, errors, compression ratio |
| GET    | `/network-metrics`                    | All connections: RTT, jitter, packet loss, retransmit rate |
| GET    | `/connections`                        | List all configured connections |
| GET    | `/instances`                          | List all running instances with state |
| GET    | `/instances/:id`                      | Single instance details |
| GET    | `/bonding`                            | Bonding state for all instances |
| POST   | `/bonding`                            | Update failover thresholds |
| POST   | `/bonding/failover`                   | Manual link switch |
| GET    | `/congestion`                         | Congestion control state |
| POST   | `/delta-timer`                        | Set or clear manual timer override |
| GET    | `/monitoring/alerts`                  | Current alert status |
| GET    | `/prometheus`                         | Prometheus-format metrics |
| GET    | `/connections/:id/metrics`            | Per-connection metrics |
| GET    | `/connections/:id/network-metrics`    | Per-connection network quality |
| POST   | `/capture/start`                      | Start packet capture |
| GET    | `/capture`                            | Packet capture statistics |
| GET    | `/capture/export`                     | Export packet capture |

### Quick health check commands

```bash
HOST=http://localhost:3000/plugins/signalk-edge-link
TOKEN="your-token"

# Overall metrics
curl -s -H "X-Edge-Link-Token: $TOKEN" $HOST/metrics | jq .

# Network quality (RTT, loss, jitter)
curl -s -H "X-Edge-Link-Token: $TOKEN" $HOST/network-metrics | jq .

# Bonding status
curl -s -H "X-Edge-Link-Token: $TOKEN" $HOST/bonding | jq .

# Congestion control state
curl -s $HOST/congestion | jq .

# Alert status
curl -s -H "X-Edge-Link-Token: $TOKEN" $HOST/monitoring/alerts | jq .

# Prometheus text format
curl -s $HOST/prometheus
```

### Prometheus integration

The `/prometheus` endpoint outputs standard Prometheus text format:

```
# HELP signalk_edge_link_rtt_ms Round-trip time in milliseconds
# TYPE signalk_edge_link_rtt_ms gauge
signalk_edge_link_rtt_ms{connection="vessel-client"} 42.3

# HELP signalk_edge_link_packet_loss Packet loss ratio (0-1)
# TYPE signalk_edge_link_packet_loss gauge
signalk_edge_link_packet_loss{connection="vessel-client"} 0.002

# HELP signalk_edge_link_deltas_sent_total Total deltas sent
# TYPE signalk_edge_link_deltas_sent_total counter
signalk_edge_link_deltas_sent_total{connection="vessel-client"} 148293
```

A starter Grafana dashboard is included at `grafana/dashboards/edge-link.json`.

### Configuring alert thresholds

```json
{
  "alertThresholds": {
    "rtt": {
      "warning": 300,
      "critical": 800
    },
    "packetLoss": {
      "warning": 0.03,
      "critical": 0.10
    },
    "retransmitRate": {
      "warning": 0.05,
      "critical": 0.15
    },
    "jitter": {
      "warning": 100,
      "critical": 300
    },
    "queueDepth": {
      "warning": 100,
      "critical": 500
    }
  }
}
```

---

## 14. Management API and CLI

### Authentication

Management endpoints require a token when `managementApiToken` is configured:

```bash
# Via header (recommended)
curl -H "X-Edge-Link-Token: $TOKEN" ...

# Via Authorization header
curl -H "Authorization: Bearer $TOKEN" ...

# Via URL parameter (less secure — token in server logs)
curl "http://localhost:3000/plugins/signalk-edge-link/instances?edgeLinkToken=$TOKEN"
```

Set the token in plugin configuration:
```json
{ "managementApiToken": "your-long-random-token" }
```

Or via environment variable:
```bash
export SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN="your-long-random-token"
```

### Web UI token injection

When the management UI is served with server-side token injection:

```javascript
// Preferred: inject via global at page load
window.__EDGE_LINK_AUTH__ = {
  token: "your-token",
  headerMode: "both"  // "both" | "authorization" | "x-edge-link-token"
};
```

Alternative: store in `localStorage`:
```javascript
localStorage.setItem("signalkEdgeLinkManagementToken", "your-token");
```

### CLI tool

The plugin includes a command-line management tool:

```bash
# List running instances (table format)
npm run cli -- instances list \
  --token=$EDGE_LINK_TOKEN \
  --state=running \
  --format=table

# Show a specific instance
npm run cli -- instances show vessel-client \
  --token=$EDGE_LINK_TOKEN \
  --format=table

# Create a new instance from a JSON config
npm run cli -- instances create \
  --config ./my-connection.json \
  --token=$EDGE_LINK_TOKEN

# Update an instance field
npm run cli -- instances update vessel-client \
  --patch '{"udpAddress":"10.0.0.2"}' \
  --token=$EDGE_LINK_TOKEN

# Delete an instance
npm run cli -- instances delete vessel-client \
  --token=$EDGE_LINK_TOKEN

# Bonding status
npm run cli -- bonding status \
  --token=$EDGE_LINK_TOKEN \
  --format=table

# Update bonding thresholds
npm run cli -- bonding update \
  --patch '{"failoverThreshold":300}' \
  --token=$EDGE_LINK_TOKEN

# Overall plugin status
npm run cli -- status --token=$EDGE_LINK_TOKEN --format=table
```

### Config migration (legacy to v2 format)

Older versions used a flat config object. Migrate to the `connections[]` array format:

```bash
npm run migrate:config -- old-config.json new-config.json
```

---

## 15. Complete Example Configurations

### Example 1 — Minimal v1 (simplest possible)

Suitable for: stable LAN link, no retransmission needed, lowest overhead.

**Server (shore):**
```json
{
  "connections": [{
    "name": "shore-server",
    "serverType": "server",
    "udpPort": 4446,
    "secretKey": "MySecretKey12345678901234567890",
    "protocolVersion": 1
  }]
}
```

**Client (vessel):**
```json
{
  "connections": [{
    "name": "vessel-client",
    "serverType": "client",
    "udpAddress": "192.168.1.100",
    "udpPort": 4446,
    "secretKey": "MySecretKey12345678901234567890",
    "protocolVersion": 1,
    "testAddress": "8.8.8.8",
    "testPort": 53,
    "pingIntervalTime": 1
  }]
}
```

---

### Example 2 — Production v3 server (shore side)

Suitable for: shore aggregator receiving from multiple vessels with authenticated control packets.

```json
{
  "managementApiToken": "long-random-management-token-here",
  "requireManagementApiToken": true,
  "connections": [{
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
  }]
}
```

---

### Example 3 — Production v3 client with congestion control (vessel side)

Suitable for: vessel on cellular/satellite sending to the shore server above.

```json
{
  "managementApiToken": "long-random-management-token-here",
  "connections": [{
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
  }]
}
```

---

### Example 4 — Dual-link bonding (LTE + Starlink)

Suitable for: offshore vessel with two uplinks and maximum resilience.

**Vessel (client with bonding):**
```json
{
  "connections": [{
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
  }]
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

## 16. Performance Tuning

### Smart batching and compression

The plugin dynamically sizes packets to stay under 1400 bytes (85% of UDP MTU) using an exponential moving average of bytes per delta:

| Batch size | Raw JSON | After Brotli | Ratio  | Bytes/delta |
|------------|----------|--------------|--------|-------------|
| 1 delta    | 221 B    | 193 B        | 1.1×   | 193 B       |
| 5 deltas   | 1.1 KB   | 227 B        | 5.0×   | 45 B        |
| 10 deltas  | 2.3 KB   | 253 B        | 9.1×   | 25 B        |
| 20 deltas  | 4.5 KB   | 341 B        | 13.6×  | 17 B        |
| 50 deltas  | 11.3 KB  | 537 B        | 21.6×  | 11 B        |

Larger batches = better compression. Increase `deltaTimer` on bandwidth-constrained links.

### Processing latency per stage

| Stage           | p50      | p95      | p99      |
|-----------------|----------|----------|----------|
| Serialize       | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt         | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build    | 0.001 ms | 0.002 ms | 0.009 ms |
| Full TX→RX      | 1.076 ms | 1.446 ms | 2.067 ms |

Compression dominates processing cost. High delta rates on constrained hardware → increase `deltaTimer`.

### Deployment profiles

#### Raspberry Pi 3/4 (vessel node, constrained CPU)

```json
{
  "protocolVersion": 3,
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

- `deltaTimer` ≥ 250 ms — less frequent Brotli compression
- Enable `useMsgpack` and `usePathDictionary` to reduce Brotli input size
- Monitor RSS: normal 30–80 MB; investigate if > 150 MB

#### x86 / ARM64 shore server

```json
{
  "protocolVersion": 3,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 100,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 2000
  }
}
```

- Low `deltaTimer` (100–250 ms) for low-latency feeds
- Congestion control with `targetRTT: 100` for LAN-speed connections

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

Also add `sentence_filter.json` to exclude high-frequency NMEA sentences (GSV, GSA, GLL).

- High `deltaTimer` (2000–5000 ms) maximizes compression ratio
- `targetRTT: 800` prevents constant congestion decisions on a high-RTT link
- Both `useMsgpack` and `usePathDictionary` reduce per-packet size before compression

### Performance tuning summary

| Link type     | `deltaTimer` | `useMsgpack` | `usePathDictionary` | `targetRTT` | Notes |
|---------------|-------------|-------------|-------------------|-------------|-------|
| Local LAN     | 100–250 ms  | optional    | optional          | 50 ms       | v1 is fine here |
| LTE (good)    | 250–500 ms  | yes         | yes               | 150–200 ms  | Enable congestion control |
| LTE (variable)| 500–1000 ms | yes         | yes               | 300 ms      | Increase `maxDeltaTimer` |
| Satellite     | 2000–5000 ms| yes         | yes               | 700–1000 ms | Filter NMEA sentences too |
| Starlink (low)| 500–1000 ms | yes         | yes               | 200–400 ms  | Comparable to LTE |

---

## 17. Troubleshooting

### Quick diagnostic checklist

Before investigating specific issues:

1. Both ends running same plugin version? (`npm list signalk-edge-link`)
2. Encryption keys identical on both sides? (32 ASCII, 64 hex, or 44 base64)
3. UDP port open in firewall? (`ufw status` or `iptables -L`)
4. Plugin enabled in Signal K Admin UI?
5. Node.js ≥ 16? (`node --version`)

### Encryption / decryption errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unsupported state or unable to authenticate data` | Key mismatch | Verify keys are identical, same format, same `stretchAsciiKey` setting |
| `Secret key must be exactly 32 characters` | Wrong key length | Use exactly 32 ASCII chars, 64 hex chars, or 44 base64 chars |
| `Key lacks sufficient diversity` | Key too simple | Use `openssl rand -hex 32` to generate a proper key |
| Persistent decryption errors after key change | One end not restarted | Restart plugin on both ends after any key change |

### Connection errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED` | Server not listening or wrong port | Verify server is running; check `udpPort` matches both ends |
| `ENETUNREACH` | No route to host | Check network connectivity |
| `testAddress is only supported on v1 clients` | v1-only fields in v2/v3 config | Remove `testAddress`, `testPort`, `pingIntervalTime` from v2/v3 connections |
| `Invalid magic bytes` | v1 client sending to v2/v3 server | Set same `protocolVersion` on both ends |
| Protocol version mismatch warning | Mismatched `protocolVersion` | Set same version on both ends and restart both |

### No data flowing

**Client side checks:**
```bash
# Is the client sending anything?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq .deltasSent

# Is the delta timer running?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq .readyToSend

# Are there encryption errors?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq .encryptionErrors
```

**Server side checks:**
```bash
# Is the server receiving anything?
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq .deltasReceived

# Are there decryption errors?
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq .decryptionErrors
```

### Bonding not failing over

| Symptom | Check |
|---------|-------|
| Failover not triggering despite bad primary | Verify `bonding.enabled: true`; check backup is not also `"down"` in `GET /bonding` |
| Backup shows `"down"` | Ensure UDP is allowed bidirectionally; server must echo HEARTBEAT probes |
| Frequent failover/failback (flapping) | Increase `failbackDelay` (try 60 s); increase `rttThreshold` |
| `POST /bonding` returns 400 | Check field names and ranges against [Section 7.7](#77-connection-bonding-client-v2v3-only) |

### Congestion control not adapting

| Symptom | Check |
|---------|-------|
| Timer stays at `maxDeltaTimer` | Your `targetRTT` is below link's actual RTT — increase it |
| Timer not moving at all | Verify `congestionControl.enabled: true`; check `GET /congestion` for `manualMode: false` |
| Timer oscillates rapidly | Link RTT hovering near `targetRTT` — increase `targetRTT` by 20–30% |

### Poor compression ratio

- Increase `deltaTimer` (more deltas per batch = better compression)
- Enable `useMsgpack: true` and `usePathDictionary: true`
- Add `sentence_filter.json` to exclude high-frequency NMEA sentences
- Verify `oversizedPackets` counter stays 0 (no fragmentation)

### High memory usage

Normal bounded memory:
- Retransmit queue: up to 5000 × ~1400 bytes ≈ 7 MB
- Monitoring history: bounded at 60/200/120 entries
- Delta buffer: max 1000 entries

If RSS exceeds 150 MB and keeps growing, report an issue with your configuration and `GET /metrics` output.

---

## 18. Developer Reference

### Build and test

```bash
npm run build          # TypeScript compile + webpack (web UI)
npm run dev            # Watch mode (TypeScript)
npm test               # All unit tests
npm run test:v2        # v2 protocol tests only
npm run test:integration  # End-to-end pipeline tests
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
```

### Source file map

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry point; creates instance registry, registers Express routes, handles start/stop lifecycle |
| `src/types.ts` | All TypeScript interfaces: Delta, ConnectionConfig, Metrics, InstanceState, packet constants |
| `src/connection-config.ts` | Configuration validation and normalization |
| `src/constants.ts` | All tuning constants (MTU, buffer sizes, timeouts, retry counts) |
| `src/instance.ts` | Single connection lifecycle: subscribes, batches deltas, manages socket, drives monitoring |
| `src/pipeline.ts` | v1 protocol: compress → encrypt → send (client); receive → decrypt → decompress → inject (server) |
| `src/pipeline-v2-client.ts` | v2/v3 client: packet building, retransmit queue, ACK/NAK handling, congestion hook |
| `src/pipeline-v2-server.ts` | v2/v3 server: packet parsing, per-client sessions, ACK/NAK generation, heartbeat response |
| `src/pipeline-factory.ts` | Selects pipeline based on `serverType` and `protocolVersion` |
| `src/pipeline-utils.ts` | Shared Brotli, encryption, UDP send utilities |
| `src/packet.ts` | v2/v3 header encode/decode; magic/version/type/flags/sequence/CRC validation |
| `src/retransmit-queue.ts` | Bounded queue for retransmit candidates; timeout-based eviction; RTT-scaled retry |
| `src/sequence.ts` | Sequence number tracking, gap detection, NAK scheduling (server side) |
| `src/congestion.ts` | AIMD congestion control; adjusts delta timer every 5 s based on RTT/loss |
| `src/bonding.ts` | Primary/backup link health monitoring; automatic failover/failback |
| `src/crypto.ts` | AES-256-GCM encrypt/decrypt; PBKDF2 key derivation; HMAC (v3) |
| `src/delta-sanitizer.ts` | Strip own telemetry; validate paths; normalize outbound deltas |
| `src/pathDictionary.ts` | Bidirectional Signal K path ↔ 2-byte numeric ID encoding |
| `src/metadata.ts` | Collect/diff Signal K path metadata; package for transmission; update receiver schema |
| `src/values-snapshot.ts` | Capture full current Signal K state for FULL_STATUS_REQUEST replay |
| `src/source-replication.ts` | Server-side registry tracking source identities across clients |
| `src/source-dispatch.ts` | Normalize delta source references for correct Signal K routing |
| `src/metrics.ts` | Per-instance metrics accumulation: deltas, bytes, errors, path stats |
| `src/metrics-publisher.ts` | Publish link metrics to Signal K (`networking.edgeLink.*`) |
| `src/monitoring.ts` | Packet loss heatmap, path latency tracking, retransmit charts, alert thresholds |
| `src/routes.ts` | Route dispatcher; management auth; rate limiting |
| `src/routes/metrics.ts` | `/metrics`, `/network-metrics`, `/prometheus` endpoints |
| `src/routes/config.ts` | `/plugin-config`, `/connections/:id/config/*` endpoints |
| `src/routes/connections.ts` | `/connections`, `/instances` endpoints |
| `src/routes/control.ts` | `/bonding/failover`, `/delta-timer` endpoints |
| `src/routes/monitoring.ts` | `/monitoring/alerts`, packet capture endpoints |
| `src/prometheus.ts` | Prometheus metrics exporter |
| `src/config-io.ts` | Load/save runtime JSON config files |
| `src/config-watcher.ts` | File system watcher; debounce and reload on modification |
| `src/CircularBuffer.ts` | Fixed-size circular buffer for metrics history |
| `src/bin/edge-link-cli.ts` | CLI tool: instance/bonding management, config migration |
| `src/scripts/migrate-config.ts` | Migrate legacy flat config to `connections[]` format |
| `src/shared/connection-schema.ts` | Single source of truth for plugin config schema |
| `src/webapp/` | React management UI source (compiled to `public/`) |

### Key functions

| Function | File | What it does |
|----------|------|-------------|
| `processDelta()` | `instance.ts` | Receives a raw Signal K delta; filters, deduplicates, buffers, and triggers batching |
| `flushDeltaBatch()` | `instance.ts` | Takes buffered deltas, serializes, compresses, encrypts, sends via the active pipeline |
| `sendDelta()` | `pipeline-v2-client.ts` | v2/v3: builds a DATA packet, adds to retransmit queue, sends via UDP |
| `parsePacket()` | `pipeline-v2-server.ts` | v2/v3: validates header, decrypts, dispatches by packet type |
| `onDataPacket()` | `pipeline-v2-server.ts` | Processes a decrypted DATA payload: sequence tracking, delta injection, ACK scheduling |
| `normalizeKey()` | `crypto.ts` | Converts any of the three key formats to a raw 32-byte Buffer |
| `encodeDelta()` | `pathDictionary.ts` | Replaces Signal K path strings with numeric IDs in a delta |
| `decodeDelta()` | `pathDictionary.ts` | Reverses path dictionary encoding back to path strings |
| `RetransmitQueue.add()` | `retransmit-queue.ts` | Stores a packet copy for potential retransmission |
| `RetransmitQueue.acknowledge()` | `retransmit-queue.ts` | Removes all entries up to the cumulative ACK sequence |

### Configuration validation rules

The validator (`src/connection-config.ts`) enforces:

- `serverType` must be `"server"` or `"client"`
- `udpPort` must be an integer 1024–65535
- `secretKey` must match one of the three accepted formats
- `protocolVersion` must be 1, 2, or 3
- Server connections must not include `congestionControl`, `bonding`, `alertThresholds`, `udpAddress`, or `skipOwnData`
- v1 clients must not include `heartbeatInterval`; v2/v3 clients must not include `testAddress`, `testPort`, or `pingIntervalTime`
- Bonding: primary and backup must have different address:port pairs
- Reliability values must be within documented ranges
- Alert thresholds: `warning` ≤ `critical`; ratio metrics 0–1

---

*For detailed protocol specifications, see `docs/protocol-v2-spec.md` and `docs/protocol-v3-spec.md`. For the full configuration field reference with exact JSON Schema, see `docs/configuration-reference.md`.*
