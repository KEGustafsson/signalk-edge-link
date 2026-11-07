# Phase 6: Fleet Sharing Protocol Design - Context

**Gathered:** 2026-11-02
**Milestone:** v2 Fleet Data Sharing
**Requirements:** FLEET-PROTO-001 (and the decisions every later phase depends on)

<domain>
## Phase Boundary

Phase 6 produces the wire specification and the design decisions for server → client fleet data. It changes no runtime code. Output is a spec section, decision records D-01 to D-08 marked accepted or changed, and a test plan for phases 7-10.

Target topology:

```text
  [Vessel A] ─┐                       ┌─► A receives B, C
  [Vessel B] ─┼─ UDP v3 uplink ─► [Hub server] ─┼─► B receives A, C
  [Vessel C] ─┘   (unchanged)          fleet data └─► C receives A, B
                                       over the same session
```

</domain>

<evidence>
## Code Facts the Design Relies On

These describe 4.3.0, the release the design started from. Peers that do not run fleet sharing still behave this way, which is what the compatibility rules rely on.

- Server replies go to the client packet's source `address:port` (`sendUDP` to the packet's `rinfo` in `reliable-server/data-handler.ts`). Sessions are keyed the same way (`getOrCreateSession` keys on `address:port`). Fleet packets can use that address and need no new port on the vessel.
- The client drops packets not from its configured peer, then verifies the v3 tag with its own epoch (`isExpectedPeer` and `handleControlPacket` in `reliable-client/control-packets.ts`). In 4.3.0 it dispatched ACK, NAK, META_REQUEST and FULL_STATUS_REQUEST and ignored other known types (`handleControlPacket`); 4.4.0 also handles HELLO_ACK and FLEET_DATA.
- Unknown packet types throw in the header parser (`VALID_PACKET_TYPES` check in `src/codec/packet/parser.ts`). A 4.3.0 client receiving a new type counts it in `malformedPackets` and logs at debug level (`handleControlPacket`). The server must therefore never send fleet packets to a client that did not advertise the capability.
- HELLO already carries `capabilities: string[]` (`buildHelloPacket` in `src/codec/packet/builder.ts`). A 4.3.0 server does not read it, so it ignores a new entry; a 4.4.0 server reads it for `fleet-v1` (`handleFleetHello`). HELLO payload is plaintext JSON with an HMAC tag, capped at 4096 bytes (`HELLO_PAYLOAD_MAX_BYTES`), refreshed every 300 s (`HELLO_REFRESH_INTERVAL_MS`).
- AES-256-GCM, random 12-byte IV per packet (`src/codec/crypto.ts`).
- All clients of one server instance share that instance's `secretKey`. Any client can already decrypt any other client's captured uplink, so the server instance is the existing trust group.
- `SequenceTracker`, `RetransmitQueue` and `ReplayWindow` (`src/transport/reliability/`) hold no direction-specific state.
- Server ingest keeps delta `context` and original `$source` (`handleMessageBySource` in `src/codec/source-dispatch.ts`).
- The default client subscription is `context: "*"` (`initializePersistentStorage` in `src/app/config/watcher.ts`), which includes AIS targets in the vessel's tree.
- Bonding runs two hub server instances on separate ports (`docs/bonding.md`).
- `SUPPORTED_PROTOCOL_VERSIONS` is `{3}` (`src/codec/packet/constants.ts`); a mismatched version is rejected, not negotiated.

</evidence>

<decisions>
## Design Decisions (accepted 2026-11-02)

The wire format is specified in `docs/protocol-v3-spec.md` §15. Each decision below states what was chosen and what it changed from the proposal.

### D-01: Protocol v3 capability extension (accepted)

Version byte stays `0x03`. The feature is enabled by the HELLO capability `fleet-v1` plus server config, and answered explicitly by a new HELLO_ACK packet. HELLO_ACK is generic: `accepted` lists capability strings, so later features negotiate the same way without another packet type.

### D-02: Four packet types, stream-scoped sequences (changed)

`0x09` HELLO_ACK, `0x0A` FLEET_DATA, `0x0B` FLEET_ACK, `0x0C` FLEET_NAK. Changes from the proposal:

- FLEET_DATA always carries the HMAC tag, independent of `authenticatedHeaders`. A new packet type has no legacy peers to stay compatible with, so there is no reason to leave its header unauthenticated.
- Every FLEET_DATA, FLEET_ACK and FLEET_NAK starts with a 4-byte stream id chosen by the server per accepted session. A server restart or a session re-accept starts a new stream, so the client resets its sequence tracker on a known event instead of guessing from sequence jumps.
- FLEET_ACK receivers ignore trailing bytes, leaving room for later fields such as a receive window.

### D-03: Encrypted identity with a nonce (changed)

HELLO carries `fleet`: AES-256-GCM over `{v, self, nonce, pathFilter?, maxBytesPerSec?}`. Added: a per-HELLO `nonce` echoed in HELLO_ACK. The client adopts a stream only from a HELLO_ACK that echoes its latest nonce, so a replayed old HELLO_ACK cannot switch the client to a stale stream. Duplicate `self`: newest HELLO wins.

### D-04: Scope set by the server, filtered by the receiver (changed)

Server: `scope` `fleet` (default) or `all`, `includeServerVessel` (default `false`), `pathFilter`, `maxBytesPerSec`. Added: the client sends its own `pathFilter` and `maxBytesPerSec` inside the encrypted `fleet` field. The vessel pays for its downlink, so the vessel decides what it receives; the server applies the stricter of both.

### D-05: Loop prevention on both ends (changed)

Client: drops from uplink every context it received in FLEET_DATA. Added on the server: origin authority. While fleet sharing is on, uplink deltas for a context declared by another accepted session are dropped, so vessel B's data enters the hub only from B, including AIS-derived copies of B relayed by A.

### D-06: Reliable, coalesced (accepted)

Newest value per `(context, $source, path)` between flushes; per-session token bucket; retransmit on FLEET_NAK and after 2 s unacknowledged, 3 attempts maximum, queue 512 packets.

### D-07: Join snapshot plus member-join fan-out (changed)

Snapshot on accept and on each new-nonce HELLO, at most once per 10 s. Added: when a vessel joins, its current values are queued to every other member, so members see a new vessel immediately rather than when its paths next change.

### D-08: Liveness via HELLO_ACK keepalive (changed)

Server sends HELLO_ACK after 20 s without fleet traffic to a session; client re-sends HELLO after 60 s without any fleet packet. This recovers fleet delivery after a server restart without new packet types. Offline members: no deletion; Signal K timestamps show value age.

### Bonding

Rejected by configuration validation in this milestone (FLEET-FUT-001). Stream ids are per session, so a later design can move a stream between the two links of a bonded client.

</decisions>

<risks>
## Risks and Where They Are Handled

- **NAT expiry:** fleet packets reach the vessel only while its NAT mapping is open. The 25 s default heartbeat (`startHeartbeat` in `reliable-client/lifecycle.ts`) holds mappings with timeouts above 25 s. Some carrier NATs time out UDP at 30 s, so the margin is small. `docs/troubleshooting.md` tells operators to lower `heartbeatInterval` below the NAT's UDP timeout.
- **IV budget:** one `secretKey` now encrypts uplink from every client plus fleet packets to every client. NIST SP 800-38D limits random 96-bit IVs to 2^32 encryptions per key. At 100 sessions × 10 packets/s in each direction that is 2,000 packets/s, about 25 days to reach 2^32. `docs/security.md` (AES-GCM nonce budget) covers it; online key rotation stays out of scope (FUT-SEC-001).
- **Downlink bandwidth:** each vessel receives data for N-1 vessels on a metered link. FLEET-BW-001 rate limit plus the `fleet` default scope (no AIS) bound it.
- **Session churn:** a client that changes source port gets a new session (`getOrCreateSession`); its fleet sequence restarts. Each accepted session gets its own stream id and FLEET_DATA sequences start at 0 per stream (spec §15.1, §15.4), so the client starts a fresh sequence when it adopts the new stream.

</risks>
