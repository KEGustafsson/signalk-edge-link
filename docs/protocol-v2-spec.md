# Signal K Edge Link Protocol v2.0 Specification

## 1. Introduction

The Signal K Edge Link Protocol v2.0 is a binary UDP protocol designed for reliable, bandwidth-efficient transmission of Signal K delta data between vessels and shore servers. It operates in challenging maritime network environments including cellular edge areas, satellite links, and multi-path connections.

The v2 protocol adds a comprehensive binary packet header layer to the existing v1 encryption/compression pipeline, enabling:

- **Sequence tracking** for packet loss detection
- **Packet type differentiation** (DATA, ACK, NAK, HEARTBEAT, HELLO)
- **Flag-based feature negotiation** (compression, encryption, msgpack, path dictionary)
- **CRC16 integrity checking** at the header level
- **ACK/NAK retransmission** for reliable delivery (>99.9% at 5% loss)
- **Dynamic congestion control** using AIMD algorithm
- **Connection bonding** with automatic failover between primary/backup links
- **Backward compatibility** with v1 protocol (auto-detection via magic bytes)

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

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 2 bytes | Magic | `0x53 0x4B` ("SK") - identifies v2 packets |
| 2 | 1 byte | Version | `0x02` for v2 protocol |
| 3 | 1 byte | Type | Packet type (see section 3) |
| 4 | 1 byte | Flags | Feature flags (see section 4) |
| 5 | 4 bytes | Sequence | Packet sequence number (uint32, big-endian) |
| 9 | 4 bytes | Length | Payload length in bytes (uint32, big-endian) |
| 13 | 2 bytes | CRC16 | CRC-CCITT checksum of header bytes 0-12 |

## 3. Packet Types

| Value | Name | Direction | Description | Payload |
|-------|------|-----------|-------------|---------|
| 0x01 | DATA | Client → Server | Signal K delta data | Encrypted/compressed delta |
| 0x02 | ACK | Server → Client | Cumulative acknowledgement | uint32 acked sequence |
| 0x03 | NAK | Server → Client | Negative acknowledgement | Array of uint32 missing sequences |
| 0x04 | HEARTBEAT | Bidirectional | Keep-alive | None (0 bytes) |
| 0x05 | HELLO | Client → Server | Connection establishment | JSON with protocol info |

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

Total per-packet overhead: 15 bytes (v2 header) + 28 bytes (encryption) = 43 bytes.

### ACK Packet

Payload: 4 bytes containing the uint32 cumulative acknowledged sequence number. All packets up to and including this sequence have been received.

ACKs are sent periodically by the server to confirm receipt. The client uses cumulative ACKs to clear its retransmission queue.

### NAK Packet

Payload: N × 4 bytes, each uint32 representing a missing sequence number. Sent when the receiver detects gaps in the sequence. The client retransmits the requested packets from its retransmission queue.

Retransmission limits:
- Maximum retransmit attempts per packet: 3
- Retransmit queue capacity: 5,000 packets
- Packets exceeding max attempts are discarded

### HEARTBEAT Packet

No payload. Sent periodically to indicate the connection is alive. The default heartbeat interval is 60 seconds, configurable from 10 to 3,600 seconds.

### HELLO Packet

Payload: JSON string with connection metadata:

```json
{
  "protocolVersion": 2,
  "clientId": "vessel-xxx",
  "timestamp": 1707321234567
}
```

Sent once at connection establishment to identify the client and negotiate protocol version.

## 4. Flags

Byte 4 of the header contains feature flags:

| Bit | Mask | Name | Description |
|-----|------|------|-------------|
| 0 | 0x01 | COMPRESSED | Payload is Brotli compressed |
| 1 | 0x02 | ENCRYPTED | Payload is AES-256-GCM encrypted |
| 2 | 0x04 | MESSAGEPACK | Data serialized with MessagePack (vs JSON) |
| 3 | 0x08 | PATH_DICTIONARY | Paths encoded with path dictionary |
| 4-7 | - | Reserved | Must be 0 |

Both client and server must agree on flag settings via configuration. Mismatched flags will cause decoding failures.

## 5. CRC16 Checksum

The CRC16 field uses the CRC-CCITT polynomial (0x1021) with initial value 0xFFFF.

The checksum is computed over header bytes 0 through 12 (everything except the CRC16 field itself). This provides header integrity verification without the overhead of checksumming the entire payload (which has its own AES-GCM authentication tag).

Packets with invalid CRC16 are silently discarded.

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
- >99.9% delivery rate under 5% packet loss conditions
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

| Parameter | Default | Range |
|-----------|---------|-------|
| Minimum delta timer | 100 ms | 50 - 1,000 ms |
| Maximum delta timer | 5,000 ms | 1,000 - 30,000 ms |
| Target RTT | 200 ms | 50 - 2,000 ms |
| Adjustment interval | 5,000 ms | - |
| Max adjustment per step | 20% | - |

### Manual Override

The delta timer can be manually set via the REST API, which disables automatic congestion control. Automatic mode can be re-enabled via the API.

## 9. Connection Bonding

Connection bonding provides dual-link redundancy with automatic failover between a primary and backup network connection (e.g., LTE + Starlink).

### Architecture

```
                    ┌─────────────────┐
                    │  Pipeline v2    │
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

Failover events emit Signal K notifications at `notifications.signalk-edge-link.linkFailover` with state `alert` and both visual and sound methods.

## 10. Security

### Encryption

All DATA payloads are encrypted with AES-256-GCM:

| Property | Detail |
|----------|--------|
| Algorithm | AES-256-GCM |
| Key size | 256 bits (32 ASCII characters) |
| IV | 12 bytes, unique per message (random) |
| Auth tag | 16 bytes, tamper detection |
| Wire format | `[IV (12B)][Encrypted Data][Auth Tag (16B)]` |

### Key Requirements

- Exactly 32 characters (256 bits)
- Minimum 8 unique characters (entropy check)
- Must match on both client and server

### Security Properties

- **Confidentiality**: AES-256-GCM encryption
- **Integrity**: GCM authentication tag (16 bytes)
- **Replay protection**: Sequence numbers with duplicate detection
- **Header integrity**: CRC16 checksum on packet headers
- **Outbound-only**: No open inbound ports required on the vessel

## 11. Performance Characteristics

### Compression

| Batch Size | Raw JSON | Compressed | Ratio | Per-Delta |
|-----------|----------|-----------|-------|-----------|
| 1 delta | 221 B | 193 B | 1.15x | 193 B |
| 5 deltas | 1.1 KB | 227 B | 5.03x | 45 B |
| 10 deltas | 2.3 KB | 253 B | 9.13x | 25 B |
| 20 deltas | 4.5 KB | 341 B | 13.65x | 17 B |
| 50 deltas | 11.3 KB | 537 B | 21.59x | 11 B |

### Latency (per stage, excluding network)

| Stage | p50 | p95 | p99 |
|-------|-----|-----|-----|
| Serialize | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build | 0.001 ms | 0.002 ms | 0.009 ms |
| Full TX→RX | 1.076 ms | 1.446 ms | 2.067 ms |

### Smart Batching

UDP packets are kept under the MTU limit (1,400 bytes) using adaptive smart batching:

| Constant | Value | Purpose |
|----------|-------|---------|
| Safety margin | 85% | Target 85% of MTU (1,190 bytes effective) |
| Smoothing factor | 0.2 | Rolling average weight |
| Initial estimate | 200 bytes | Starting bytes-per-delta |
| Min deltas | 1 | Always send at least 1 |
| Max deltas | 50 | Cap to prevent excessive latency |

## 12. Protocol Negotiation

### Version Detection

The server detects v2 packets by checking:

1. First two bytes are `0x53 0x4B` ("SK")
2. Third byte is `0x02` (version)

v1 packets do not start with these magic bytes (they start with the random AES-GCM IV), so the server can handle both versions simultaneously.

### Backward Compatibility

- The v1 pipeline (`lib/pipeline.js`) is unchanged and fully functional
- A pipeline factory selects v1 or v2 based on configuration
- The server can distinguish packet versions by magic bytes
- All v1 tests continue to pass
- v2 is opt-in via `protocolVersion: 2` configuration

## 13. Implementation Files

| File | Purpose |
|------|---------|
| `lib/packet.js` | PacketBuilder, PacketParser, packet type constants |
| `lib/sequence.js` | SequenceTracker for loss detection |
| `lib/retransmit-queue.js` | RetransmitQueue for reliable delivery |
| `lib/pipeline-factory.js` | Version selector (v1 or v2) |
| `lib/pipeline-v2-client.js` | v2 client pipeline (send side) |
| `lib/pipeline-v2-server.js` | v2 server pipeline (receive side) |
| `lib/congestion.js` | CongestionControl with AIMD algorithm |
| `lib/bonding.js` | BondingManager with failover/failback |
| `lib/monitoring.js` | PacketLossTracker, PathLatencyTracker, AlertManager |
| `lib/prometheus.js` | Prometheus metrics exporter |
| `lib/metrics-publisher.js` | Signal K metrics publisher |
| `lib/crypto.js` | AES-256-GCM encryption/decryption |
| `lib/constants.js` | All protocol constants and defaults |

## 14. Signal K Paths Published

The v2 protocol publishes the following metrics to the Signal K data model:

| Path | Type | Description |
|------|------|-------------|
| `networking.modem.rtt` | number (s) | Round-trip time to test endpoint |
| `networking.edgeLink.rtt` | number (ms) | Pipeline RTT |
| `networking.edgeLink.jitter` | number (ms) | RTT jitter |
| `networking.edgeLink.packetLoss` | number (ratio) | Packet loss ratio (0-1) |
| `networking.edgeLink.retransmitRate` | number (ratio) | Retransmission rate |
| `networking.edgeLink.linkQuality` | number (0-100) | Composite link quality score |
| `networking.edgeLink.queueDepth` | number | Retransmit queue depth |
| `networking.edgeLink.throughput.out` | number (B/s) | Outbound throughput |
| `networking.edgeLink.throughput.in` | number (B/s) | Inbound throughput |
| `networking.edgeLink.bonding.activeLink` | string | Active bonding link name |
| `networking.edgeLink.bonding.primary.*` | object | Primary link health metrics |
| `networking.edgeLink.bonding.backup.*` | object | Backup link health metrics |
| `notifications.signalk-edge-link.*` | notification | Alert notifications |
