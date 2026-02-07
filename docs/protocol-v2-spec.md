# Signal K Edge Link v2.0 Protocol Specification

## 1. Introduction

The v2 protocol adds a binary packet header layer to the existing Signal K Edge Link UDP communication. This enables:

- **Sequence tracking** for packet loss detection
- **Packet type differentiation** (DATA, ACK, NAK, HEARTBEAT, HELLO)
- **Flag-based feature negotiation** (compression, encryption, msgpack, path dictionary)
- **CRC16 integrity checking** at the header level
- **Future reliability** via ACK/NAK retransmission (Phase 2)

The v2 protocol is designed to coexist with v1. The server can distinguish v2 packets from v1 packets by checking the magic bytes.

## 2. Packet Format

All multi-byte integers are big-endian (network byte order).

### Wire Format

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Magic (0x534B = "SK")     |   Version     |     Type      |
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

| Value | Name | Description | Payload |
|-------|------|-------------|---------|
| 0x01 | DATA | Signal K delta data | Encrypted/compressed delta |
| 0x02 | ACK | Cumulative acknowledgement | uint32 acked sequence |
| 0x03 | NAK | Negative acknowledgement | Array of uint32 missing sequences |
| 0x04 | HEARTBEAT | Keep-alive | None (0 bytes) |
| 0x05 | HELLO | Connection establishment | JSON with protocol info |

### DATA Packet

Carries Signal K delta data through the processing pipeline:
1. Delta serialized (JSON or MessagePack)
2. Compressed (Brotli quality 10)
3. Encrypted (AES-256-GCM)

The resulting ciphertext is the payload.

### ACK Packet

Payload: 4 bytes containing the uint32 cumulative acknowledged sequence number.
All packets up to and including this sequence have been received.

### NAK Packet

Payload: N × 4 bytes, each uint32 representing a missing sequence number.
Sent when the receiver detects gaps in the sequence.

### HEARTBEAT Packet

No payload. Sent periodically to indicate the connection is alive.

### HELLO Packet

Payload: JSON string with connection metadata:
```json
{
  "protocolVersion": 2,
  "clientId": "vessel-xxx",
  "timestamp": 1707321234567
}
```

## 4. Flags

Byte 4 of the header contains feature flags:

| Bit | Mask | Name | Description |
|-----|------|------|-------------|
| 0 | 0x01 | COMPRESSED | Payload is Brotli compressed |
| 1 | 0x02 | ENCRYPTED | Payload is AES-256-GCM encrypted |
| 2 | 0x04 | MESSAGEPACK | Data serialized with MessagePack (vs JSON) |
| 3 | 0x08 | PATH_DICTIONARY | Paths encoded with path dictionary |
| 4-7 | - | Reserved | Must be 0 |

## 5. CRC16 Checksum

The CRC16 field uses the CRC-CCITT polynomial (0x1021) with initial value 0xFFFF.

The checksum is computed over header bytes 0 through 12 (everything except the CRC16 field itself). This provides header integrity verification without the overhead of checksumming the entire payload (which has its own AES-GCM authentication).

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

## 7. Protocol Negotiation

### Version Detection

The server detects v2 packets by checking:
1. First two bytes are `0x53 0x4B` ("SK")
2. Third byte is `0x02` (version)

v1 packets do not start with these magic bytes (they start with the random AES-GCM IV), so the server can handle both versions simultaneously.

### Connection Flow

```
Client                          Server
  |                                |
  |--- HELLO (version, id) ------>|
  |                                |
  |--- DATA (seq=0, delta) ------>|
  |--- DATA (seq=1, delta) ------>|
  |--- DATA (seq=2, delta) ------>|
  |                                |
  |<--- ACK (seq=2) --------------|  (Phase 2)
  |                                |
  |--- DATA (seq=3, delta) ------>|
  |--- DATA (seq=5, delta) ------>|  (seq 4 lost)
  |                                |
  |<--- NAK ([4]) ----------------|  (Phase 2)
  |                                |
  |--- DATA (seq=4, retransmit) ->|  (Phase 2)
  |                                |
  |--- HEARTBEAT ---------------->|  (periodic)
```

## 8. Backward Compatibility

- The v1 pipeline (`lib/pipeline.js`) is unchanged
- A pipeline factory selects v1 or v2 based on configuration
- The server can distinguish packet versions by magic bytes
- All v1 tests continue to pass
- v2 is opt-in via `protocolVersion: 2` configuration

## 9. Implementation Files

| File | Purpose |
|------|---------|
| `lib/packet.js` | PacketBuilder, PacketParser, constants |
| `lib/sequence.js` | SequenceTracker for loss detection |
| `lib/pipeline-factory.js` | Version selector |
| `lib/pipeline-v2-client.js` | v2 client pipeline |
| `lib/pipeline-v2-server.js` | v2 server pipeline |

## 10. Future Extensions (Phase 2+)

- Retransmit queue for reliable delivery
- Bidirectional ACK/NAK over UDP
- Adaptive NAK timeout based on RTT
- Selective repeat retransmission
- Congestion control
