# 00 — Overview and Principles

## Goal

Convert SignalK Edge Link from a feature-complete proof-of-concept into a
productized plugin: a clean, layered architecture made of small,
single-purpose, independently testable modules with explicit lifecycles,
fewer steps per operation, and stronger reliability/security guarantees —
**without regressing any proven behavior.**

## Scope

In scope: a structural rewrite of the entire `src/` tree, the web UI, the
test layout, the build/CI hygiene, and the documentation set.

Out of scope (frozen): the UDP wire format, the cryptographic scheme, the
reliability algorithm semantics, the HTTP API surface, the plugin config
schema, the CLI command surface, and the Prometheus metric names. These are
external contracts and proven internals; see docs 03 and 04.

## The core contract: rewrite structure, preserve the core

The current code passes a strict `tsc`, ESLint, a full webpack build, and
**1878 tests across 74 suites**, with no TODO/FIXME markers. The crypto and
the v2/v3 reliability protocol are correct. Therefore the rewrite obeys
three rules:

1. **Algorithms are reused, not reinvented.** Where an algorithm is already
   correct and self-contained (crypto, CRC16, sequence arithmetic,
   retransmit aging, AIMD congestion, path dictionary, dedup, compact
   delta, source registry), the rewrite either (a) reuses the module nearly
   verbatim into its new home, or (b) re-implements it against the original
   as a reference and proves equivalence with golden vectors. The choice is
   recorded per module in doc 05.
2. **Behavior is pinned before it moves.** Doc 03 captures the wire/crypto
   behavior as byte-level golden vectors; doc 06 ports the existing test
   suite to TypeScript. Nothing is refactored until its behavior is under
   test.
3. **Contracts are preserved exactly.** Every HTTP route, status code,
   response field, config schema property, CLI flag, and Prometheus metric
   name in doc 04 must survive unchanged so external consumers (SignalK
   admin, Grafana dashboards, CLI users, existing peers on the wire) keep
   working.

"Full rewrite" here means: new module boundaries, new lifecycle model
(explicit FSM, composition over closures), new UI (React components), new
docs, new test organization — **not** a new protocol, new crypto, or new
public API.

## What is actually wrong today (the targets)

1. **God Object** `instance.ts` (1983 lines): one closure, `startInner()`
   ~454 lines, ~40 internal functions sharing closure state, lifecycle
   encoded as colliding booleans (`stopped`, `readyToSend`,
   `socketRecoveryInProgress`, `subscribing`). UDP socket setup duplicated
   3×. `pipeline-factory.ts` exists but is bypassed.
2. **Monolithic pipelines** (`pipeline-v2-client.ts` 1490,
   `pipeline-v2-server.ts` 1515): send-path, retransmit, congestion,
   metrics, sessions, metadata all interleaved.
3. **Monolithic UI** (`webapp/index.ts` 2341): hand-rolled HTML-string
   engine (40+ `renderX` helpers, `innerHTML` + manual `escapeHtml`)
   running alongside React 16 + RJSF. React 16 is EOL; `@types/react`
   (16.14) mismatches `react` (16.13).
4. **Security/protocol posture:** v2 control packets are CRC-only
   (forgeable); `stretchAsciiKey` mismatch causes silent total decrypt
   failure with no diagnostic.
5. **Test/build hygiene:** tests are `.js` (untyped); `collectCoverageFrom`
   targets stale `lib/**`; webapp excluded; thresholds modest (60/65%).
6. **Documentation drift:** README advertises 11 docs; all 11 are missing.
   Content is in one 2349-line `GUIDE.md`.
7. **Config inconsistency:** `package.json engines.node` says `>=24`,
   README badge says `>=16` — reconciled to **`>=16`** (decision: support
   Node 16+; the `engines` field is the bug, fixed in Phase 0).
8. **Scattered validation:** logic spread across `connection-config.ts`,
   `routes/config-validation.ts`, `metadata.ts` with a mirrored constant.

## Success criteria (definition of done)

- No source file > 400 LOC (hard cap 500 with written justification).
- No function > 60 LOC; cyclomatic complexity capped via ESLint.
- `instance.ts` God Object replaced by a thin orchestrator + composed
  services, each unit-tested in isolation.
- Explicit lifecycle FSM with guarded transitions; no boolean soup.
- Single source of truth for config schema + validation.
- Web UI is a React component tree with tests; string-template engine gone.
- All ported tests green; new unit tests for every extracted service;
  golden-vector conformance suite green (byte-for-byte wire/crypto).
- `npm run verify` (type-check + lint + test) is the single green gate, run
  in CI on every PR; coverage measured from `src/**` incl. webapp; raised
  thresholds (target 80% lines/functions, 70% branches).
- All 11 README-referenced docs exist; a doc-existence test prevents
  re-drift. Node version reconciled.
- Wire interop verified against the _old_ build (old client ↔ new server
  and vice-versa) for v1, v2, v3.

## Non-goals / explicitly deferred

- New protocol versions or new crypto primitives.
- New product features (active-active bonding, multi-hop relay, SSE
  streaming) — these become tractable _after_ the rewrite and are listed in
  doc 08 as future work, not part of this effort.
