# Future Security and Protocol Roadmap

Future security, protocol and scaling design options, with their tradeoffs and promotion criteria. None of the future options in this document are implemented in the current release line; the Current Baseline section describes released behavior.

## Current Baseline

Payloads use AES-256-GCM with a random per-packet IV. Protocol v3 authenticates every control packet (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST and the fleet control packets) with an HMAC-SHA256 tag. v1 has no control packets. v2 was removed in 3.0.0.

`secretKey` must normalize to the same AES key on both peers. A 32-character ASCII key with `stretchAsciiKey` derives a different key than without it, so both peers must set `stretchAsciiKey` the same way.

Changing `secretKey` needs a coordinated configuration update and plugin restart on both peers. Once one peer has switched, packets from the other fail authentication.

There is no online key agreement, online key rotation or forward secrecy. Mismatched reliable protocol versions are rejected, never silently downgraded.

## Non-Goals for the Current Release Line

No handshake protocol, automatic peer negotiation, dual-key receive window, distributed rate-limit store, database-backed metrics retention or protocol-v4 wire behavior.

Future work must not weaken protocol pinning. Any new security posture must be explicit, observable and reversible by operators.

## Online Key Rotation and Key Agreement Options

| Option                                | What it could solve                                                               | Design work required                                                                                                      | Current milestone stance                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Coordinated offline rotation          | Keeps the existing operational model while documenting safer rollout steps.       | Operator runbooks, restart ordering, monitoring guidance, and incident-response timing.                                   | Safe baseline; no protocol change.              |
| Dual-key grace window                 | Allows a receiver to accept old and new keys for a bounded migration period.      | Key identifiers, strict expiry, replay protection, downgrade resistance, telemetry, failure behavior, and rollback rules. | Future design only; not implemented.            |
| Pre-shared-key ratchet                | Derives fresh traffic keys from the existing pre-shared secret over time.         | Ratchet state persistence, loss recovery, replay protection, peer authentication, desync handling, and observability.     | Future design only; requires protocol work.     |
| Authenticated ephemeral key agreement | Adds forward secrecy by authenticating an ephemeral key exchange with peer trust. | Identity model, authenticated Diffie-Hellman pattern selection, downgrade resistance, replay protection, and mixed peers. | Future design only; do not hand-roll casually.  |
| Protocol-v4 handshake                 | Provides a versioned place for capability negotiation and future crypto upgrades. | New version-gated handshake, explicit transcript binding, migration docs, rollback, metrics, and compatibility test plan. | Future protocol phase; disabled until designed. |

Consult primary specifications such as TLS 1.3 and the Noise Protocol Framework before choosing a key schedule or handshake pattern.

## Protocol Compatibility and Migration Constraints

Any protocol migration must be version-gated, opt-in, disabled by default until both peers are configured for it, and have no silent fallback, for downgrade resistance.

Before implementation, a design must specify replay protection, peer authentication, mixed-version behavior, failure behavior, operator rollout steps, rollback and observability.

Migration docs must list the peer-matching settings that can break a link: `protocolVersion`, `secretKey`, `stretchAsciiKey`, `useMsgpack` (v1 only; a v3 receiver reads the MessagePack flag in each packet), UDP address and UDP port. `usePathDictionary` is not one: the receiver decodes numeric and plain paths alike.

v3 DATA carries the same encrypted payload as v2 DATA. The v3 header has version byte `0x03`, `authenticatedHeaders` (default on) appends a 16-byte HMAC tag to DATA, and v3 added authenticated control packets. A protocol-v4 handshake must keep a clear boundary between existing v1/v3 behavior and new opt-in behavior.

## Scaling Limits and External Controls

These controls are process-local:

- management API rate limiting
- management auth telemetry
- in-memory metrics history
- per-server `MAX_CLIENT_SESSIONS`
- per-session and per-source-IP `UDP_RATE_LIMIT_MAX_PACKETS`

For global controls or longer retention, use external systems: reverse proxy or API gateway rate limits, Signal K auth/TLS, firewall/VPN allowlists, Prometheus/Grafana and external log aggregation.

Database-backed metrics history, cluster-wide rate-limit state and distributed auth telemetry are future architecture decisions. They need storage ownership, retention, cardinality, privacy, failure-mode, migration and rollback design first.

## Promotion Criteria for Future Work

Promote an item only when the active milestone needs it and the design meets the compatibility and security criteria above.

| Deferred ID   | Future backlog candidate                           | Promotion trigger                                                                                  |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| FUT-SEC-001   | 999.1 Online Key Rotation and Key Agreement Design | Promote when online rotation, key agreement, or forward secrecy is selected for design.            |
| FUT-PROTO-001 | 999.2 Protocol-v4 Compatibility and Migration Plan | Promote before any major wire-format, negotiation, or protocol-version behavior change.            |
| FUT-SCALE-001 | 999.3 Distributed Management Controls Architecture | Promote when deployments need global management rate limits or cross-process telemetry rollups.    |
| FUT-OPS-001   | 999.4 Metrics History Storage Architecture         | Promote when built-in history beyond Prometheus/Grafana or external storage becomes a requirement. |
