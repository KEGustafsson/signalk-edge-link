# Signal K Edge Link — Protocol Reference

Operator overview of the two protocol modes, **Basic (v1)** and **Advanced (v3)**. Byte layouts, limits and test vectors are in [protocol-v3-spec.md](protocol-v3-spec.md).

Protocol v2 (reliable transport with a CRC-only, unauthenticated control plane) was removed in 3.0.0, because any host that could reach the UDP port could forge control packets. A node speaks v1 or v3 on the wire. A stored `protocolVersion: 2` is accepted and coerced to `3`; see [migration/v2-to-v3.md](migration/v2-to-v3.md).

## Choosing a mode

`protocolVersion` takes `1` (Basic) or `3` (Advanced). Config files also accept the aliases `"basic"` and `"advanced"`, which are normalized to `1` and `3`.

| Property                      | v1 (Basic)                   | v3 (Advanced)                                 |
| ----------------------------- | ---------------------------- | --------------------------------------------- |
| Payload confidentiality       | AES-GCM                      | AES-GCM                                       |
| Payload integrity             | GCM tag                      | GCM tag                                       |
| Control packet authentication | —                            | HMAC-SHA256                                   |
| Retransmission on loss        | —                            | ACK/NAK                                       |
| RTT measurement               | ping monitor (`testAddress`) | ACK timing                                    |
| Congestion control, bonding   | —                            | yes                                           |
| Path metadata transport       | —                            | METADATA packet                               |
| Fleet sharing                 | —                            | yes (not with bonding)                        |
| DATA/METADATA overhead        | 28 bytes                     | 43 bytes, plus 16 with `authenticatedHeaders` |
| Safe on untrusted networks    | partial                      | yes                                           |

v1 has no control packets to forge, but also no recovery. Use it only on stable, trusted links such as a LAN.

**Both ends must use the same `protocolVersion`.** With a mismatch no data flows: a v3 receiver counts the packets in `malformedPackets`, a Basic (v1) receiver fails to decrypt them and counts `encryptionErrors`.

## v1 — Basic encrypted UDP

Each batch of deltas is serialized (JSON or MessagePack), Brotli-compressed, encrypted and sent as one UDP datagram:

```text
[12-byte random IV][AES-256-GCM ciphertext][16-byte GCM auth tag]
```

A lost packet is not recovered. The receiver recognizes v1 because the packet does not start with the v3 magic bytes `SK`. v1 has no packet-type byte, so it carries no metadata.

RTT comes from an external ping monitor. v1 clients require `testAddress` and `testPort`; `pingIntervalTime` is optional. All three are rejected on v3 clients:

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

## v3 — Reliable, authenticated transport

Every v3 packet starts with a 15-byte header: magic `SK`, version `0x03`, packet type, flags, uint32 sequence, uint32 payload length and a CRC16 of the first 13 bytes ([spec §2](protocol-v3-spec.md#2-packet-format)). DATA and METADATA carry an encrypted payload after the header: `[12B IV][ciphertext][16B GCM tag]`. Control packets carry a plaintext payload and a 16-byte HMAC tag; FLEET_DATA puts a stream ID before its encrypted data. Per-type layouts are in [spec §3](protocol-v3-spec.md#3-packet-types).

### Packet types

| Hex  | Name                | Direction       | Purpose                                                         |
| ---- | ------------------- | --------------- | --------------------------------------------------------------- |
| 0x01 | DATA                | Client → Server | Delta batch                                                     |
| 0x02 | ACK                 | Server → Client | Cumulative acknowledgement                                      |
| 0x03 | NAK                 | Server → Client | List of missing sequence numbers                                |
| 0x04 | HEARTBEAT           | Client → Server | Keep-alive (keeps NAT mappings open; no reply)                  |
| 0x05 | HELLO               | Client → Server | Session start, client identity, capabilities                    |
| 0x06 | METADATA            | Client → Server | Path metadata (units, descriptions, zones) and source snapshots |
| 0x07 | META_REQUEST        | Server → Client | Ask for a fresh metadata snapshot                               |
| 0x08 | FULL_STATUS_REQUEST | Server → Client | Ask for a full values-snapshot replay                           |
| 0x09 | HELLO_ACK           | Server → Client | Fleet capability answer and keepalive                           |
| 0x0A | FLEET_DATA          | Server → Client | Other vessels' deltas (fleet sharing)                           |
| 0x0B | FLEET_ACK           | Client → Server | Acknowledges FLEET_DATA                                         |
| 0x0C | FLEET_NAK           | Client → Server | Missing FLEET_DATA sequences                                    |

The server sends HELLO_ACK (`0x09`) in reply to a HELLO that offers fleet sharing, accepted or declined, and after acceptance also as a periodic keepalive while the fleet session is idle. FLEET_DATA, FLEET_ACK and FLEET_NAK (`0x0A`–`0x0C`) are sent only after the server accepts it. Peers that predate fleet sharing never receive any of them ([spec §15](protocol-v3-spec.md#15-fleet-sharing-capability-fleet-v1)).

### Delivery

The server sends a cumulative ACK every `reliability.ackInterval` (default 100 ms) and a NAK when it detects a gap. The client keeps sent DATA packets in a retransmit queue (default 5000 packets, at most 3 retransmits each) and resends what a NAK names:

```text
  Client                                 Server
    │──── HELLO ──────────────────────────►│  session established
    │──── DATA seq=0,1,2 ─────────────────►│
    │◄─── ACK 2 ───────────────────────────│
    │──── DATA seq=3, seq=5 ──────────────►│  seq=4 lost
    │◄─── NAK [4] ─────────────────────────│
    │──── DATA seq=4 (retransmit) ────────►│
    │◄─── ACK 5 ───────────────────────────│
    │──── HEARTBEAT ──────────────────────►│  keep-alive, no reply
```

The client sends HEARTBEAT every `heartbeatInterval` (default 25000 ms) to keep NAT mappings open; the server does not answer it. RTT comes from ACKs of DATA packets that were not retransmitted, so an idle link gets no new RTT samples. Fleet data reaches a vessel behind NAT only while that mapping is open, so `heartbeatInterval` must be shorter than the NAT's UDP timeout ([spec §15](protocol-v3-spec.md#15-fleet-sharing-capability-fleet-v1)).

Settings are in [configuration-reference.md](configuration-reference.md); send-rate adaptation is in [congestion-control.md](congestion-control.md) and failover in [bonding.md](bonding.md).

### Authentication

Control packets (ACK, NAK, HEARTBEAT, HELLO, HELLO_ACK, META_REQUEST, FULL_STATUS_REQUEST, FLEET_ACK and FLEET_NAK) carry a plaintext payload and a 16-byte truncated HMAC-SHA256 tag over the first 13 header bytes and the payload, keyed by `secretKey`. A host without the key cannot forge an ACK, NAK, HELLO or snapshot request. FLEET_DATA carries a 4-byte stream ID followed by AES-GCM ciphertext, and always carries the same HMAC tag over the header and that payload, whatever `authenticatedHeaders` is set to.

DATA and METADATA are protected by the GCM tag. With `authenticatedHeaders` (default `true`) they also carry a 16-byte HMAC tag that binds the header to the ciphertext. `epochBoundAuth` (default `false`, both ends 4.0.0+) also binds each tag to the connection epoch to block replays across restarts ([spec §5.1](protocol-v3-spec.md#51-epoch-bound-authentication-optional)).

### Settings both peers must match

The settings marked "Both ends" in the [configuration reference](configuration-reference.md#common-fields-client-and-server): in Advanced mode these are the key settings, `protocolVersion`, `authenticatedHeaders` and `epochBoundAuth`. Encoding options such as `useMsgpack` and `usePathDictionary` are detected by the receiver. A mismatch shows up as decrypt or authentication failures and `malformedPackets`; see [troubleshooting.md](troubleshooting.md).
