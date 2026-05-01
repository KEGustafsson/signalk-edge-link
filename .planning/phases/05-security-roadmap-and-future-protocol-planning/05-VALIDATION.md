---
phase: 5
slug: security-roadmap-and-future-protocol-planning
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 5 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- | ------------- | ----- | ----- | ----- | --------------------------------------------------------------------------------------------------- |
| **Framework**          | Markdown/static documentation checks, `rg`, Prettier, and the existing release-doc truth guard.                                                                                                                                                               |
| **Config file**        | `package.json`, `.prettierrc.js`, `.planning/config.json`.                                                                                                                                                                                                    |
| **Quick run command**  | `rg -n "FUT-SEC-001                                                                                                                                                                                                                                           | FUT-OPS-001 | FUT-SCALE-001 | FUT-PROTO-001 | 999.1 | 999.2 | 999.3 | 999.4" docs/future-security-and-protocol-roadmap.md .planning/ROADMAP.md .planning/REQUIREMENTS.md` |
| **Focused commands**   | `rg -n "future-security-and-protocol-roadmap.md" docs/security.md docs/architecture-overview.md docs/metrics.md docs/performance-tuning.md`; `npm.cmd run check:release-docs`; `npx.cmd prettier --check <touched docs and planning files>`                   |
| **Full suite command** | Not required for docs/planning-only execution. Run `npm.cmd run lint && npm.cmd run check:ts && npx.cmd tsc -p tsconfig.webapp.json --noEmit && npm.cmd run build && npm.cmd test` only if source, tests, generated schemas, or build-affecting files change. |
| **Estimated runtime**  | 1-5 minutes for docs/planning checks; 3-12 minutes if the full repository gate becomes necessary.                                                                                                                                                             |

---

## Sampling Rate

- **After every task commit:** Run the task's focused `rg`, release-doc, or Prettier check.
- **After every plan wave:** Re-run the focused commands touched by the completed wave.
- **Before `$gsd-verify-work`:** Run all focused Phase 5 commands. Run the broad repository gate only if execution changes source/tests/build artifacts.
- **Max feedback latency:** 5 minutes for normal Phase 5 docs/planning work.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref             | Secure Behavior                                                                  | Test Type       | Automated Command                                                                                                                                                                                                                                                                                                                                        | File Exists | Status  |
| ------- | ---- | ---- | ----------- | ---------------------- | -------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| 5-01-01 | 01   | 1    | V1-PLAN-001 | T-5-01, T-5-02, T-5-03 | Future key rotation and protocol options are documented as design work, not code | Markdown/static | `rg -n "Online key rotation\|key agreement\|dual-key grace\|PSK ratchet\|authenticated ephemeral\|protocol-v4\|downgrade resistance\|mixed-version" docs/future-security-and-protocol-roadmap.md`                                                                                                                                                        | planned     | pending |
| 5-01-02 | 01   | 1    | V1-PLAN-001 | T-5-04, T-5-05         | Current docs link to the future roadmap without changing current behavior        | Markdown/static | `rg -n "future-security-and-protocol-roadmap.md" docs/security.md docs/architecture-overview.md docs/metrics.md docs/performance-tuning.md`                                                                                                                                                                                                              | yes         | pending |
| 5-01-03 | 01   | 1    | V1-PLAN-001 | T-5-06                 | Public docs remain release-truth and formatting clean                            | npm/prettier    | `npm.cmd run check:release-docs`; `npx.cmd prettier --check docs/future-security-and-protocol-roadmap.md docs/security.md docs/architecture-overview.md docs/metrics.md docs/performance-tuning.md`                                                                                                                                                      | yes         | pending |
| 5-02-01 | 02   | 2    | V1-PLAN-001 | T-5-07, T-5-08         | Deferred requirements are parked as explicit 999.x backlog candidates            | Markdown/static | `rg -n "FUT-SEC-001\|FUT-OPS-001\|FUT-SCALE-001\|FUT-PROTO-001\|999.1\|999.2\|999.3\|999.4" docs/future-security-and-protocol-roadmap.md .planning/ROADMAP.md .planning/REQUIREMENTS.md`                                                                                                                                                                 | planned     | pending |
| 5-02-02 | 02   | 2    | V1-PLAN-001 | T-5-09                 | Backlog directories exist for future promotion and context accumulation          | File/static     | `Test-Path .planning\phases\999.1-online-key-rotation-and-key-agreement-design\.gitkeep; Test-Path .planning\phases\999.2-protocol-v4-compatibility-and-migration-plan\.gitkeep; Test-Path .planning\phases\999.3-distributed-management-controls-architecture\.gitkeep; Test-Path .planning\phases\999.4-metrics-history-storage-architecture\.gitkeep` | planned     | pending |
| 5-02-03 | 02   | 2    | V1-PLAN-001 | T-5-10                 | Phase 5 validation proves docs and planning coverage without unsafe secrets      | Static/prettier | `rg -n "real token\|actual token\|secretKey.*[0-9a-fA-F]{32,}\|managementApiToken.*[A-Za-z0-9_-]{16,}" docs/future-security-and-protocol-roadmap.md .planning/ROADMAP.md .planning/REQUIREMENTS.md` should return no matches; `npx.cmd prettier --check .planning/ROADMAP.md .planning/REQUIREMENTS.md`                                                  | yes         | pending |

---

## Wave 0 Requirements

Existing documentation tooling covers Phase 5. No dependency installation, new test framework, database schema push, runtime service, or external account setup is required.

---

## Manual-Only Verifications

All Phase 5 work has automated/static verification. Manual review of the resulting roadmap doc is optional before promotion of backlog items.

---

## Validation Sign-Off

- [x] All tasks have automated verification or command checks.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing test infrastructure.
- [x] No watch-mode flags.
- [x] Feedback latency target < 5 minutes for docs/planning work.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending Phase 5 execution
