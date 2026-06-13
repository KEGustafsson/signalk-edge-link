# Signal K Edge Link — Protocol v3 (Advanced Mode)

> Authenticated control-plane details for Advanced (v3) mode.
> For packet header format, types, and flags shared with v2, see [protocol-v2.md](protocol-v2.md).
> For bit-level wire specification, see [protocol-v2-spec.md](protocol-v2-spec.md).

---

## What v3 Adds to v2

v3 (Advanced mode) is **identical to v2 in data path and wire format**. The only difference is that **control packets** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST) carry a **16-byte HMAC-SHA256 authentication tag** appended after the payload.

DATA packets (type `0x01`) are unaffected — they are already authenticated by the AES-256-GCM auth tag.

---

## Control Packet Layout in v3

| Packet              | v2 payload        | v3 payload                           |
| ------------------- | ----------------- | ------------------------------------ |
| ACK                 | `uint32 ackedSeq` | `uint32 ackedSeq` + 16-byte HMAC tag |
| NAK                 | N × `uint32 seq`  | N × `uint32 seq` + 16-byte HMAC tag  |
| HEARTBEAT           | (empty)           | 16-byte HMAC tag only                |
| HELLO               | JSON payload      | JSON payload + 16-byte HMAC tag      |
| META_REQUEST        | (empty)           | 16-byte HMAC tag only                |
| FULL_STATUS_REQUEST | (empty)           | 16-byte HMAC tag only                |

The HMAC tag covers `header[0..12] ‖ payload`, keyed by the shared `secretKey`. The header CRC16 remains in place for fast corruption detection.

---

## Why This Matters

In v2, any host that can reach the UDP port can forge a valid control packet:

- **Forged FULL_STATUS_REQUEST** — triggers a full snapshot replay (reflection amplifier)
- **Forged NAK** — causes spurious retransmissions
- **Forged HELLO** — creates a spurious server session

v3 closes all of these because forging requires knowledge of the shared secret. The plugin emits a startup warning when a v2 connection is configured with a publicly reachable port.

---

## Security Comparison

| Property                      | v1 (Basic) | v2                   | v3 (Advanced) |
| ----------------------------- | ---------- | -------------------- | ------------- |
| Data payload confidentiality  | ✓          | ✓                    | ✓             |
| Data payload integrity (GCM)  | ✓          | ✓                    | ✓             |
| Control packet authentication | —          | CRC only (forgeable) | HMAC-SHA256 ✓ |
| Retransmission on loss        | —          | ✓                    | ✓             |
| Congestion control            | —          | ✓                    | ✓             |
| Bonding / failover            | —          | ✓                    | ✓             |
| Safe on untrusted networks    | partial    | **No**               | **Yes**       |

---

## Version Byte

The packet header version byte (`offset 2`) is `0x03` for v3. The server uses this to enable HMAC verification. A packet with version `0x02` received by a v3 server is rejected; similarly a v3 packet received by a v2 server is rejected.

**Both sides must run the same version. Upgrading one side without the other causes immediate link failure** — `malformedPackets` increments and no data flows.

---

## v3 Upgrade Checklist

1. Set `protocolVersion: 3` on both client and server
2. Restart both peers simultaneously
3. Confirm data flow resumes — check `deltasSent` / `deltasReceived`
4. Confirm ACK/NAK traffic is present in `GET /metrics`
5. If the link does not recover, verify both sides use the same `protocolVersion` and `secretKey`

---

## Version Selection in Configuration

In the plugin configuration, `protocolVersion` accepts:

| Value | Mode     | Config UI label |
| ----- | -------- | --------------- |
| `1`   | Basic    | Basic           |
| `3`   | Advanced | Advanced        |

The configuration also accepts string aliases `"basic"` and `"advanced"` for hand edits; these are normalized to numeric on save.

---

## Wire Specification

For the full wire-level specification including METADATA envelope schema, source snapshot format, sequence number semantics, and v1 metadata port details, see [protocol-v2-spec.md](protocol-v2-spec.md).
