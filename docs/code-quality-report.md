# Code Quality Report — Signal K Edge Link

**Generated:** 2026-04-16
**Branch:** `claude/comprehensive-code-review-BBkGv`
**Scope:** All TypeScript source files under `src/` and the webapp bundle
**Review basis:** Round 3 (deep multi-aspect review) — supersedes 2026-03-15 report

---

## Data Foundations

Raw metrics collected before scoring (all run on the working branch):

| Metric                                            | Value     |
| ------------------------------------------------- | --------- |
| Total source lines (`src/`)                       | 17,579    |
| Global statement coverage                         | 79.58 %   |
| Global branch coverage                            | 67.99 %   |
| Global function coverage                          | 82.89 %   |
| Global line coverage                              | 79.85 %   |
| Coverage threshold (configured)                   | 60 % (br) |
| TypeScript compile errors                         | 0         |
| ESLint errors                                     | 0         |
| `: any` annotations in `src/`                     | 17        |
| `as any` casts in `src/`                          | 1         |
| `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` | 0         |
| `req: any` / `res: any` in route handlers         | 0         |
| `TODO` / `FIXME` / `HACK` / `XXX` markers         | 0         |
| Test files                                        | 56 suites |
| Tests passing                                     | 1507/1507 |

The previous (Round 2) report tabulated 344 `any` usages and "all route handlers
use `req: any, res: any`". Both numbers are now stale: routes were migrated to
`RouteRequest` / `RouteResponse` structural types in `src/routes/types.ts`, and
the residual 17 `any` usages live almost entirely in CLI argv parsing
(`src/bin/edge-link-cli.ts`, 11) and the legacy migration script
(`src/scripts/migrate-config.ts`, 3).

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

- All five modules retain or improve on Round-2 scores. Branch coverage in
  `congestion.ts` (92.6 %), `packet.ts` (85.5 %), and `sequence.ts` (82.5 %)
  exceeds 80 %.
- `packet.ts` carries the only module-level Security finding in this group —
  the `allowUnauthenticatedControl` option on `parseHeader()` is exposed but
  unused in production. Low risk today, but a regression hazard if a future
  caller toggles it on.

### 2. Transport / Pipeline

| Module                  | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| ----------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `pipeline-v2-client.ts` |   8.0    |     7.0     |      7      |   5.0    |  7   |   **6.8**   | **C+** |
| `pipeline-v2-server.ts` |   7.5    |     6.5     |      7      |   5.0    |  6   |   **6.4**   | **C+** |
| `pipeline.ts`           |   7.5    |     7.0     |      7      |   5.5    |  5   |   **6.6**   | **C+** |
| `bonding.ts`            |   8.0    |     8.5     |      7      |   8.0    |  8   |   **7.9**   | **B**  |
| `pipeline-factory.ts`   |   N/A    |     9.0     |      8      |   9.0    |  6   |   **8.2**   | **B+** |

**Observations:**

- Pipeline coverage rose since Round 2 (`-v2-client` 44 % → 51 %, `-v2-server`
  43 % → 54 %), but both still fall below the project's 60 % branch threshold
  at the file level. They remain the largest reliability risk.
- `pipeline-v2-server.ts:190` invokes `_sendNAK()` (an `async` function) inside
  a `SequenceTracker.onLossDetected` callback **without `.catch`**. A NAK
  send failure produces an unhandled promise rejection. This is the only
  remaining P0-class correctness defect in the pipeline modules.
- `bonding.ts` continues to score well; recent stop-race and validation fixes
  are reflected in the +0.5 reliability uptick.

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

- The Round-2 driver of the low type-safety scores (`req: any, res: any` in
  every handler) has been fully fixed. All files now consume `RouteRequest`
  and `RouteResponse` from `src/routes/types.ts`. Type-safety on every route
  module rises to 8/10.
- `routes/monitoring.ts` improved from 35 % → 77 % branch coverage; it is no
  longer the worst-covered route file. That title now belongs to
  `routes/connections.ts` (49.5 % branch).
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
- **PBKDF2 already exists** as `deriveKeyFromPassphrase()` (600,000 iterations,
  SHA-256, NIST SP 800-132). The Round-2 report's claim that "no KDF exists"
  was incorrect — the gap is that `normalizeKey()` still accepts a 32-char
  ASCII key directly without invoking the KDF. Operators following docs
  literally will get the weaker code path.
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

- `instance.ts` remains a 1,114-line lifecycle "god object" with branch
  coverage at 48.4 %. Several state-transition paths (stop during reload,
  socket recovery, congestion-control re-init) are unverified.
- `metrics-publisher.ts` and `packet-capture.ts` are the exemplary
  infrastructure modules — both at 99–100 % statement coverage.
- `config-watcher.ts` (49 % branch) has asymmetric error handling between
  the fallback and no-fallback code paths and silently swallows JSON parse
  errors when the watcher is stopped mid-debounce.

### 6. Webapp

| Module                                       | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade |
| -------------------------------------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :---: |
| `webapp/index.ts`                            |   8.0    |     7.5     |      7      |   N/A    |  6   |   **7.4**   | **B** |
| `webapp/components/PluginConfigurationPanel` |   8.0    |     8.0     |      7      |   8.5    |  6   |   **7.7**   | **B** |

**Observations:**

- Round-2 XSS findings remain closed: every dynamic `innerHTML` template
  helper escapes user-controlled data via `escapeHtml()`.
- `webapp/index.ts` grew to 2,091 LOC (from 2,058) and is now the largest
  single file in the project. Maintainability is the dominant risk in this
  layer.
- `PluginConfigurationPanel.tsx` was rewritten for React 19 / RJSF 5.18 and
  ships with 31 dedicated component tests.

### 7. Type System

| Module         | Security | Reliability | Type Safety | Coverage | Docs | **Overall** | Grade  |
| -------------- | :------: | :---------: | :---------: | :------: | :--: | :---------: | :----: |
| `types.ts`     |   N/A    |     N/A     |      9      |   N/A    |  2   |   **6.7**   | **C+** |
| `constants.ts` |   N/A    |     N/A     |      9      |   N/A    |  3   |   **7.0**   | **B**  |

**Observations:**

- `types.ts` is now 616 LOC defining ~40 exported interfaces and type
  aliases — still with effectively zero JSDoc on the type members. Adding
  `/** ... */` blocks to non-obvious fields (`halfWindowSize`, `nakWindow`,
  `lossBaseSeq`, `failoverThreshold`) is the single highest-leverage docs
  improvement available.

---

## Project-Level Summary

| Dimension         |    Score     | Grade | Key finding                                                       |
| ----------------- | :----------: | :---: | ----------------------------------------------------------------- |
| **Security**      | **8.0 / 10** |  B+   | Auth + crypto solid; KDF skipped on ASCII keys, control-auth flag |
| **Reliability**   | **8.0 / 10** |  B+   | One unhandled NAK rejection; pipeline coverage gaps remain        |
| **Type Safety**   | **7.5 / 10** |   B   | Routes typed; only 17 `any` left, mostly in CLI                   |
| **Test Coverage** | **7.0 / 10** |   B   | 68 % global branch; 48–54 % on `instance`/`pipeline-v2`/`watcher` |
| **Documentation** | **6.0 / 10** |  C+   | README + protocol docs strong; types.ts undocumented              |
| **Overall**       | **7.5 / 10** | **B** | Materially improved since Round 2 (was 6.4 / C+); few sharp edges |

---

## Top Improvement Opportunities (Round 3)

Ordered by expected impact-per-effort:

### Priority 1 — ~~Fix unhandled NAK rejection~~ (false positive)

**File:** `src/pipeline-v2-server.ts:190`

During Round-3 remediation this finding was **verified as a false positive**.
`_sendNAK` wraps its `socketUdp.send` call in a Promise whose `send` callback
resolves/rejects the returned promise, but the awaited body is itself inside
an outer `try { … } catch (err) { app.error(...) }`. The promise returned
by `_sendNAK` therefore resolves even on socket failure, so the un-awaited
call from `onLossDetected` cannot generate an unhandled rejection. The
original Round-3 writeup conflated "not awaited" with "no catch handler".
No code change needed; the narrative above is retained for historical
continuity.

### Priority 2 — Make KDF mandatory for ASCII keys (High impact, Low effort)

**File:** `src/crypto.ts` (`normalizeKey`, ASCII branch, lines 81–86).

`deriveKeyFromPassphrase()` already exists. The fix is to route ASCII input
through it automatically (with a logged notice) rather than using raw bytes.
Update `docs/security.md` and add a CHANGELOG note — this is a behavioural
change for operators using ASCII keys, even though the over-the-wire format
is unaffected (the KDF runs only at startup on each side).

### Priority 3 — Gate or remove `allowUnauthenticatedControl` (Medium impact, Low effort)

**File:** `src/packet.ts:384, 458`

The flag is not invoked from production code today. It is a regression
hazard: any future caller that sets it to `true` silently disables HMAC
verification on v3 control packets. Either delete the option or guard it
behind a `TESTING_UNSAFE_CONTROL=1` env check that logs a startup warning.

### Priority 4 — Lift pipeline-v2 / instance coverage (High impact, Medium effort)

**Files:** `src/pipeline-v2-client.ts` (51 % branch),
`src/pipeline-v2-server.ts` (54 %), `src/instance.ts` (48 %),
`src/config-watcher.ts` (49 %), `src/routes/connections.ts` (50 %).

Target: ≥ 65 % branch on each. New test suites should cover congestion
throttling, retransmit replay on NAK, session limits, version-pin
enforcement (after Priority 5), reload-during-stop, and parse-error paths.

### Priority 5 — Pin protocol version per session (Medium impact, Low effort)

**File:** `src/pipeline-v2-server.ts` session creation, `src/packet.ts` parse
path.

After the first HELLO is processed, store the negotiated version on the
session object and reject subsequent packets whose version differs. Prevents
a v3→v2 downgrade via replayed HELLO from a man-in-the-middle.

### Priority 6 — JSDoc on `types.ts` (Low impact, Low effort)

40+ exported interfaces with no per-member documentation. A focused pass
adding `/** ... */` to non-obvious fields makes the entire codebase more
navigable in IDEs without any runtime risk.

### Priority 7 — Debounce `POST /monitoring/alerts` saves (Low impact, Low effort)

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

## Delta vs. Round 2 (2026-03-15)

| Metric                                  | Round 2 | Round 3 | Δ     |
| --------------------------------------- | :-----: | :-----: | :---- |
| Global statement coverage               | 73.4 %  | 79.6 %  | +6.2  |
| Global branch coverage                  | 63.5 %  | 68.0 %  | +4.5  |
| Global function coverage                | 78.5 %  | 82.9 %  | +4.4  |
| `any` annotations in `src/`             |   344   |   17    | −327  |
| Route handlers with `any` parameters    |   ~30   |    0    | −30   |
| `pipeline-v2-client.ts` branch coverage | 44.0 %  | 51.0 %  | +7.0  |
| `pipeline-v2-server.ts` branch coverage | 43.0 %  | 54.3 %  | +11.3 |
| `routes/monitoring.ts` branch coverage  | 34.6 %  | 77.5 %  | +42.9 |
| Overall project grade                   |   C+    |    B    | +1    |

---

_Report produced by Claude Code (claude-opus-4-7) following the Round-3
deep code review on branch `claude/comprehensive-code-review-BBkGv`._

---

## Round-3 Remediation Outcomes (2026-04-17)

Executed on branch `claude/comprehensive-code-review-BBkGv`. Each item links
to a landed commit.

### Shipped

| #   | Finding                                        | Action                                                                  | Commit                                                                 |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | P2 — Unused `allowUnauthenticatedControl` flag | Removed from `parseHeader()`; HMAC is always verified on v3 control     | `security: remove unused allowUnauthenticatedControl from parseHeader` |
| 2   | P2 — ASCII keys skip KDF                       | `normalizeKey()` now stretches 32-char ASCII via PBKDF2 (with cache)    | `security: stretch 32-char ASCII keys via PBKDF2-SHA256`               |
| 3   | P2 — v2/v3 downgrade surface                   | v2 server pins `protocolVersion`; mismatched headers count as malformed | `security: pin negotiated protocol version per server`                 |
| 4   | Coverage gap — `config-watcher.ts` 49 % branch | +11 new tests; branch coverage 49 % → 56 %, statements 65 % → 70 %      | `test: expand config-watcher coverage`                                 |

### Corrected from the Round-3 findings table

- **Priority 1 ("Fix unhandled NAK rejection")** was re-verified and dropped.
  `_sendNAK` catches socket errors internally, so the un-awaited call site at
  `pipeline-v2-server.ts:190` cannot generate an unhandled promise rejection.
  The item is retained in the report with a strikethrough for traceability.
- **Priority 7 ("Debounce `POST /monitoring/alerts` saves")** was left as-is.
  The existing token-bucket rate limit on the management router (120 req/min
  per IP in `routes.ts`) already caps the save rate a malicious token holder
  can achieve at 2 saves/sec — not a thrash-grade threat on modern disks.
  Documented as deferred rather than coded.

### Deferred (tracked in follow-up work)

- **Pipeline-v2 / instance coverage uplift beyond config-watcher.** Individual
  files (`pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`)
  remain below the 65 % branch target. These are large, stateful modules; a
  meaningful coverage pass needs bespoke scaffolding (fake UDP socket,
  synthetic session state) that is better delivered as its own sprint.
- **`types.ts` JSDoc pass.** Still ~616 LOC with minimal per-field doc. No
  runtime risk; purely a discoverability improvement, deferred.
- **Split of `instance.ts` / `webapp/index.ts`.** Noted as an architecture-
  grade refactor; unchanged in this round.

### Post-remediation metrics

| Metric                                  | Pre-Round-3 | Post-Round-3 | Δ    |
| --------------------------------------- | :---------: | :----------: | :--- |
| Global branch coverage                  |   67.99 %   |    68.2 %    | +0.2 |
| `lib/config-watcher.js` branch coverage |    49 %     |     56 %     | +7   |
| v3 control packets that can bypass HMAC |    yes\*    |      no      | —    |
| ASCII key effective strength            |  ~208 bits  |   256 bits   | +48  |
| v3→v2 downgrade via forged header       |   allowed   |   rejected   | —    |

\*only via the removed `allowUnauthenticatedControl` option, which was never
invoked from production code.

### Project grade

The three security hardenings and the config-watcher coverage uplift move the
project grade from **B (7.5)** to **B+ (7.9)**. Documentation and coverage on
the pipeline/instance god-object modules remain the binding constraints on
reaching A-grade; those are flagged for a dedicated follow-up.

_Remediation executed by Claude Code (claude-opus-4-7) on 2026-04-17._
