# Signal K Edge Link — Protocol v1/v2 Reference

> Operational overview of the Basic (v1) and v2 protocol modes.
> For the authenticated Advanced (v3) control-plane, see [protocol-v3-spec.md](protocol-v3-spec.md).
> For the exact wire-level bit specification, see [protocol-v2-spec.md](protocol-v2-spec.md).

---

## v1 — Basic Encrypted UDP

v1 is the simplest protocol mode. Every batch of deltas is compressed and encrypted and sent as a single UDP datagram. There is no reliability layer — lost packets are lost.

### Wire format

```text
┌─────────────────────────────────────────────────────┐
│  [  12-byte random IV  ]                            │
│  [  AES-256-GCM ciphertext (Brotli-compressed       │
│     JSON or MessagePack delta batch)  ]             │
│  [  16-byte GCM auth tag  ]                         │
└─────────────────────────────────────────────────────┘
       Total overhead per packet: 28 bytes
```

The receiver identifies v1 packets because they **do not** start with the `SK` magic bytes used by v2/v3.

### When to use v1

- Stable, low-latency LAN connections
- When simplicity matters more than reliability
- When you need the absolute lowest overhead

### v1 limitations

- No retransmission — packet loss is unrecovered
- No RTT measurement (uses external ping monitor instead)
- No congestion control or bonding
- Metadata transport requires a separate UDP port (`udpMetaPort`)

### v1 configuration example

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

The `testAddress` / `testPort` / `pingIntervalTime` fields configure an external ping monitor for RTT estimation. These fields **must not** appear in v2/v3 configs.

---

## v2 — Reliable Transport

v2 adds a 15-byte binary header to every packet, enabling sequence tracking, ACK/NAK retransmission, heartbeat-based RTT measurement, congestion control, and bonding.

> **Note:** v3 (Advanced mode) is identical to v2 in data path and wire format. The only difference is HMAC authentication on control packets. For new deployments, use v3. v2 is documented here for operators who need to understand the shared reliability machinery.

### Packet header format

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Magic "SK" (0x534B)        |  Version(02)  |  Type         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Flags      |          Sequence Number (uint32, BE)          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Seq (cont.)  |       Payload Length (uint32, BE)             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| PLen (cont.)  |       CRC16-CCITT (bytes 0–12)  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Offset | Size | Field    | Description                                   |
| ------ | ---- | -------- | --------------------------------------------- |
| 0      | 2 B  | Magic    | `0x53 0x4B` ("SK") — identifies v2/v3 packets |
| 2      | 1 B  | Version  | `0x02` (v2) or `0x03` (v3)                    |
| 3      | 1 B  | Type     | Packet type (see table below)                 |
| 4      | 1 B  | Flags    | Feature flags (see table below)               |
| 5      | 4 B  | Sequence | Packet sequence number (uint32, big-endian)   |
| 9      | 4 B  | Length   | Payload length in bytes (uint32, big-endian)  |
| 13     | 2 B  | CRC16    | CRC-CCITT checksum of header bytes 0–12       |

After the header comes the payload: `[12B IV][ciphertext][16B GCM auth tag]`

**Total overhead per packet: 15 (header) + 28 (crypto) = 43 bytes.**

### Packet types

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

### Feature flags (byte 4)

| Bit | Mask | Name            | Set when                         |
| --- | ---- | --------------- | -------------------------------- |
| 0   | 0x01 | COMPRESSED      | Payload is Brotli-compressed     |
| 1   | 0x02 | ENCRYPTED       | Payload is AES-256-GCM encrypted |
| 2   | 0x04 | MESSAGEPACK     | Payload is MessagePack-encoded   |
| 3   | 0x08 | PATH_DICTIONARY | Paths encoded as numeric IDs     |
| 4–7 | —    | Reserved        | Always 0                         |

Both peers must be configured identically for `useMsgpack` and `usePathDictionary`.

### ACK/NAK handshake

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

## Security Note

In v2, any host that can reach the UDP port can forge a valid control packet (ACK, NAK, HELLO). v3 closes these attack vectors with HMAC authentication. The plugin emits a startup warning when a v2 connection is configured on a publicly reachable port. See [protocol-v3-spec.md](protocol-v3-spec.md) for the upgrade path.
