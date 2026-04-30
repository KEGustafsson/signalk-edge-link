# Requirements

**Project:** Signal K Edge Link
**Initialized:** 2026-04-30
**Scope:** First GSD maintenance and hardening milestone

## Requirement States

- **Validated:** Existing product behavior observed in the codebase map.
- **Active:** Work selected for the first GSD milestone.
- **Deferred:** Real requirements, but intentionally outside the first milestone.

## Validated Existing Requirements

| ID      | Requirement                                                                                                                          | Evidence                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| VAL-001 | The plugin must support multiple isolated client/server connections in one Signal K plugin process.                                  | `.planning/codebase/ARCHITECTURE.md` |
| VAL-002 | Each connection must own its runtime resources, including sockets, timers, watchers, metrics, monitoring, and pipeline state.        | `.planning/codebase/ARCHITECTURE.md` |
| VAL-003 | The transport must support encrypted UDP payload delivery.                                                                           | `.planning/codebase/ARCHITECTURE.md` |
| VAL-004 | Reliable UDP modes must support sequencing, ACK/NAK handling, retransmit queues, and recovery behavior.                              | `.planning/codebase/ARCHITECTURE.md` |
| VAL-005 | Protocol v3 control packets must be authenticated.                                                                                   | `.planning/codebase/ARCHITECTURE.md` |
| VAL-006 | Configuration must stay schema-driven across backend validation, UI, REST routes, docs, and samples.                                 | `.planning/codebase/CONCERNS.md`     |
| VAL-007 | Management APIs must expose status, configuration, runtime operations, metrics, monitoring, Prometheus, and packet capture surfaces. | `.planning/codebase/ARCHITECTURE.md` |
| VAL-008 | Operators must be able to manage the plugin through the Signal K UI and CLI.                                                         | `.planning/codebase/ARCHITECTURE.md` |
| VAL-009 | Release packaging must include current `lib/` and `public/` build outputs.                                                           | `.planning/codebase/STACK.md`        |

## Active Milestone Requirements

| ID          | Requirement                                                                                                                       | Acceptance Signal                                                                                                                 | Phase |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----- |
| V1-DOC-001  | Correct stale architecture and API documentation references so docs match current code and package metadata.                      | Docs no longer reference known legacy file names or stale package version claims.                                                 | 1     |
| V1-DOC-002  | Add a lightweight release documentation check or checklist that catches version and package-truth drift before publishing.        | Release workflow or documented release checklist includes doc/package consistency verification.                                   | 1     |
| V1-REL-001  | Preserve package artifact correctness by making build/pack verification explicit for release-affecting work.                      | Phase validation proves `lib/` and `public/` are regenerated before pack/publish.                                                 | 1     |
| V1-SEC-001  | Keep management token fail-closed behavior documented and covered without breaking backward-compatible defaults.                  | Token-required and token-optional paths have docs and focused tests.                                                              | 2     |
| V1-SEC-002  | Add observable management auth counters for allowed and denied requests.                                                          | Metrics or Prometheus output exposes auth decision counters with tests.                                                           | 2     |
| V1-SEC-003  | Preserve token and secret redaction across management responses, logs, docs, and tests.                                           | Secret-like values are not exposed by changed routes or docs.                                                                     | 2     |
| V1-OPS-001  | Reduce alert threshold persistence churn while preserving operator updates.                                                       | Alert persistence is coalesced or otherwise protected, with ordering and failure tests.                                           | 2     |
| V1-OPS-002  | Keep operational metrics, monitoring, and Prometheus docs aligned with implemented fields.                                        | Docs and tests reflect any metric or monitoring surface changes.                                                                  | 2     |
| V1-TEST-001 | Add focused lifecycle coverage around socket recovery, timer cleanup, watcher cleanup, and stop/start ordering.                   | Tests exercise high-risk lifecycle branches before related refactors.                                                             | 3     |
| V1-TEST-002 | Add focused v2/v3 reliable transport coverage for ACK/NAK, retransmit, stale session, metadata/source recovery, and gap handling. | Tests cover selected reliable transport edge cases and pass under Jest.                                                           | 3     |
| V1-UI-001   | Tighten webapp TypeScript safety incrementally without changing the operator workflow.                                            | `tsconfig.webapp.json` or targeted webapp types become stricter with component tests passing.                                     | 4     |
| V1-UI-002   | Preserve schema/config parity across shared schema, backend validation, REST routes, UI, docs, and samples.                       | Any config field change updates all required surfaces and compatibility tests.                                                    | 4     |
| V1-PLAN-001 | Capture larger security and scaling work as explicit future protocol or architecture decisions.                                   | Future work such as key rotation, online key agreement, and distributed limits is documented with tradeoffs and scope boundaries. | 5     |

## Completed Requirement Evidence

| ID         | Completed  | Evidence                                                                                                                        |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| V1-DOC-001 | 2026-04-30 | `docs/architecture-overview.md` and `docs/api-reference.md` corrected; `npm run check:release-docs` enforces current truth.     |
| V1-DOC-002 | 2026-04-30 | `scripts/check-release-truth.js`, `check:release-docs`, `docs/release-checklist.md`, and publish workflow CI guard added.       |
| V1-REL-001 | 2026-04-30 | `npm run build` and `npm pack --ignore-scripts` passed; package payload includes generated `lib/` and `public/` artifact trees. |

## Deferred Requirements

| ID            | Requirement                                      | Reason Deferred                                                                                       |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| FUT-SEC-001   | Online key rotation or key agreement.            | Requires protocol design, compatibility handling, and migration docs.                                 |
| FUT-OPS-001   | Database-backed metrics or history.              | Not needed for the first maintenance milestone and would add a new persistence surface.               |
| FUT-SCALE-001 | Cluster-wide rate-limit state inside the plugin. | Current process-local rate limiting is acceptable with reverse-proxy controls for larger deployments. |
| FUT-PROTO-001 | Major protocol redesign.                         | Needs a dedicated design phase separate from maintenance hardening.                                   |

## Coverage Check

All active milestone requirements are assigned to one roadmap phase:

- Phase 1: V1-DOC-001, V1-DOC-002, V1-REL-001
- Phase 2: V1-SEC-001, V1-SEC-002, V1-SEC-003, V1-OPS-001, V1-OPS-002
- Phase 3: V1-TEST-001, V1-TEST-002
- Phase 4: V1-UI-001, V1-UI-002
- Phase 5: V1-PLAN-001
