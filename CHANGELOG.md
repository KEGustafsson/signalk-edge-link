# Changelog

All notable changes to signalk-edge-link are documented here.

## [2.8.0] - 2026-05-21

### Fixed

- **Duplicate outbound deltas in proxy chains** (`pipeline.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`): When
  edge-link instances were chained (boat → relay → shore), a delta could
  fan out twice because both the live processDelta path and the cache
  replay path emitted the same value. Outbound dedupe now keys on
  `(context, path, $source, timestamp, value-hash)` and drops repeats
  before they hit the UDP send queue.
- **Synchronous cache replay during `subscribe()`** (`pipeline.ts`):
  signalk-server's subscriptionmanager flushes its current cache
  synchronously inside `subscribe()`, which raced with our own snapshot
  replay and produced doubled deltas for every cached path on plugin
  start. The synchronous flush is now suppressed so only our deterministic
  replay path runs.
- **Doubled `processDelta` delivery after restart** (`pipeline.ts`,
  `instance.ts`): Two independent races could each rebind the
  `processDelta` listener twice — once during start/stop overlap, once
  when the flow-diagnostic timer started before the listener was
  attached. Both are now ordered so a failed start cannot leak a timer
  or a second listener.
- **`isServerMode()` startup-ordering bug** (`instance.ts`): The helper
  read from runtime state that was not yet populated when
  signalk-server started the plugin before its own server bind
  completed. It now derives directly from the plugin options so
  server/client mode is correct from the first delta.
- **Boat-side `$source` lost across hops** (`pipeline.ts`,
  `pipeline-v2-server.ts`): Multi-hop chains were rewriting `$source` on
  each hop, hiding the original device. The original boat-side `$source`
  is now preserved verbatim end-to-end.
- **Edge-link-injected values leaked into outbound snapshots**
  (`pipeline-v2-server.ts`): Values the plugin itself wrote back into
  signalk-server (e.g. RTT, link state) were being re-sent in the next
  full snapshot, creating a feedback loop. Those paths are now excluded
  from the outbound snapshot.
- **`FULL_STATUS_REQUEST` not cascading across multi-hop chains**
  (`pipeline-v2-server.ts`, `pipeline-v2-client.ts`): A server restart
  in the middle of a chain only requested a snapshot from its immediate
  upstream peer; downstream peers stayed stale. The request now cascades
  end-to-end and the drain runs again after each hop's snapshot
  arrives.
- **Source attribution + timestamps lost during snapshot replay**
  (`pipeline-v2-server.ts`): FullStatus replay was synthesizing a fresh
  timestamp and a generic `$source`, which broke downstream consumers
  relying on the original metadata. Both are now preserved.
- **Spurious v1-field rejection in HTTP route handlers** (`routes/connections.ts`):
  The connection POST/PUT handlers were validating raw request bodies before
  sanitization, so when the webapp re-submitted a config that still carried
  v1-only fields (`testAddress`, `testPort`, `pingIntervalTime`) on a v2/v3
  connection — the very rejection rule added in 2.5.1 — the request failed
  even though those fields would have been stripped by the sanitizer a step
  later. The route handlers now sanitize before validate, so v1-only fields
  on a v2/v3 body are silently dropped on the HTTP path. The 2.5.1 rejection
  rule in `validateConnectionConfig` is unchanged; it still fires for any
  caller that validates without sanitizing first.

### Security

- **Peer-supplied data hardening** (`pipeline-v2-server.ts`, `packet.ts`,
  `crypto.ts`, schema): Tightened bounds on every field a peer can
  influence — snapshot chunk count, METADATA path lists, source
  registry size, dedupe LRU cap — to prevent a hostile or
  malfunctioning peer from inflating local memory. All limits are
  configurable but default to safe values.
- **v2 CRC-only control frames flagged** (`packet.ts`, schema): v2
  control frames are still CRC-protected rather than HMAC-protected
  (v3 fixed this). The schema now surfaces a deprecation warning when
  a connection is configured for v2, and `parseHeader()` records the
  weaker auth posture in metrics so operators can see the exposure.

### Added

- **CI gate on every PR + push** (`.github/workflows/`): A new workflow
  runs `lint`, `check:ts`, webapp typecheck, `build`, and `test` on
  every PR and on direct pushes. Release-doc drift continues to be
  checked by `check:release-docs` inside the publish workflow.
- **Chunked snapshot replay** (`pipeline-v2-server.ts`): Snapshot
  replay now chunks large state trees so a fresh subscribe on a busy
  boat does not block the event loop or exceed UDP MTU.
- **Per-path `processDelta` counter (opt-in)** (`instance.ts`): When
  `SIGNALK_EDGE_LINK_PROCESS_DELTA_TRACE` is set, the plugin records
  per-path call counts to make hop-inflation issues observable
  without leaving the diagnostic on in production builds.

### Changed

- **Cheaper outbound dedupe** (`pipeline.ts`): The dedupe LRU now uses
  a fixed-size ring + content hash instead of a growing Map keyed on
  full delta JSON. Steady-state memory is bounded and dedupe lookup
  is O(1).

## [2.6.0] - 2026-05-11

### Added

- **Full-values snapshot request on server restart** (`packet.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`): When a v2/v3
  server restarts mid-session, it now emits a `FULL_STATUS_REQUEST`
  control frame and the client responds with a snapshot of every
  currently-known path. This eliminates the "ghost values" window where
  a restarted server reported stale or missing data until each path
  happened to update again.
- **State replay on subscribe and recovery** (`pipeline.ts`): The
  pipeline now replays the current Signal K tree state at subscribe
  time and after socket recovery, so receivers see a consistent
  starting point without waiting for the next live update.

## [2.5.1] - 2026-05-10

### Fixed

- **Lost startup deltas while subscription is pending** (`pipeline.ts`):
  Signal K deltas that arrived between plugin start and the
  subscriptionmanager finishing its first subscribe were being
  silently dropped. They are now buffered and dispatched once the
  subscription is active.
- **Stale `connections` key in flat-config sync** (`config-io.ts`): The
  legacy flat-config `_currentOptions` sync path retained a stale
  `connections` key when a connection was deleted, causing the deleted
  connection to resurrect on next reload.
- **`testAddress` / `testPort` / `pingIntervalTime` accepted on v2/v3
  clients** (`schema`, `routes.ts`): These v1-only fields are now
  rejected on v2/v3 clients with a clear validation error instead of
  silently being ignored.
- **Connections not sanitized before validation at startup**
  (`instance.ts`): A startup config with leftover v1 fields on a v2
  connection failed validation; sanitization now runs first so the
  config loads cleanly.
- **Persistence fallback + stale-version regex** (`config-io.ts`,
  `scripts/check-release-truth.js`): The release-truth check missed
  prerelease suffixes (`-rc.1`, `-beta.0`) and the persistence
  fallback path could write a corrupted file on disk-full conditions.
- **Redacted secret restoration hardening** (`config-io.ts`): When a
  redacted secret round-tripped through the UI, edge cases could
  restore the wrong original value. The restore path now requires
  byte-exact placeholder matching.

### Added

- **Phase 4 + Phase 5 documentation** (`.planning/`, `docs/`): Schema
  parity, webapp type-safety, configuration parity, and the future
  security roadmap are now captured in versioned planning docs and
  linked from `docs/README.md`.
- **Webapp `noImplicitAny`** (`tsconfig.webapp.json`,
  `src/webapp/`): The webapp build now enforces `noImplicitAny`;
  configuration-form change handlers and the configuration panel are
  fully typed.
- **UDP metadata port schema + route + tests** (`schema`, `routes.ts`,
  `__tests__/`): The previously implicit `udpMetaPort` option is now
  schema-validated, exposed via the management routes, and covered by
  parity tests.

## [2.5.0] - 2026-04-28

### Added

- **Source replication over UDP** (`source-registry.ts`,
  `source-replication.ts`, `pipeline-v2-client.ts`,
  `pipeline-v2-server.ts`, `packet.ts`): Client-side `$source`
  identities are now replicated to the server so the receiver sees the
  same provenance (`vessels.self.navigation.position` from
  `gps.0`, `ais.1`, etc.) as the sender, instead of every value
  collapsing into `edge-link`. Snapshot at startup, live diffs after,
  with a debounced registry-size log and a deterministic identity
  hash so re-registrations do not cause spurious updates.
- **Metadata contract alignment**: Source-replication metadata uses an
  empty object (`{}`) for "no metadata" instead of `null`, matching the
  metadata streaming contract from 2.3.0.

### Fixed

- **Source-replication merge timing + no-op hash + API exposure**
  (`source-registry.ts`): A racy merge could overwrite a freshly
  registered source with stale data; the no-op detector now uses a
  content hash so identical re-registrations are skipped; the
  registry API is exposed for tests and the receiver side.
- **Missing source metadata updates** (`pipeline-v2-server.ts`):
  Regression test added — a metadata-only update on an
  already-known source was being dropped.

### Security

- **Harden redacted secret restoration** (`config-io.ts`): Round-tripped
  secrets that did not match the exact redaction placeholder are now
  rejected rather than silently passed through.

## [2.4.1] - 2026-04-27

### Fixed

- **Null/empty placeholder metadata fields** (`metadata.ts`): A
  Signal K source emitting `meta: { units: null, description: "" }`
  was being treated as a metadata change on every delta, causing
  unnecessary METADATA packets. Null and empty placeholders are now
  preserved as explicit clears (renamed sanitizer) but no longer
  trigger spurious diff packets.

## [2.4.0] - 2026-04-25

### Fixed

- **RTT path always forwarded under `skipOwnData`** (`pipeline.ts`):
  When `skipOwnData` was enabled to suppress echoing local writes back
  upstream, it was also suppressing the plugin's own RTT measurement
  path. RTT now always forwards regardless of `skipOwnData`.
- **Plugin selection bug** (`instance.ts`): A config with multiple
  connections could pick the wrong pipeline implementation when the
  first connection was v1 and later ones were v2/v3.

## [2.3.0] - 2026-04-24

### Added

- **Optional metadata streaming** (`metadata.ts`, `packet.ts`, `pipeline.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`, schema):
  Signal K path metadata (units, descriptions, zones, display names, ...) can
  now be forwarded to the remote receiver alongside deltas by adding a `meta`
  block to `subscription.json`. Default off, so existing deployments are
  unchanged.
  - Two new packet types: `METADATA` (0x06) on v2/v3 and `META_REQUEST` (0x07)
    so a receiver can demand a fresh snapshot on startup without waiting for
    the next periodic resend.
  - v1 clients transmit meta on a separate `udpMetaPort` with an `"SKM1"`
    magic prefix inside the encrypted payload; existing v1 receivers that
    have not been upgraded ignore the packets.
  - Full snapshot at startup and on socket recovery; live meta changes
    pulled from `updates[].meta[]` and coalesced into a debounced diff
    packet; periodic full resend (default 300 s, configurable 30–86400 s).
  - Diffs computed against a sha1 cache so unchanged meta is never resent;
    `includePathsMatching` regex and `maxPathsPerPacket` chunking for
    bandwidth control.
  - Web UI: new fieldset in the subscription card exposes the meta toggle,
    interval, regex, and packet-size controls.
  - Receiver side: `pipeline-v2-server.ts` decodes METADATA packets and
    re-emits each entry as a Signal K delta with `updates[].meta[]` so the
    local Signal K server picks it up via `app.handleMessage`.

## [2.2.0] - 2026-04-17

### Breaking

- **`parseHeader({ allowUnauthenticatedControl })` removed** (`packet.ts`):
  The option was never used in production code paths and allowed v3 control
  frames to bypass HMAC verification. V3 control packets are now always
  HMAC-verified.

### Added

- **Opt-in ASCII-key stretching with `stretchAsciiKey`** (`crypto.ts`,
  `packet.ts`, `bonding.ts`, `pipeline-v2-*.ts`, schema): A new per-connection
  boolean option `stretchAsciiKey` (default `false`) routes 32-character
  ASCII keys through PBKDF2-SHA256 (600,000 iterations, salt
  `signalk-edge-link-v1`) before they are used as the AES-256-GCM / HMAC key.
  Hex (64-char) and base64 (44-char) keys are unaffected. The derivation is
  deterministic and cached per-process. **Both peers must use the same
  setting** — enabling it on one end and not the other will fail AES-GCM
  authentication on every packet. Treat the flag as part of the key. Default
  is `false` for backwards compatibility; existing deployments are unchanged.

### Security

- **Protocol version pinning** (`pipeline-v2-server.ts`): A v3-configured
  server now rejects any packet whose header advertises a different protocol
  version; a v2-configured server likewise rejects v3 packets. This closes a
  downgrade surface where a MITM could inject forged v2 control frames
  (ACK/NAK/HEARTBEAT/HELLO) — which carry no HMAC tag — at a server that had
  negotiated v3.
- **PBKDF2 stretching available for ASCII keys** (see Added above): when
  enabled, lifts the effective entropy of a 32-char human-typeable ASCII key
  from ~208 bits to the full 256-bit AES strength and makes offline brute-
  force attacks on leaked passphrases significantly more expensive.

### Tests

- New `__tests__/config-watcher.test.js` cases covering the hash-dedupe fast
  path, `readFallback` branch, `state.stopped` guards, watcher-handle
  lifecycle, legacy-file migration, and persistent-storage initialization.
- New `receivePacket – protocol version pin` regression tests in
  `__tests__/pipeline-v2-server.test.js`.
- New `normalizeKey ASCII path` and `encryptBinary / decryptBinary
stretchAsciiKey round-trip` regression tests in `__tests__/crypto.test.js`
  covering the default raw-bytes path, the opt-in PBKDF2 path, and the
  mismatched-flag failure mode.

### Documentation

- `docs/code-quality-report.md` summarises the repository's quality model,
  headline signals (coverage, typing, lint), and open improvement
  opportunities.

---

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

## [2.1.0]

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
