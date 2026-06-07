# 08 — Risks, Decisions, Open Questions

## Risk register

| #   | Risk                                                                                      | Likelihood | Impact   | Mitigation                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| R1  | Rewrite silently changes wire/crypto bytes → breaks interop with deployed peers           | Med        | Critical | Golden vectors (doc 03/06) + old↔new interop gate before cutover; crypto/packet are 🔎 with vector proof     |
| R2  | Behavior hidden in the God Object lost during extraction                                  | Med        | High     | Characterization tests captured in phase 0/4; port suite unchanged                                           |
| R3  | Schedule overrun (rewrite scope is large)                                                 | High       | Med      | Strangler phases, each shippable; old tree stays live until phase 8                                          |
| R4  | Route/CLI/metrics contract drift                                                          | Low        | High     | Doc 04 contract snapshots + ported route tests + frozen Prometheus names                                     |
| R5  | UI rewrite breaks SignalK admin embedding                                                 | Med        | Med      | Phase 7 isolated; federation (remote name/exposed module/shared singletons) preserved + verified             |
| R6  | React 16→18 fallout (RJSF compat, lifecycle warnings)                                     | Med        | Low      | Done inside phase 7 behind RTL tests; keep RJSF (Q4) → pin React-18-compatible `@rjsf/*` versions            |
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
- **Q2 RESOLVED — Minimum Node version is `>=16`.** The README badge is
  authoritative; `package.json engines.node` (`>=24`) is the bug and is
  reconciled to `>=16` in Phase 0. The rewrite must restrict itself to APIs
  available on Node 16, and CI runs a matrix starting at Node 16. Caveat:
  Node 16 is past upstream EOL — accepted to support older SignalK/marine
  installs; revisit if a dependency forces a higher floor (Phase 0 verifies
  the current code and full test suite actually run on Node 16).
- **Q3 RESOLVED — keep v1 and v3, REMOVE v2.** v3 = v2 + authenticated
  control packets, so the entire reliable binary stack survives in v3; only
  the unauthenticated CRC control-plane variant is removed. This also
  resolves risk R-security (forgeable v2 control) by removal and simplifies
  the codec (one control trailer: HMAC). `protocolVersion` enum becomes
  `{1, 3}` for new selections, but a stored `2` is ACCEPTED and coerced to
  `3` (config back-compat — see below and doc 04 §2.1). At the wire level the
  node speaks v3 only; an incoming `0x02` packet is rejected, so this is a
  breaking change for un-upgraded on-the-wire v2 peers (doc 03 §Protocol
  scope). v3 is the recommended default for new secure deployments; v1
  remains for simple local links.
- **Q1 RESOLVED — target version `3.0.0`** for the cutover (major bump;
  CHANGELOG + migration note). Release-channel choice (beta/RC before
  flipping npm `latest`) still open under Q1 below.
- **Config backwards compatibility (decision).** Existing config files must
  keep loading with no manual edits. Stored `protocolVersion: 2` (and `3`)
  resolves to v3 at load (coerced `2 → 3`); `1` stays v1. Legacy single-
  object config and boolean `serverType` normalizations are also preserved.
  See doc 04 §2.1.
- **Q8 RESOLVED — user-facing protocol naming.** v1 is presented to end
  users as **"Basic"** and v3 as **"Advanced"** in the UI and human-facing
  config/docs. Internally the code keeps numeric v1/v3 and the canonical
  stored value stays numeric (`1`/`3`); the config also accepts the string
  aliases `"basic"`/`"advanced"` for hand edits (normalized to numeric).
  See doc 04 §2.1 / §6.3.

## Open questions (need maintainer answer before/early in execution)

**Q1 — Release & versioning.** ✅ RESOLVED: target **`3.0.0`** (from 2.9.1),
published as a **manual (human-gated) release** — no separate beta/RC
channel. The publish step is triggered by a person (manual run /
`workflow_dispatch`, not auto-publish on merge/tag), and 3.0.0 goes out for
testing and wider usage directly.

**Q2 — Minimum Node version.** ✅ RESOLVED: Node `>=16` (see Decisions
above).

**Q3 — v1 and v2 fate.** ✅ RESOLVED: keep v1 and v3, remove v2 (see
Decisions above; migration in doc 04 §2.1). Remaining minor follow-up: the
default `protocolVersion` for new connections stays `1` (no behavior change)
with v3 recommended — revisit if you'd prefer v3 as the out-of-box default.

**Q4 — Config form tech.** ✅ RESOLVED: **keep `@rjsf/*` (React JSON Schema
Form).** It binds the form to the single JSON-Schema source of truth (doc 02
`app/config/schema.ts`), which is exactly the Basic/Advanced `enumNames`
approach (doc 04 §6.3). Phase 7 must therefore pick `@rjsf/*` versions
compatible with React 18 and re-verify the federated mount.

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
harness and the pure codec layer are valuable and decision-independent.
All decisions are settled: Q1 (3.0.0, manual release), Q2 (Node `>=16`),
Q3 (keep v1/v3, remove v2), Q4 (keep RJSF), Q8 (Basic/Advanced naming), and
config back-compat (2→3 coercion). Q5–Q7 are execution-style preferences
this plan already defaults sensibly (in-place strangler; future features out
of scope; ~80% webapp coverage target) — adjust if desired, but none block
starting Phase 0.
