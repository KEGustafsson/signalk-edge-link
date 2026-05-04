# Future Security and Protocol Roadmap

This note tracks future security, protocol, and scaling design work for Signal K Edge Link. It documents tradeoffs and promotion criteria only; it does not describe capabilities that exist in the current release line.

## Current Baseline

Current payloads use AES-256-GCM with a per-packet random IV. Protocol v3 authenticates ACK, NAK, HEARTBEAT, HELLO, and META_REQUEST control packets with HMAC tags, while v1 and v2 retain their existing behavior.

The configured `secretKey` must normalize to the same AES key on both peers. If a 32-character ASCII key is used with `stretchAsciiKey`, both peers must set `stretchAsciiKey` the same way, because that setting changes the derived key.

Changing `secretKey` requires a coordinated configuration update and plugin restart on both peers. Packets encrypted or authenticated with an old key fail authentication after the peer has switched to the new key.

There is no online key agreement, online key rotation, or forward secrecy today. Current protocol-version pinning intentionally rejects mismatched reliable protocol versions rather than falling back silently.

## Non-Goals for the Current Release Line

The current release line does not add a handshake protocol, automatic peer negotiation, dual-key receive windows, a distributed rate-limit store, database-backed metrics retention, or protocol-v4 wire behavior.

Future work must not weaken current protocol pinning. Any new security posture must be explicit, observable, and reversible by operators.

## Online Key Rotation and Key Agreement Options

| Option                                | What it could solve                                                               | Design work required                                                                                                      | Current milestone stance                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Coordinated offline rotation          | Keeps the existing operational model while documenting safer rollout steps.       | Operator runbooks, restart ordering, monitoring guidance, and incident-response timing.                                   | Safe baseline; no protocol change.              |
| Dual-key grace window                 | Allows a receiver to accept old and new keys for a bounded migration period.      | Key identifiers, strict expiry, replay protection, downgrade resistance, telemetry, failure behavior, and rollback rules. | Future design only; not implemented.            |
| Pre-shared-key ratchet                | Derives fresh traffic keys from the existing pre-shared secret over time.         | Ratchet state persistence, loss recovery, replay protection, peer authentication, desync handling, and observability.     | Future design only; requires protocol work.     |
| Authenticated ephemeral key agreement | Adds forward secrecy by authenticating an ephemeral key exchange with peer trust. | Identity model, authenticated Diffie-Hellman pattern selection, downgrade resistance, replay protection, and mixed peers. | Future design only; do not hand-roll casually.  |
| Protocol-v4 handshake                 | Provides a versioned place for capability negotiation and future crypto upgrades. | New version-gated handshake, explicit transcript binding, migration docs, rollback, metrics, and compatibility test plan. | Future protocol phase; disabled until designed. |

Future design work should consult primary protocol specifications such as TLS 1.3 and the Noise Protocol Framework before choosing any key schedule or handshake pattern.

## Protocol Compatibility and Migration Constraints

Any protocol migration must be version-gated, opt-in, disabled by default until both peers are intentionally configured, and have no silent fallback. This is required for downgrade resistance and to keep security posture understandable.

Future designs must specify replay protection, peer authentication, mixed-version behavior, failure behavior, operator rollout steps, rollback, and observability before implementation starts.

Peer-matching settings that can break a link must remain explicit in migration docs: `protocolVersion`, `secretKey`, `stretchAsciiKey`, `useMsgpack`, `usePathDictionary`, UDP address, and UDP port.

Protocol v3 currently reuses the v2 data packet format and adds authenticated control packets. Any protocol-v4 handshake should preserve a clear boundary between existing v1/v2/v3 behavior and new opt-in behavior.

## Scaling Limits and External Controls

Current scaling controls are intentionally process-local:

- process-local management API rate limiting
- process-local management auth telemetry
- in-memory metrics history
- per-server `MAX_CLIENT_SESSIONS`
- per-session `UDP_RATE_LIMIT_MAX_PACKETS`

Deployments that need global controls or longer retention should use external systems first: reverse proxy or API gateway rate limits, Signal K auth/TLS, firewall/VPN allowlists, Prometheus/Grafana, and external log aggregation.

Database-backed metrics history, cluster-wide rate-limit state, and distributed auth telemetry aggregation are future architecture decisions. They need storage ownership, retention, cardinality, privacy, failure-mode, migration, and rollback design before implementation.

## Promotion Criteria for Future Work

Future work should be promoted only when the active milestone needs it and the design can satisfy the compatibility and security criteria above.

| Deferred ID   | Future backlog candidate                           | Promotion trigger                                                                                  |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| FUT-SEC-001   | 999.1 Online Key Rotation and Key Agreement Design | Promote when online rotation, key agreement, or forward secrecy is selected for design.            |
| FUT-PROTO-001 | 999.2 Protocol-v4 Compatibility and Migration Plan | Promote before any major wire-format, negotiation, or protocol-version behavior change.            |
| FUT-SCALE-001 | 999.3 Distributed Management Controls Architecture | Promote when deployments need global management rate limits or cross-process telemetry rollups.    |
| FUT-OPS-001   | 999.4 Metrics History Storage Architecture         | Promote when built-in history beyond Prometheus/Grafana or external storage becomes a requirement. |
