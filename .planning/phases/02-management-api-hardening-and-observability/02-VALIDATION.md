---
phase: 2
slug: management-api-hardening-and-observability
nyquist_compliant: true
wave_0_complete: true
---

# Phase 2 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Framework**          | Node.js/npm, Jest 29, TypeScript, ESLint, Prettier                                                                                                                                                                       |
| **Config file**        | `package.json`, `tsconfig.json`, `tsconfig.webapp.json`, `.prettierrc.js`, `.eslintrc.js`                                                                                                                                |
| **Quick run command**  | `npm run check:ts`                                                                                                                                                                                                       |
| **Focused commands**   | `npm test -- __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js`; `npm test -- __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js`; `npm test -- __tests__/routes.monitoring.test.js` |
| **Full suite command** | `npm run lint && npm run check:ts && npx tsc -p tsconfig.webapp.json --noEmit && npm test`                                                                                                                               |
| **Estimated runtime**  | 3-10 minutes depending on install/test cache                                                                                                                                                                             |

---

## Sampling Rate

- **After every task commit:** Run the task's focused Jest suite or grep/static check.
- **After every plan wave:** Run `npm run check:ts` plus the focused suites touched in the wave.
- **Before `$gsd-verify-work`:** Run the full suite command when local dependencies are available.
- **Max feedback latency:** 10 minutes.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement                        | Threat Ref     | Secure Behavior                                  | Test Type              | Automated Command                                                                                                    | File Exists |
| ------- | ---- | ---- | ---------------------------------- | -------------- | ------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| 2-01-01 | 01   | 1    | V1-SEC-001, V1-SEC-002, V1-SEC-003 | T-2-01, T-2-02 | Records auth decisions without changing behavior | Jest route tests       | `npm test -- __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js`                                | yes         |
| 2-01-02 | 01   | 1    | V1-SEC-002, V1-OPS-002             | T-2-01         | Exposes additive JSON telemetry only             | Jest/static            | `npm test -- __tests__/routes.rate-limit.test.js`; `rg -n "managementAuth" src __tests__`                            | yes         |
| 2-02-01 | 02   | 2    | V1-SEC-002, V1-SEC-003, V1-OPS-002 | T-2-03, T-2-04 | Emits bounded global Prometheus counters         | Jest/static            | `npm test -- __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js`                                       | yes         |
| 2-02-02 | 02   | 2    | V1-OPS-002, V1-SEC-003             | T-2-05         | Keeps docs aligned without secret examples       | docs/static            | `rg -n "managementAuth" docs/api-reference.md docs/metrics.md docs/management-tools.md docs/security.md`             | yes         |
| 2-03-01 | 03   | 3    | V1-OPS-001, V1-SEC-003             | T-2-06, T-2-07 | Coalesces saves while preserving updates         | Jest fake timers       | `npm test -- __tests__/routes.monitoring.test.js`                                                                    | yes         |
| 2-03-02 | 03   | 3    | V1-OPS-001, V1-OPS-002             | T-2-05, T-2-06 | Documents operator-visible persistence behavior  | docs/static/type check | `rg -n "coalesc" docs/api-reference.md docs/management-tools.md docs/configuration-reference.md`; `npm run check:ts` | yes         |

---

## Wave 0 Requirements

Existing test infrastructure covers all Phase 2 requirements. No dependency installation, new test framework, or external service is required.

---

## Manual-Only Verifications

Manual API exercise is optional after automated checks pass:

- Call `/status`, `/metrics`, and `/prometheus` with open access, missing token, invalid token, and valid token configurations if a local Signal K test harness is available.
- Confirm management token values and transport secrets are absent from JSON, Prometheus text, docs, and logs generated during validation.

---

## Validation Sign-Off

- [x] All tasks have automated verification or command checks.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing test infrastructure.
- [x] No watch-mode flags.
- [x] Feedback latency target < 10 minutes.
- [x] `nyquist_compliant: true` set in frontmatter.
