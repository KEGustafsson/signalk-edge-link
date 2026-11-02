# Requirements

**Project:** Signal K Edge Link
**Milestone:** v2 Fleet Data Sharing (`v2-fleet-sharing`). The milestone number is unrelated to transport protocol v2.
**Initialized:** 2026-11-02
**Scope:** Let every client of one server receive the other clients' vessel data over the link the client already opened, without receiving its own vessel back.

## Requirement States

- **Validated:** Existing behavior this milestone builds on, with code evidence.
- **Active:** Work selected for this milestone.
- **Deferred:** Real requirements, intentionally outside this milestone.

## Problem Statement

Today vessel data flows one way, client → server. The server sends the client only ACK, NAK, HEARTBEAT, META_REQUEST and FULL_STATUS_REQUEST (`src/codec/packet/constants.ts:33-43`). Vessels A, B and C reporting to hub H can only see each other if H also runs one client per vessel and each vessel runs a server. That manual setup has three problems:

1. Each vessel needs inbound UDP from H. Vessels on LTE or Starlink behind carrier-grade NAT usually cannot accept it.
2. `subscription.json` `context` is a single string (default `"*"`, `src/app/config/watcher.ts:260`), so H's client to A cannot exclude A's own vessel. A stores its own data a second time.
3. A vessel client left on `"*"` sends B's and C's data back to H. The receive-side loop guard only drops `$source` values starting with `signalk-edge-link` (`src/codec/source-dispatch.ts:44-50`), and the server keeps the original `$source` (`src/codec/source-dispatch.ts:242-248`), so relayed data passes it.

## Validated Existing Behavior

| ID         | Behavior                                                                                                                                                     | Evidence                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| VAL-FL-001 | The server sends replies to the source address and port of the client's packet, which is the mapping the client's NAT created.                               | `src/transport/pipeline/reliable-server/data-handler.ts:60`                    |
| VAL-FL-002 | Server sessions are keyed by `address:port`, capped at `MAX_CLIENT_SESSIONS = 100` per server instance.                                                      | `reliable-server/sessions.ts:111`, `src/foundation/constants.ts:87`            |
| VAL-FL-003 | The client accepts packets only from its configured peer and verifies v3 auth tags before dispatch.                                                          | `src/transport/pipeline/reliable-client/control-packets.ts:219-227`            |
| VAL-FL-004 | HELLO carries a JSON `capabilities` array. No server code reads it, so a new capability string is ignored by current servers.                                | `src/codec/packet/builder.ts:255-260`; no other `capabilit` reader             |
| VAL-FL-005 | HELLO is HMAC-authenticated but not encrypted; its payload is plaintext JSON capped at `HELLO_PAYLOAD_MAX_BYTES = 4096`. HELLO is refreshed every 300 s.     | `builder.ts:268`, `constants.ts:181`, `constants.ts:220`                       |
| VAL-FL-006 | Current parsers reject unknown packet types by throwing `Unknown packet type`. The client catches it, increments `malformedPackets` and logs at debug level. | `src/codec/packet/parser.ts:41-42`, `control-packets.ts:262-267`               |
| VAL-FL-007 | `SequenceTracker`, `RetransmitQueue` and `ReplayWindow` are standalone classes with no direction-specific state.                                             | `src/transport/reliability/{sequence,retransmit-queue,replay-window}.ts`       |
| VAL-FL-008 | Payload encryption is AES-256-GCM with a random 12-byte IV per packet.                                                                                       | `src/codec/crypto.ts:9`, `src/codec/crypto.ts:211`                             |
| VAL-FL-009 | The values snapshot walks every context in the Signal K tree and groups leaves by context, source and timestamp.                                             | `src/codec/values-snapshot.ts:230-250`                                         |
| VAL-FL-010 | The client can resolve its own vessel context URN.                                                                                                           | `src/codec/metadata/collect.ts:336`, `src/app/connection/process-delta.ts:141` |
| VAL-FL-011 | Bonding uses two independent server instances on the hub; the client switches traffic between them.                                                          | `docs/bonding.md:9`, `docs/bonding.md:71`                                      |
| VAL-FL-012 | Client heartbeat default is 25 s, which is what keeps the client's NAT mapping open between DATA packets.                                                    | `src/transport/pipeline/reliable-client/lifecycle.ts:255`                      |

## Active Milestone Requirements

| ID              | Requirement                                                                                                                                                                                           | Acceptance Signal                                                                                                                                 | Phase |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| FLEET-PROTO-001 | Specify fleet packet types, payload layouts, flags, auth tags and per-direction sequence spaces before any implementation.                                                                            | Spec section merged in `docs/protocol-v3-spec.md` (or a v4 spec, per decision D-01) with byte layouts and test vectors.                           | 6     |
| FLEET-PROTO-002 | Fleet data travels server → client over the existing session, sent to the session's `address:port`. The client opens no listening socket.                                                             | Integration test: a client with no server instance receives fleet data.                                                                           | 8     |
| FLEET-PROTO-003 | Fleet sharing is opt-in on both ends. The client advertises a capability in HELLO; the server sends fleet packets only to sessions that advertised it and only when its own option is enabled.        | Tests: a client without the capability receives zero fleet packets; a new client against a server without the feature keeps a working uplink.     | 8     |
| FLEET-PROTO-004 | Fleet data is delivered with sequence numbers, ACK/NAK and retransmission, reusing `SequenceTracker`, `RetransmitQueue` and `ReplayWindow`.                                                           | Tests for loss, duplicate, reorder, client restart and server restart on the fleet direction.                                                     | 8     |
| FLEET-PROTO-005 | With the feature disabled on either end, uplink wire bytes and behavior are unchanged.                                                                                                                | Existing `npm run test:v2` and protocol tests pass unmodified; HELLO bytes are identical when the client option is off.                           | 8     |
| FLEET-ID-001    | The client tells the server its own vessel context URN without exposing it in plaintext on the wire.                                                                                                  | Packet-capture test: the URN string does not appear in any captured datagram.                                                                     | 7     |
| FLEET-ID-002    | The server never sends a session data for that session's declared vessel context.                                                                                                                     | Test: client A receives B and C, and no delta with A's context.                                                                                   | 7     |
| FLEET-ID-003    | By default the server shares only the vessel contexts declared by sessions on the same server instance (same `secretKey`). AIS targets and other contexts are sent only if the operator selects that. | Test: an AIS context present on the hub is not sent under the default scope and is sent under the `all` scope.                                    | 7     |
| FLEET-LOOP-001  | A client never sends uplink a context it received as fleet data, even with `subscription.json` `context: "*"`.                                                                                        | Test: hub + 2 clients with `"*"`; hub receives each vessel's data only from that vessel's own session.                                            | 7     |
| FLEET-SNAP-001  | When a session first advertises the capability, or reconnects with a higher epoch, the server sends a snapshot of current fleet values. Rate-limited per session.                                     | Test: a late-joining client receives existing fleet values without waiting for new deltas; repeated HELLOs within the limit trigger one snapshot. | 8     |
| FLEET-BW-001    | The server enforces a per-session fleet rate limit configured by the operator, coalescing to the latest value per path when over the limit.                                                           | Test: under the limit nothing is dropped; over it, bytes/s stays at or under the limit and the newest value per path is delivered.                | 8     |
| FLEET-SEC-001   | Fleet DATA is AES-256-GCM encrypted. `authenticatedHeaders` and `epochBoundAuth` apply to the fleet direction. Fleet ACK/NAK from the client carry v3 HMAC tags.                                      | Negative tests: tampered, replayed, wrong-key and wrong-epoch fleet packets are rejected and counted.                                             | 8     |
| FLEET-SEC-002   | The client caps inbound fleet packets per second and fleet payload size, and drops fleet packets when its own option is off.                                                                          | Tests: over-cap packets are dropped and counted; a client with the option off processes no fleet packet.                                          | 8     |
| FLEET-SEC-003   | Document the AES-GCM random-IV budget per key across both directions and all sessions sharing one `secretKey`.                                                                                        | `docs/security.md` states the limit, its source (NIST SP 800-38D) and the packet rate at which it matters.                                        | 10    |
| FLEET-CFG-001   | Fleet options exist in every config surface: `src/index.ts`, `src/shared/connection-schema.ts`, the web UI, `docs/configuration-reference.md`, samples and tests. Default is off.                     | Schema, route and UI tests cover the new fields; `npm run check:ts` passes.                                                                       | 9     |
| FLEET-CFG-002   | Config validation rejects fleet sharing together with bonding, and with `protocolVersion: 1`.                                                                                                         | Validation tests for both combinations.                                                                                                           | 9     |
| FLEET-OPS-001   | JSON metrics and Prometheus output cover fleet packets, bytes, retransmits, rate-limit drops, loop drops and peer count on both ends, with no per-vessel labels.                                      | Metrics and Prometheus formatting tests; `docs/metrics.md` updated.                                                                               | 9     |
| FLEET-OPS-002   | The client reports fleet state: `disabled`, `offered` (capability sent, nothing received), `active`, or `not-offered` (no fleet packet after a timeout).                                              | Status route test for each state; `not-offered` is visible in the UI.                                                                             | 9     |
| FLEET-TEST-001  | An in-process test runs one hub and three clients; each client ends with the other two vessels and not its own.                                                                                       | Integration test under `test/` passes in CI.                                                                                                      | 10    |
| FLEET-DOC-001   | README topology section, protocol spec, configuration reference, metrics, security and troubleshooting docs describe fleet sharing, including the NAT keepalive dependency on heartbeats.             | `npm run check:release-docs` passes; docs reviewed against the implemented code.                                                                  | 10    |

## Non-Goals

- Fleet sharing over bonded links (deferred as FLEET-FUT-001).
- Fleet sharing on protocol v1.
- Hub-to-hub meshes or chains of hubs exchanging fleet data.
- Per-vessel access control beyond the server-instance scope in FLEET-ID-003.
- Delay-based congestion control on the fleet direction; this milestone adds loss-adaptive pacing (spec §15.9) on top of the FLEET-BW-001 limit.
- Changes to key management, key rotation or forward secrecy (tracked as FUT-SEC-001).

## Deferred Requirements

| ID            | Requirement                                                                        | Reason Deferred                                                                                        |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FLEET-FUT-001 | Fleet sharing over bonded links.                                                   | Two hub server instances would both send to the client; needs a rule for which one sends (VAL-FL-011). |
| FLEET-FUT-002 | `/sources` tree sharing on the fleet direction.                                    | Each update already carries its `source` object; a full tree copy has not been needed.                 |
| FLEET-FUT-004 | Sharing across server instances with different `secretKey` values on the same hub. | Crosses a trust boundary the operator created by using different keys.                                 |

## Coverage Check

All active requirements are assigned to one roadmap phase:

- Phase 6: FLEET-PROTO-001
- Phase 7: FLEET-ID-001, FLEET-ID-002, FLEET-ID-003, FLEET-LOOP-001
- Phase 8: FLEET-PROTO-002, FLEET-PROTO-003, FLEET-PROTO-004, FLEET-PROTO-005, FLEET-SNAP-001, FLEET-BW-001, FLEET-SEC-001, FLEET-SEC-002
- Phase 9: FLEET-CFG-001, FLEET-CFG-002, FLEET-OPS-001, FLEET-OPS-002
- Phase 10: FLEET-SEC-003, FLEET-TEST-001, FLEET-DOC-001
