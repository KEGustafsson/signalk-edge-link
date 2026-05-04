---
phase: 1
slug: documentation-and-release-truth
nyquist_compliant: true
wave_0_complete: true
---

# Phase 1 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**          | Node.js/npm, Jest 29, TypeScript, ESLint, Prettier                                                                                       |
| **Config file**        | `package.json`, `tsconfig.json`, `tsconfig.webapp.json`, `.github/workflows/publish-packages.yml`                                        |
| **Quick run command**  | `npm run check:release-docs`                                                                                                             |
| **Full suite command** | `npm run lint && npm run check:ts && npx tsc -p tsconfig.webapp.json --noEmit && npm run build && npm test && npm pack --ignore-scripts` |
| **Estimated runtime**  | 2-8 minutes depending on install/build/test cache                                                                                        |

---

## Sampling Rate

- **After every task commit:** Run the task's focused grep or npm-script check.
- **After every plan wave:** Run `npm run check:release-docs` once the script exists.
- **Before `$gsd-verify-work`:** Run the full suite command when local dependencies and generated artifacts are available.
- **Max feedback latency:** 10 minutes.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior                          | Test Type     | Automated Command                                                                                                                                                      |
| ------- | ---- | ---- | ----------- | ---------- | ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-01-01 | 01   | 1    | V1-DOC-001  | T-1-01     | Avoids stale docs that mislead operators | grep/static   | `rg -n "bonding-manager\|congestion-control\|alert-manager\|sequence-tracker" docs/architecture-overview.md`                                                           |
| 1-01-02 | 01   | 1    | V1-DOC-001  | T-1-02     | Keeps public API docs tied to package    | node/static   | `node -e "const p=require('./package.json');const d=require('fs').readFileSync('docs/api-reference.md','utf8');if(!d.includes('current: '+p.version))process.exit(1)"` |
| 1-02-01 | 02   | 2    | V1-DOC-002  | T-1-03     | Fails closed on release-doc drift        | npm script    | `npm run check:release-docs`                                                                                                                                           |
| 1-02-02 | 02   | 2    | V1-REL-001  | T-1-04     | Verifies package payload before release  | build/package | `npm run build && npm pack --ignore-scripts`                                                                                                                           |

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework installation is required.

---

## Manual-Only Verifications

All phase behaviors have automated or command-based verification.

---

## Validation Contract

- All tasks have automated verification or command checks.
- Sampling continuity: no three consecutive tasks without automated verify.
- Wave 0 covers all missing references.
- No watch-mode flags.
- Feedback latency target under 10 minutes.
- `nyquist_compliant: true` set in frontmatter.
