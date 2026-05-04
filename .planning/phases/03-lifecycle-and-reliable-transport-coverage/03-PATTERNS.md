# Phase 3 Pattern Map

**Mapped:** 2026-04-30
**Purpose:** Analog files and test seams for lifecycle and reliable transport coverage.

## Closest Analogs

| Target                                                                      | Closest Existing Analog                                                 | Pattern To Reuse                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/instance.test.js` lifecycle additions                            | Existing `createInstance` API and buffering/retry tests                 | Local factories, fake app callbacks, direct state inspection through `getState()`, fake timers where timers are involved. |
| `__tests__/config-watcher.test.js` watcher additions                        | Existing debounce and stopped-state tests                               | Mock `fs.watch` / fake watcher handles, assert callback suppression after `state.stopped`, restore timers in `afterEach`. |
| `__tests__/v2/pipeline-v2-client-coverage.test.js`                          | Existing ACK/NAK, recovery burst, control packet, and loss-window tests | Fake socket `send` callbacks, `PacketBuilder`, `receiveACK`, `receiveNAK`, `handleControlPacket`, metrics assertions.     |
| `__tests__/v2/pipeline-v2-server-coverage.test.js`                          | Existing session, idle expiration, rate limit, and periodic ACK tests   | Fake timers around ACK interval, fake remote addresses/ports, packet builders, metrics counters.                          |
| `__tests__/v2/pipeline-v2-server.test.js`                                   | Existing DATA, duplicate, NAK, v3 signing, and forged heartbeat tests   | Build real encrypted packets and assert forwarded deltas, socket sends, or rejection logs.                                |
| `__tests__/v2/sequence.test.js` and `__tests__/v2/retransmit-queue.test.js` | Existing protocol primitive tests                                       | Pure deterministic tests before pipeline-level coverage.                                                                  |

## File Ownership Guidance

### Lifecycle Plan

- Write scope: `__tests__/instance.test.js`, `__tests__/config-watcher.test.js`, and source files only if tests expose a bug or a small test seam is needed.
- Avoid touching v2 pipeline coverage files in the lifecycle plan unless needed for mocked worker hooks.

### Reliable Transport Plan

- Write scope: `__tests__/v2/pipeline-v2-client-coverage.test.js`, `__tests__/v2/pipeline-v2-server-coverage.test.js`, `__tests__/v2/sequence.test.js`, `__tests__/v2/retransmit-queue.test.js`, and related source only if tests expose current behavior drift.
- Avoid touching metadata/source end-to-end tests unless the behavior belongs to Plan 03.

### Metadata and Source Plan

- Write scope: `__tests__/v2/pipeline-v2-server.test.js`, `__tests__/v2/meta-end-to-end.test.js`, `__tests__/v2/source-replication.test.js`, and selected client/instance tests for recovery re-prime behavior.
- Depend on the reliable transport plan before adding envelope-specific coverage.

## Test Hygiene

- Use `afterEach(() => jest.useRealTimers())` when fake timers are enabled.
- Stop created pipelines or instances before test exit.
- Prefer observable behavior over private variable assertions.
- Keep synthetic secrets obviously fake and never introduce real token-like values.

## PATTERN MAPPING COMPLETE
