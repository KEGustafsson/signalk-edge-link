# Signal K Edge Link — Protocol Reference

> Operational overview of the two protocol modes: **Basic (v1)** and **Advanced (v3)**.
> For the exact wire-level bit specification, see [protocol-v3-spec.md](protocol-v3-spec.md).

> **A note on v2.** An earlier reliable-transport version (v2) used a CRC-only,
> unauthenticated control plane. It was **removed in 3.0.0**: any host that could
> reach the UDP port could forge control packets. On the wire the node now speaks
> v1 or v3 only. A stored `protocolVersion: 2` is accepted for config back-compat
> and silently coerced to `3`.

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

The receiver identifies v1 packets because they **do not** start with the `SK` magic bytes used by v3.

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
      "secretKey": "<32-character-ASCII-key>",
      "protocolVersion": 1,
      "testAddress": "8.8.8.8",
      "testPort": 53,
      "pingIntervalTime": 1
    }
  ]
}
```

The `testAddress` / `testPort` / `pingIntervalTime` fields configure an external ping monitor for RTT estimation. These fields **must not** appear in Advanced/v3 configs.

---

## v3 — Reliable, Authenticated Transport (Advanced)

v3 (Advanced mode) adds a 15-byte binary header to every packet, enabling sequence tracking, ACK/NAK retransmission, heartbeat-based RTT measurement, congestion control, and bonding. Every control packet additionally carries a 16-byte HMAC-SHA256 authentication tag keyed by the shared `secretKey`.

### Packet header format

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

All control packets (everything except DATA) carry a trailing 16-byte HMAC-SHA256 tag.

### Feature flags (byte 4)

| Bit | Mask | Name                 | Set when                                                   |
| --- | ---- | -------------------- | ---------------------------------------------------------- |
| 0   | 0x01 | COMPRESSED           | Payload is Brotli-compressed                               |
| 1   | 0x02 | ENCRYPTED            | Payload is AES-256-GCM encrypted                           |
| 2   | 0x04 | MESSAGEPACK          | Payload is MessagePack-encoded                             |
| 3   | 0x08 | PATH_DICTIONARY      | Paths encoded as numeric IDs                               |
| 4   | 0x10 | AUTHENTICATED_HEADER | DATA/METADATA carry a header-binding HMAC tag (default on) |
| 5–7 | —    | Reserved             | Always 0                                                   |

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

### Control-plane authentication

Every control packet (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST,
FULL_STATUS_REQUEST) carries a 16-byte truncated HMAC-SHA256 tag over
`header[0..12] ‖ payload`, keyed by the shared `secretKey`:

| Packet              | Base payload      | On-the-wire payload                  |
| ------------------- | ----------------- | ------------------------------------ |
| ACK                 | `uint32 ackedSeq` | `uint32 ackedSeq` + 16-byte HMAC tag |
| NAK                 | N × `uint32 seq`  | N × `uint32 seq` + 16-byte HMAC tag  |
| HEARTBEAT           | (empty)           | 16-byte HMAC tag only                |
| HELLO               | JSON payload      | JSON payload + 16-byte HMAC tag      |
| META_REQUEST        | (empty)           | 16-byte HMAC tag only                |
| FULL_STATUS_REQUEST | (empty)           | 16-byte HMAC tag only                |

DATA packets (type `0x01`) are unaffected — they are already authenticated by
the AES-256-GCM auth tag. `authenticatedHeaders` (default `true`) adds a
header-binding HMAC tag to DATA/METADATA packets too; both peers must use the
same setting.

---

## Security Comparison

| Property                      | v1 (Basic) | v3 (Advanced) |
| ----------------------------- | ---------- | ------------- |
| Data payload confidentiality  | ✓          | ✓             |
| Data payload integrity (GCM)  | ✓          | ✓             |
| Control packet authentication | —          | HMAC-SHA256 ✓ |
| Retransmission on loss        | —          | ✓             |
| Congestion control            | —          | ✓             |
| Bonding / failover            | —          | ✓             |
| Safe on untrusted networks    | partial    | **Yes**       |

Without a reliability layer, v1 (Basic) has no control packets to forge, but
also no retransmission, congestion control, or bonding. Use it only on
trusted/private links.

---

## Version Selection in Configuration

In the plugin configuration, `protocolVersion` accepts:

| Value | Mode     | Config UI label |
| ----- | -------- | --------------- |
| `1`   | Basic    | Basic           |
| `3`   | Advanced | Advanced        |

The configuration also accepts the string aliases `"basic"` and `"advanced"`
for hand edits; these are normalized to numeric on save. A legacy `2` is
accepted and coerced to `3`.

**Both sides must run the same version.** Upgrading one side without the other
causes immediate link failure — `malformedPackets` increments and no data
flows.

For the full wire-level specification including METADATA envelope schema,
source snapshot format, sequence number semantics, and v1 metadata port
details, see [protocol-v3-spec.md](protocol-v3-spec.md).
