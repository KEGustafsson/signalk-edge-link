---
phase: 4
slug: schema-ui-type-safety-and-configuration-parity
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 4 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**          | Node.js/npm, Jest 29, TypeScript, ESLint, Prettier                                                                                                                                                                                                                                                                                 |
| **Config file**        | `package.json`, `tsconfig.json`, `tsconfig.webapp.json`, `.prettierrc.js`, `.eslintrc.js`                                                                                                                                                                                                                                          |
| **Quick run command**  | `npx.cmd tsc -p tsconfig.webapp.json --noEmit --noImplicitAny true`                                                                                                                                                                                                                                                                |
| **Focused commands**   | `npm.cmd test -- --runTestsByPath __tests__/PluginConfigurationPanel.test.js __tests__/webapp.test.js`; `npm.cmd test -- --runTestsByPath __tests__/schema-compat.test.js __tests__/connection-config.test.js __tests__/routes.config-validation.test.js`; `npm.cmd test -- --runTestsByPath __tests__/config-docs-parity.test.js` |
| **Full suite command** | `npm.cmd run lint && npm.cmd run check:ts && npx.cmd tsc -p tsconfig.webapp.json --noEmit && npm.cmd run build && npm.cmd test`                                                                                                                                                                                                    |
| **Estimated runtime**  | 3-12 minutes depending on install/test cache                                                                                                                                                                                                                                                                                       |

---

## Sampling Rate

- **After every task commit:** Run the task's focused typecheck, Jest suite, or docs/sample parity command.
- **After every plan wave:** Run `npm.cmd run check:ts` plus the focused suites touched in the wave.
- **Before `$gsd-verify-work`:** Run the full suite command when local dependencies are available.
- **Max feedback latency:** 12 minutes.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement          | Threat Ref | Secure Behavior                                                                        | Test Type        | Automated Command                                                                                                               | File Exists | Status  |
| ------- | ---- | ---- | -------------------- | ---------- | -------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| 4-01-01 | 01   | 1    | V1-UI-001            | T-4-01     | Webapp config-panel form events are typed without changing operator workflow           | TypeScript       | `npx.cmd tsc -p tsconfig.webapp.json --noEmit --noImplicitAny true`                                                             | yes         | pending |
| 4-01-02 | 01   | 1    | V1-UI-001, V1-UI-002 | T-4-02     | RJSF no-op changes do not dirty the form and save payload stays stable                 | Jest component   | `npm.cmd test -- --runTestsByPath __tests__/PluginConfigurationPanel.test.js __tests__/webapp.test.js`                          | yes         | pending |
| 4-02-01 | 02   | 2    | V1-UI-002            | T-4-03     | Public connection fields survive validation/sanitization and non-public secrets do not | Jest unit        | `npm.cmd test -- --runTestsByPath __tests__/connection-config.test.js __tests__/schema-compat.test.js`                          | yes         | pending |
| 4-02-02 | 02   | 2    | V1-UI-002            | T-4-04     | Legacy and per-connection routes keep matching validation behavior                     | Jest route       | `npm.cmd test -- --runTestsByPath __tests__/routes.config-validation.test.js`                                                   | yes         | pending |
| 4-03-01 | 03   | 3    | V1-UI-002            | T-4-05     | Docs schema and samples remain compatible with runtime config                          | Jest docs/sample | `npm.cmd test -- --runTestsByPath __tests__/config-docs-parity.test.js`                                                         | planned     | pending |
| 4-03-02 | 03   | 3    | V1-UI-001, V1-UI-002 | T-4-06     | Full lint/type/build/test gate passes after parity updates                             | Repository gate  | `npm.cmd run lint && npm.cmd run check:ts && npx.cmd tsc -p tsconfig.webapp.json --noEmit && npm.cmd run build && npm.cmd test` | yes         | pending |

---

## Wave 0 Requirements

Existing test infrastructure covers Phase 4. No dependency installation, new UI library, new test framework, external service, or database schema push is required.

---

## Manual-Only Verifications

All Phase 4 behaviors have automated verification. Manual Signal K admin UI smoke testing is optional after automated checks pass.

---

## Validation Sign-Off

- [x] All tasks have automated verification or command checks.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing test infrastructure.
- [x] No watch-mode flags.
- [x] Feedback latency target < 12 minutes.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending Phase 4 execution
