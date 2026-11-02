# Phase 6: Fleet Sharing Protocol Design - Context

**Gathered:** 2026-11-02
**Status:** Ready for planning
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

- Server replies go to the client packet's source `address:port` (`src/transport/pipeline/reliable-server/data-handler.ts:60`). Sessions are keyed the same way (`reliable-server/sessions.ts:111`). Fleet packets can use that address and need no new port on the vessel.
- The client drops packets not from its configured peer, then verifies the v3 tag with its own epoch (`reliable-client/control-packets.ts:219-227`). It dispatches ACK, NAK, META_REQUEST, FULL_STATUS_REQUEST and ignores other known types (`control-packets.ts:239-262`).
- Unknown packet types throw in the header parser (`src/codec/packet/parser.ts:41-42`). A current client receiving a new type counts it in `malformedPackets` and logs at debug level (`control-packets.ts:262-267`). The server must therefore never send fleet packets to a client that did not advertise the capability.
- HELLO already carries `capabilities: string[]` (`src/codec/packet/builder.ts:255-260`). No server code reads it, so current servers ignore a new entry. HELLO payload is plaintext JSON with an HMAC tag, capped at 4096 bytes (`src/foundation/constants.ts:181`), refreshed every 300 s (`constants.ts:220`).
- AES-256-GCM, random 12-byte IV per packet (`src/codec/crypto.ts:211`).
- All clients of one server instance share that instance's `secretKey`. Any client can already decrypt any other client's captured uplink, so the server instance is the existing trust group.
- `SequenceTracker`, `RetransmitQueue` and `ReplayWindow` (`src/transport/reliability/`) hold no direction-specific state.
- Server ingest keeps delta `context` and original `$source` (`src/codec/source-dispatch.ts:242-248`).
- The default client subscription is `context: "*"` (`src/app/config/watcher.ts:260`), which includes AIS targets in the vessel's tree.
- Bonding runs two hub server instances on separate ports (`docs/bonding.md:71`).
- `SUPPORTED_PROTOCOL_VERSIONS` is `{3}` (`src/codec/packet/constants.ts:24`); a mismatched version is rejected, not negotiated.

</evidence>

<decisions>
## Design Decisions (proposed; accept or change during planning)

### D-01: Protocol v3 capability extension, not protocol v4

**Proposal:** Add new packet types under protocol version `0x03`, enabled only by a HELLO capability (`fleet-v1`) and server config.

**Reason:** The uplink format is unchanged (FLEET-PROTO-005). Current servers ignore the capability (VAL-FL-004), and the server sends nothing new to a client without it, so mixed fleets keep working.

**Constraint from `docs/future-security-and-protocol-roadmap.md`:** opt-in, explicit, no silent fallback. A client configured for fleet data whose server never sends any must report `not-offered` (FLEET-OPS-002), not stay silent.

**Alternative:** treat this as backlog phase 999.2 (protocol v4). That costs a version bump on every peer and gains nothing the capability gate does not already give.

### D-02: New packet types

| Value | Name      | Direction       | Payload                                                                |
| ----- | --------- | --------------- | ---------------------------------------------------------------------- |
| 0x09  | FLEET     | Server → Client | Same pipeline as DATA: serialize, path dictionary, Brotli, AES-256-GCM |
| 0x0A  | FLEET_ACK | Client → Server | uint32 cumulative fleet sequence + HMAC tag                            |
| 0x0B  | FLEET_NAK | Client → Server | uint32[] missing fleet sequences + HMAC tag                            |

Existing ACK/NAK cannot be reused: they acknowledge the client's uplink sequence. Fleet sequence numbers are a separate space per session.

**To specify in this phase:** whether `useMsgpack` and `usePathDictionary` follow the session's uplink flags or are set by the server; how `AUTHENTICATED_HEADER` and `EPOCH_BOUND_AUTH` bind on FLEET (which epoch: the client's, as control packets do today).

### D-03: Encrypted vessel identity in HELLO

**Proposal:** When the capability is on, HELLO carries a field `fleetIdentity`: the client's self context URN, AES-256-GCM encrypted with the session key and base64 encoded.

**Reason:** HELLO is plaintext (VAL-FL-005); a plain URN would put the vessel's MMSI on the wire (FLEET-ID-001). HELLO is already retried and refreshed every 300 s, so the identity reaches a restarted server without a new packet type.

**Alternative:** infer identity from uplink DATA contexts. Rejected: with `context: "*"` a client sends AIS targets too, so the contexts it sends do not identify it.

**Open:** what the server does when two sessions declare the same URN (vessel reinstalled, NAT port change). Proposal: the newest session wins; the older one is removed from the fleet set and counted.

### D-04: Sharing scope

**Proposal:** `fleetSharing.scope` on the server:

- `fleet` (default): only contexts declared by live sessions on this server instance, minus the receiving session's own.
- `all`: every context in the hub's tree except the receiving session's own (includes AIS).

Plus `includeServerVessel` (default `false`): also send the hub's own `vessels.self`, for when the hub is itself a vessel.

### D-05: Loop prevention on the client

**Proposal:** The client records every context it writes from FLEET packets and drops those contexts in `processDelta` before uplink (`src/app/connection/process-delta.ts`). The client's own self context is never added to that set.

**Why not force `context: "vessels.self"`:** `"*"` is the default (`src/app/config/watcher.ts:260`) and forwards the vessel's AIS targets to the hub; forcing `vessels.self` would stop that.

**Open:** how long a context stays in the set after its last FLEET delta. Proposal: for the life of the connection.

### D-06: Delivery: reliable, coalesced at batch time

**Proposal:** Reuse the uplink batching interval model; before sending a batch, keep only the newest value per `(context, path, $source)`. Send with fleet sequence numbers and retransmit on FLEET_NAK. Retransmit queue size bounded per session.

**Alternative:** best-effort, no retransmit. Smaller code, but a lost packet leaves a stale value until that path changes; slow-changing paths (e.g. `design.*`, anchor position) could stay stale for hours.

### D-07: Join and restart snapshot

**Proposal:** On first HELLO with the capability, or a HELLO with a higher epoch, send a values snapshot of the scoped contexts, built with `src/codec/values-snapshot.ts`. At most one snapshot per session per 10 s, matching FULL_STATUS_REQUEST's existing limit.

### D-08: Fleet member goes offline

**Proposal:** Do nothing in this milestone. Signal K keeps last values with their timestamps, so receivers can judge age. Document it in troubleshooting.

**Alternative:** send a notification delta when a member's session expires. Deferred until someone asks for it.

</decisions>

<risks>
## Risks to Address in the Spec

- **NAT expiry:** fleet packets reach the vessel only while its NAT mapping is open. The 25 s default heartbeat (`reliable-client/lifecycle.ts:255`) holds mappings with timeouts above 25 s. Some carrier NATs time out UDP at 30 s, so the margin is small. Document; consider recommending `heartbeatInterval` ≤ 20000 when fleet sharing is on.
- **IV budget:** one `secretKey` now encrypts uplink from every client plus fleet packets to every client. NIST SP 800-38D limits random 96-bit IVs to 2^32 encryptions per key. At 100 sessions × 10 packets/s in each direction that is 2,000 packets/s, about 25 days to reach 2^32. Phase 10 documents this (FLEET-SEC-003); key rotation itself stays in FUT-SEC-001.
- **Downlink bandwidth:** each vessel receives data for N-1 vessels on a metered link. FLEET-BW-001 rate limit plus the `fleet` default scope (no AIS) bound it.
- **Session churn:** a client that changes source port gets a new session (`sessions.ts:111`); its fleet sequence restarts. The spec must say the client resets its fleet `SequenceTracker` when the server's fleet sequence restarts after a new HELLO.

</risks>

<deliverables>
## Phase 6 Deliverables

1. Draft section in `docs/protocol-v3-spec.md`: FLEET, FLEET_ACK, FLEET_NAK byte layouts, flag use, tag inputs, capability string, `fleetIdentity` format, sequence rules.
2. Test vectors for each new packet (fixed key, epoch, sequence, payload → expected bytes), checked into `__tests__/fixtures/` during Phase 8.
3. Each decision D-01 to D-08 marked accepted or replaced in this file.
4. Phase 7-10 plans, starting with `07-01-PLAN.md`.

Validation for this phase is review only: no source changes, `git diff --stat` limited to `docs/` and `.planning/`.

</deliverables>
