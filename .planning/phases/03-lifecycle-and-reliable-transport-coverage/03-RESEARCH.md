# Phase 3: Lifecycle and Reliable Transport Coverage - Research

**Researched:** 2026-04-30
**Domain:** Brownfield lifecycle and reliable UDP regression coverage
**Confidence:** HIGH

<user_constraints>

## User Constraints

Phase 3 has a captured context file. The decisions in that file are binding for planning:

- Treat tests as the primary deliverable.
- Focus on high-risk lifecycle and reliable transport regression seams, not broad coverage-percentage chasing.
- Prioritize `src/instance.ts`, `src/config-watcher.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/sequence.ts`, `src/retransmit-queue.ts`, and `src/packet.ts`.
- Use fake timers, mocked sockets/watchers, packet builders/parsers, and existing Jest harnesses before real network integration.
- Keep source edits narrow: small helper extraction or bug fixes only when tests reveal a real problem or need a deterministic seam.
- Do not redesign UDP protocols, change configuration schema, add dashboards, alter management API behavior, or start online key rotation/security redesign.

</user_constraints>

<architectural_responsibility_map>

## Architectural Responsibility Map

| Capability                         | Primary Tier                                                  | Secondary Tier                                                                    | Rationale                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Instance stop/recovery coverage    | `src/instance.ts`                                             | `__tests__/instance.test.js`                                                      | `createInstance()` owns sockets, timers, subscriptions, v2 workers, and stop ordering.                     |
| Config watcher recovery coverage   | `src/config-watcher.ts`                                       | `__tests__/config-watcher.test.js`                                                | Watcher debounce/recovery is isolated enough for direct fake-timer tests.                                  |
| Client ACK/NAK/retransmit coverage | `src/pipeline-v2-client.ts`                                   | `__tests__/v2/pipeline-v2-client-coverage.test.js`                                | Client pipeline exposes `receiveACK`, `receiveNAK`, `handleControlPacket`, and worker controls.            |
| Server session/sequence coverage   | `src/pipeline-v2-server.ts`                                   | `__tests__/v2/pipeline-v2-server-coverage.test.js`                                | Server pipeline owns sessions, ACK timer, rate limits, sequence tracking, and duplicate handling.          |
| Protocol primitive coverage        | `src/sequence.ts`, `src/retransmit-queue.ts`, `src/packet.ts` | `__tests__/v2/sequence.test.js`, `__tests__/v2/retransmit-queue.test.js`          | Deterministic unit tests can cover edge cases before pipeline-level tests.                                 |
| Metadata/source recovery coverage  | v2 client/server pipelines                                    | `__tests__/v2/meta-end-to-end.test.js`, `__tests__/v2/source-replication.test.js` | Recovery behavior crosses control packets, envelope sequence handling, and source registry merge behavior. |

</architectural_responsibility_map>

<research_summary>

## Summary

Phase 3 should be planned as a test-focused hardening phase. The codebase already has substantial Jest coverage and reusable fake-socket/pipeline harnesses, but the code quality report still calls out lifecycle and v2/v3 pipeline modules as high-risk coverage gaps. The safest plan is to add behavior-driven regression tests around the rare branches that would be painful in production: leaked timers, stopped-state callback races, watcher recovery cleanup, client socket recovery, stale ACK handling, NAK retransmit paths, duplicate packet ACKs, stale sessions, metadata/source envelope dedupe, and source recovery after peer restart.

The phase should avoid sweeping refactors. `src/instance.ts`, `src/pipeline-v2-client.ts`, and `src/pipeline-v2-server.ts` are large modules, but their public factory APIs and existing tests provide enough seams for most coverage. If a private branch cannot be tested without brittle state tricks, extract a small local helper or expose a narrow testable behavior through the existing returned API. Any source change should be paired with a regression test that fails without it.

**Primary recommendation:** execute three plans in order: lifecycle cleanup coverage, reliable ACK/NAK/retransmit coverage, and metadata/source recovery coverage. Run focused suites after each plan and the full gate before phase completion.

</research_summary>

<standard_stack>

## Standard Stack

| Tool / Pattern          | Current Use                                                           | Phase Use                                                                           |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Jest 29                 | Unit, route, v2, component, and integration tests                     | Add fake-timer and fake-socket regression coverage.                                 |
| TypeScript              | Strict backend source                                                 | Keep helper extraction typed and run `npm run check:ts`.                            |
| Fake timers             | Existing time-dependent tests                                         | Assert recovery/debounce/ACK/retry timers are cancelled or fired deterministically. |
| Fake app/socket objects | Existing instance and pipeline tests                                  | Avoid real Signal K or UDP dependencies for focused coverage.                       |
| Packet primitives       | `PacketBuilder`, `PacketParser`, `SequenceTracker`, `RetransmitQueue` | Build deterministic v2/v3 packet and sequence scenarios.                            |
| Integration tests       | `test/integration/` reliability and pipeline flows                    | Use only for cross-module behavior not visible through unit harnesses.              |

</standard_stack>

<architecture_patterns>

## Architecture Patterns

### Pattern: Lifecycle Resource Assertion

```text
createInstance(...)
  -> start()
  -> trigger timer/socket/watcher/subscription branch
  -> stop()
  -> advance fake timers or emit delayed event
  -> assert no state mutation, duplicate listener, open watcher, or worker restart
```

This pattern is best for `socketRecoveryTimer`, `subscriptionRetryTimer`, config debounce timers, watcher recovery timers, `heartbeatHandle`, v2 metrics publishing, and source/metadata timers.

### Pattern: Protocol Primitive Before Pipeline

Use `SequenceTracker` and `RetransmitQueue` tests for pure sequence/ACK logic, then add one pipeline-level test proving that the primitive behavior is wired into client or server metrics and socket sends.

### Pattern: Fake Socket Send Failure

Many pipeline branches are error-handling paths around `socketUdp.send`. A fake socket with a callback-driven `send(buffer, port, address, cb)` can prove ACK/NAK or retransmit error handling without real UDP.

### Pattern: Metadata Envelope Dedupe

Build metadata/source envelopes with explicit `seq` and `idx` values. Send first, duplicate, stale, then restart-like sequence `0` after the threshold. Assert the receiver accepts or drops each envelope and updates metrics accordingly.

</architecture_patterns>

<dont_hand_roll>

## Don't Hand-Roll

| Problem                 | Don't Build                                 | Use Instead                                   | Why                                                      |
| ----------------------- | ------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| New test framework      | Mocha/Vitest/custom runner                  | Jest 29                                       | Existing config and CI already use Jest.                 |
| Real UDP orchestration  | External sockets or services for unit cases | Fake sockets and packet builders              | Faster, deterministic, and easier to debug.              |
| Protocol redesign       | New ACK/NAK semantics                       | Existing v2/v3 behavior                       | Phase scope is regression coverage.                      |
| Broad lifecycle rewrite | Extract an instance framework               | Small helper extraction only if tests need it | Keeps review localized and avoids destabilizing runtime. |
| UI or docs expansion    | Dashboards or new operator pages            | Test-only plans unless behavior changes       | Phase is coverage-focused.                               |

</dont_hand_roll>

<common_pitfalls>

## Common Pitfalls

### Pitfall 1: Tests That Only Chase Coverage

**What goes wrong:** Tests execute lines but do not fail when a resource leak, retransmit bug, or stale packet bug is introduced.
**How to avoid:** Each test should assert a behavioral effect: closed watcher count, no timer callback after stop, no duplicate listener, ACK sent count, queue depth, metric counter, or dropped/forwarded message.

### Pitfall 2: Real Timers Leaking Across Suites

**What goes wrong:** Fake timers are left active or real intervals survive teardown.
**How to avoid:** Use `afterEach(() => jest.useRealTimers())`, stop created pipelines/instances, and assert timer-sensitive code with `advanceTimersByTime`.

### Pitfall 3: Mocking Too Much Of The Subject

**What goes wrong:** A test mocks away the lifecycle or pipeline logic it is supposed to validate.
**How to avoid:** Mock boundaries such as `dgram.createSocket`, `fs.watch`, and app callbacks, but invoke real `createInstance()`, `createWatcherWithRecovery()`, or pipeline factory APIs.

### Pitfall 4: Weakening v3 Control Authentication

**What goes wrong:** Tests build unauthenticated v3 control packets or make v2/v3 mismatch behavior ambiguous.
**How to avoid:** Use `PacketBuilder`/`PacketParser` configured with `secretKey` and preserve protocol-version pinning tests.

### Pitfall 5: Overlapping Plan Write Sets

**What goes wrong:** Multiple plans edit the same large test file in parallel and create conflicts.
**How to avoid:** Execute plans sequentially. If two plans both touch `__tests__/instance.test.js`, the later plan depends on the earlier one.

</common_pitfalls>

<validation_architecture>

## Validation Architecture

Phase 3 validation should start with the narrow suite for each plan:

- Lifecycle coverage: `npm test -- --runTestsByPath __tests__/instance.test.js __tests__/config-watcher.test.js`
- Reliable transport coverage: `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-client-coverage.test.js __tests__/v2/pipeline-v2-server-coverage.test.js __tests__/v2/sequence.test.js __tests__/v2/retransmit-queue.test.js`
- Metadata/source recovery coverage: `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-server.test.js __tests__/v2/meta-end-to-end.test.js __tests__/v2/source-replication.test.js`
- Broader protocol sampling after transport changes: `npm run test:v2`
- Static/type checks after source edits: `npm run check:ts` and `npm run lint`
- Full phase check before verification: `npm run lint && npm run check:ts && npx tsc -p tsconfig.webapp.json --noEmit && npm run build && npm test`

No manual-only verification is required for Phase 3. Real Signal K runtime smoke testing is optional after automated checks pass.

</validation_architecture>

<sources>

## Sources

### Primary

- `.planning/phases/03-lifecycle-and-reliable-transport-coverage/03-CONTEXT.md` - binding Phase 3 decisions D-01 through D-19.
- `.planning/REQUIREMENTS.md` - Phase 3 requirement IDs and acceptance signals.
- `.planning/ROADMAP.md` - Phase 3 goal and success criteria.
- `.planning/codebase/TESTING.md` - test layout and validation strategy.
- `.planning/codebase/ARCHITECTURE.md` - lifecycle and transport boundaries.
- `.planning/codebase/CONCERNS.md` - lifecycle and reliable transport coverage gaps.
- `docs/code-quality-report.md` - file-level risk and coverage gap notes.

### Source and Tests

- `src/instance.ts`
- `src/config-watcher.ts`
- `src/pipeline-v2-client.ts`
- `src/pipeline-v2-server.ts`
- `src/sequence.ts`
- `src/retransmit-queue.ts`
- `src/packet.ts`
- `src/metadata.ts`
- `src/source-replication.ts`
- `src/source-snapshot.ts`
- `__tests__/instance.test.js`
- `__tests__/config-watcher.test.js`
- `__tests__/v2/pipeline-v2-client-coverage.test.js`
- `__tests__/v2/pipeline-v2-server-coverage.test.js`
- `__tests__/v2/pipeline-v2-server.test.js`
- `__tests__/v2/sequence.test.js`
- `__tests__/v2/retransmit-queue.test.js`
- `__tests__/v2/meta-end-to-end.test.js`
- `__tests__/v2/source-replication.test.js`
- `test/integration/reliability.test.js`
- `test/integration/packet-sequence.test.js`
- `test/integration/pipeline-v2-e2e.test.js`

</sources>

_Research complete — see phase plan for implementation guidance._
