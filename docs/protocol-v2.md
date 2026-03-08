# Protocol v2 overview

Signal K Edge Link protocol v2 extends the original encrypted UDP transport with reliability and adaptive link behavior suited for unstable networks.

Protocol v3 keeps this same reliable transport model but authenticates control packets. Use v3 when both peers can be upgraded together and the link should not trust unauthenticated ACK/NAK/HEARTBEAT/HELLO traffic.

## Packet and transport model

- **Transport:** UDP.
- **Security:** AES-256-GCM encryption/authentication.
- **Payload encoding:** JSON deltas (optionally MessagePack), optionally path dictionary encoded, Brotli compressed before encryption.
- **Header semantics:** Sequence-aware packet types (DATA, ACK, NAK, HEARTBEAT) used by the v2 client/server pipelines.

## Reliability features

v2 adds reliability controls on top of UDP:

- **Sequence tracking** for in-order and duplicate detection.
- **ACK aggregation** to acknowledge received packets with low control overhead.
- **NAK signaling** for missing sequence ranges.
- **Retransmit queue** on sender side to resend unacknowledged packets.
- **Session handling** in server mode for multiple remote clients.

These features are implemented by the v2 packet, sequence, retransmit and server/client pipeline modules.

## Congestion handling

v2 introduces congestion control that adjusts sending behavior based on live link quality:

- packet loss / retransmissions,
- RTT and jitter,
- queue depth and send pressure.

The goal is to reduce queue explosions and packet bursts under poor link conditions while still delivering navigation-critical updates.

## Bonding interactions

When bonding is enabled, v2 can use primary/backup links with failover logic based on link quality and thresholds.

- `GET /bonding` surfaces active link and per-instance state.
- `POST /bonding` applies validated threshold changes across bonding-enabled instances.

## Operational guidance

- Use v2 for cellular/satellite/high-loss links.
- Prefer v3 over v2 on untrusted networks or whenever you want authenticated control packets.
- Start with defaults; tune failover and congestion thresholds after observing metrics.
- Keep both endpoints aligned on protocol version and compatible options.

## Related docs

- `docs/architecture-overview.md`
- `docs/configuration-reference.md`
- `docs/protocol-v3-spec.md`
- `docs/bonding.md`
- `docs/congestion-control.md`
- `docs/api-reference.md`
