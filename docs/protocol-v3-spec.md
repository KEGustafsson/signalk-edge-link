# Signal K Edge Link Protocol v3.0 Specification

## 1. Introduction

The Signal K Edge Link Protocol v3.0 is a binary UDP protocol designed for reliable, bandwidth-efficient transmission of Signal K delta data between vessels and shore servers. It operates in challenging maritime network environments including cellular edge areas, satellite links, and multi-path connections.

The v3 protocol adds a comprehensive binary packet header layer to the v1 (Basic) encryption/compression pipeline, enabling:

- **Sequence tracking** for packet loss detection
- **Packet type differentiation** (DATA, ACK, NAK, HEARTBEAT, HELLO)
- **Flag-based feature negotiation** (compression, encryption, msgpack, path dictionary)
- **CRC16 integrity checking** at the header level
- **HMAC-SHA256 authentication** on all control packets
- **ACK/NAK retransmission** for reliable delivery (>99.9% at 5% loss)
- **Dynamic congestion control** using AIMD algorithm
- **Connection bonding** with automatic failover between primary/backup links
- **Backward compatibility** with the v1 (Basic) protocol (auto-detection via magic bytes)

> **Protocol history.** An earlier reliable-transport version (v2) used a CRC-only,
> unauthenticated control plane. It was removed in 3.0.0 because any host that could
> reach the UDP port could forge control packets. On the wire the node now speaks v3
> only; a stored `protocolVersion: 2` is accepted for config back-compat and silently
> coerced to `3`. See §5.

## 2. Packet Format

All multi-byte integers are big-endian (network byte order).

### Wire Format

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Magic (0x534B = "SK")    |   Version     |     Type      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Flags     |                Sequence Number                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Seq (cont.)  |              Payload Length                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| PLen (cont.)  |           CRC16 (CCITT)       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                      Payload (variable)                       |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### Header Fields (15 bytes total)

| Offset | Size    | Field    | Description                                  |
| ------ | ------- | -------- | -------------------------------------------- |
| 0      | 2 bytes | Magic    | `0x53 0x4B` ("SK") - identifies v3 packets   |
| 2      | 1 byte  | Version  | `0x03` for v3 protocol                       |
| 3      | 1 byte  | Type     | Packet type (see section 3)                  |
| 4      | 1 byte  | Flags    | Feature flags (see section 4)                |
| 5      | 4 bytes | Sequence | Packet sequence number (uint32, big-endian)  |
| 9      | 4 bytes | Length   | Payload length in bytes (uint32, big-endian) |
| 13     | 2 bytes | CRC16    | CRC-CCITT checksum of header bytes 0-12      |

## 3. Packet Types

| Value | Name                | Direction       | Description                                                        | Payload                             |
| ----- | ------------------- | --------------- | ------------------------------------------------------------------ | ----------------------------------- |
| 0x01  | DATA                | Client → Server | Signal K delta data                                                | Encrypted/compressed delta          |
| 0x02  | ACK                 | Server → Client | Cumulative acknowledgement                                         | uint32 acked sequence + HMAC tag    |
| 0x03  | NAK                 | Server → Client | Negative acknowledgement                                           | Array of uint32 missing seqs + HMAC |
| 0x04  | HEARTBEAT           | Bidirectional   | Keep-alive                                                         | 16-byte HMAC tag only               |
| 0x05  | HELLO               | Client → Server | Connection establishment                                           | JSON with protocol info + HMAC tag  |
| 0x06  | METADATA            | Client → Server | Signal K path metadata (units, ...)                                | Encrypted/compressed meta envelope  |
| 0x07  | META_REQUEST        | Server → Client | Demand a fresh metadata snapshot                                   | 16-byte HMAC tag only               |
| 0x08  | FULL_STATUS_REQUEST | Server → Client | Demand a full values-snapshot replay (e.g. after a server restart) | 16-byte HMAC tag only               |
| 0x09  | HELLO_ACK           | Server → Client | Capability answer to HELLO; fleet keepalive (§15)                  | JSON + HMAC tag                     |
| 0x0A  | FLEET_DATA          | Server → Client | Other vessels' deltas (§15)                                        | stream id + encrypted delta + HMAC  |
| 0x0B  | FLEET_ACK           | Client → Server | Cumulative acknowledgement of FLEET_DATA (§15)                     | stream id + uint32 seq + HMAC       |
| 0x0C  | FLEET_NAK           | Client → Server | Missing FLEET_DATA sequences (§15)                                 | stream id + uint32[] + HMAC         |

### DATA Packet

Carries Signal K delta data through the processing pipeline:

1. Delta batch collected (1-50 deltas per batch)
2. Serialized (JSON or MessagePack)
3. Optionally path-encoded (path dictionary)
4. Compressed (Brotli quality 10)
5. Encrypted (AES-256-GCM with unique IV)

The resulting ciphertext is the packet payload. Wire format of the encrypted payload:

```
[IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]
```

Total per-packet overhead: 15 bytes (header) + 28 bytes (encryption) = 43 bytes.

### ACK Packet

Payload: 4 bytes containing the uint32 cumulative acknowledged sequence number, followed by a 16-byte HMAC-SHA256 authentication tag (see §5). All packets up to and including this sequence have been received.

ACKs are sent periodically by the server to confirm receipt. The client uses cumulative ACKs to clear its retransmission queue.

### NAK Packet

Payload: N × 4 bytes (each uint32 a missing sequence number) followed by a 16-byte HMAC-SHA256 authentication tag (see §5). Sent when the receiver detects gaps in the sequence. The client retransmits the requested packets from its retransmission queue.

Retransmission limits:

- Maximum retransmit attempts per packet: 3
- Retransmit queue capacity: 5,000 packets
- Packets exceeding max attempts are discarded

### HEARTBEAT Packet

Payload: a 16-byte HMAC-SHA256 authentication tag only. Sent periodically to indicate the connection is alive. The default heartbeat interval is 60 seconds, configurable from 10 to 3,600 seconds.

### HELLO Packet

Payload: JSON string with connection metadata, followed by a 16-byte HMAC-SHA256 authentication tag (see §5):

```json
{
  "protocolVersion": 3,
  "clientId": "vessel-xxx",
  "timestamp": 1707321234567
}
```

`timestamp` is milliseconds since the epoch by the client's clock, strictly increasing across the HELLOs of one client process: a HELLO in the same millisecond as the previous one, or after a backward clock step, carries the previous value plus 1. §15.7 relies on this.

Sent at connection establishment to identify the client and negotiate
protocol version, retried with exponential backoff until any control packet
proves the server holds a session for this source port. The client also
re-sends HELLO on a fixed cadence (every 5 minutes) on a live link: a server
that restarts faster than the ACK-idle rehandshake threshold under continuous
traffic re-mints its session from the first DATA packet — with no client
identity and no epoch — and resumes ACKing immediately, so no silence-based
trigger ever fires. HELLO is idempotent server-side, so the refresh bounds
that identity/anti-replay loss to one cadence interval.

### METADATA Packet (0x06)

Optional packet type carrying Signal K path metadata (`units`, `description`,
`zones`, `displayName`, ...) so the server can populate `updates[].meta[]` for
the local Signal K instance.

**Sequence space.** METADATA carries an independent uint32 sequence number
that does not advance the DATA sequence counter. METADATA is therefore outside
the cumulative ACK/NAK stream — losing or reordering METADATA never generates
spurious DATA NAKs.

**Reliability.** METADATA is **not** ACK/NAK'd. Loss is recovered at the
application level by:

- Periodic full-snapshot resend at `intervalSec` cadence
- Server-initiated `META_REQUEST` (0x07) on first contact from a new session
- Sender-restart detection: a receiver MUST treat an incoming envelope with
  `seq == 0` as a sender-lifecycle reset (clear any per-session
  `lastMetaEnvSeq` / chunk-replay state) rather than dropping it as stale,
  so a freshly-restarted sender's first envelope is accepted.
- Anti-replay: the receiver keeps a per-peer sliding window over the METADATA
  **header** sequence (a separate window from DATA, since the sequence spaces
  are independent) that survives session idle expiry and eviction. It is
  enforced under the same rules as the DATA window — only once the peer's
  epoch handshake has armed the guard, re-baselined only on a strictly higher
  epoch — so a captured authentic METADATA datagram cannot be replayed after
  the live session (and its envelope-dedup state) is gone.

**Payload pipeline** (mirrors DATA):

```text
envelope → JSON|MessagePack → Brotli → AES-256-GCM
```

with the same flag bits (`COMPRESSED`, `ENCRYPTED`, `MESSAGEPACK`,
`PATH_DICTIONARY`).

**Envelope schema** (versioned):

```json
{
  "v": 1,
  "kind": "snapshot" | "diff",
  "seq": <uint32>,
  "idx": <uint32>,
  "total": <uint32>,
  "entries": [
    { "context": "vessels.urn:mrn:imo:mmsi:12345",
      "path": "navigation.speedOverGround",
      "meta": { "units": "m/s", "description": "Speed over ground" } },
    ...
  ]
}
```

- `v` — envelope schema version, currently `1`. Receivers MUST drop envelopes
  whose `v` they do not understand.
- `kind` — `"snapshot"` for a full re-broadcast (additive over `meta[path]`,
  not full-state replacement); `"diff"` for an incremental update derived from
  live `updates[].meta[]` events.
- `seq` — monotonic per sender, identifies the **batch**. Multi-chunk batches
  share one `seq`. Receivers MUST drop envelopes whose `seq` is behind the
  last-seen value in uint32 space (wrap-aware comparison: distance ≥ 0x80000000
  ⇒ stale).
- `idx`, `total` — chunk index / count within a batch. Receivers MAY apply
  chunks individually (current additive semantics) and MUST drop exact
  `(seq, idx)` replays within the same batch.
- `entries[].path` — string, or path-dictionary integer when the
  `PATH_DICTIONARY` flag is set on the packet header.

**Receiver semantics.** Each entry is dispatched to the local Signal K server
as a Signal K delta with `updates[].meta[]`:

```json
{
  "context": "<entry.context>",
  "updates": [{
    "timestamp": "<now>",
    "values": [],
    "meta": [{ "path": "<entry.path>", "value": <entry.meta> }]
  }]
}
```

Implementations SHOULD batch entries by context (one `app.handleMessage`
per context, not per entry) for snapshot efficiency.

### META_REQUEST Packet (0x07)

Control packet. Server → Client. Payload: a 16-byte HMAC-SHA256 tag (see §5).

Sent by the server **once per session** when a HELLO arrives, to demand an
immediate metadata snapshot rather than waiting up to `intervalSec` for the
client's next periodic resend.

The client SHOULD rate-limit its response to at most one snapshot per ~5
seconds to protect against malformed or hostile receivers spamming requests.

### FULL_STATUS_REQUEST Packet (0x08)

Control packet. Server → Client. Payload: a 16-byte HMAC-SHA256 tag (see §5).

Sent by the server **at most once per session**, on either trigger:
when the operator enabled `requestFullStatusOnRestart` and a HELLO (or first
DATA) from a client arrives, or — independent of that option — when a
value-dedup sentinel arrives for a path the session has no cached baseline
for, which is the signature of a receiver that lost its dedup cache (server
restart, session expiry/eviction) while the sender kept deduping; without the
replay those paths would stay absent until their values actually changed. The client
walks the current Signal K tree and replays every leaf as a synthetic
delta through the normal DATA pipeline — so a server that lost in-flight
state across a restart can rebuild it without waiting for the next live
update on each path.

The client rate-limits FULL_STATUS_REQUEST handling to at most one replay
per 10 seconds. In multi-hop proxy chains, when a client-mode instance
receives FULL_STATUS_REQUEST it MAY cascade the request to all clients
connected to a co-located server-mode instance, so a tree restart at the
top of the chain replays all the way to the leaves.

### METADATA Packet — Source Snapshot Variant

The METADATA packet type (0x06) also carries periodic source-tree
snapshots. The envelope is structurally identical to the metadata
envelope above, but uses `kind: "sources"` and replaces `entries` with a
`sources` object copied from the sender's `app.signalk.retrieve().sources`
tree. Receivers MUST verify both the envelope schema version (`v`) and
recognize `kind: "sources"`; unknown `kind` values are dropped.

A separate per-sender sequence counter (server-side) prevents source
resends from making in-flight metadata chunks look stale.

Receivers MUST validate the merged tree to prevent an authenticated
peer from polluting the local Signal K tree with arbitrary content:
provider keys are restricted to printable ASCII, key length and string-
value length are capped, the per-snapshot provider count is bounded,
and recursion depth is limited. Exact numeric limits are
implementation-defined.

### v1 metadata transport

The legacy v1 (Basic) wire format has no packet-type byte, so meta cannot be
multiplexed onto the DATA port without confusing existing v1 receivers.

**v1 therefore carries no metadata.** Metadata transport requires protocol v3,
which uses the METADATA packet type (`0x06`) on the main data port.

> An earlier design proposed a separate metadata UDP port (`udpMetaPort`) with
> the 4-byte ASCII magic `SKM1` prefixed inside the encrypted plaintext. It was
> never implemented — no such option exists in the configuration schema or the
> runtime — and the documentation that described it has been removed.

## 4. Flags

Byte 4 of the header contains feature flags:

| Bit | Mask | Name                 | Description                                                                                                                                                                                                                          |
| --- | ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 0x01 | COMPRESSED           | Payload is Brotli compressed                                                                                                                                                                                                         |
| 1   | 0x02 | ENCRYPTED            | Payload is AES-256-GCM encrypted                                                                                                                                                                                                     |
| 2   | 0x04 | MESSAGEPACK          | Data serialized with MessagePack (vs JSON)                                                                                                                                                                                           |
| 3   | 0x08 | PATH_DICTIONARY      | Paths encoded with path dictionary                                                                                                                                                                                                   |
| 4   | 0x10 | AUTHENTICATED_HEADER | DATA/METADATA carry a trailing HMAC tag binding the header to the AEAD ciphertext (default on in v3; both peers must use the same `authenticatedHeaders` setting)                                                                    |
| 5   | 0x20 | EPOCH_BOUND_AUTH     | The trailing HMAC tag additionally covers the sender's connection epoch (see §5.1). Opt-in via `epochBoundAuth`; both peers must agree and both must run 4.0.0+. Never set on HELLO, which is the packet that establishes the epoch. |
| 6-7 | -    | Reserved             | Must be 0                                                                                                                                                                                                                            |

Both client and server must agree on flag settings via configuration. Mismatched flags will cause decoding failures.

## 5. CRC16 Checksum and Control-Packet Authentication

The CRC16 field in the 15-byte header uses the CRC-CCITT polynomial (0x1021) with initial value 0xFFFF.

The checksum is computed over header bytes 0 through 12 (everything except the CRC16 field itself). This provides header integrity verification without the overhead of checksumming the entire payload (DATA/METADATA payloads carry their own AES-GCM authentication tag).

Packets with invalid CRC16 are silently discarded.

### Control packet authentication — HMAC-SHA256

Every control packet (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST,
FULL_STATUS_REQUEST) carries a **16-byte truncated HMAC-SHA256 tag** (the
first 16 bytes of the 32-byte HMAC output) appended after the payload:

| Packet              | Base payload      | v3 payload (on the wire)             |
| ------------------- | ----------------- | ------------------------------------ |
| ACK                 | `uint32 ackedSeq` | `uint32 ackedSeq` + 16-byte HMAC tag |
| NAK                 | N × `uint32 seq`  | N × `uint32 seq` + 16-byte HMAC tag  |
| HEARTBEAT           | (empty)           | 16-byte HMAC tag only                |
| HELLO               | JSON payload      | JSON payload + 16-byte HMAC tag      |
| META_REQUEST        | (empty)           | 16-byte HMAC tag only                |
| FULL_STATUS_REQUEST | (empty)           | 16-byte HMAC tag only                |

The HMAC tag covers `header[0..12] ‖ payload`, keyed by the shared
`secretKey`. The header CRC16 remains in place for fast corruption detection.
DATA packets (type `0x01`) are unaffected — they are already authenticated by
the AES-256-GCM auth tag.

### 5.1 Epoch-bound authentication (optional)

When both peers enable `epochBoundAuth`, the tag additionally covers the
sender's **connection epoch** — the monotonic value the client advertises in its
HELLO — appended as a big-endian uint64:

```text
tag = HMAC-SHA256(secretKey, header[0..12] ‖ payload ‖ uint64(epoch))[0..15]
```

The width is 64 bits because the epoch is millisecond wall-clock scale
(`max(Date.now(), stored + 1)`), which does not fit in 32 bits. Truncating it
would make any two epochs 2^32 ms apart — just under 50 days — produce the same
tag, restoring the cross-epoch replay this binding exists to prevent.

Packets carrying an epoch-bound tag set the `EPOCH_BOUND_AUTH` flag (bit 5).
The flag is inside the HMAC-covered header, so an attacker cannot strip it to
force a downgrade: clearing the bit changes the authenticated bytes and the tag
no longer verifies.

**HELLO is always exempt.** It is the packet that establishes the epoch, so the
receiver has no value to verify against until it has been processed.

**What this closes.** Anti-replay enforcement arms only once a peer completes
the epoch handshake. Without epoch binding, a packet replayed from a source
address the receiver has never seen lands on a freshly-created anti-replay guard
whose epoch is 0 — there is nothing to enforce against, so the replay is
accepted. Binding the epoch makes a captured packet authenticate _only_ inside
the epoch it was sent in: a receiver with no established epoch for the source
has no valid value to verify with, and a receiver whose peer has since restarted
holds a newer epoch. Replays across a restart and replays from spoofed sources
both fail authentication.

**Compatibility.** Off by default. A peer that does not implement the flag
computes the tag without the epoch, so **both ends must enable it and both must
run 4.0.0 or later**; otherwise every packet fails authentication. It adds no
bytes on the wire.

### Why HMAC matters

A CRC trailer is **not** a security primitive. The removed v2 control plane used
CRC only, so any host that could reach the UDP port could mint a valid control
frame:

- A spoofed `HELLO` creates a server-side session.
- A spoofed `FULL_STATUS_REQUEST` triggers a full-tree snapshot replay toward the spoofed source address (usable as a reflection amplifier).
- A spoofed `NAK` causes spurious retransmissions.
- A spoofed `META_REQUEST` triggers a meta snapshot replay.

v3 closes all of these: forging a control frame requires knowledge of the
shared secret. Only a peer holding `secretKey` can mint a valid v3 control
frame. Use v1 (Basic, no reliability layer) only on trusted/private links.

## 6. Sequence Numbers

- Sequence numbers are unsigned 32-bit integers (0 to 4,294,967,295)
- DATA packets increment the sequence by 1 after each send
- ACK, NAK, HEARTBEAT, and HELLO packets use the current sequence without incrementing
- Sequence wraparound occurs from 0xFFFFFFFF back to 0x00000000

### Loss Detection

The receiver maintains a `SequenceTracker` that:

1. Expects sequences in order (0, 1, 2, ...)
2. Detects gaps when a higher-than-expected sequence arrives
3. Schedules NAK callbacks after a configurable timeout
4. Handles out-of-order delivery by buffering and advancing when contiguous
5. Detects and discards duplicate packets

### Retransmission

The sender maintains a `RetransmitQueue` that:

1. Stores a copy of each sent DATA packet (up to 5,000 packets)
2. On receiving a NAK, retransmits the requested sequences
3. Limits retransmission attempts to 3 per packet
4. Clears acknowledged packets on cumulative ACK receipt
5. Evicts oldest entries when queue reaches capacity

## 7. Reliability Mechanism

The protocol provides reliable delivery through a cumulative ACK / selective NAK scheme:

```
Client                          Server
  |                                |
  |--- HELLO (version, id) ------>|
  |                                |
  |--- DATA (seq=0, delta) ------>|
  |--- DATA (seq=1, delta) ------>|
  |--- DATA (seq=2, delta) ------>|
  |                                |
  |<--- ACK (seq=2) --------------|  (all received)
  |                                |
  |--- DATA (seq=3, delta) ------>|
  |--- DATA (seq=5, delta) ------>|  (seq 4 lost in transit)
  |                                |
  |<--- NAK ([4]) ----------------|  (gap detected)
  |                                |
  |--- DATA (seq=4, retransmit) ->|  (retransmitted)
  |                                |
  |<--- ACK (seq=5) --------------|  (all caught up)
  |                                |
  |--- HEARTBEAT ---------------->|  (periodic keep-alive)
```

**Delivery guarantees:**

- > 99.9% delivery rate under 5% packet loss conditions
- Automatic retransmission of lost packets
- Duplicate detection and suppression
- Cumulative acknowledgement reduces ACK traffic

## 8. Congestion Control

The protocol implements an AIMD (Additive Increase, Multiplicative Decrease) algorithm to dynamically adjust the delta timer (send interval) based on network conditions.

### Algorithm

The congestion controller evaluates network conditions every 5 seconds (configurable):

1. **Additive increase**: When packet loss < 1% AND RTT < target RTT, decrease the timer by 5% (increase send rate)
2. **Multiplicative decrease**: When packet loss > 5% OR RTT > 1.5× target RTT, increase the timer by 50% (decrease send rate)
3. **Neutral**: No change when conditions are moderate

### Smoothing

Network metrics (RTT and packet loss) are smoothed using an Exponential Moving Average (EMA) with alpha = 0.2:

```
avgRTT = 0.2 × currentRTT + 0.8 × previousAvgRTT
```

### Bounds

| Parameter               | Default  | Range             |
| ----------------------- | -------- | ----------------- |
| Minimum delta timer     | 100 ms   | 50 - 1,000 ms     |
| Maximum delta timer     | 5,000 ms | 1,000 - 30,000 ms |
| Target RTT              | 200 ms   | 50 - 2,000 ms     |
| Adjustment interval     | 5,000 ms | -                 |
| Max adjustment per step | 20%      | -                 |

### Manual Override

The delta timer can be manually set via the REST API, which disables automatic congestion control. Automatic mode can be re-enabled via the API.

## 9. Connection Bonding

Connection bonding provides dual-link redundancy with automatic failover between a primary and backup network connection (e.g., LTE + Starlink).

### Architecture

```
                    ┌─────────────────┐
                    │  Reliable       │
                    │  Client         │
                    └───────┬─────────┘
                            │
                    ┌───────▼─────────┐
                    │  Bonding        │
                    │  Manager        │
                    └───┬─────────┬───┘
                        │         │
               ┌────────▼──┐  ┌──▼────────┐
               │  Primary   │  │  Backup    │
               │  (LTE)     │  │  (Starlink)│
               │  UDP Socket│  │  UDP Socket│
               └────────────┘  └───────────┘
```

### Operating Mode: Main/Backup

- Primary link is active by default
- Backup link is in standby (health-monitored but not used for data)
- Failover triggers when primary exceeds thresholds
- Failback to primary after recovery + delay period

### Health Monitoring

Each link is independently monitored via heartbeat probes:

- Heartbeat probes sent every 1,000 ms (configurable)
- RTT measured from probe round-trip time
- Packet loss calculated from heartbeat response ratio
- Link quality score (0-100) computed from weighted RTT (40%) and loss (60%)
- Link marked DOWN after no response for 5,000 ms

### Failover Conditions

Failover from primary to backup triggers when ANY condition is met:

- Primary RTT > 500 ms (configurable)
- Primary packet loss > 10% (configurable)
- Primary link status = DOWN

### Failback Conditions

Failback from backup to primary requires ALL conditions:

- At least 30,000 ms since failover (prevents oscillation)
- Primary RTT < 400 ms (threshold × 0.8 hysteresis)
- Primary packet loss < 5% (threshold × 0.5 hysteresis)
- Primary link not DOWN

### Signal K Notifications

Failover events emit Signal K notifications at `notifications.signalk-edge-link.<instanceId>.linkFailover` with state `alert` and both visual and sound methods. The source label is `signalk-edge-link:<instanceId>`.

## 10. Security

### Encryption

All DATA payloads are encrypted with AES-256-GCM:

| Property    | Detail                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| Algorithm   | AES-256-GCM                                                                             |
| Key size    | 256 bits (32-byte secret: 32-character ASCII, 64-character hex, or 44-character base64) |
| IV          | 12 bytes, unique per message (random)                                                   |
| Auth tag    | 16 bytes, tamper detection                                                              |
| Wire format | `[IV (12B)][Encrypted Data][Auth Tag (16B)]`                                            |

### Key Requirements

- Exactly 32 characters (256 bits)
- Minimum 8 unique characters (entropy check)
- Must match on both client and server

### Security Properties

- **Confidentiality**: AES-256-GCM encryption
- **Integrity**: GCM authentication tag (16 bytes)
- **Control authentication**: HMAC-SHA256 on every control packet
- **Replay protection**: Sequence numbers with duplicate detection
- **Header integrity**: CRC16 checksum on packet headers
- **Outbound-only**: No open inbound ports required on the vessel

## 11. Performance Characteristics

### Compression

| Batch Size | Raw JSON | Compressed | Ratio  | Per-Delta |
| ---------- | -------- | ---------- | ------ | --------- |
| 1 delta    | 221 B    | 193 B      | 1.15x  | 193 B     |
| 5 deltas   | 1.1 KB   | 227 B      | 5.03x  | 45 B      |
| 10 deltas  | 2.3 KB   | 253 B      | 9.13x  | 25 B      |
| 20 deltas  | 4.5 KB   | 341 B      | 13.65x | 17 B      |
| 50 deltas  | 11.3 KB  | 537 B      | 21.59x | 11 B      |

### Latency (per stage, excluding network)

| Stage           | p50      | p95      | p99      |
| --------------- | -------- | -------- | -------- |
| Serialize       | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt         | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build    | 0.001 ms | 0.002 ms | 0.009 ms |
| Full TX→RX      | 1.076 ms | 1.446 ms | 2.067 ms |

### Smart Batching

UDP packets are kept under the MTU limit (1,400 bytes) using adaptive smart batching:

| Constant         | Value     | Purpose                                   |
| ---------------- | --------- | ----------------------------------------- |
| Safety margin    | 85%       | Target 85% of MTU (1,190 bytes effective) |
| Smoothing factor | 0.2       | Rolling average weight                    |
| Initial estimate | 200 bytes | Starting bytes-per-delta                  |
| Min deltas       | 1         | Always send at least 1                    |
| Max deltas       | 50        | Cap to prevent excessive latency          |

## 12. Protocol Negotiation

### Version Detection

The server detects v3 packets by checking:

1. First two bytes are `0x53 0x4B` ("SK")
2. Third byte is `0x03` (version)

v1 (Basic) packets do not start with these magic bytes (they start with the random AES-GCM IV), so the server can handle both the Basic and reliable modes simultaneously.

### Backward Compatibility

- The v1 (Basic) pipeline is unchanged and fully functional
- A pipeline factory selects v1 or v3 based on configuration
- The server can distinguish packet versions by magic bytes
- All v1 tests continue to pass
- v3 is selected via `protocolVersion: 3` (or `"advanced"`); a stored `protocolVersion: 2` is accepted and coerced to `3`

## 13. Implementation Files

| File                                                       | Purpose                                                |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `src/codec/packet-codec.ts`                                | Packet builder/parser, packet type constants           |
| `src/transport/reliability/sequence.ts`                    | SequenceTracker for loss detection                     |
| `src/transport/reliability/retransmit-queue.ts`            | RetransmitQueue for reliable delivery                  |
| `src/transport/pipeline/factory.ts`                        | Pipeline selector (v1 or v3)                           |
| `src/transport/pipeline/reliable-client.ts`                | Reliable client pipeline (send side)                   |
| `src/transport/pipeline/reliable-server.ts`                | Reliable server pipeline (receive side)                |
| `src/transport/congestion.ts`                              | CongestionControl with AIMD algorithm                  |
| `src/transport/bonding.ts`                                 | BondingManager with failover/failback                  |
| `src/domain/monitoring/`                                   | PacketLossTracker, PathLatencyTracker, AlertManager    |
| `src/domain/metrics/prometheus.ts`                         | Prometheus metrics exporter                            |
| `src/transport/metrics/publisher.ts`                       | Signal K metrics publisher                             |
| `src/codec/crypto.ts`                                      | AES-256-GCM encryption/decryption; HMAC                |
| `src/foundation/constants.ts`                              | Protocol constants and defaults                        |
| `src/codec/fleet-identity.ts`                              | Encrypted HELLO fleet identity (§15.2)                 |
| `src/codec/fleet-payload.ts`                               | FLEET_DATA payload encode/decode (§15.4)               |
| `src/transport/pipeline/reliable-server/fleet.ts`          | Fleet membership, scope, origin authority (§15.6-15.7) |
| `src/transport/pipeline/reliable-server/fleet-sender.ts`   | Fleet flush, retransmit, keepalive, lifecycle          |
| `src/transport/pipeline/reliable-server/fleet-meta.ts`     | First-sight fleet metadata (§15.8)                     |
| `src/transport/pipeline/reliable-server/fleet-rate.ts`     | Fleet token bucket and loss-adaptive rate (§15.9)      |
| `src/transport/pipeline/reliable-client/fleet.ts`          | Fleet HELLO fields, HELLO_ACK, FLEET_DATA receive      |
| `src/transport/pipeline/reliable-client/fleet-dispatch.ts` | Fleet delta dispatch, newest-value guard               |

## 14. Signal K Paths Published

The reliable (v3) protocol publishes the following metrics to the Signal K data model:

| Path                                             | Type           | Description                        |
| ------------------------------------------------ | -------------- | ---------------------------------- |
| `networking.modem.rtt`                           | number (s)     | Round-trip time to test endpoint   |
| `networking.edgeLink.rtt`                        | number (ms)    | Pipeline RTT                       |
| `networking.edgeLink.jitter`                     | number (ms)    | RTT jitter                         |
| `networking.edgeLink.packetLoss`                 | number (ratio) | Packet loss ratio (0-1)            |
| `networking.edgeLink.retransmitRate`             | number (ratio) | Retransmission rate                |
| `networking.edgeLink.linkQuality`                | number (0-100) | Composite link quality score       |
| `networking.edgeLink.queueDepth`                 | number         | Retransmit queue depth             |
| `networking.edgeLink.throughput.out`             | number (B/s)   | Outbound throughput                |
| `networking.edgeLink.throughput.in`              | number (B/s)   | Inbound throughput                 |
| `networking.edgeLink.bonding.activeLink`         | string         | Active bonding link name           |
| `networking.edgeLink.bonding.primary.*`          | object         | Primary link health metrics        |
| `networking.edgeLink.bonding.backup.*`           | object         | Backup link health metrics         |
| `notifications.signalk-edge-link.<instanceId>.*` | notification   | Alert notifications (per-instance) |

## 15. Fleet Sharing (capability `fleet-v1`)

Fleet sharing lets every client of one server instance receive the other clients' vessel data over the session the client already opened. The server sends to the `address:port` the client's packets come from, so the client needs no listening socket and no inbound firewall or NAT rule. A client never receives its own vessel.

Fleet sharing is an additive extension of protocol v3: the version byte stays `0x03`, and the uplink (DATA, METADATA, ACK, NAK, HEARTBEAT, HELLO) is byte-for-byte unchanged when the feature is off on either end. It is not available on v1 or on bonded clients.

### 15.1 Negotiation

1. A client with `fleetSharing.enabled` adds `"fleet-v1"` to the HELLO `capabilities` array and a `fleet` field (§15.2).
2. A server that receives such a HELLO answers with HELLO_ACK (§15.3). `accepted` contains `"fleet-v1"` only when the server's own `fleetSharing.enabled` is true.
3. The server sends FLEET_DATA only to sessions it has accepted. The client sends FLEET_ACK and FLEET_NAK only after it has received a HELLO_ACK accepting `fleet-v1`.

Receivers built before this extension reject packet types `0x09`-`0x0C` as unknown (`Unknown packet type`) and count them in `malformedPackets`. Rules 2 and 3 guarantee such a peer never receives them.

A server built before this extension never reads `capabilities` and never sends HELLO_ACK. The client reports `not-offered` after three HELLOs without an answer and keeps the uplink working.

### 15.2 HELLO `fleet` field

`fleet` is a base64 string: AES-256-GCM (`[IV 12][ciphertext][tag 16]`, same key and `stretchAsciiKey` as DATA) over UTF-8 JSON:

```json
{
  "v": 1,
  "self": "vessels.urn:mrn:imo:mmsi:230123456",
  "nonce": "3f9c1a7e5b2d4c60",
  "pathFilter": { "allow": ["navigation.*"], "deny": [] },
  "maxBytesPerSec": 4096
}
```

| Field            | Required | Meaning                                                                                                                         |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `v`              | yes      | Field version. Receivers ignore a `fleet` field whose `v` they do not know and treat the HELLO as non-fleet.                    |
| `self`           | yes      | The client's own context. The server never sends this context to this client.                                                   |
| `nonce`          | yes      | 16 hex characters, new for every HELLO. Echoed in HELLO_ACK to bind the answer to this HELLO.                                   |
| `pathFilter`     | no       | Paths the client wants, same globs as `pathFilter` elsewhere. Applied on the server before sending.                             |
| `maxBytesPerSec` | no       | Ceiling the client requests. A request below 256 bytes/s is raised to 256. The server uses the lower of this and its own limit. |

The vessel identity is encrypted because HELLO is authenticated but not encrypted; a plaintext `self` would expose the vessel's MMSI to anyone on the path. Receivers ignore unknown keys inside the decrypted object.

### 15.3 HELLO_ACK (0x09)

Control packet, Server → Client. Payload: UTF-8 JSON followed by the 16-byte HMAC tag (§5). The tag is epoch-bound under `epochBoundAuth` like every other server → client control packet.

```json
{
  "v": 1,
  "accepted": ["fleet-v1"],
  "nonce": "3f9c1a7e5b2d4c60",
  "fleet": { "stream": 2864434397, "maxBytesPerSec": 4096 }
}
```

- `nonce` echoes the HELLO's `fleet.nonce`. The client accepts a HELLO_ACK only when it matches the nonce of its most recent HELLO.
- `fleet.stream` is a random uint32 the server picks when it accepts the session. It names the FLEET_DATA sequence space (§15.4).
- The server re-sends HELLO_ACK as a keepalive when it has sent nothing to an accepted session for 20 s. A client that receives no fleet packet for 60 s sends a new HELLO; the server answers it with a new HELLO_ACK. After a server restart that HELLO starts a new stream, which brings a join snapshot (§15.6). This is how a session survives a server restart.

### 15.4 FLEET_DATA (0x0A)

Server → Client. Always authenticated with the 16-byte HMAC tag over header bytes 0-12 and the payload, whatever `authenticatedHeaders` is set to; under `epochBoundAuth` the tag is bound to the client's epoch.

```text
[Header 15][stream uint32 BE][AES-256-GCM: IV 12 | ciphertext | tag 16][HMAC 16]
```

- Plaintext before encryption: Brotli-compressed delta array, JSON or MessagePack (`MESSAGEPACK` flag), optionally path-dictionary encoded (`PATH_DICTIONARY` flag). Same encoding as DATA; no compact deltas, no value-dedup sentinels.
- Header sequence: the FLEET_DATA sequence of this stream, starting at 0, independent of DATA and METADATA sequence spaces.
- The client drops FLEET_DATA whose stream is not the stream of its accepted HELLO_ACK, and FLEET_DATA rejected by its replay window for that stream.
- Each delta keeps its `context`, `$source` and `timestamp`. The client writes them into its Signal K tree the way the server writes DATA.

### 15.5 FLEET_ACK (0x0B) and FLEET_NAK (0x0C)

Control packets, Client → Server, HMAC-authenticated (§5), epoch-bound under `epochBoundAuth`.

```text
FLEET_ACK: [stream uint32 BE][cumulative seq uint32 BE] ... [HMAC 16]
FLEET_NAK: [stream uint32 BE][missing seq uint32 BE] × n   [HMAC 16]   (n ≤ 64)
```

Receivers ignore bytes after the defined fields in FLEET_ACK so later versions can append fields. The server ignores either packet when the stream is not the session's current stream.

The client sends FLEET_ACK at most every 200 ms while FLEET_DATA arrives. It sends FLEET_NAK for gaps using the same timers as the server's DATA NAKs (`nakTimeout`, `maxNakRounds`). The server retransmits on FLEET_NAK, and retransmits any packet still unacknowledged after 2 s, at most 3 times per packet.

### 15.6 What the server sends

For an accepted session `s` the server sends a context `C` when all of these hold:

1. `C` is not `s.self`.
2. Scope `fleet` (default): `C` is the `self` of another accepted session on the same server instance, or `C` is the server's own vessel and `includeServerVessel` is true. Scope `all`: any context, including AIS targets.
3. The path does not start with `networking.edgeLink.`.
4. The path passes the server's `fleetSharing.pathFilter` and the client's requested `pathFilter`.

Values are coalesced per `(context, $source, path)` between flushes (`batchIntervalMs`, default 1000 ms): only the newest value is sent. Each session has a token bucket that fills at `min(server maxBytesPerSec, client maxBytesPerSec) × rate factor` (§15.9) and holds one second of that rate, at least 1400 bytes. Every FLEET_DATA send, first or retransmitted, goes out only when the bucket covers its size; otherwise pending values wait for a later flush and newer values replace them.

Whenever a session starts a new fleet stream (first fleet HELLO, a client restart, or a session re-created after a server restart), the server sends a snapshot of the in-scope values from its Signal K tree. A snapshot that falls inside the 10 s limit is deferred, not dropped: the server sends it once the limit has passed, to whichever stream the session then has. When a session joins the fleet, the server also queues that vessel's current values for every other accepted session.

### 15.7 Identity and loop rules

- **One owner per vessel.** If two sessions declare the same `self`, the newer HELLO wins and the older session leaves the fleet (`fleet.identityConflicts`). Ownership is a claim by a holder of the key, not a proof of vessel identity.
- **No ownership by replay.** For each vessel the server records the `timestamp` of the newest accepted fleet HELLO. `timestamp` is the HELLO's own field, covered by the HELLO tag and strictly increasing per client process (HELLO Packet section), so no clock agreement with the server is needed. While the vessel has a live owner, a HELLO from any other session is ignored (`fleet.replayedHellos`) unless its `timestamp` is strictly greater than the record. A HELLO without a numeric `timestamp` counts as `0`. The owner's own HELLOs are always accepted and never move the record back. With no live owner, any HELLO is accepted and becomes the record. Records cover up to 1024 vessels; a live owner without a record cannot be displaced until its next HELLO.
- **Origin authority on the server.** While fleet sharing is enabled, the server drops uplink deltas from session `X` whose context is the declared `self` of another accepted session (`fleet.originDrops`). Vessel B's data enters the hub only from B.
- **No echo on the client.** The client records every context it received in FLEET_DATA and drops those contexts from its own uplink (`fleet.loopDrops`). Its own `self` is never recorded. This holds with `subscription.json` `context: "*"`.

### 15.8 Metadata

Metadata (units, zones, display names) rides inside FLEET_DATA as standard `updates[].meta` entries; there is no separate fleet metadata packet.

- **First sight.** The first time the server sends a session a `(context, path)`, it attaches that path's `meta` from its own Signal K tree, in a meta-only update of the same delta. A receiver therefore shows a fleet value with its units from the first packet. The server remembers what it sent per session (bounded to 20000 keys, then reset), so later packets carry no metadata.
- **Changes.** Live deltas that carry `updates[].meta` for an in-scope context are queued and sent like values, newest entry per `(context, path)`.
- The client applies its requested `pathFilter` to metadata paths and never records metadata for its own vessel.

### 15.9 Loss-adaptive rate

The server keeps a rate factor per session, starting at 1. A FLEET_NAK naming at least one sequence, or a FLEET_DATA still unacknowledged after 2 s, multiplies the factor by 0.7, at most once per second, down to 0.1. After 2 s without loss the factor grows by 0.05 per second back to 1. The effective rate never drops below 256 bytes/s. The vessel's downlink, usually the slowest hop, therefore sets the pace without configuration, and a burst of loss counts once rather than once per lost packet.

### 15.10 Limits

| Constant                                    | Value                                   | Where  |
| ------------------------------------------- | --------------------------------------- | ------ |
| HELLO_ACK keepalive after idle              | 20 s                                    | Server |
| Client re-HELLO after no fleet packet       | 60 s                                    | Client |
| Join snapshot minimum interval              | 10 s                                    | Server |
| Retransmit unacknowledged FLEET_DATA        | 2 s                                     | Server |
| Maximum retransmits per FLEET_DATA          | 3                                       | Server |
| Retransmit queue per session                | 512                                     | Server |
| Values per FLEET_DATA packet                | at most 40, fewer to stay ≤ 1400 bytes  | Server |
| FLEET_ACK minimum spacing                   | 200 ms                                  | Client |
| Inbound FLEET_DATA per second               | 200                                     | Client |
| Encrypted `fleet` field, base64 length      | 2048                                    | Both   |
| Metadata keys remembered per session        | 20000                                   | Server |
| Rate cut on loss / floor                    | ×0.7 / 0.1, at most once per 1 s        | Server |
| Rate recovery after 2 s without loss        | +0.05 per second                        | Server |
| Minimum `maxBytesPerSec` and effective rate | 256 bytes/s (lower requests are raised) | Server |

FLEET_DATA packets target 1400 bytes. A value whose packet alone exceeds 1400 bytes travels in a packet of its own, so losing that packet costs no other value. A value whose own FLEET_DATA datagram, fully encoded (header, stream id, encrypted payload and tag), exceeds 65,507 bytes, the UDP payload limit, is dropped and counted in `fleet.packetsAbandoned`. A packet larger than the bucket waits for a full bucket and is then sent, leaving the bucket in debt, so values queued after it wait about its size divided by the session rate.

### 15.11 Test vectors

Key: the 32 bytes `00 01 02 … 1f` (hex key `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`). Header sequence 0 unless stated. Tags are HMAC-SHA256 over header bytes 0-12 and the payload (then the 8-byte big-endian epoch when `EPOCH_BOUND_AUTH` is set), truncated to 16 bytes; CRC is CRC-16/CCITT (polynomial 0x1021, initial 0xFFFF) over header bytes 0-12. These bytes were computed independently of the packet builder; `__tests__/v2/fleet-codec.test.js` checks the builder and parser against them.

| Packet                 | Inputs                                                                                                         | Bytes (hex)                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLEET_ACK              | stream `0x01020304`, cumulative seq 16                                                                         | `534b030b00000000000000001878fd0102030400000010867130d10c17e6d48759ea94d6ec7fe8`                                                                                                                                                                                                         |
| FLEET_ACK, epoch-bound | as above, epoch 1700000000000, flag `0x20`                                                                     | `534b030b200000000000000018df0101020304000000101854b54731d487a6b6afee248e9574dc`                                                                                                                                                                                                         |
| FLEET_NAK              | stream `0x01020304`, missing 5 and 7                                                                           | `534b030c00000000000000001c2483010203040000000500000007435cf5158835af1e54650d31c06ee280`                                                                                                                                                                                                 |
| HELLO_ACK              | `{"v":1,"accepted":["fleet-v1"],"nonce":"0011223344556677","fleet":{"stream":16909060,"maxBytesPerSec":4096}}` | `534b030900000000000000007c8a557b2276223a312c226163636570746564223a5b22666c6565742d7631225d2c226e6f6e6365223a2230303131323233333434353536363737222c22666c656574223a7b2273747265616d223a31363930393036302c226d61784279746573506572536563223a343039367d7d4c1b5de5f08854fbd3ac02066dafe40e` |
| FLEET_DATA             | stream `0x01020304`, seq 7, flags `0x03`, 16 bytes `0xaa` standing in for the AES-GCM output                   | `534b030a030000000700000024aaf701020304aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaafe8c56f292f29fe0098624eab0c6a5a8`                                                                                                                                                                                 |
