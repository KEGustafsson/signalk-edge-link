# SignalK Edge Link — Productization Rewrite Plan

> Status: Proposal for review. No code changes accompany this document.
> Decision recorded: **full rewrite** approach, plan-only deliverable.
>
> This file is the executive summary. The **full detailed plan** lives in
> [`rewrite/`](./rewrite/README.md) — architecture, per-module catalog,
> frozen conformance spec, external-contract inventory, old→new file map,
> test strategy, phase-by-phase execution, and the open questions.

## 0. Purpose and guiding principle

This document plans a ground-up rewrite of SignalK Edge Link to turn a
working proof-of-concept into a productized, maintainable, and hardened
plugin. The objective is a clean architecture with small, single-purpose
modules, explicit lifecycles, fewer steps in each operation, and stronger
reliability/security guarantees.

**Guiding principle — rewrite the structure, preserve the proven core.**
The current cryptography, the v2/v3 reliability protocol (ACK/NAK,
sequence tracking, retransmission, congestion control), bonding, and input
validation are already correct: a strict TypeScript build, ESLint, a full
webpack build, and **1878 passing tests across 74 suites** all pass today.
A rewrite that ignores that body of proven behavior would re-introduce
solved bugs. Therefore:

- The existing **wire format and crypto behavior are frozen as a
  conformance specification** (see §5). The rewrite must pass the same
  interop/crypto tests, byte-for-byte where the wire is concerned.
- The existing **test suite is carried forward as the acceptance gate.**
  Tests are ported (to TypeScript) and must stay green throughout.
- "Full rewrite" means: new module boundaries, new lifecycle model, new
  UI, new docs — **not** a new protocol or new crypto.

## 1. Baseline assessment (evidence)

| Check                | Command                        | Result                         |
| -------------------- | ------------------------------ | ------------------------------ |
| Type check (strict)  | `npm run check:ts`             | 0 errors                       |
| Lint                 | `npm run lint`                 | 0 errors                       |
| Build (ts + webpack) | `npm run build`                | success (1 asset-size warning) |
| Tests                | `npm test`                     | 1878 passed / 74 suites        |
| Debt markers         | grep TODO/FIXME/HACK in `src/` | none found                     |

Source size today: ~24.4k LOC TypeScript. Complexity concentrates in five
files:

| File                        | LOC  | Role                                      |
| --------------------------- | ---- | ----------------------------------------- |
| `src/webapp/index.ts`       | 2341 | Hand-rolled HTML-string UI engine         |
| `src/instance.ts`           | 1983 | Per-connection God Object / lifecycle     |
| `src/pipeline-v2-server.ts` | 1515 | Server receive/sessions/metadata/dispatch |
| `src/pipeline-v2-client.ts` | 1490 | Client send/retransmit/congestion/metrics |
| `src/types.ts`              | 949  | Central type definitions                  |

### Problems the rewrite must solve

1. **God Object (`instance.ts`).** One ~1983-line closure; `startInner()`
   alone ~454 lines mixing client+server setup. Lifecycle is an implicit
   state machine encoded as colliding booleans (`stopped`, `readyToSend`,
   `socketRecoveryInProgress`, `subscribing`). UDP socket setup duplicated
   3×. `pipeline-factory.ts` exists but is bypassed (pipelines built
   inline).
2. **Monolithic pipelines.** Send-path, retransmit, congestion, and
   metrics are interleaved in 1.5k-line files; hard to test in isolation.
3. **Security/protocol posture.**
   - v2 control packets (ACK/NAK/HEARTBEAT) are CRC-only and therefore
     forgeable by an off-path attacker; v3 fixes this with HMAC but v2 is
     still offered without a hard deprecation path.
   - `stretchAsciiKey` mismatch between peers causes **silent total
     decrypt failure** with no actionable diagnostic and no wire
     negotiation.
4. **Web UI.** 2341-line string-templating engine running alongside React
   16 + RJSF; untested; the one plausible XSS surface. React 16 is EOL.
5. **Testing/build hygiene.** Tests are `.js` testing `.ts` (test code is
   not type-checked); `collectCoverageFrom` targets stale `lib/**/*.js`;
   webapp fully excluded from coverage; thresholds modest (60/65%).
6. **Documentation drift.** README advertises an 11-file documentation
   map — **all 11 files are missing** (architecture-overview,
   configuration-reference, api-reference, protocol-v3-spec, bonding,
   congestion-control, metrics, management-tools, security,
   performance-tuning, troubleshooting). Real content lives in one
   2349-line `GUIDE.md`.
7. **Scattered validation.** Connection validation logic spread across
   `connection-config.ts`, `routes/config-validation.ts`, and
   `metadata.ts` with a hand-mirrored constant.

## 2. Target architecture

A layered, dependency-inward design. Lower layers know nothing about
higher layers. Every module is independently unit-testable and ideally
< 400 LOC.

```
┌─────────────────────────────────────────────────────────────┐
│ Presentation:   webapp (React 18 components + hooks)          │
│                 CLI (edge-link-cli)                           │
├─────────────────────────────────────────────────────────────┤
│ Interface:      HTTP API (route modules) · Plugin entrypoint  │
│                 (SignalK registration, schema)                │
├─────────────────────────────────────────────────────────────┤
│ Application:    ConnectionManager (registry, lifecycle)       │
│                 Connection (orchestrator, explicit FSM)       │
├─────────────────────────────────────────────────────────────┤
│ Domain svcs:    SubscriptionManager · DeltaBatcher           │
│                 KeepaliveManager · MetadataStreamer          │
│                 MonitoringService · MetricsRegistry           │
│                 BondingManager · CongestionController         │
├─────────────────────────────────────────────────────────────┤
│ Transport:      Pipeline (v1 | v2 | v3) behind one interface  │
│                 ReliabilityEngine (seq, ACK/NAK, retransmit)  │
│                 UdpSocketManager (create/recover/close)       │
├─────────────────────────────────────────────────────────────┤
│ Codec/wire:     PacketCodec · Crypto · Compression           │
│                 PathDictionary · CompactDelta · ValueDedup    │
│                 SourceCodec (replication/dispatch/snapshot)   │
├─────────────────────────────────────────────────────────────┤
│ Foundation:     types · constants · config-io · logger        │
│                 CircularBuffer · result/error primitives      │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Key design decisions

- **One transport interface.** `Pipeline` exposes a stable contract
  (`send`, `receive`, `start`, `stop`, `getMetrics`). v1/v2/v3 are
  implementations behind it; the factory is the _only_ construction path.
  No inline pipeline creation anywhere.
- **Explicit Connection FSM.** Replace boolean soup with a single state
  enum: `Created → Starting → Ready → Recovering → Stopping → Stopped`,
  with guarded transitions and a single place that owns "can I send?".
- **Composition over closures.** The per-connection God Object becomes a
  thin `Connection` orchestrator that _composes_ domain services. Each
  service owns its own state and timers and exposes a small API.
- **Result/typed-error discipline.** Replace silent failures (notably the
  `stretchAsciiKey` case) with typed results that carry actionable
  diagnostics up to logs/metrics/UI.
- **Single validation source of truth.** One schema/validation module used
  by the plugin schema, the HTTP API, the CLI, and the docs parity test.
- **Pure codec layer.** Everything in the codec/wire layer is pure and
  deterministic (no I/O, no timers), making it trivially testable and
  fuzzable — this is where the frozen conformance spec lives.

### 2.2 Module inventory (target)

Foundation: `types/`, `constants.ts`, `config-io.ts`, `logger.ts`,
`result.ts`, `circular-buffer.ts`.

Codec/wire: `crypto.ts`, `packet-codec.ts`, `compression.ts`,
`path-dictionary.ts`, `compact-delta.ts`, `value-dedup.ts`,
`source-codec.ts`, `metadata-codec.ts`.

Transport: `udp-socket-manager.ts`, `reliability/sequence.ts`,
`reliability/retransmit-queue.ts`, `reliability/ack-nak.ts`,
`congestion.ts`, `pipeline/pipeline.ts` (interface),
`pipeline/v1.ts`, `pipeline/v2-client.ts`, `pipeline/v2-server.ts`
(v3 = v2 + authenticated control, selected by capability flag).

Domain: `subscription-manager.ts`, `delta-batcher.ts`,
`keepalive-manager.ts`, `metadata-streamer.ts`, `monitoring.ts`,
`metrics/registry.ts`, `metrics/publisher.ts`, `metrics/prometheus.ts`,
`bonding.ts`, `packet-capture.ts`.

Application: `connection.ts` (orchestrator + FSM),
`connection-manager.ts` (registry, port-collision, ordered start/stop),
`config/schema.ts`, `config/validation.ts`, `config/migrate.ts`,
`config/watcher.ts`.

Interface: `plugin.ts` (SignalK entrypoint), `api/router.ts`,
`api/auth.ts`, `api/rate-limit.ts`, `api/routes/*.ts`,
`bin/edge-link-cli.ts`.

Presentation: `webapp/` (React 18 component tree + hooks).

## 3. Rewrite execution strategy

To avoid a "big bang" that is impossible to review or validate, execute
the rewrite as a **strangler migration inside the same repo**: build the
new layered codebase under `src2/` (or feature-flagged modules), port and
green the tests layer by layer, then switch the entrypoint and delete the
old tree in the final step. Each phase ends with `check:ts && lint && test`
green.

### Phase 0 — Conformance harness and guardrails

- Freeze the wire/crypto behavior: extract golden vectors (encrypted
  packets, ACK/NAK frames, metadata envelopes, path-dictionary encodings)
  from the current code into `__conformance__/` fixtures.
- Port the test suite to TypeScript so test code is type-checked.
- Fix coverage to measure `src/**` via ts-jest; stop excluding webapp.
- Add `npm run verify` = `check:ts && lint && test` and wire it into CI.
- Outcome: an executable definition of "correct" that the rewrite targets.

### Phase 1 — Foundation + codec/wire layer

- Re-implement the pure layers (types, constants, crypto, packet-codec,
  compression, path-dictionary, compact-delta, value-dedup, source-codec).
- These must pass the Phase 0 golden vectors **byte-for-byte**.
- Add property/fuzz tests (the project already fuzzes the packet parser).

### Phase 2 — Transport + reliability

- Re-implement `udp-socket-manager`, `sequence`, `retransmit-queue`,
  `ack-nak`, `congestion`, and the `pipeline` implementations behind the
  single interface; factory is the only constructor.
- Pass all v2/v3 protocol and integration tests, including v2↔v3 interop
  and reliability/loss-simulation tests.

### Phase 3 — Domain services

- Extract `SubscriptionManager`, `DeltaBatcher`, `KeepaliveManager`,
  `MetadataStreamer`, `MonitoringService`, `MetricsRegistry`,
  `BondingManager` as standalone, unit-tested services.

### Phase 4 — Application layer (the FSM)

- Build `Connection` (explicit lifecycle FSM, composes domain services)
  and `ConnectionManager` (registry, validation, port-collision, ordered
  start/stop, status aggregation).
- This is where the old `instance.ts` God Object dies.

### Phase 5 — Interface layer

- New `plugin.ts` entrypoint, single validation source of truth, route
  modules with shared auth/rate-limit, CLI.
- Preserve every existing HTTP route path and response shape (covered by
  route tests) so external consumers and the docs parity test keep working.

### Phase 6 — Security/protocol hardening (within frozen wire)

- Formal v2 deprecation: schema warning + an explicit opt-in flag to use
  v2; default new connections to v3.
- Key-derivation capability signaling so `stretchAsciiKey` mismatch yields
  a clear diagnostic instead of silent failure (additive, back-compatible).
- Run the bundled `/security-review` over the full diff.

### Phase 7 — Web UI rewrite

- Replace the string-templating engine with a React 18 component tree
  (`<MetricsCard>`, `<ConnectionsList>`, `<MonitoringTab>`, config form)
  plus hooks for fetch/auth/polling; add React Testing Library coverage.
- React 16 → 18 upgrade validated against the SignalK admin embedding.

### Phase 8 — Cutover and cleanup

- Switch the package entrypoint to the new tree; delete the old modules.
- Bump major version; ship migration notes.

### Phase 9 — Documentation convergence

- Split `GUIDE.md` into the 11 documents the README promises (or correct
  the README map), and add a doc-existence test so links cannot rot again.
- Regenerate configuration/api references from the single schema source.

## 4. Cross-cutting concerns

- **Observability:** every domain service emits to the central
  `MetricsRegistry`; no metric is computed inline. Keep Prometheus export
  and the existing metric names (back-compat for Grafana dashboard).
- **Error handling:** typed `Result`/error objects at module boundaries;
  no swallowed exceptions; every drop/failure path increments a metric.
- **Config:** one JSON Schema drives plugin options, API validation, and
  docs. Legacy single-object config auto-migration preserved and tested.
- **Security controls preserved:** AES-256-GCM, per-packet random IV,
  HMAC-authenticated v3 control plane, timing-safe management-token compare,
  decompression-bomb caps, per-IP session caps, UDP rate limiting,
  prototype-pollution guards — all carried forward and re-tested.
- **Backwards compatibility:** wire format frozen; HTTP routes and CLI
  flags preserved; config files (`subscription.json`, `delta_timer.json`,
  `sentence_filter.json`) unchanged.

## 5. Conformance specification (frozen behavior)

The rewrite must not change these without an explicit, separately reviewed
protocol decision:

1. **Packet format:** magic `0x534B` ("SK"), version/type/flags byte
   layout, sequence width, length, CRC16-CCITT, v3 control HMAC-SHA256
   (16-byte tag) vs v2 CRC.
2. **Crypto:** AES-256-GCM, 12-byte random IV prepended, 16-byte auth tag;
   key normalization (32-char ASCII / 64-hex / 44-base64); optional
   PBKDF2-SHA256 at 600k iterations for ASCII keys.
3. **Reliability:** cumulative ACK semantics, NAK timeout behavior,
   out-of-order buffering, resync thresholds, retransmit aging.
4. **Limits:** MAX_DELTAS_PER_PACKET, MAX_DECOMPRESSED_SIZE,
   MAX_PARSE_PAYLOAD_SIZE, session caps, rate-limit windows.
5. **Envelope dedup:** metadata/source-snapshot (seq, idx) dedup and
   sender-restart detection threshold.

Golden-vector fixtures in `__conformance__/` encode each of these.

## 6. Risk register

| Risk                               | Likelihood | Impact   | Mitigation                                                 |
| ---------------------------------- | ---------- | -------- | ---------------------------------------------------------- |
| Rewrite regresses wire/crypto      | Med        | Critical | Frozen conformance vectors + ported tests gate every phase |
| Schedule overrun (rewrite scope)   | High       | Med      | Strangler phases, each independently shippable/reviewable  |
| Hidden behavior in God Object lost | Med        | High     | Characterization tests captured before deletion            |
| Route/CLI contract drift           | Low        | High     | Existing route/CLI tests preserved as acceptance gate      |
| UI rewrite breaks admin embedding  | Med        | Med      | Phase 7 isolated; validate against SignalK admin shell     |
| React 18 upgrade fallout           | Med        | Low      | Done as part of isolated UI phase, behind tests            |

## 7. Recommendation and open questions

Recommendation: even under the chosen full-rewrite direction, run it as the
phased strangler migration above so the proven protocol/crypto core is
re-derived against frozen specs rather than reinvented. This delivers the
clean-architecture restart with the lowest achievable regression risk.

Open questions for the maintainer before execution begins:

1. Target package major version and npm release cadence for the cutover.
2. Minimum supported Node version (current `engines` says `>=24`; README
   says 16+ — these disagree and should be reconciled).
3. Whether v2 should be hard-removed in the rewrite (drop legacy) or kept
   behind an opt-in deprecation flag.
4. Whether to keep RJSF for the config form or move fully to custom React.
5. Appetite for a `src2/` parallel tree vs. in-place module-by-module
   replacement on the feature branch.
