---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Codebase Concerns

**Analysis Date:** 2026-04-30

## Tech Debt

**Large lifecycle orchestrator in `src/instance.ts`:**

- Issue: `src/instance.ts` owns plugin-instance lifecycle, sockets, timers, config watchers, Signal K subscriptions, metadata/source snapshot dispatch, and pipeline startup/teardown in one large module.
- Why: The module is the natural point where Signal K app state, connection options, and runtime resources meet.
- Impact: Changes to one feature can accidentally affect stop/start ordering, cleanup, or recovery behavior for unrelated features.
- Fix approach: Extract focused lifecycle helpers only when changing that area, and keep regression tests around socket recovery, timer cleanup, and watcher cleanup.

**Reliable transport complexity in `src/pipeline-v2-client.ts` and `src/pipeline-v2-server.ts`:**

- Issue: Reliability, retransmission, telemetry, metadata/source snapshots, congestion, and bonding behavior are concentrated in large pipeline modules.
- Why: v2/v3 behavior evolved from an initially simpler UDP pipeline.
- Impact: Packet-order, stale session, and reconnect edge cases are easy to miss without targeted tests.
- Fix approach: Prefer small helper extraction plus tests in `__tests__/v2/` and `test/integration/` when touching these modules.

**Documentation drift in architecture docs:**

- Issue: `docs/architecture-overview.md` references some legacy file names such as `src/bonding-manager.ts`, `src/congestion-control.ts`, `src/alert-manager.ts`, and `src/sequence-tracker.ts`; the current code uses `src/bonding.ts`, `src/congestion.ts`, `src/monitoring.ts`, and `src/sequence.ts`.
- Why: Implementation names changed while the high-level architecture doc kept older names.
- Impact: New contributors can search for files that no longer exist.
- Fix approach: Update `docs/architecture-overview.md` when next touching docs or architecture.

**Release-version documentation drift:**

- Issue: `docs/api-reference.md` title says current `2.1.1`, while `package.json` declares version `2.5.0`.
- Why: API docs were not synchronized with later release metadata.
- Impact: Operators may question whether endpoint docs match the installed package.
- Fix approach: Update API doc version and add a release-doc check before publishing.

## Known Bugs

**No confirmed active runtime bug found in this mapping pass.**

- Evidence: Existing review docs such as `docs/code-review-2026-04-29.md` report no blocking defects for the reviewed management auth/rate-limit path.
- Caveat: This was a static mapping pass, not a full test run or manual runtime exercise.

## Security Considerations

**Management API can remain open by default for backward compatibility:**

- Risk: If no `managementApiToken` is configured and `requireManagementApiToken` is not enabled, management routes allow access.
- Current mitigation: `requireManagementApiToken` and `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` can force fail-closed behavior; docs recommend configuring a token and trusted network controls.
- Recommendations: Treat token configuration as mandatory in production deployments and keep auth coverage tests in `__tests__/routes.auth-guard.test.js` and `__tests__/routes.rate-limit.test.js` updated.

**Shared-secret transport has no forward secrecy:**

- Risk: Compromise of a long-lived `secretKey` allows decryption of captured traffic encrypted with that key.
- Current mitigation: AES-256-GCM with random IVs and operational key-rotation guidance in `docs/security.md`.
- Recommendations: Rotate keys regularly and document any future online rotation or key agreement design before implementation.

**Compression-before-encryption leaks packet-size information:**

- Risk: Brotli before AES-GCM can leak limited information through ciphertext size differences.
- Current mitigation: The documented risk is considered low for maritime telemetry, and payload contents remain authenticated/encrypted.
- Recommendations: Be cautious before transmitting sensitive non-telemetry payloads over the same channel.

**Browser token handling requires operator care:**

- Risk: Management tokens stored in `localStorage` can be exposed by browser-side compromise; query tokens can leak through history/logs if explicitly enabled.
- Current mitigation: `src/webapp/utils/apiFetch.ts` disables query-token use by default and supports injected runtime token configuration.
- Recommendations: Prefer `window.__EDGE_LINK_AUTH__.token` injection or trusted network access for production UI usage.

## Performance Bottlenecks

**Synchronous option persistence for alert threshold updates:**

- Problem: `POST /monitoring/alerts` persists changes through `app.savePluginOptions` on each request.
- Evidence: `docs/code-quality-report.md` flags the path and recommends coalescing saves; route logic lives in `src/routes/monitoring.ts`.
- Cause: Alert updates are persisted immediately for durability.
- Improvement path: Debounce or coalesce alert persistence per connection, then add tests for persistence ordering and failure responses.

**Brotli, MessagePack, path dictionary, and reliable transport overhead tradeoffs:**

- Problem: Protocol v2/v3 and optional compression/encoding features improve WAN behavior but can increase CPU and memory load on constrained devices.
- Evidence: Operator guidance exists in `docs/performance-tuning.md` and benchmark reports under `docs/performance/`.
- Improvement path: Run relevant benchmark scripts under `test/benchmarks/` when changing packet size, batching, compression, or retransmit behavior.

## Fragile Areas

**Timer and socket cleanup:**

- Why fragile: `src/instance.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/bonding.ts`, and `src/sequence.ts` create timers, intervals, sockets, and listener callbacks.
- Common failures: Leaked timers after stop, duplicate socket listeners after recovery, stale pipeline workers, or cleanup order regressions.
- Safe modification: Pair every new timer/listener/resource with explicit cleanup and add tests around stop/restart/recovery.
- Test coverage: Existing tests cover many recovery paths, but `docs/code-quality-report.md` still lists lifecycle modules as coverage gaps.

**Shared schema and validation parity:**

- Why fragile: Connection fields must align across `src/shared/connection-schema.ts`, `src/connection-config.ts`, `src/types.ts`, webapp form behavior, route validation, docs, and samples.
- Common failures: UI accepts a field the backend rejects, backend stores a field the UI drops, or docs show stale ranges/defaults.
- Safe modification: Update schema, validation, types, docs, samples, and tests in the same change.
- Test coverage: `__tests__/connection-config.test.js`, `__tests__/schema-compat.test.js`, `__tests__/PluginConfigurationPanel.test.js`, and route config tests are the important guardrails.

**Generated artifact drift:**

- Why fragile: `lib/` and `public/` are ignored build outputs but are the package payload.
- Common failures: Publishing stale built output after source changes if `npm run build` is skipped.
- Safe modification: Always run `npm run build` before packaging or publishing.
- Test coverage: `.github/workflows/publish-packages.yml` runs lint, type checks, build, and tests before packing.

## Scaling Limits

**In-memory client session tracking:**

- Current capacity: Server pipeline limits client sessions globally and per source IP in `src/pipeline-v2-server.ts`.
- Limit: `MAX_CLIENT_SESSIONS` and the per-IP cap guard resource growth but also define maximum simultaneous remote session behavior.
- Symptoms at limit: Session eviction, rejected new sessions, and debug/error logs.
- Scaling path: Adjust constants carefully with DoS and memory tests if higher fan-in is needed.

**API rate limiting is process-local:**

- Current capacity: In-memory map in `src/routes.ts` tracks per-client request counts.
- Limit: It is not shared across clustered processes or multiple Signal K nodes.
- Symptoms at limit: 429 responses per local process; distributed deployments need external controls.
- Scaling path: Use reverse-proxy rate limits for production deployments that need global enforcement.

## Dependencies at Risk

**Node runtime floor vs modern dependencies:**

- Risk: `package.json` allows Node >=16 while CI publish workflow uses Node 22. Some dependencies may evolve with higher runtime expectations over time.
- Impact: Users on older Node 16 installations could see install/build/runtime incompatibilities after future dependency updates.
- Migration plan: Keep dependency updates tested on the declared minimum or raise `engines.node` deliberately with release notes.

**Frontend TypeScript strictness differs from backend:**

- Risk: `tsconfig.json` is strict for backend code, while `tsconfig.webapp.json` sets `strict: false` and `noImplicitAny: false`.
- Impact: Webapp type regressions can slip through more easily than backend type regressions.
- Migration plan: Tighten webapp strictness incrementally with focused component/util fixes.

## Missing Critical Features

**Online key rotation / key agreement:**

- Problem: `docs/security.md` states that changing `secretKey` requires coordinated restart and there is no online key rotation.
- Current workaround: Operators manually update both peers and restart during a maintenance window.
- Blocks: Seamless rotation and short-lived session keys.
- Implementation complexity: High; would need protocol design, compatibility handling, and migration docs.

**Auth telemetry counters:**

- Problem: `docs/code-review-2026-04-29.md` recommends lightweight counters for authorized/denied management requests.
- Current workaround: Debug logs record some auth decisions.
- Blocks: Easy dashboarding/alerting for unauthorized management access attempts.
- Implementation complexity: Low to medium; add counters to metrics state and surface them through metrics/Prometheus docs.

## Test Coverage Gaps

**Lifecycle and pipeline branch coverage:**

- What's not fully covered: File-level branch coverage for `src/instance.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, and `src/config-watcher.ts` is called out in `docs/code-quality-report.md`.
- Risk: Regressions in rare error/recovery paths can escape broad tests.
- Priority: High for protocol/lifecycle changes.
- Difficulty to test: Requires carefully controlled sockets, timers, filesystem watcher behavior, and packet-loss scenarios.

**Route persistence side effects:**

- What's not fully covered: Persistence throttling/coalescing behavior is not implemented for alert updates.
- Risk: A future fix could accidentally drop operator updates or persist stale thresholds.
- Priority: Medium.
- Difficulty to test: Needs fake `savePluginOptions` callbacks and timer control.

---

_Concerns audit: 2026-04-30_
_Update as risks are fixed, new edge cases are discovered, or docs drift is corrected_
