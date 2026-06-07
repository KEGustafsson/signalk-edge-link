# 07 — Phase Plan

Execution model: **strangler migration in the same repo.** Build the new
layered tree under `src/` directories (doc 01) while the old flat modules
keep working; switch the entrypoint at cutover; delete the old tree last.
Every phase ends with `npm run verify` green and is independently
reviewable/shippable. Effort estimates are relative (S/M/L/XL), not
calendar commitments.

---

## Phase 0 — Guardrails & conformance harness (effort: M)

**Goal:** make "correct" executable before changing anything.

Tasks:

- Add `npm run verify` = `check:ts && lint && test`; wire into CI on PRs.
- Fix Jest: `collectCoverageFrom: src/**`, remove webapp exclusions, keep
  ts-jest so tests run against source (no stale `lib/`).
- Reconcile Node version to **`>=16`** (decision recorded, doc 08 Q2): set
  `package.json engines.node` to `">=16"`, add a CI Node matrix starting at
  16, and verify the current code + full suite actually run on Node 16
  (flag any dependency or API that forces a higher floor).
- Add import-boundary ESLint rule scaffold (no-op until layers exist) and
  max-lines / max-statements / complexity caps (warn now, error later).
- Build `__conformance__/` golden-vector generator from current code; commit
  vectors; add conformance test (doc 06 §6.1).
- Build the old↔new interop harness skeleton (loopback dgram / simulated
  sockets).
- Add doc-existence test (asserts README-referenced docs exist) — initially
  xfail/skip until phase 9, or create stubs now.

**Exit criteria:** verify green; golden vectors generated & asserted against
current code; coverage measured from `src/`; CI runs verify.

---

## Phase 1 — Foundation + codec/wire layer (effort: L)

**Goal:** the pure core, proven byte-for-byte.

Tasks:

- Create `foundation/` (split `types.ts`; move `constants.ts`,
  `config-io.ts`, `CircularBuffer`; add `logger.ts`, `result.ts`).
- Create `codec/` per doc 02: `crypto`, `packet-codec`, `compression`,
  `path-dictionary`, `compact-delta`, `value-dedup`, `delta-sanitizer`,
  `metadata-codec`, `source-codec`, `values-snapshot`.
- Reuse algorithm bodies (♻) / reference-reimplement crypto & packet (🔎).
- Unit + property/fuzz tests per module; **all golden vectors reproduce.**

**Exit criteria:** codec layer passes golden vectors byte-for-byte; fuzz
tests green; verify green. No higher layer depends on old codec files.

---

## Phase 2 — Transport + reliability (effort: L)

**Goal:** one transport interface, reliability proven under simulation.

Tasks:

- `transport/reliability/{sequence,retransmit-queue,ack-nak}`,
  `transport/congestion`, `transport/udp-socket-manager` (dedupes the 3×
  socket setup; absorbs `udpSendAsync`).
- `transport/pipeline/{pipeline (interface),factory,v1,reliable-client/*,
reliable-server/*}`; factory is the ONLY constructor.
- **Remove v2 (doc 08 Q3):** the reliable pipelines implement v3 only; drop
  the CRC control-trailer path and `usesAuthenticatedControl`; parser rejects
  header version `0x02`. The reliability machinery (sequence/retransmit/
  congestion/bonding/metadata) is reused unchanged — v3 keeps all of it.
- Port the existing v2 protocol/integration/reliability tests **retargeted to
  v3** (HMAC control); add v2-version-byte rejection tests; run against
  `network-simulator`.
- **Old↔new interop** passes for v1/v3 (data/control/metadata/sources).

**Exit criteria:** all transport/protocol/reliability/interop tests green;
verify green.

---

## Phase 3 — Domain services (effort: L)

**Goal:** extract everything trapped in the God Object into testable
services.

Tasks:

- `domain/{subscription-manager,delta-batcher,keepalive-manager,
metadata-streamer,source-snapshot-service,source-registry,bonding}`.
- `domain/monitoring/*` (4 trackers + alerts + capture/inspector).
- `domain/metrics/{registry,publisher,prometheus}` (names frozen).
- Unit tests per service with injected clock/mocks; port bonding/monitoring/
  metrics/prometheus suites.

**Exit criteria:** each service unit-tested in isolation; ported suites
green; Prometheus output matches frozen names (assert against a snapshot of
current output); verify green.

---

## Phase 4 — Application layer (FSM) — kills the God Object (effort: L)

**Goal:** thin orchestrator + explicit lifecycle.

Tasks:

- `app/lifecycle.ts` (FSM + guards + `canSend()`).
- `app/connection.ts` (compose services; ≤400 LOC) — replaces
  `instance.ts`.
- `app/connection-manager.ts` (registry, validate, port-collision, ordered
  server-then-client start, cascade-stop on failure, status aggregation).
- `app/config/{schema,validation,migrate,watcher}` — single schema/
  validation source; delete mirrored constant.
- Port `index.test.js` / `instance.test.js` lifecycle tests against the new
  application layer; add FSM transition tests (incl. stop-during-recovery).

**Exit criteria:** `instance.ts` no longer referenced; FSM tests green;
lifecycle/config tests green; verify green.

---

## Phase 5 — Interface layer (effort: M)

**Goal:** preserve the entire external API; remove route→internals reach.

Tasks:

- `interface/plugin.ts` (SignalK entrypoint) using `ConnectionManager`.
- `interface/api/{auth,rate-limit,router}` + `routes/*` (1:1 with doc 04).
- Routes read only through public APIs (no `pipeline.sendHello()` pokes, no
  `plugin._currentOptions`).
- Port all route tests (auth, rate-limit, monitoring branches, coverage
  suites); assert the 36 auth-action set.

**Exit criteria:** every endpoint in doc 04 responds identically (route
tests + a contract snapshot test green); verify green.

---

## Phase 6 — Security/protocol hardening (within frozen wire) (effort: M)

**Goal:** close the remaining posture gap additively. (The forgeable-v2
posture issue is already resolved by removal in Phase 2.)

Tasks:

- v2→v3 config coercion + naming aliases (back-compat, doc 04 §2.1):
  sanitizer accepts `protocolVersion` as `1|2|3` or `"basic"|"advanced"` and
  normalizes to numeric (`1|"basic"`→1, `2|3|"advanced"`→3) — no operator
  edit, no refuse-to-start; admin UI shows `Basic`(1) / `Advanced`(3);
  `migrate-config` bumps `2 → 3`; a coerced connection logs a one-time info
  note.
- `stretchAsciiKey` capability/version signal so mismatch yields typed
  `DecryptError` + clear log/metric/UI message — without changing the bytes
  of a correctly matched exchange (golden vectors stay valid).
- Run bundled `/security-review` over the full diff; address findings.
- Add config-coercion (2→3) and key-mismatch-diagnostic tests (wire-level
  `0x02` rejection is already tested in Phase 2).

**Exit criteria:** golden vectors still valid; new security tests green;
security review clean; verify green.

---

## Phase 7 — Web UI rewrite (effort: XL)

**Goal:** React component tree; delete the string engine; React 18.

Tasks:

- Upgrade React 16→18 + matching `@types/react`; validate Module Federation
  still mounts `PluginConfigurationPanel` in SignalK admin.
- Build component tree + hooks (doc 04 §6.3); reproduce every tab/view.
- Preserve `apiFetch` token-injection contract.
- React Testing Library coverage per component/hook; include webapp in
  coverage.
- Delete `webapp/index.ts` string engine.

**Exit criteria:** UI reaches feature parity (manual check against old UI
screenshots + RTL tests); federation verified; webapp coverage ≥ target;
verify green.

---

## Phase 8 — Cutover & cleanup (effort: M)

**Goal:** flip to the new tree, delete the old.

Tasks:

- Point `package.json` main/bin and webpack entries at new modules.
- Delete all superseded old `src/` files; remove any temporary shims.
- Full regression: ported suite + golden vectors + old↔new interop + manual
  smoke against a live SignalK pair (client↔server, v1/v3).
- Version bump to **3.0.0** + CHANGELOG + migration note documenting the
  v3-only wire (breaking for un-upgraded v2 peers) and the automatic
  `protocolVersion: 2 → 3` config coercion (doc 04 §2.1).
- Publish 3.0.0 as a **manual (human-gated) release** — no beta/RC channel
  (doc 08 Q1). The existing `publish-packages.yml` is already
  `workflow_dispatch`-only (GitHub Packages scoped snapshots); keep public
  release manual too. Fix that workflow's stale header comment ("on every
  push to main or dev" — the trigger is actually `workflow_dispatch`).

**Exit criteria:** no old modules remain; all gates green; manual smoke
passes; release artifacts build.

---

## Phase 9 — Documentation convergence (effort: M)

**Goal:** kill doc drift permanently.

Tasks:

- Split `GUIDE.md` into the 11 README-referenced docs (architecture-
  overview, configuration-reference, api-reference, protocol-v3-spec,
  bonding, congestion-control, metrics, management-tools, security,
  performance-tuning, troubleshooting), or correct the README map to match.
- Generate configuration-reference + api-reference from the single schema /
  route table where feasible.
- Enable the doc-existence test (un-skip from phase 0).
- Update README quick-start, Node version (`>=16`), and protocol guidance —
  end-user docs refer to **Basic** (v1) / **Advanced** (v3); numeric values
  shown only as a parenthetical (doc 08 Q8).

**Exit criteria:** all referenced docs exist; doc-existence + config-docs-
parity tests green; verify green.

---

## Sequencing & parallelism

- 0 → 1 → 2 → 3 are mostly sequential (each builds on the layer below).
- 4 depends on 1–3. 5 depends on 4. 6 can overlap 5 (touches codec/transport
  - schema). 7 can run in parallel from after phase 5 (UI only needs the
    HTTP API stable). 8 after 5–7. 9 can start anytime, finalized at 8.
- Keep the OLD tree wired as the live entrypoint until phase 8 so `main`
  always ships a working plugin.
