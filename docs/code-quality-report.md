# Code Quality Report — Signal K Edge Link

**Generated:** 2026-03-15
**Branch:** `claude/comprehensive-code-review-m4y67`
**Scope:** All TypeScript source files under `src/` and the webapp bundle
**Review basis:** Two completed deep-review rounds (Rounds 1 & 2)

---

## Data Foundations

Raw metrics collected before scoring:

| Metric                                   | Value         |
| ---------------------------------------- | ------------- |
| Total source lines (`src/`)              | ~14,894       |
| Global statement coverage                | 73.43 %       |
| Global branch coverage                   | 63.49 %       |
| Global function coverage                 | 78.52 %       |
| Coverage threshold (configured)          | 55 % (global) |
| TypeScript compile errors                | 0             |
| Unsafe `any` usages in `src/`            | 344           |
| `TODO` / `FIXME` / `HACK` markers        | 0             |
| `throw` / `catch` / `reject` constructs  | 184           |
| JSDoc `@param`/`@returns`/`@throws` tags | ~293          |

---

## Scoring Rubric

Five dimensions, each scored **1–10**. `N/A` is used when a dimension does not apply to a given
module (e.g. Security for a pure data structure; Coverage for a type-only file).

| Score | Label                                                         |
| ----- | ------------------------------------------------------------- |
| 9–10  | Excellent — best-practice implementation, no significant gaps |
| 7–8   | Good — minor issues only                                      |
| 5–6   | Average — known gaps that should be addressed                 |
| 3–4   | Below average — significant problems present                  |
| 1–2   | Poor — critical issues                                        |

### Dimension definitions

**Security** — auth coverage on all endpoints, input validation, output encoding, crypto
correctness, token handling.

**Reliability** — error handling coverage, null/undefined safety, edge-case handling, timer and
subscription lifecycle.

**Type Safety** — TypeScript strictness, proportion of `any`/`unknown` usage, use of branded
types, inference quality.

**Test Coverage** — branch-coverage percentage as the primary metric (statement coverage as a
tiebreaker). Scale: ≥ 95 % → 10, ≥ 80 % → 8, ≥ 65 % → 6, ≥ 45 % → 4.5, < 30 % → 3.

**Documentation** — JSDoc density on exported symbols, inline comments on non-obvious logic,
README/docs completeness.

### Weighting

```
Overall = Security×0.25 + Reliability×0.25 + TypeSafety×0.20 + Coverage×0.20 + Docs×0.10
```

When a dimension is N/A it is excluded from the weighted average.

### Letter grades

| Grade | Overall |
| ----- | ------- |
| A     | ≥ 8.5   |
| B+    | ≥ 8.0   |
| B     | ≥ 7.0   |
| C+    | ≥ 6.0   |
| C     | ≥ 5.5   |
| D     | ≥ 4.0   |
| F     | < 4.0   |

---

## Module Scores

### 1. Core Protocol

| Module                | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| --------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `sequence.ts`         |   N/A    |   **9.5**   |      7      | **9.5**  |  6   |   **8.6**   | **A**  |
| `retransmit-queue.ts` |   N/A    |   **8.5**   |      7      | **8.5**  |  7   |   **7.9**   | **B**  |
| `congestion.ts`       |   N/A    |   **9.0**   |      7      | **9.5**  |  7   |   **8.4**   | **B+** |
| `packet.ts`           |   N/A    |   **8.5**   |      7      | **9.0**  |  8   |   **8.2**   | **B+** |
| `CircularBuffer.ts`   |   N/A    |   **10**    |      9      |  **10**  |  4   |   **8.5**   | **A**  |

**Observations:**

- `sequence.ts` correctly implements RFC-1982 uint32 serial arithmetic with full edge-case
  coverage: duplicate detection, out-of-order window, gap-triggered resync, NAK-timer cleanup.
  Branch coverage is 92 %.
- `CircularBuffer.ts` achieves 100 % across all coverage metrics. The bounds-check fix in
  Round 1 was the only issue found.
- Type safety is held back in all three reliability-focused modules by use of plain `number`
  primitives where branded types (`SequenceNumber`, `AckNumber`) would prevent class-level
  mistakes at compile time.

---

### 2. Transport / Pipeline

| Module                  | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ----------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `pipeline-v2-client.ts` |    8     |     6.5     |      5      |   4.5    |  7   |   **6.3**   | **C+** |
| `pipeline-v2-server.ts` |   7.5    |     6.5     |      5      |   4.5    |  5   |   **5.9**   | **C**  |
| `pipeline.ts`           |    7     |     6.5     |      5      |   6.0    |  4   |   **5.9**   | **C**  |
| `bonding.ts`            |   7.5    |     7.5     |      5      |   8.0    |  8   |   **7.2**   | **B**  |
| `pipeline-factory.ts`   |   N/A    |     9.0     |      7      |   9.0    |  6   |   **7.9**   | **B**  |

**Observations:**

- `pipeline-v2-client.ts` (~900 lines, 44 % branch) and `pipeline-v2-server.ts` (~806 lines,
  43 % branch) contain the most complex retry/congestion/session logic and are the least tested
  files in the project. This is the single largest reliability risk.
- `bonding.ts` scored well after the Round 1 fix making `getActiveDestination()` an atomic read
  (no mid-update race). JSDoc coverage is the highest of any transport module (40 tags).
- `pipeline-factory.ts` is small, focused, and nearly fully covered.

---

### 3. Route Handlers

| Module                        | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ----------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `routes.ts` (auth core)       |   8.5    |     7.5     |      4      |   7.5    |  7   |   **7.1**   | **B**  |
| `routes/connections.ts`       |   8.0    |     7.0     |      4      |   6.5    |  6   |   **6.5**   | **C+** |
| `routes/control.ts`           |   8.5    |     8.5     |      4      |   9.0    |  5   |   **7.5**   | **B**  |
| `routes/metrics.ts`           |   7.5    |     8.0     |      5      |   8.0    |  5   |   **7.1**   | **B**  |
| `routes/monitoring.ts`        |   7.5    |     7.5     |      4      |   3.5    |  5   |   **5.9**   | **C**  |
| `routes/config.ts`            |   8.5    |     7.0     |      4      |   7.0    |  6   |   **6.7**   | **C+** |
| `routes/config-validation.ts` |   8.5    |     9.0     |      7      |   9.5    |  5   |   **8.0**   | **B+** |

**Observations:**

- After Round 2, all destructive and read endpoints that carry sensitive data are
  auth-guarded via `managementAuthMiddleware`. The management token uses timing-safe
  SHA-256 comparison and logs all attempts with IP and action.
- All route handlers declare `req: any, res: any`, which eliminates Express type checking
  on parameter types, status codes, and response shapes. This is the main driver of the low
  type-safety scores across the entire routes layer.
- `routes/control.ts` jumped from 18 % to 90 % branch coverage after the new test suite
  added in Round 2. `routes/metrics.ts` similarly improved from 3 % to 80 %.
- `routes/monitoring.ts` remains at 34.6 % branch coverage — the worst-covered route file.

---

### 4. Security & Crypto

| Module                     | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| -------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `crypto.ts`                |   7.5    |     8.5     |      6      |   8.5    |  7   |   **7.6**   | **B**  |
| `webapp/utils/apiFetch.ts` |   8.5    |     8.5     |      7      |   8.0    |  7   |   **8.1**   | **B+** |

**Observations:**

- AES-256-GCM is implemented correctly: 12-byte random IV per encryption, 16-byte auth tag,
  authenticated decryption verified with `crypto.timingSafeEqual()`. No nonce reuse risk.
- The 0.5-point security deduction on `crypto.ts` is for the ASCII key path: a 32-character
  ASCII key is used directly without a KDF, yielding ~208 bits of effective entropy vs. 256
  bits for hex/base64 keys. Adding PBKDF2 (600K iterations, SHA-256) would close this gap.
- `apiFetch.ts` defaults to `includeTokenInQuery: false`, preventing token leakage into
  browser history and server logs (fixed in Round 1).

---

### 5. Infrastructure

| Module                 | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ---------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `instance.ts`          |   6.5    |     7.5     |      4      |   6.5    |  4   |   **6.1**   | **C+** |
| `monitoring.ts` (lib)  |   N/A    |     9.5     |      6      |   9.5    |  7   |   **8.1**   | **B+** |
| `metrics.ts` (lib)     |   N/A    |     8.5     |      5      |   7.0    |  3   |   **6.5**   | **C+** |
| `metrics-publisher.ts` |   N/A    |     10      |      7      |   9.5    |  6   |   **8.3**   | **B+** |
| `packet-capture.ts`    |   N/A    |     9.5     |      6      |   9.5    |  6   |   **8.0**   | **B+** |
| `config-watcher.ts`    |   N/A    |     7.0     |      5      |   5.0    |  3   |   **5.4**   | **C**  |
| `connection-config.ts` |   N/A    |     7.0     |      6      |   4.5    |  4   |   **5.7**   | **C**  |

**Observations:**

- `instance.ts` is a 989-line "connection lifecycle god object". Timer and subscription cleanup
  is now correct after the Round 1 orphan-timer fix, but 47 % branch coverage leaves many
  state-transition paths unverified.
- `metrics-publisher.ts` is the exemplary infrastructure module: 100 % statement coverage,
  well-typed, no `any`, and a narrow single responsibility.
- `config-watcher.ts` (50 % branch) and `connection-config.ts` (42 % branch) both fall below
  the 55 % project threshold on branch coverage.

---

### 6. Webapp

| Module                    | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `webapp/index.ts`         |   7.5    |     7.5     |      5      |   N/A    |  6   |   **7.0**   | **B**  |
| `webapp/components/*.tsx` |   7.0    |     7.0     |      6      |   N/A    |  5   |   **6.5**   | **C+** |

**Observations:**

- After Round 2 XSS fixes, all module-level template helpers now call `escapeHtml()` before
  inserting user-controlled data into `innerHTML`. The class-method helpers already did this.
- The webapp bundle is not included in Jest coverage (N/A).
- `webapp/index.ts` at 2,058 lines is the largest single file in the project and the primary
  maintainability risk in the webapp layer.

---

### 7. Type System

| Module         | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| -------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `types.ts`     |   N/A    |     N/A     |      8      |   N/A    |  2   |   **5.0**   | **C**  |
| `constants.ts` |   N/A    |     N/A     |      9      |   N/A    |  3   |   **6.0**   | **C+** |

**Observations:**

- `types.ts` contains 30+ exported interfaces and type aliases across 334 lines with zero
  JSDoc blocks. All fields are self-named but many carry non-obvious semantics
  (e.g. `halfWindowSize`, `nakWindow`). Adding short `/** ... */` descriptions would improve
  IDE autocomplete significantly at near-zero effort.
- Type definitions themselves are well-structured — interfaces are granular and composable.

---

## Project-Level Summary

| Dimension         |    Score     | Grade  | Key finding                                                       |
| ----------------- | :----------: | :----: | ----------------------------------------------------------------- |
| **Security**      | **7.5 / 10** |   B    | Timing-safe auth, AES-GCM correct; no KDF for ASCII keys          |
| **Reliability**   | **7.5 / 10** |   B    | Core protocol excellent; pipeline coverage too sparse             |
| **Type Safety**   | **4.5 / 10** |   D+   | 344 `any` usages; route handlers fully untyped                    |
| **Test Coverage** | **6.5 / 10** |   C+   | Global 63 % branch; 34–47 % on three high-risk modules            |
| **Documentation** | **5.5 / 10** |   C    | Excellent README; JSDoc missing on `types.ts` and several modules |
| **Overall**       | **6.4 / 10** | **C+** | Solid foundation with clear, addressable improvement areas        |

---

## Top Improvement Opportunities

Ordered by expected impact-per-effort:

### Priority 1 — Pipeline test coverage (High impact, High effort)

`pipeline-v2-client.ts` (44 % branch) and `pipeline-v2-server.ts` (43 % branch) contain the
most complex and security-adjacent logic — congestion control, session authentication, brotli
decompression, retransmit replay — yet have the lowest test coverage of any core module.

**Target:** Add `test/pipeline-v2-client.test.js` and `test/pipeline-v2-server.test.js` covering:

- Successful handshake and data round-trip
- Auth failure / wrong key
- Congestion-window throttling
- Retransmit timeout and replay
- Decompression size guard (`MAX_DECOMPRESSED_SIZE`)
- Session limit enforcement (`MAX_CLIENT_SESSIONS`)

**Expected coverage gain:** +15–20 percentage points on global branch coverage.

---

### Priority 2 — Replace `any` in route handlers (High impact, Medium effort)

All route handlers use `req: any, res: any`. Replacing these with Express's `Request` and
`Response` types (and typed `req.params`/`req.body` via generics) would:

- Enable the TypeScript compiler to catch status-code mismatches and missing response fields
- Reduce the overall `any` count by ~60–80 occurrences
- Enable stricter null checks on request parameters

**Suggested approach:** Add `@types/express` if not already declared; replace `any` in routes
one file at a time starting with the smallest (`routes/control.ts`).

---

### Priority 3 — `routes/monitoring.ts` coverage (Medium impact, Medium effort)

This is the only route file without a corresponding test file. At 34.6 % branch coverage it
falls well below both the 55 % project threshold and the 80 %+ of neighbouring route modules.

**Target:** Create `test/routes.monitoring.test.js` mirroring the structure of the new
`test/routes.control.test.js`.

---

### Priority 4 — KDF for ASCII secret keys (Medium impact, Low effort)

ASCII keys use raw bytes, yielding ~208 bits of effective entropy. Adding PBKDF2 with
600,000 iterations (NIST SP 800-132 recommendation) or Argon2id would raise ASCII keys to
the same security level as hex/base64 keys. The change is isolated to `crypto.ts` and the key
normalisation helper.

```typescript
// Suggested addition in crypto.ts — ASCII path only
const derived = crypto.pbkdf2Sync(asciiKey, "signalk-edge-link-v1", 600_000, 32, "sha256");
```

Existing hex and base64 paths are unaffected.

---

### Priority 5 — JSDoc on `types.ts` (Low impact, Low effort)

30+ exported interfaces with zero documentation blocks. A single focused session adding
`/** ... */` descriptions to the most-used types (`ConnectionConfig`, `ReliabilityConfig`,
`CongestionControlConfig`, `BondingConfig`, `Metrics`, `InstanceState`) would make the entire
codebase more navigable without any runtime risk.

---

## Module Rankings (Overall Score)

| Rank | Module                        | Score | Grade |
| ---- | ----------------------------- | :---: | :---: |
| 1    | `sequence.ts`                 |  8.6  |   A   |
| 2    | `CircularBuffer.ts`           |  8.5  |   A   |
| 3    | `congestion.ts`               |  8.4  |  B+   |
| 4    | `metrics-publisher.ts`        |  8.3  |  B+   |
| 5    | `packet.ts`                   |  8.2  |  B+   |
| 6    | `webapp/utils/apiFetch.ts`    |  8.1  |  B+   |
| 7    | `monitoring.ts` (lib)         |  8.1  |  B+   |
| 8    | `routes/config-validation.ts` |  8.0  |  B+   |
| 9    | `packet-capture.ts`           |  8.0  |  B+   |
| 10   | `retransmit-queue.ts`         |  7.9  |   B   |
| 11   | `pipeline-factory.ts`         |  7.9  |   B   |
| 12   | `crypto.ts`                   |  7.6  |   B   |
| 13   | `routes/control.ts`           |  7.5  |   B   |
| 14   | `bonding.ts`                  |  7.2  |   B   |
| 15   | `routes.ts` (auth)            |  7.1  |   B   |
| 16   | `routes/metrics.ts`           |  7.1  |   B   |
| 17   | `webapp/index.ts`             |  7.0  |   B   |
| 18   | `routes/connections.ts`       |  6.5  |  C+   |
| 19   | `metrics.ts` (lib)            |  6.5  |  C+   |
| 20   | `routes/config.ts`            |  6.7  |  C+   |
| 21   | `webapp/components/*.tsx`     |  6.5  |  C+   |
| 22   | `instance.ts`                 |  6.1  |  C+   |
| 23   | `pipeline-v2-client.ts`       |  6.3  |  C+   |
| 24   | `routes/monitoring.ts`        |  5.9  |   C   |
| 25   | `pipeline.ts`                 |  5.9  |   C   |
| 26   | `pipeline-v2-server.ts`       |  5.9  |   C   |
| 27   | `connection-config.ts`        |  5.7  |   C   |
| 28   | `config-watcher.ts`           |  5.4  |   C   |
| 29   | `types.ts`                    |  5.0  |   C   |

---

_Report produced by Claude Code (claude-sonnet-4-6) following two rounds of deep code review._
