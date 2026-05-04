---
phase: 3
slug: lifecycle-and-reliable-transport-coverage
nyquist_compliant: true
wave_0_complete: true
---

# Phase 3 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**          | Node.js/npm, Jest 29, TypeScript, ESLint, Prettier                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Config file**        | `package.json`, `tsconfig.json`, `tsconfig.webapp.json`, `.prettierrc.js`, `.eslintrc.js`                                                                                                                                                                                                                                                                                                                                                             |
| **Quick run command**  | `npm run check:ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Focused commands**   | `npm test -- --runTestsByPath __tests__/instance.test.js __tests__/config-watcher.test.js`; `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-client-coverage.test.js __tests__/v2/pipeline-v2-server-coverage.test.js __tests__/v2/sequence.test.js __tests__/v2/retransmit-queue.test.js`; `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-server.test.js __tests__/v2/meta-end-to-end.test.js __tests__/v2/source-replication.test.js` |
| **Full suite command** | `npm run lint && npm run check:ts && npx tsc -p tsconfig.webapp.json --noEmit && npm run build && npm test`                                                                                                                                                                                                                                                                                                                                           |
| **Estimated runtime**  | 3-12 minutes depending on install/test cache                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## Sampling Rate

- **After every task commit:** Run the task's focused Jest suite or grep/static check.
- **After every plan wave:** Run `npm run check:ts` plus the focused suites touched in the wave.
- **Before `$gsd-verify-work`:** Run the full suite command when local dependencies are available.
- **Max feedback latency:** 12 minutes.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement              | Threat Ref     | Secure Behavior                                                        | Test Type            | Automated Command                                                                                                                                   | File Exists |
| ------- | ---- | ---- | ------------------------ | -------------- | ---------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 3-01-01 | 01   | 1    | V1-TEST-001              | T-3-01, T-3-02 | Stopped instances do not leak watchers, timers, or callbacks           | Jest fake timers     | `npm test -- --runTestsByPath __tests__/config-watcher.test.js __tests__/instance.test.js`                                                          | yes         |
| 3-01-02 | 01   | 1    | V1-TEST-001              | T-3-03         | Client socket recovery can be cancelled safely by stop                 | Jest fake socket     | `npm test -- --runTestsByPath __tests__/instance.test.js`                                                                                           | yes         |
| 3-02-01 | 02   | 2    | V1-TEST-002              | T-3-04, T-3-05 | ACK/NAK and retransmit behavior remains bounded and authenticated      | Jest protocol tests  | `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-client-coverage.test.js __tests__/v2/pipeline-v2-server-coverage.test.js`                    | yes         |
| 3-02-02 | 02   | 2    | V1-TEST-002              | T-3-06         | Sequence gaps and stale ACKs do not corrupt reliable state             | Jest primitive tests | `npm test -- --runTestsByPath __tests__/v2/sequence.test.js __tests__/v2/retransmit-queue.test.js`                                                  | yes         |
| 3-03-01 | 03   | 3    | V1-TEST-002              | T-3-07, T-3-08 | Metadata/source restart and stale-envelope behavior is covered         | Jest v2 tests        | `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-server.test.js __tests__/v2/meta-end-to-end.test.js __tests__/v2/source-replication.test.js` | yes         |
| 3-03-02 | 03   | 3    | V1-TEST-001, V1-TEST-002 | T-3-09         | Socket recovery re-primes metadata/source state without leaking timers | Jest fake timers     | `npm test -- --runTestsByPath __tests__/instance.test.js __tests__/v2/pipeline-v2-client-coverage.test.js`                                          | yes         |

---

## Wave 0 Requirements

Existing test infrastructure covers all Phase 3 requirements. No dependency installation, new test framework, or external service is required.

---

## Manual-Only Verifications

All Phase 3 behaviors have automated verification. Manual Signal K runtime smoke testing is optional after automated checks pass.

---

## Validation Sign-Off

- [x] All tasks have automated verification or command checks.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing test infrastructure.
- [x] No watch-mode flags.
- [x] Feedback latency target < 12 minutes.
- [x] `nyquist_compliant: true` set in frontmatter.
