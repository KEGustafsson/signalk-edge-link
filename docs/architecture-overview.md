# Signal K Edge Link — Architecture Overview

> System architecture, topology patterns, and data-flow pipelines.
> For installation and configuration, see [GUIDE.md](GUIDE.md).

---

## What It Does and Why

Signal K Edge Link transfers vessel navigation and sensor data between two Signal K server instances over encrypted UDP. It is built specifically for network paths where **bandwidth is limited, latency is variable, and packet loss happens** — cellular, satellite, and other WAN links.

### Why not use the built-in Signal K subscriptions?

Standard Signal K uses TCP/WebSocket subscriptions. These work well on reliable LAN connections but are poorly suited to:

- **Cellular roaming** — NAT mappings expire; connections drop silently
- **Satellite links** — High RTT and tiny bandwidth budgets; no adaptation
- **Multi-hop relay** — No mechanism to chain instances together
- **Bandwidth optimization** — No compression, no batching, no path deduplication

Signal K Edge Link solves each of these with UDP transport, Brotli compression, AES-256-GCM encryption, and (in Advanced mode) a reliability layer with ACK/NAK retransmission, congestion control, and dual-link failover.

### Protocol modes at a glance

| Mode         | Numeric | Best for                                       | Key features                                                                 |
| ------------ | ------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **Basic**    | v1      | Stable local links, simplest setup             | Encrypted UDP, Brotli compression. No retransmission or reliability metrics. |
| **Advanced** | v3      | WAN links with packet loss or variable latency | ACK/NAK reliability, congestion control, bonding, HMAC authentication        |

**Recommendation:** Use **Advanced (v3)** for any new deployment. Fall back to **Basic (v1)** only for stable local links where simplicity matters more than reliability.

---

## System Architecture

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

## How Data Flows

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
 │ (v3)             │  with magic, version, type, flags, seq, CRC
 └──────────┬───────┘
            │
            ▼
 ┌──────────────────┐
 │ Retransmit queue │  v3: store copy for possible retransmission
 │ (v3)             │  (up to 5000 entries)
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
 │ (v3)             │  Silently discard on mismatch
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
 │ decode (v3)      │
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

## Source Layer Map

The plugin is organized into a layered architecture under `src/`:

| Layer           | Path              | Responsibility                                             |
| --------------- | ----------------- | ---------------------------------------------------------- |
| Foundation      | `src/foundation/` | Types, constants, config I/O, CircularBuffer               |
| Codec           | `src/codec/`      | Crypto, packet codec, compression, path dictionary         |
| Transport       | `src/transport/`  | UDP socket, pipelines (v1/v3), reliability, congestion     |
| Domain services | `src/domain/`     | Subscription, delta batching, bonding, metrics, monitoring |
| Application     | `src/app/`        | Connection FSM, connection manager, config watcher         |
| Interface       | `src/routes/`     | REST API routes, auth, rate limiting                       |
| Web UI          | `src/webapp/`     | React management dashboard                                 |

For the complete source file map and key function index, see [GUIDE.md §20](GUIDE.md#20-developer-reference).
