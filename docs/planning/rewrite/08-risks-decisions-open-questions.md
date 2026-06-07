# 08 — Risks, Decisions, Open Questions

## Risk register

| #   | Risk                                                                                      | Likelihood | Impact   | Mitigation                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| R1  | Rewrite silently changes wire/crypto bytes → breaks interop with deployed peers           | Med        | Critical | Golden vectors (doc 03/06) + old↔new interop gate before cutover; crypto/packet are 🔎 with vector proof     |
| R2  | Behavior hidden in the God Object lost during extraction                                  | Med        | High     | Characterization tests captured in phase 0/4; port suite unchanged                                           |
| R3  | Schedule overrun (rewrite scope is large)                                                 | High       | Med      | Strangler phases, each shippable; old tree stays live until phase 8                                          |
| R4  | Route/CLI/metrics contract drift                                                          | Low        | High     | Doc 04 contract snapshots + ported route tests + frozen Prometheus names                                     |
| R5  | UI rewrite breaks SignalK admin embedding                                                 | Med        | Med      | Phase 7 isolated; federation (remote name/exposed module/shared singletons) preserved + verified             |
| R6  | React 16→18 fallout (RJSF compat, lifecycle warnings)                                     | Med        | Low      | Done inside phase 7 behind RTL tests; decide RJSF vs custom (Q4)                                             |
| R7  | Coverage regresses while moving tests                                                     | Med        | Med      | Coverage gate from `src/`; thresholds never lowered; raise incrementally                                     |
| R8  | `stretchAsciiKey` hardening accidentally changes matched-exchange bytes                   | Low        | High     | Additive capability signal only; golden vectors must stay valid (phase 6 exit)                               |
| R9  | Splitting large codec files (delta-sanitizer, metadata) introduces subtle behavior change | Low        | Med      | Pure layer + round-trip/property tests catch divergence                                                      |
| R10 | Performance regression from added abstraction (per-packet hot path)                       | Low        | Med      | Keep codec pure & allocation-conscious; reuse `parameter-performance-impact-report.md` benchmarks as a check |

## Decisions already made (in this plan)

- Keep the proven wire format, crypto, reliability semantics, HTTP API,
  config schema, CLI surface, and Prometheus names FROZEN (doc 03/04).
- Strangler migration in-repo; old tree stays live until cutover (doc 07).
- Layered architecture with pure codec layer + explicit lifecycle FSM
  (doc 01).
- Tests ported to TypeScript, retargeted at `src/`; new golden-vector
  conformance suite created (doc 06).

## Open questions (need maintainer answer before/early in execution)

**Q1 — Release & versioning.** Current version is 2.9.1. Target major
version for cutover (3.0.0?) and release cadence? Is a beta/RC channel
wanted before flipping the npm `latest` tag?

**Q2 — Minimum Node version.** `package.json engines.node` says `>=24`;
README badge says `>=16`. These contradict. Which is the real floor? (Picks
the test matrix in CI and affects available APIs.)

**Q3 — v1 and v2 fate.** Three sub-decisions:

- Keep v1 (legacy pipeline + ping monitor) or drop it?
- Hard-remove v2 (CRC control, forgeable) or keep it behind an explicit
  opt-in deprecation flag with v3 as default?
- Either way, what is the migration/communication for existing v1/v2
  deployments?

**Q4 — Config form tech.** Keep `@rjsf/*` (React JSON Schema Form) for the
plugin config panel, or move to a custom React form? RJSF couples the UI to
the JSON Schema (nice for the single-source-of-truth goal) but adds bundle
size and React-version constraints.

**Q5 — Migration mechanics.** Parallel `src2/` tree, or in-place module-by-
module replacement on the feature branch? (This plan assumes in-place under
new `src/` subdirectories with the old flat files coexisting until cutover.)

**Q6 — Scope of "everything."** Are the deferred future features (active-
active bonding, multi-hop relay, SSE metrics streaming, constant-time key
compare) explicitly OUT of this rewrite (recommended), or should any be
folded in?

**Q7 — Webapp coverage bar.** The UI is essentially untested today. What
coverage bar is acceptable for the new React tree (this plan targets ~80%
but UI tests have diminishing returns)?

## Recommendation

Proceed phase 0 → 1 first regardless of the open questions: the conformance
harness and the pure codec layer are valuable and decision-independent. Pin
Q2 (Node) and Q3 (v1/v2 fate) before phase 2, and Q1/Q4 before phase 7/8.
