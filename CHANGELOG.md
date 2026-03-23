# Changelog

All notable changes to signalk-edge-link are documented here.

## [2.1.1]

### Fixed

- **RTT measurement accuracy** (`pipeline-v2-client.ts`): Improved RTT
  measurement with Karn's algorithm — retransmitted packets are now excluded
  from RTT samples to prevent inflated estimates. Added smoothed RTO
  calculation for more stable timeout behaviour on lossy links (PR #106).
- **Stale RTT in congestion control** (`pipeline-v2-client.ts`): Prevented
  stale RTT values from being fed to the congestion control EMA, which could
  cause unnecessary delta timer increases after idle periods (PR #106).
- **Bonding link validation** (`connection-config.ts`): Added validation that
  bonding primary and backup links use different address:port combinations,
  preventing misconfiguration where the same link is used for both.
- **Stop-race in delta flush** (`instance.ts`): Added `state.stopped` guard
  in the `flushDeltaBatch` finally block to prevent scheduling an extra flush
  via `setImmediate` after `stop()` is called.

### Removed

- **Dead `networkSimulator` code** (`types.ts`, `instance.ts`,
  `routes/monitoring.ts`): Removed the `networkSimulator` field from
  `InstanceState` and all references — it was declared but never instantiated.
  The `/monitoring/simulation` endpoint is preserved for API compatibility and
  returns `{ enabled: false }`.

### Tests

- Added `connection-config.test.js` with unit tests for bonding primary/backup
  validation and basic connection config validation.

---

## [2.1.1]

### Highlights

Reliability and UI modernisation release. Fixes an oversized-packet bug in the
sender pipeline, rewrites the plugin configuration panel for broader React
compatibility, and adds comprehensive failover/recovery test coverage.

### Changed

- **PluginConfigurationPanel rewrite**: Rewrote the RJSF-based configuration
  panel for React 19 compatibility; also compatible with React 16. Replaced
  `@signalk/server-admin-ui-dependencies` with standalone `@rjsf/core`,
  `@rjsf/utils`, and `@rjsf/validator-ajv8` (PR #101).
- **React 16 dev dependency**: Development and testing now use React 16 to
  match the Signal K reference plugin environment (PR #101).

### Fixed

- **Oversized UDP packets** (`instance.ts`, `pipeline-v2-server.ts`,
  `pipeline.ts`): The sender now caps each flush batch at
  `state.maxDeltasPerBatch`, and the receiver enforces `MAX_DELTAS_PER_PACKET`
  (500) on inbound packets, truncating and logging excess deltas. This prevents
  MTU-exceeding packets that could be silently dropped by the network (PR #103).

### Tests

- Added 31 component tests for `PluginConfigurationPanel` covering CRUD, mode
  switching, validation, save/load, and error states (PR #101).
- Added comprehensive failover-recovery lifecycle tests for `BondingManager`,
  including 15 additional gap-coverage tests for edge cases (PR #104).
- Added flush batch cap, drain loop, and buffer overflow tests for the sender
  pipeline (PR #103).

---

## [2.0.0]

### Highlights

First stable release of the v2 series. This release promotes the 2.0.0-beta
series (twelve beta iterations) to stable and closes all known reliability,
type-safety, and documentation gaps identified during the pre-release audit.

### Added

- **Protocol v3**: Control-plane authentication with HMAC-SHA256 over the hello
  handshake, preventing unauthenticated nodes from injecting control packets.
- **Connection bonding**: Primary/backup link management with automatic failover,
  health scoring, and configurable RTT/loss thresholds (`src/bonding.ts`).
- **AIMD congestion control**: Additive-increase / multiplicative-decrease delta
  timer adjustment with RTT feedback loop (`src/congestion.ts`).
- **Recovery burst**: Automatic retransmission burst when ACK silence exceeds
  `recoveryAckGapMs` (default 4 s), recovering from extended network outages
  without waiting for explicit NAKs.
- **Comprehensive observability**: Prometheus metrics endpoint, per-path
  statistics, packet-loss heatmaps, alert thresholds, and packet capture
  (`src/monitoring.ts`, `src/packet-capture.ts`).
- **Path dictionary**: Dictionary-based path compression for up to 40 % payload
  reduction on typical Signal K delta streams (`src/pathDictionary.ts`).
- **Smart batching**: Adaptive delta coalescing that learns average delta size
  and maximises UDP frame utilisation without exceeding `MAX_SAFE_UDP_PAYLOAD`.
- **Management REST API**: Token-authenticated endpoints for instance CRUD,
  live metrics, monitoring alerts, and connection health.
- **Brotli + MessagePack**: Optional binary encoding alongside existing zlib
  compression; negotiated per-packet via packet flags.
- **Socket recovery**: Automatic UDP socket recreation on error, with per-worker
  restart and subscription handover to keep data flowing during recovery.
- **Retransmit deduplication**: `getOldestSequences(limit, minRetransmitAge)`
  filter prevents the recovery burst and a concurrent NAK handler from
  double-sending the same sequence within one burst interval.

### Changed

- **Default protocol**: New connections default to v2 (reliable ACK/NAK). v1
  remains available for legacy interop via `protocolVersion: 1`.
- **Configuration schema**: `connections` is now an array of objects; the old
  single-connection flat schema is auto-migrated on first load.
- **Sequence numbers**: 32-bit unsigned with correct wraparound arithmetic
  throughout (serial-space comparisons replace naive subtraction).
- **Error handling**: All `catch` clauses now type `err: unknown` and narrow via
  `instanceof Error`; `as any` casts reduced from ~340 to zero in hot paths.
- **Key validation**: `validateSecretKey` rejects malformed base64 inputs with
  an explicit error instead of silently falling through to the ASCII key path.
- **Rate limiting**: Management API routes enforce per-IP request limits to
  prevent log-flooding and resource exhaustion from misbehaving clients.

### Fixed

- **Timer leak** (`instance.ts`): `clearInterval(state.helloMessageSender)` is
  now called unconditionally before creating a replacement interval, preventing
  timer accumulation if `start()` is ever called more than once on an instance.
- **Telemetry flag** (`pipeline-v2-client.ts`): `telemetrySendInFlight` is now
  reset inside a `try/catch` that also covers the `sendDelta()` call, so a
  synchronous throw can never leave the flag permanently `true`.
- **Socket recovery race** (`instance.ts`): `socketRecoveryInProgress` is set
  atomically at the start of the error handler; `state.stopped` is checked
  inside the recovery `setTimeout` callback before recreating the socket.
- **recoveryDrainTimer teardown** (`pipeline-v2-client.ts`): Timer is cleared
  in `stopMetricsPublishing()` before any other state is torn down, ensuring
  `_runRecoveryBurst()` cannot fire against partially cleaned-up state.
- **Subscription leak** (`instance.ts`): Old unsubscribe handlers are preserved
  in a local variable during re-subscription; they are released only after the
  new subscription is confirmed, and restored on failure so `stop()` can always
  clean up.
- **NaN/Infinity in congestion control**: `_calculatePacketLoss()` result is
  clamped to `[0, 1]` before being passed to `congestionControl.updateMetrics()`.
- **Webpack vulnerability**: Upgraded `copy-webpack-plugin` and
  `jest-environment-jsdom` to resolve two high-severity CVEs (PR #95).
- **API warning noise**: Removed misleading management-API token warning that
  fired even when authentication was correctly configured (PR #94).

### Security

- Protocol v3 hello authentication prevents unauthenticated control packets.
- AES-256-GCM with a 12-byte random IV per packet; no IV reuse across sessions.
- Timing-safe comparison for HMAC verification tags.
- Base64 key decoding validates decoded length and throws on mismatch rather
  than silently using a truncated key.
- Management API enforces token authentication and per-route rate limiting.
