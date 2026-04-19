# Code Quality Report — Signal K Edge Link

**Scope:** All TypeScript source files under `src/` and the webapp bundle.

This document captures the repository's quality model and the durable
observations that inform module-level scores. Exact, time-varying metrics
(coverage percentages, `any` counts, failing-test totals) are published as
CI artifacts and are not duplicated here.

---

## Headline Signals

- **Build / lint / types:** `tsc` (backend and webapp) and `eslint` gate on
  zero errors in CI.
- **Coverage:** Global branch coverage sits in the high 60s with a 60 %
  configured threshold. Core protocol modules (`sequence.ts`, `packet.ts`,
  `congestion.ts`) exceed 80 % branch coverage; the pipeline-v2 and instance
  modules remain the primary coverage gaps.
- **Type safety:** Route handlers use structural `RouteRequest` /
  `RouteResponse` types rather than `any`. The residual `any` usages are
  concentrated in CLI argv parsing and the legacy migration script; no route
  handler carries `any` parameters.
- **Process hygiene:** No `TODO` / `FIXME` / `HACK` / `XXX` markers in the
  tracked source tree.

For drill-down metrics (per-file coverage, exact `any` counts, test-suite
output) consult the CI pipeline artifacts.

---

## Scoring Rubric

Five dimensions, each scored **1–10**. `N/A` is used when a dimension does not
apply to a given module (e.g. Security for a pure data structure).

| Score | Label                                                         |
| ----- | ------------------------------------------------------------- |
| 9–10  | Excellent — best-practice implementation, no significant gaps |
| 7–8   | Good — minor issues only                                      |
| 5–6   | Average — known gaps that should be addressed                 |
| 3–4   | Below average — significant problems present                  |
| 1–2   | Poor — critical issues                                        |

### Dimension definitions

- **Security** — auth coverage, input validation, output encoding, crypto
  correctness, token handling.
- **Reliability** — error handling, null/undefined safety, resource lifecycle
  (timers, sockets, listeners), race-condition safety.
- **Type Safety** — strictness, proportion of `any`/`unknown`, branded types,
  inference quality.
- **Test Coverage** — branch coverage as the primary metric. ≥ 95 % → 10,
  ≥ 80 % → 8, ≥ 65 % → 6, ≥ 45 % → 4.5, < 30 % → 3.
- **Documentation** — JSDoc density on exported symbols, inline comments on
  non-obvious logic, README/docs completeness.

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
| `sequence.ts`         |   N/A    |   **9.5**   |      8      | **8.0**  |  7   |   **8.4**   | **B+** |
| `retransmit-queue.ts` |   N/A    |   **8.5**   |      8      | **6.5**  |  7   |   **7.7**   | **B**  |
| `congestion.ts`       |   N/A    |   **9.0**   |      8      | **9.0**  |  7   |   **8.5**   | **A**  |
| `packet.ts`           |   7.0    |   **9.0**   |      8      | **8.5**  |  8   |   **8.1**   | **B+** |
| `CircularBuffer.ts`   |   N/A    |   **10**    |      9      |  **10**  |  4   |   **8.5**   | **A**  |

**Observations:**

- Branch coverage for `congestion.ts`, `packet.ts`, and `sequence.ts` is
  comfortably above 80 %. See CI artifacts for exact per-file numbers.
- `packet.ts` enforces v3 control-packet HMAC verification unconditionally;
  there is no runtime knob to bypass it.

### 2. Transport / Pipeline

| Module                  | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ----------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `pipeline-v2-client.ts` |   8.0    |     7.0     |      7      |   5.0    |  7   |   **6.8**   | **C+** |
| `pipeline-v2-server.ts` |   7.5    |     6.5     |      7      |   5.0    |  6   |   **6.4**   | **C+** |
| `pipeline.ts`           |   7.5    |     7.0     |      7      |   5.5    |  5   |   **6.6**   | **C+** |
| `bonding.ts`            |   8.0    |     8.5     |      7      |   8.0    |  8   |   **7.9**   | **B**  |
| `pipeline-factory.ts`   |   N/A    |     9.0     |      8      |   9.0    |  6   |   **8.2**   | **B+** |

**Observations:**

- `pipeline-v2-client.ts` and `pipeline-v2-server.ts` remain the primary
  coverage gap in this layer — both sit below the project's 60 % branch
  threshold at the file level and represent the largest reliability risk.
- `_sendNAK()` is invoked without `await` inside the
  `SequenceTracker.onLossDetected` callback. The returned promise still
  resolves on socket failure because `_sendNAK` wraps its `socketUdp.send`
  in an outer `try { … } catch (err) { app.error(…) }`, so no unhandled
  rejection escapes.
- `bonding.ts` is well-covered; its reliability rating reflects the
  stop-race and validation hardening in recent releases.

### 3. Route Handlers

| Module                        | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ----------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `routes.ts` (auth core)       |   9.0    |     8.0     |      8      |   7.0    |  7   |   **7.9**   | **B**  |
| `routes/connections.ts`       |   8.5    |     7.0     |      8      |   5.0    |  6   |   **7.0**   | **B**  |
| `routes/control.ts`           |   9.0    |     8.5     |      8      |   8.5    |  6   |   **8.3**   | **B+** |
| `routes/metrics.ts`           |   8.5    |     8.0     |      8      |   6.5    |  5   |   **7.4**   | **B**  |
| `routes/monitoring.ts`        |   8.0    |     7.5     |      8      |   7.5    |  6   |   **7.6**   | **B**  |
| `routes/config.ts`            |   8.5    |     7.5     |      8      |   6.0    |  6   |   **7.3**   | **B**  |
| `routes/config-validation.ts` |   9.0    |     9.5     |      9      |   9.5    |  5   |   **8.7**   | **A**  |

**Observations:**

- Route handlers consume `RouteRequest` / `RouteResponse` from
  `src/routes/types.ts`; no handler carries `req: any, res: any`
  parameters.
- `routes/connections.ts` is now the worst-covered route module; focused
  test work is tracked under Priority 4.
- `POST /monitoring/alerts` calls `app.savePluginOptions()` synchronously on
  every request with no debounce; an authenticated client can thrash disk.
  Recommend coalescing saves.

### 4. Security & Crypto

| Module                     | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| -------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `crypto.ts`                |   8.0    |     9.0     |      8      |   7.0    |  9   |   **8.1**   | **B+** |
| `webapp/utils/apiFetch.ts` |   8.5    |     8.5     |      8      |   8.0    |  7   |   **8.2**   | **B+** |

**Observations:**

- AES-256-GCM is implemented correctly: 12-byte random IV per encryption,
  16-byte auth tag, authenticated decryption via `decipher.setAuthTag`.
  `crypto.timingSafeEqual()` guards both the v3 control-packet HMAC and the
  management token comparison.
- `deriveKeyFromPassphrase()` implements PBKDF2-SHA256 with the
  `PBKDF2_ITERATIONS` constant (NIST SP 800-132). `normalizeKey()` accepts an
  opt-in `stretchAsciiKey` flag: when `true`, 32-char ASCII keys are routed
  through PBKDF2 (cached per process); when `false` (default) the raw ASCII
  bytes are used directly. Both peers must use the same setting — treat the
  flag as part of the key.
- `apiFetch.ts` keeps `includeTokenInQuery: false` by default (Round-1 fix
  retained); tokens never leak into URLs.

### 5. Infrastructure

| Module                 | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ---------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `instance.ts`          |   7.0    |     7.5     |      7      |   4.5    |  5   |   **6.4**   | **C+** |
| `monitoring.ts` (lib)  |   N/A    |     9.0     |      7      |   8.5    |  7   |   **8.0**   | **B+** |
| `metrics.ts` (lib)     |   N/A    |     8.5     |      7      |   7.0    |  4   |   **7.0**   | **B**  |
| `metrics-publisher.ts` |   N/A    |     10      |      8      |   9.5    |  7   |   **8.7**   | **A**  |
| `packet-capture.ts`    |   N/A    |     9.5     |      8      |   9.5    |  7   |   **8.8**   | **A**  |
| `config-watcher.ts`    |   N/A    |     7.0     |      7      |   4.5    |  5   |   **6.3**   | **C+** |
| `connection-config.ts` |   N/A    |     8.0     |      8      |   8.0    |  6   |   **7.7**   | **B**  |

**Observations:**

- `instance.ts` is the largest lifecycle module and one of the primary
  coverage gaps. Several state-transition paths (stop during reload, socket
  recovery, congestion-control re-init) remain unverified.
- `metrics-publisher.ts` and `packet-capture.ts` are the exemplary
  infrastructure modules — both fully exercised by their test suites.
- `config-watcher.ts` has asymmetric error handling between the fallback and
  no-fallback code paths and silently swallows JSON parse errors when the
  watcher is stopped mid-debounce.

### 6. Webapp

| Module                                       | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade |
| -------------------------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :---: |
| `webapp/index.ts`                            |   8.0    |     7.5     |      7      |   N/A    |  6   |   **7.4**   | **B** |
| `webapp/components/PluginConfigurationPanel` |   8.0    |     8.0     |      7      |   8.5    |  6   |   **7.7**   | **B** |

**Observations:**

- Every dynamic `innerHTML` template helper escapes user-controlled data via
  `escapeHtml()`; no open XSS surface.
- `webapp/index.ts` is the largest single source file in the project.
  Maintainability is the dominant risk in this layer.
- `PluginConfigurationPanel.tsx` is the React/RJSF config panel and carries
  a dedicated component-test suite.

### 7. Type System

| Module         | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| -------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `types.ts`     |   N/A    |     N/A     |      9      |   N/A    |  2   |   **6.7**   | **C+** |
| `constants.ts` |   N/A    |     N/A     |      9      |   N/A    |  3   |   **7.0**   | **B**  |

**Observations:**

- `types.ts` defines the project's exported interface and type-alias surface
  with effectively no JSDoc on the type members. Adding `/** ... */` blocks
  to non-obvious fields (`halfWindowSize`, `nakWindow`, `lossBaseSeq`,
  `failoverThreshold`) is the single highest-leverage docs improvement
  available.

---

## Project-Level Summary

| Dimension         |    Score     | Grade | Key finding                                                    |
| ----------------- | :----------: | :---: | -------------------------------------------------------------- |
| **Security**      | **8.0 / 10** |  B+   | Auth + crypto solid; ASCII-key PBKDF2 stretching is opt-in     |
| **Reliability**   | **8.0 / 10** |  B+   | Pipeline coverage gaps remain; no open unhandled-rejection     |
| **Type Safety**   | **7.5 / 10** |   B   | Routes fully typed; residual `any` concentrated in the CLI     |
| **Test Coverage** | **7.0 / 10** |   B   | Global branch comfortably above threshold; pipeline-v2 lags    |
| **Documentation** | **6.0 / 10** |  C+   | README + protocol docs strong; `types.ts` undocumented         |
| **Overall**       | **7.5 / 10** | **B** | Few sharp edges; coverage gaps on pipeline-v2 are the priority |

---

## Top Improvement Opportunities

Ordered by expected impact-per-effort. Historical remediation status is in
`CHANGELOG.md`; this section tracks only currently open opportunities.

### Priority 1 — Lift pipeline-v2 / instance coverage (High impact, Medium effort)

**Files:** `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`,
`src/instance.ts`, `src/config-watcher.ts`, `src/routes/connections.ts`.

Target: ≥ 65 % branch on each. New test suites should cover congestion
throttling, retransmit replay on NAK, session limits, version-pin
enforcement, reload-during-stop, and parse-error paths.

### Priority 2 — JSDoc on `types.ts` (Low impact, Low effort)

All exported interfaces and type aliases with no per-member documentation.
A focused pass adding `/** ... */` to non-obvious fields (`halfWindowSize`,
`nakWindow`, `lossBaseSeq`, `failoverThreshold`) makes the entire codebase
more navigable in IDEs without any runtime risk.

### Priority 3 — Debounce `POST /monitoring/alerts` saves (Low impact, Low effort)

Coalesce `app.savePluginOptions()` calls to at most one per second per
connection. Prevents disk thrashing from a malicious authenticated client.

---

## Module Rankings (Overall Score)

| Rank | Module                               | Score | Grade |
| ---- | ------------------------------------ | :---: | :---: |
| 1    | `routes/config-validation.ts`        |  8.7  |   A   |
| 1    | `metrics-publisher.ts`               |  8.7  |   A   |
| 3    | `packet-capture.ts`                  |  8.8  |   A   |
| 4    | `congestion.ts`                      |  8.5  |   A   |
| 4    | `CircularBuffer.ts`                  |  8.5  |   A   |
| 6    | `sequence.ts`                        |  8.4  |  B+   |
| 7    | `routes/control.ts`                  |  8.3  |  B+   |
| 8    | `webapp/utils/apiFetch.ts`           |  8.2  |  B+   |
| 8    | `pipeline-factory.ts`                |  8.2  |  B+   |
| 10   | `crypto.ts`                          |  8.1  |  B+   |
| 10   | `packet.ts`                          |  8.1  |  B+   |
| 12   | `monitoring.ts` (lib)                |  8.0  |  B+   |
| 13   | `bonding.ts`                         |  7.9  |   B   |
| 13   | `routes.ts` (auth)                   |  7.9  |   B   |
| 15   | `connection-config.ts`               |  7.7  |   B   |
| 15   | `retransmit-queue.ts`                |  7.7  |   B   |
| 15   | `webapp/components/Plugin…Panel.tsx` |  7.7  |   B   |
| 18   | `routes/monitoring.ts`               |  7.6  |   B   |
| 19   | `routes/metrics.ts`                  |  7.4  |   B   |
| 19   | `webapp/index.ts`                    |  7.4  |   B   |
| 21   | `routes/config.ts`                   |  7.3  |   B   |
| 22   | `routes/connections.ts`              |  7.0  |   B   |
| 22   | `metrics.ts` (lib)                   |  7.0  |   B   |
| 24   | `pipeline-v2-client.ts`              |  6.8  |  C+   |
| 25   | `types.ts`                           |  6.7  |  C+   |
| 26   | `pipeline.ts`                        |  6.6  |  C+   |
| 27   | `pipeline-v2-server.ts`              |  6.4  |  C+   |
| 27   | `instance.ts`                        |  6.4  |  C+   |
| 29   | `config-watcher.ts`                  |  6.3  |  C+   |

---

## Coverage Metrics

Live coverage figures (statement, branch, function, line) are published by
CI as artefacts of the test job; this document intentionally avoids
duplicating those numbers because they drift with every change. See the
latest CI run's `coverage/` artefact or run `npm run test:coverage`
locally for an authoritative snapshot.

Release-scoped comparisons against prior review rounds are recorded in
`CHANGELOG.md` rather than inline here.

---

## Current Security & Protocol Behaviour

The notable hardenings reflected in the scores above describe the
present-day architecture:

- **v3 control packets are HMAC-verified** in `packet.ts`; there is no
  runtime opt-out.
- **ASCII keys may be PBKDF2-stretched** via the `stretchAsciiKey`
  connection flag handled in `crypto.ts`; both peers must agree on the
  stretching mode.
- **v2/v3 servers pin `protocolVersion`** per session in
  `pipeline-v2-server.ts`; packets whose header version drifts after the
  first HELLO are rejected and counted as malformed.

See `CHANGELOG.md` for the release-scoped history of how these
behaviours evolved.
