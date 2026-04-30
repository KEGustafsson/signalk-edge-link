# Phase 3: Lifecycle and Reliable Transport Coverage - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 3-lifecycle-and-reliable-transport-coverage
**Areas discussed:** Coverage investment shape, Lifecycle resource cleanup, Reliable transport recovery, Metadata and source recovery, Allowed implementation movement

---

## Coverage Investment Shape

| Option                          | Description                                                                                                                    | Selected |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Targeted regression seams first | Add tests around the highest-risk lifecycle and reliable transport failure modes called out in the roadmap and quality report. | yes      |
| Broad coverage sweep            | Raise file-level branch coverage by touching many shallow paths.                                                               |          |
| Large refactor first            | Refactor the large lifecycle and pipeline modules before adding most tests.                                                    |          |

**User's choice:** Auto-selected recommended default: Targeted regression seams first.
**Notes:** Phase 3 is a coverage phase. Planning should protect meaningful failures rather than chase line counts.

---

## Lifecycle Resource Cleanup

| Option                                 | Description                                                                                              | Selected |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| Stop/recovery/watcher resource cleanup | Focus on socket recovery, pending timers, watcher recovery, subscription retry, and stop/start ordering. | yes      |
| Status-only lifecycle assertions       | Limit tests to public status shape and basic start/stop state.                                           |          |
| Manual runtime smoke tests             | Prefer manual runtime checks over deterministic Jest tests.                                              |          |

**User's choice:** Auto-selected recommended default: Stop/recovery/watcher resource cleanup.
**Notes:** Use fake timers and mocked sockets/watchers where possible.

---

## Reliable Transport Recovery

| Option                        | Description                                                                                        | Selected |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| ACK/NAK and sequence recovery | Cover ACK/NAK, retransmit, stale session, duplicate, packet reordering, and sequence-gap behavior. | yes      |
| Bonding and congestion first  | Spend the phase primarily on bonding and congestion-control tests.                                 |          |
| Packet primitive tests only   | Test only packet builder/parser primitives and avoid pipeline behavior.                            |          |

**User's choice:** Auto-selected recommended default: ACK/NAK and sequence recovery.
**Notes:** Bonding is already relatively well covered; pipeline v2 client/server files are the priority risk.

---

## Metadata and Source Recovery

| Option                                          | Description                                                                                                                           | Selected |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Cover existing metadata/source restart behavior | Add targeted tests for HELLO-triggered metadata request, stale envelope dropping, sender restart reset, and source snapshot recovery. | yes      |
| Defer all metadata/source behavior              | Leave metadata/source recovery out of Phase 3.                                                                                        |          |
| Add new protocol behavior                       | Expand the protocol with new metadata/source recovery semantics.                                                                      |          |

**User's choice:** Auto-selected recommended default: Cover existing metadata/source restart behavior.
**Notes:** Keep this to regression coverage for current behavior, not a protocol expansion.

---

## Allowed Implementation Movement

| Option                            | Description                                                                                    | Selected |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Minimal helper extraction only    | Extract small helpers or fix source only when tests reveal a bug or need a deterministic seam. | yes      |
| Tests only, no source changes     | Add tests but avoid all source edits even if behavior is hard to test or broken.               |          |
| Broad lifecycle/pipeline refactor | Rewrite the large lifecycle and pipeline modules while adding tests.                           |          |

**User's choice:** Auto-selected recommended default: Minimal helper extraction only.
**Notes:** Keep source changes behavior-preserving unless a regression test proves a real bug.

---

## the agent's Discretion

- Exact plan boundaries and test names.
- Exact helper names and local extraction points.
- Whether metadata/source recovery lives in the same plan as ACK/NAK coverage or a separate narrow plan.
- Whether a small bug fix is included when a new regression test exposes current behavior drift.

## Deferred Ideas

- Protocol redesign, online key rotation, new UI dashboards, broad performance tuning, schema work, and sweeping lifecycle/pipeline rewrites are out of scope for Phase 3.
