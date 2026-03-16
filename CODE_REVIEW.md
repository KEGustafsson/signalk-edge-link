# Code Review Verdict: signalk-edge-link v2.1.0-beta.11

This document provides a comprehensive code review across eight aspects of the `signalk-edge-link` Signal K plugin.

---

## Overall Verdict: B+ (Good, with notable reliability gaps)

The codebase is well-structured and security-conscious for a Signal K plugin. The use of TypeScript strict mode, AES-256-GCM with proper key derivation, comprehensive configuration validation, and an observable architecture are strong positives.

However, **four high-severity correctness issues** — all involving timer/flag race conditions — pose real production risks under edge-case conditions (rapid start/stop cycles, simultaneous errors, concurrent recovery). These should be addressed before a stable release.

---

## 1. Security — B+

### Strengths
- AES-256-GCM authenticated encryption with a 12-byte random IV per packet
- PBKDF2-SHA256 key derivation (600k iterations, NIST SP 800-132 compliant)
- `crypto.timingSafeEqual` used for auth tag comparison — constant-time, immune to timing attacks
- Shannon entropy check on keys (min 3.0 bits/char) rejects weak/repeating passwords
- Rate limiting (120 req/min/IP) on the management API
- Optional management API token auth

### Issues

| Severity | File | Line | Description |
|----------|------|------|-------------|
| Medium | `src/crypto.ts` | 67 | Base64 key regex validates format but if the decoded buffer fails the `length === 32` check, execution silently falls through to the ASCII key path with no error or warning — key format degrades without notice |
| Medium | `src/instance.ts` | 632 | `options.secretKey` is passed directly to `v2Server.receivePacket()` without a null/undefined guard; an unconfigured key would propagate silently to decryption |

---

## 2. Correctness — B

### Strengths
- Deep config validation before any instance starts (fail-fast, port collision detection)
- All instances started concurrently with partial-failure rollback
- Retransmit queue uses uint32 sequence numbers with wraparound-aware distance math

### Issues

| Severity | File | Lines | Description |
|----------|------|-------|-------------|
| 🔴 High | `src/pipeline-v2-client.ts` | 748–760 | `telemetrySendInFlight` flag is set to `true` before `sendDelta()` returns its promise. If `sendDelta()` throws *synchronously*, the `.finally()` callback is never reached, permanently locking out future telemetry sends |
| 🔴 High | `src/instance.ts` | 764–791 | Socket recovery race: `socketRecoveryInProgress` is checked then set several lines later. Multiple rapid errors can all observe `false` and each spawn a recovery attempt. Also, `state.stopped` is checked before the `setTimeout()` callback fires, so recovery can execute post-shutdown |
| 🔴 High | `src/instance.ts` | 720–723 | `helloMessageSender` timer is cleared only inside a conditional block; if the condition is false, the old timer keeps running while a new one is created — duplicate hello messages on repeated `start()` calls |
| Medium | `src/retransmit-queue.ts` | 188–191 | No deduplication guard prevents `receiveNAK()` and the recovery burst from independently requesting retransmission of the same sequence simultaneously |
| Low | `src/metrics.ts` | 128–130 | `recentErrors.splice(0, length - RECENT_ERRORS_LIMIT)` is a silent no-op when the array is shorter than the limit (negative splice count) |

---

## 3. Performance — A-

### Strengths
- Smart batching uses exponential moving average (EMA) of bytes-per-delta to pack deltas up to the MTU limit (1400 bytes safe threshold) without fragmentation
- Brotli quality 6 achieves ~90% of maximum compression at ~10% of the CPU cost
- Optional MessagePack binary serialization reduces payload size further
- Circular buffers with hard capacity limits prevent unbounded memory growth
- AIMD congestion control dynamically adjusts send rate based on live RTT and loss measurements

### Issues

| Severity | File | Lines | Description |
|----------|------|-------|-------------|
| Low | `src/crypto.ts` | 163–169 | Key entropy check builds full repeated strings (`pattern.repeat(n).slice(0, 32)`) in a loop for each pattern length 1–8. Minor allocation waste in a validation-only path (not the hot path) |

---

## 4. Error Handling — B

### Strengths
- Fine-grained error categories: `compression`, `encryption`, `udpSend`, `crypto`, `pingTimeout`, `sendFailure`, `general`
- Recent error list (last 20 with timestamps) stored in state for live diagnostics
- UDP send uses exponential backoff retry
- Non-fatal errors (bad delta batch, compression failure) are tracked but don't halt processing

### Issues

| Severity | File | Lines | Description |
|----------|------|-------|-------------|
| 🔴 High | `src/pipeline-v2-client.ts` | 271–273 | `recoveryDrainTimer` cleanup is order-dependent (cleared in `stopMetricsPublishing()`). If the timer fires between shutdown start and cleanup, it accesses partially torn-down state |
| Medium | `src/pipeline-v2-client.ts` | 749–760 | Telemetry send uses `.catch(log).finally(reset)`; if the catch handler itself throws, the error is silently swallowed. Additionally, no timeout bounds the send — a stalled UDP write can block the `telemetrySendInFlight` slot indefinitely |
| Medium | `src/instance.ts` | 481–482 | Unsubscribe callbacks array is cleared before re-subscribing. If the subsequent `app.subscriptionmanager.subscribe()` call throws, no cleanup handlers remain — subscription leak |

---

## 5. Type Safety — B+

### Strengths
- TypeScript strict mode (`strict: true`) in `tsconfig.json`
- Comprehensive type definitions in `src/types.ts` (617 lines)
- Interfaces cover all major state objects, pipeline configs, and metrics structures

### Issues

| Severity | File | Line(s) | Description |
|----------|------|---------|-------------|
| Medium | `src/metrics.ts` | 95, 103 | `_pathStatsStalest` declared as `any`; `Metrics` object cast with `as any` at construction — defeats strict typing in hot paths |
| Medium | `src/metrics.ts` | 251–265 | `update.values` accessed before verifying `update` itself is non-null; downstream guard at line 253 only checks `values`, not `update` |
| Medium | `src/pipeline-v2-client.ts` | 453–456 | Return value of `_calculatePacketLoss()` not validated for `NaN` before passing to congestion control's `updateMetrics()` |

---

## 6. Architecture — A-

### Strengths
- Clean separation of concerns: pipeline, crypto, sequence tracking, congestion control, and bonding are all isolated modules
- Factory pattern for pipeline version selection (`src/pipeline-factory.ts`)
- Full instance isolation — each connection has independent state; Map-based registry enables safe multi-instance operation
- Observability as a first-class concern: Prometheus export, PCAP packet capture, alert threshold framework
- File watchers with debounce + MD5 hash check for zero-downtime runtime config reloads

### Issues
- `src/instance.ts` (~1100 lines) and `src/pipeline-v2-client.ts` (~940 lines) are large; both would benefit from splitting lifecycle management from runtime operation logic
- Timer and file watcher setup in `instance.ts` uses nested callbacks; an event-emitter abstraction would reduce coupling and make cleanup ordering explicit
- No dedicated error boundary around pipeline failures — error propagation relies on each stage independently catching its own exceptions, with no coordinated fallback

---

## 7. Testing — B-

### Strengths
- 20+ unit test files covering crypto, compression, metrics, routes, and pipeline logic
- Network simulator tests (phase 7) for packet loss and latency scenarios
- Integration tests for full pipeline end-to-end
- Performance and memory benchmarks

### Issues
- Coverage thresholds are moderate (60% branches, 65% functions/lines) — well below production targets (typically 80%+)
- No tests for concurrent multi-instance start/stop sequences
- Bonding failover edge cases (simultaneous dual-link failure) are untested
- The four high-severity race conditions identified above have no dedicated test coverage
- No property-based or fuzz tests for the packet parser or cryptographic layer

---

## 8. Documentation — C+

### Strengths
- `README.md` covers installation, configuration, and protocol version overview
- Sample configs provided for common deployment patterns (minimal, dev, v2-bonding, v3-auth)
- TypeScript interfaces serve as self-documenting data shape contracts

### Issues
- Complex algorithms (retransmit expiry with RTT scaling, AIMD threshold tuning, bonding hysteresis parameters) lack inline comments explaining the reasoning behind constants and thresholds
- Sequence gap detection strategy and uint32 wraparound handling are not documented
- No CHANGELOG or protocol version history
- Management REST API endpoints lack JSDoc annotations or an OpenAPI/Swagger spec

---

## Priority Fix List

| Priority | File | Line(s) | Issue |
|----------|------|---------|-------|
| 🔴 High | `src/instance.ts` | 764–791 | Socket recovery race — set flag atomically before attaching error handler; guard callback with stopped check inside timeout |
| 🔴 High | `src/instance.ts` | 720–723 | Always clear `helloMessageSender` unconditionally before reassignment |
| 🔴 High | `src/pipeline-v2-client.ts` | 748–760 | Wrap `sendDelta()` in try/catch so sync throws still clear the in-flight flag |
| 🔴 High | `src/pipeline-v2-client.ts` | 271–273 | Move `recoveryDrainTimer` cleanup earlier in shutdown sequence, before pipeline state is torn down |
| 🟡 Medium | `src/crypto.ts` | 67 | Emit an explicit warning/error when base64 key decodes to wrong length instead of silent fallthrough |
| 🟡 Medium | `src/instance.ts` | 481–482 | Store new unsubscribe callback before clearing old ones; use try/finally around subscription |
| 🟡 Medium | `src/retransmit-queue.ts` | 188–191 | Add a `pendingRetransmit` Set to deduplicate concurrent NAK + burst requests |
| 🟡 Medium | `src/metrics.ts` | 95, 103 | Replace `any` casts with proper typed interfaces |
| 🟡 Medium | `src/pipeline-v2-client.ts` | 453–456 | Filter `NaN`/`Infinity` from `_calculatePacketLoss()` before passing to congestion control |
| 🟢 Low | `src/metrics.ts` | 128–130 | Use `Math.max(0, ...)` to guard splice count against negative values |
| 🟢 Low | `src/crypto.ts` | 163–169 | Use a simple regex or char-code comparison loop instead of constructing full repeated strings |
