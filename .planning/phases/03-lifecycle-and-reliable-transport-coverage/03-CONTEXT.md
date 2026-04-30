# Phase 3: Lifecycle and Reliable Transport Coverage - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 adds targeted regression coverage around the highest-risk lifecycle cleanup and reliable v2/v3 transport recovery paths before further refactoring. The phase may make small source changes when tests expose a bug or when a narrow helper extraction is needed for deterministic coverage, but it does not redesign the UDP protocols, change configuration shape, add UI dashboards, alter management API behavior, or start future security work such as online key rotation.

</domain>

<decisions>
## Implementation Decisions

### Coverage Investment Shape

- **D-01:** Treat tests as the primary deliverable. The goal is not a broad coverage-percentage sweep; it is regression coverage for paths called out as high-risk in the codebase map and quality report.
- **D-02:** Prefer a small number of focused plans/waves: lifecycle cleanup coverage first, reliable transport recovery coverage second, and metadata/source recovery coverage as part of the transport work or as a third narrow plan if needed.
- **D-03:** Every new test should protect a meaningful failure mode, such as leaked timers, duplicate socket listeners, stale sessions, dropped retransmits, stale metadata envelopes, or broken sequence-gap recovery. Avoid tests that only exercise lines without observable behavior.

### Lifecycle Resource Cleanup

- **D-04:** Prioritize `src/instance.ts` and `src/config-watcher.ts` lifecycle seams: socket recovery, stop during pending recovery, stop during subscription retry, timer cleanup, watcher rename/error recovery, watcher close cleanup, and stop/start ordering.
- **D-05:** Use fake timers, mocked sockets/watchers, and existing local Jest factories rather than real UDP sockets or real filesystem churn unless an integration-style assertion is clearly necessary.
- **D-06:** Lifecycle tests should prove that `stop()` cancels pending recovery/retry/debounce work, closes watcher handles, stops v2 pipeline periodic workers, clears heartbeat handles, and prevents callbacks from mutating stopped state.
- **D-07:** Keep multi-instance isolation in view. Tests should avoid shared global state and should fail if one instance's timers, watchers, sockets, metrics, or pipeline state leak into another.

### Reliable Transport Recovery

- **D-08:** Prioritize v2/v3 ACK/NAK, retransmit, sequence-gap, duplicate, stale session, and packet reordering behavior in `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/sequence.ts`, `src/retransmit-queue.ts`, and `src/packet.ts`.
- **D-09:** Prefer the existing `__tests__/v2/` harnesses, packet builders/parsers, fake sockets, and network simulator utilities. Use `test/integration/` only for cross-module flows where unit-level harnesses would miss the behavior.
- **D-10:** When touching v3 control packet handling, preserve authenticated control packet behavior. Tests should not weaken HMAC/version checks or make v2/v3 compatibility ambiguous.
- **D-11:** Existing well-covered subsystems such as bonding should not be the first target unless they are directly involved in a selected recovery path.

### Metadata and Source Recovery

- **D-12:** Include targeted coverage for existing metadata/source recovery behavior when it intersects reliable transport: HELLO-triggered metadata requests, client metadata/source snapshot resend after socket recovery, stale/duplicate metadata envelope dropping, source snapshot sequence reset after sender restart, and source registry recovery.
- **D-13:** Keep metadata/source work to regression coverage for current behavior. Do not add a new metadata protocol, storage layer, or operator-facing configuration in this phase.

### Allowed Implementation Movement

- **D-14:** Source edits are acceptable only when a test reveals a real bug or when a small helper extraction makes an existing behavior testable without brittle private-state tricks.
- **D-15:** Avoid broad refactors of `src/instance.ts`, `src/pipeline-v2-client.ts`, or `src/pipeline-v2-server.ts`. If helper extraction is needed, keep it local, behavior-preserving, and covered by the new tests.
- **D-16:** Documentation changes are optional for Phase 3 unless a source behavior changes in an operator-visible way. Test-only work should not create documentation churn.

### Validation Expectations

- **D-17:** Validate each plan with the narrowest relevant suites first, then run broader checks before phase completion.
- **D-18:** Expected focused commands include `npm test -- --runTestsByPath __tests__/instance.test.js __tests__/config-watcher.test.js`, `npm test -- --runTestsByPath __tests__/v2/pipeline-v2-client-coverage.test.js __tests__/v2/pipeline-v2-server-coverage.test.js`, `npm run test:v2`, and selected `test/integration/` suites when cross-module behavior is changed.
- **D-19:** Phase completion should run the standard broad gate: `npm run lint`, `npm run check:ts`, `npx tsc -p tsconfig.webapp.json --noEmit`, `npm run build`, and `npm test`.

### the agent's Discretion

- Exact test names, helper names, and plan boundaries are flexible as long as the work stays targeted to lifecycle and reliable transport regression coverage.
- The planner may split metadata/source recovery into its own plan if combining it with ACK/NAK work would make a plan too large.
- The planner may add a small bug-fix task if a new regression test reveals current behavior does not match the intended lifecycle or transport contract.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope

- `.planning/PROJECT.md` - Milestone direction, compatibility constraints, and out-of-scope future protocol/security work.
- `.planning/REQUIREMENTS.md` - Phase 3 requirement IDs `V1-TEST-001` and `V1-TEST-002` with acceptance signals.
- `.planning/ROADMAP.md` - Phase 3 goal, likely work, and success criteria.
- `.planning/STATE.md` - Current workflow state after Phase 2 completion.

### Codebase Maps and Reports

- `.planning/codebase/TESTING.md` - Jest organization, v2/integration suite layout, focused validation strategy, and simulator patterns.
- `.planning/codebase/ARCHITECTURE.md` - Instance runtime boundaries, transport pipeline boundaries, state ownership, and cleanup responsibilities.
- `.planning/codebase/CONCERNS.md` - Lifecycle/pipeline coverage gaps, timer/socket cleanup fragility, and reliable transport complexity.
- `docs/code-quality-report.md` - Specific quality findings for `instance.ts`, `config-watcher.ts`, `pipeline-v2-client.ts`, and `pipeline-v2-server.ts`.

### Lifecycle Source and Tests

- `src/instance.ts` - Instance lifecycle, sockets, timers, config watchers, subscription retry, pipeline startup/teardown, metadata/source timers, and stop behavior.
- `src/config-watcher.ts` - Debounced config handlers, watcher recovery, rename/error handling, and watcher close behavior.
- `src/types.ts` - `InstanceState`, socket/timer/watcher state, and pipeline-related shared types.
- `__tests__/instance.test.js` - Existing instance API, lifecycle, buffering, retry, and delta-send coverage.
- `__tests__/config-watcher.test.js` - Existing debounce, fallback, stopped-state, watcher, and storage initialization coverage.

### Reliable Transport Source and Tests

- `src/pipeline-v2-client.ts` - Client-side v2/v3 send, retransmit queue, ACK/NAK handling, recovery burst, heartbeat, congestion, metrics publishing, metadata/source sending.
- `src/pipeline-v2-server.ts` - Server-side sessions, sequence tracking, ACK/NAK generation, duplicate handling, idle expiration, metadata/source receive, and protocol version pinning.
- `src/sequence.ts` - Sequence tracker gap detection, duplicate detection, resync, and NAK timer management.
- `src/retransmit-queue.ts` - ACK queue pruning, stale ACK handling, retransmit selection, and max retransmit behavior.
- `src/packet.ts` - v2/v3 packet builder/parser, control packet structure, version/HMAC handling.
- `src/metadata.ts` - Metadata snapshot/diff envelopes and restart recovery assumptions.
- `src/source-replication.ts` - Source identity and registry merge behavior.
- `src/source-snapshot.ts` - Source snapshot collection and merge helpers.
- `__tests__/v2/pipeline-v2-client-coverage.test.js` - Existing client ACK/NAK, retransmit, recovery burst, control packet, and loss-window coverage.
- `__tests__/v2/pipeline-v2-server-coverage.test.js` - Existing server session, idle expiration, rate limit, periodic ACK, and receive branch coverage.
- `__tests__/v2/pipeline-v2-server.test.js` - Server DATA, source metadata, duplicate, NAK, v3 NAK signing, and forged heartbeat coverage.
- `__tests__/v2/sequence.test.js` - Sequence tracker behavior.
- `__tests__/v2/retransmit-queue.test.js` - Retransmit queue behavior.
- `__tests__/v2/meta-end-to-end.test.js` - Metadata end-to-end behavior.
- `__tests__/v2/source-replication.test.js` - Source registry behavior.
- `test/integration/reliability.test.js` - Network simulator, ACK/NAK, retransmit, and end-to-end reliability flow coverage.
- `test/integration/packet-sequence.test.js` - Packet plus sequence integration coverage.
- `test/integration/pipeline-v2-e2e.test.js` - Pipeline v2 cross-module behavior.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `createInstance()` in `src/instance.ts`: central lifecycle surface for start/stop, sockets, timers, watchers, subscriptions, pipeline initialization, and cleanup assertions.
- `createDebouncedConfigHandler()` and `createWatcherWithRecovery()` in `src/config-watcher.ts`: isolated functions that can be tested directly with fake timers and mocked watcher behavior.
- `createPipelineV2Client()` in `src/pipeline-v2-client.ts`: exposes public hooks for `receiveACK`, `receiveNAK`, `handleControlPacket`, metrics publishing, congestion control, heartbeat, and metadata/source sending.
- `createPipelineV2Server()` in `src/pipeline-v2-server.ts`: exposes public hooks for ACK timer control, metrics publishing, sequence tracker access, and receive behavior.
- `PacketBuilder`, `PacketParser`, `SequenceTracker`, and `RetransmitQueue`: protocol primitives suitable for deterministic unit tests without real sockets.
- Existing network simulator utilities in `test/integration/reliability.test.js` and nearby integration tests: reusable for cross-module ACK/NAK and retransmit flows.

### Established Patterns

- Tests prefer local factory helpers and fake app/socket objects over shared fixtures.
- Time-dependent behavior is tested with Jest fake timers.
- Route and runtime modules are commonly tested by invoking public factory APIs and inspecting state, metrics, callbacks, and mock calls.
- Protocol tests use packet builders/parsers and controlled fake sockets instead of relying on external network services.
- Broad validation runs lint, backend typecheck, webapp typecheck, build, and full Jest before phase completion.

### Integration Points

- Lifecycle coverage connects through `createInstance()`, `state.configWatcherObjects`, `state.configDebounceTimers`, `state.socketRecoveryTimer`, `state.subscriptionRetryTimer`, v2 pipeline worker stop/start hooks, and socket error handlers.
- Reliable transport coverage connects through client `receiveACK`/`receiveNAK`/`handleControlPacket`, server `receivePacket`, server ACK timer, sequence tracker state, retransmit queue state, metadata/source packet handlers, and metrics counters.
- Metadata/source recovery coverage connects through instance socket recovery, `sendSourceSnapshot()`, metadata snapshot scheduling, `META_REQUEST`, source registry merge behavior, and server envelope sequence dedupe.

</code_context>

<specifics>
## Specific Ideas

- `[auto] Coverage investment shape` - Selected targeted regression seams over a broad coverage sweep or large refactor.
- `[auto] Lifecycle resource cleanup` - Selected stop/recovery/watcher/timer cleanup using fake timers and mocked resources.
- `[auto] Reliable transport recovery` - Selected ACK/NAK, retransmit, stale session, duplicate, and sequence-gap behavior as the primary protocol coverage set.
- `[auto] Metadata and source recovery` - Selected current metadata/source restart and stale-envelope recovery behavior as in-scope when tied to reliable transport.
- `[auto] Allowed implementation movement` - Selected minimal helper extraction or bug fixes only when tests require it.

</specifics>

<deferred>
## Deferred Ideas

- Online key rotation, online key agreement, and other protocol-security redesign work remain deferred to Phase 5 or a later dedicated design phase.
- New UI dashboards or operator-facing telemetry screens are out of scope for Phase 3.
- Schema/configuration parity work belongs to Phase 4 unless a test-discovered bug requires a tiny supporting change.
- Broad performance tuning or benchmark-driven optimization is out of scope unless a selected regression test requires a small reliability fix.
- Sweeping rewrites of `src/instance.ts`, `src/pipeline-v2-client.ts`, or `src/pipeline-v2-server.ts` are out of scope.

</deferred>

---

_Phase: 03-lifecycle-and-reliable-transport-coverage_
_Context gathered: 2026-04-30_
