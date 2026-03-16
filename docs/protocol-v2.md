# Protocol v2 overview

Signal K Edge Link protocol v2 extends the original encrypted UDP transport with reliability and adaptive link behavior suited for unstable networks (cellular, satellite, high-loss WAN).

Protocol v3 keeps the same reliable transport model but adds HMAC authentication to control packets. Use v3 when both peers can be upgraded together and the link should not trust unauthenticated ACK/NAK/HEARTBEAT/HELLO traffic.

## Packet types

v2 introduces typed packets. Each packet begins with a 15-byte binary header before the encrypted payload.

| Type        | Direction          | Purpose                                                                    |
| ----------- | ------------------ | -------------------------------------------------------------------------- |
| `DATA`      | Client → Server    | Carries one or more Signal K deltas (main data payload)                    |
| `ACK`       | Server → Client    | Acknowledges a range of successfully received sequence numbers             |
| `NAK`       | Server → Client    | Requests retransmission of specific missing sequence numbers               |
| `HEARTBEAT` | Client ↔ Server    | Keepalive probe used for RTT measurement and link health monitoring        |
| `HELLO`     | Client → Server    | Session initiation; announces client protocol version and capabilities     |

In v3, `ACK`, `NAK`, `HEARTBEAT`, and `HELLO` packets carry an HMAC signature computed from the shared key so the server can reject forged control traffic.

## Packet format

```
v1 packet (no header):
  [16-byte IV][Encrypted payload][16-byte GCM auth tag]

v2/v3 packet:
  [15-byte header][16-byte IV][Encrypted payload][16-byte GCM auth tag]

Header layout (15 bytes):
  [2 bytes] Magic: "SK" (0x53 0x4B)
  [1 byte]  Protocol version (0x02 or 0x03)
  [1 byte]  Packet type (DATA=0, ACK=1, NAK=2, HEARTBEAT=3, HELLO=4)
  [4 bytes] Sequence number (uint32, big-endian)
  [4 bytes] Timestamp (unix ms, uint32, big-endian)
  [3 bytes] CRC-24 of the header bytes 0–11
```

Magic bytes allow the server to quickly distinguish v1 packets (no magic) from v2/v3 packets and reject mismatched protocol versions.

## Sequence numbering

- Sequence numbers are unsigned 32-bit integers starting at a random value per session.
- The server tracks the highest seen sequence number and detects gaps.
- Wrap-around at `2^32` is handled; the gap detection uses modular arithmetic.
- Duplicate packets (same sequence number received twice) are silently dropped after the first delivery.

## ACK aggregation

Rather than sending one ACK per packet, the server batches acknowledgements:

- The server accumulates received sequence numbers over a short window.
- A single ACK covers a contiguous range with a bitmap for sparse gaps.
- This keeps ACK traffic well below 1% of data volume at normal send rates.

## NAK and retransmission

When the server detects a gap in received sequence numbers (for example, sequences 100, 101, 103 received — 102 is missing):

1. Server sends a `NAK` for sequence 102.
2. Client looks up sequence 102 in its retransmit queue.
3. If found, client resends the original encrypted packet.
4. If the retransmit queue has evicted the packet (queue is bounded at 5000 entries by default), the gap is irrecoverable and the server discards it.

Retransmission reduces effective packet loss by > 99% on links with < 10% raw loss.

## Session model

The server maintains per-client session state keyed by remote address and port:

- Sequence counter reset detection (large backward jump triggers a new session).
- Per-client ACK/NAK generation.
- Heartbeat probe tracking for per-client RTT estimation.

Multiple clients can send to the same server instance simultaneously; each is tracked independently.

## Congestion handling

v2 introduces adaptive sending on the client side. The congestion controller:

- Monitors smoothed RTT and packet loss from ACK/NAK feedback.
- Decreases the `deltaTimer` (sends faster) when conditions are healthy.
- Increases the `deltaTimer` (sends slower) when loss or RTT exceeds thresholds.

See `docs/congestion-control.md` for algorithm details and tuning guidance.

## Bonding interactions

When bonding is enabled, v2 maintains parallel heartbeat probes on both links:

- Health data from both links feeds the bonding manager's failover decisions.
- Failover switches the active sending socket; the retransmit queue is aware of which socket to use.
- `GET /bonding` surfaces active link and per-link quality; `POST /bonding/failover` triggers a manual switch.

See `docs/bonding.md` for full bonding documentation.

## Operational guidance

- Use v2 or v3 for cellular/satellite/high-loss links.
- Prefer v3 on untrusted networks or when you want authenticated control packets.
- Start with defaults; tune failover and congestion thresholds after observing live metrics.
- Both endpoints must use the same protocol version. Mismatches result in "Invalid magic bytes" or "Unsupported protocol version" errors.

## Related docs

- `docs/architecture-overview.md` — component map and data pipeline
- `docs/configuration-reference.md` — full protocol and transport settings
- `docs/protocol-v3-spec.md` — v3 control-plane authentication details
- `docs/bonding.md` — bonding concepts and API usage
- `docs/congestion-control.md` — AIMD algorithm and tuning
- `docs/api-reference.md` — REST endpoints
