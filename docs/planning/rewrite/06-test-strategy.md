# 06 — Test Strategy

The existing suite — **1878 tests / 74 files** — is the single most
valuable asset in this rewrite. It is the acceptance gate. This document
explains how it is preserved, ported, and extended.

## Current state (baseline)

- ~74 files: ~54 in `__tests__/`, ~16 in `__tests__/v2/`, ~5 in
  `__tests__/integration/`.
- Tests are written in **JavaScript**; most `require()` the **compiled
  `lib/**`** output (acceptance-against-artifact). A few import source `.ts`
directly (`connection-config`, `routes/config-validation`,
`routes/sanitize-before-validate`).
- Jest transform: babel-jest for `.js`, ts-jest for `.ts/.tsx`. Thresholds
  60/65/65/65. `collectCoverageFrom: lib/**/*.js` excludes webapp/
  components/utils.
- **No golden-vector / fixed-byte fixtures exist.** Wire format is tested
  implicitly via build→parse round-trips and byte-offset assertions.
  `network-simulator.js` (519 lines) provides loss/latency/reorder/flap/
  throttle/Gilbert-Elliott burst simulation for reliability tests.
- Coverage is strong on: packet format (+fuzz), bonding/failover (175+
  tests), crypto, config validation, monitoring/metrics, sequence/
  retransmit, congestion. Thin on: error edge-cases, CLI, feedback-loop,
  webapp interactions.

## Problems to fix

1. JS tests are not type-checked → typos in fixtures go unnoticed.
2. Coverage points at stale `lib/` and excludes the entire UI.
3. Tests bind to compiled artifacts, so a `npm test` without a fresh
   `npm run build` can silently run against old code.
4. No explicit wire conformance vectors → "byte-for-byte" can't be asserted
   against a frozen reference.

## Strategy

### 6.1 Phase 0 — build the conformance harness FIRST

Before any rewrite code:

1. **Generate golden vectors from the CURRENT code.** Write a one-off
   generator that uses the present `PacketBuilder`/`crypto`/codecs to emit
   fixed byte arrays + their decoded forms into `__conformance__/vectors/`:
   - DATA/METADATA packets (v3) with each flag combination
     (compressed, encrypted, messagepack, pathDictionary),
   - ACK/NAK/HEARTBEAT/HELLO/META_REQUEST/FULL_STATUS_REQUEST for v3 (HMAC),
     incl. empty-payload control packets (v2 vectors are NOT generated —
     v2 is removed),
   - encrypted blobs for hex/base64/ASCII keys, with and without
     `stretchAsciiKey`,
   - compact-delta, value-dedup, path-dictionary, metadata-envelope, and
     source-snapshot-envelope round-trip pairs,
   - CRC16 of known inputs.
     Commit these vectors. They become the immutable definition of the wire.
2. **Add a conformance test** that asserts the current code reproduces the
   vectors (sanity), then later that the new code does too.
3. **Add an interop test harness** that can run the OLD compiled build and
   the NEW build against each other over a loopback `dgram` (or the
   simulated socket pair) for v1/v3 — data, control, metadata, source
   snapshot, both directions.

### 6.2 Port the suite to TypeScript

- Convert `__tests__/**/*.test.js` → `*.test.ts`, retargeting imports from
  `lib/**` to the new `src/**` modules (ts-jest compiles on the fly; no
  pre-build step, removing the stale-artifact hazard).
- Keep test _intent and assertions identical_ during porting — this is the
  regression gate; do not "improve" assertions while moving them.
- Where a test imported a now-split module, point it at the new module(s);
  add a thin re-export shim only if needed to minimize churn.
- `network-simulator.js` → `__tests__/helpers/network-simulator.ts`
  (typed), unchanged behavior.

### 6.3 Per-layer testing as modules land

Each extracted module gets focused unit tests with injected `clock`/mocks:

- L1 codec: pure round-trip + golden-vector + property/fuzz (extend the
  existing `fuzz-packet-parser` approach to all codecs).
- L2 transport: `SequenceTracker`, `RetransmitQueue`, `CongestionControl`,
  `UdpSocketManager` (mock dgram), pipeline v1/v3 against vectors.
- L3 domain: each service (subscription/batcher/keepalive/metadata/
  snapshot/monitoring/metrics/bonding) tested in isolation — newly possible
  because they're no longer trapped in the closure.
- L4 application: `Lifecycle` FSM transition table (incl. stop-during-
  recovery), `Connection` orchestration with mocked services,
  `ConnectionManager` port-collision + ordered start/stop.
- L5 interface: every route's status-code branches (port the branch-focused
  `routes.monitoring`/`*-coverage` tests); auth timing-safe + action
  telemetry; rate-limit windows.
- L6 presentation: React Testing Library for each component + hook; this is
  net-new coverage (today the UI is essentially untested and excluded).

### 6.4 New tests to add (close today's thin spots)

- Systematic error/edge-case tests per service (drop accounting, recovery,
  retry exhaustion).
- CLI command tests for each subcommand (today only 1 describe).
- Feedback-loop / own-data stripping end-to-end (today 1 describe).
- `stretchAsciiKey` mismatch → typed `DecryptError` surfaced (the
  hardening in doc 03 §2 / doc 07 phase 6).
- wire-level rejection of `0x02` version-byte packets; config normalization
  (`2 → 3`, and `"basic"`→1 / `"advanced"`→3 aliases) preserves a
  backwards-compatible load and canonical numeric storage.
- Old↔new wire interop (6.1.3) per protocol version.

### 6.5 CI gates & coverage

- `npm run verify` = `check:ts && lint && test` — single required gate on
  every PR (workflows already exist; tighten them).
- `collectCoverageFrom: src/**/*.{ts,tsx}` (drop the `lib/**` target and
  the webapp exclusions).
- Raise thresholds incrementally to a target of **80% lines/functions,
  70% branches** by end of rewrite (do not lower from today's 60/65).
- Add a **doc-existence test** asserting every doc referenced by README
  exists (prevents the current 11-missing-docs drift from recurring).
- Add a **conformance gate**: golden vectors + old↔new interop must pass
  before the cutover phase merges.

### 6.6 Acceptance definition

The rewrite is acceptable only when:

1. every ported test passes against the new `src/`,
2. all golden vectors reproduce byte-for-byte,
3. old↔new interop passes for v1/v3,
4. coverage ≥ targets including webapp,
5. `npm run verify` is green in CI.
