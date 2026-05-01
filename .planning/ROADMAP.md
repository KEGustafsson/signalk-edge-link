# Roadmap

**Project:** Signal K Edge Link
**Milestone:** v1 Maintenance and Hardening
**Initialized:** 2026-04-30

## Milestone Goal

Reduce release, documentation, security-observability, and regression risk in the existing Signal K Edge Link plugin while preserving current operator workflows and protocol compatibility.

## Phases

| Phase | Name                                             | Status   | Requirements                                               |
| ----- | ------------------------------------------------ | -------- | ---------------------------------------------------------- |
| 1     | Documentation and Release Truth                  | Complete | V1-DOC-001, V1-DOC-002, V1-REL-001                         |
| 2     | Management API Hardening and Observability       | Complete | V1-SEC-001, V1-SEC-002, V1-SEC-003, V1-OPS-001, V1-OPS-002 |
| 3     | Lifecycle and Reliable Transport Coverage        | Complete | V1-TEST-001, V1-TEST-002                                   |
| 4     | Schema, UI Type Safety, and Configuration Parity | Context  | V1-UI-001, V1-UI-002                                       |
| 5     | Security Roadmap and Future Protocol Planning    | Pending  | V1-PLAN-001                                                |

## Phase 1: Documentation and Release Truth

**Goal:** Bring public docs, architecture docs, API docs, package metadata, and release guidance back into agreement.

**Status:** Complete (2026-04-30)

**Why now:** The codebase map found stale file names and a stale API documentation version. This is a low-risk first phase that improves contributor and operator confidence before code hardening work.

**Likely work:**

- Update stale references in `docs/architecture-overview.md`.
- Update API doc version references to match `package.json`.
- Add or document a release consistency check for version, docs, build output, and package contents.
- Verify `npm pack --ignore-scripts` output includes expected runtime artifacts after build.

**Success criteria:**

- Known stale file references are corrected.
- API docs no longer claim a version older than `package.json`.
- Release checklist or automated check explicitly covers doc/package drift.
- Validation is documented in the phase verification report.

**Plan breakdown:**

Wave 1:

- `01-01` - Correct architecture and API documentation truth. Complete in `46f6fab`.

Wave 2 (blocked on Wave 1 completion):

- `01-02` - Add release documentation/package truth guard and CI wiring. Complete in `b9f06bf`.

Cross-cutting constraints:

- `package.json` remains the version source of truth.
- Runtime behavior, public API shape, and protocol compatibility are unchanged.
- Release checks must be dependency-free, local-command friendly, and CI-compatible.

## Phase 2: Management API Hardening and Observability

**Goal:** Improve management API security signals and alert persistence behavior while preserving backward-compatible defaults.

**Status:** Complete (2026-04-30)

**Why now:** The project already supports management auth and rate limiting, but operators need clearer counters and safer persistence behavior.

**Likely work:**

- Add allowed and denied management auth counters.
- Surface auth counters through existing metrics and Prometheus paths.
- Keep token-required and token-optional behavior documented and tested.
- Preserve redaction of tokens and transport secrets.
- Coalesce or debounce alert threshold persistence if implementation review confirms the current churn risk.

**Success criteria:**

- Focused auth and rate-limit tests pass.
- Metrics/Prometheus docs match any new counter fields.
- Redaction tests or review cover changed surfaces.
- Alert persistence behavior is covered by ordering/failure tests if changed.

**Plan breakdown:**

Wave 1:

- `02-01` - Add management auth telemetry core and JSON surfaces.
- Complete in `c356ed6`; summary in `12b74b0`.

Wave 2 (blocked on Wave 1 completion):

- `02-02` - Export management auth telemetry to Prometheus and operator docs.
- Complete in `3da05bf`; summary in `91f88c2`.

Wave 3 (blocked on Wave 2 completion):

- `02-03` - Coalesce alert threshold persistence and document operator-visible behavior.
- Complete in `322db1e`; summary in `302e999`.

Cross-cutting constraints:

- Management API behavior remains backward compatible and preserves fail-closed behavior when auth is explicitly required but no token is configured.
- Telemetry labels and docs never include tokens, transport secrets, IP addresses, user agents, request parameters, or raw paths.
- Metrics, monitoring, and security docs must be updated with any implemented JSON, Prometheus, or persistence behavior changes.

## Phase 3: Lifecycle and Reliable Transport Coverage

**Goal:** Add targeted regression coverage around the highest-risk lifecycle and reliable transport paths before further refactoring.

**Status:** Complete (2026-05-01)

**Why now:** The map identified large lifecycle and v2/v3 pipeline modules where rare recovery behavior is easy to regress.

**Likely work:**

- Add tests for socket recovery, timer cleanup, watcher cleanup, and stop/start ordering.
- Add tests for v2/v3 ACK/NAK, retransmit, stale sessions, metadata/source recovery, and sequence-gap handling.
- Prefer narrow helper extraction only where tests make the behavior easier to express.

**Success criteria:**

- New tests fail against intentionally broken cleanup or reliable transport paths.
- Relevant Jest suites pass.
- Any lifecycle or pipeline refactor remains behaviorally small and well covered.

**Plan breakdown:**

Wave 1:

- `03-01` - Add lifecycle cleanup regression coverage.
- Complete in `f63a32f`; summary in `70f8452`.

Wave 2 (blocked on Wave 1 completion):

- `03-02` - Add ACK/NAK, retransmit, sequence, duplicate, and stale-session coverage.
- Complete in `8f4fda6`; summary in `d83c9b2`.

Wave 3 (blocked on Wave 2 completion):

- `03-03` - Add metadata/source recovery coverage and run phase-level validation.
- Complete in `5cdd7d1`; summary in `4bef8c9`.

Cross-cutting constraints:

- Tests are the primary deliverable; source edits stay narrow and behavior-driven.
- No protocol redesign, configuration shape change, UI dashboard, management API behavior change, or future security work belongs in Phase 3.
- Use fake timers, mocked sockets/watchers, packet builders/parsers, and existing Jest harnesses before real network integration.
- Preserve v3 authenticated control packet behavior and protocol-version pinning.

## Phase 4: Schema, UI Type Safety, and Configuration Parity

**Goal:** Tighten webapp type safety and preserve configuration parity across all user-facing and runtime surfaces.

**Status:** Context gathered (2026-05-01)

**Why now:** Backend TypeScript is strict while the webapp config surface is looser. Config drift would be especially expensive for operators.

**Likely work:**

- Incrementally tighten `tsconfig.webapp.json` or targeted webapp types.
- Add or update component tests for configuration flows.
- Verify schema, validation, UI, docs, samples, and route behavior stay aligned.

**Success criteria:**

- Webapp type checks are stricter or targeted type gaps are closed.
- Component and schema compatibility tests pass.
- No operator workflow regression is introduced.

## Phase 5: Security Roadmap and Future Protocol Planning

**Goal:** Document the future security and scaling work that should not be mixed into the first maintenance phases.

**Why now:** Online key rotation, key agreement, distributed rate limits, and metrics history are real concerns but require design work before implementation.

**Likely work:**

- Write a short design note for online key rotation/key agreement options.
- Document compatibility and migration constraints for protocol changes.
- Clarify future scaling limits and recommended external controls.
- Park follow-up phases or backlog items for approved designs.

**Success criteria:**

- Deferred security and scaling requirements have explicit tradeoffs.
- No major protocol change is started without a design.
- Next milestone candidates are ready to promote when desired.

## Next Action

Phase 4 is ready for planning:

```text
$gsd-plan-phase 4 --auto
```

Alternative review command after plans are created:

```text
$gsd-review --phase 4 --all
```
