# Roadmap: Signal K Edge Link

**Project:** Signal K Edge Link
**Current Planning State:** v1 Maintenance and Hardening shipped
**Updated:** 2026-05-01

## Milestones

- **Complete:** `v1-maintenance-hardening` - v1 Maintenance and Hardening, phases 1-5, shipped 2026-05-01. Archive: `.planning/milestones/v1-maintenance-hardening-ROADMAP.md`.

## Phases

<details>
<summary>v1 Maintenance and Hardening (Phases 1-5) - shipped 2026-05-01</summary>

- [x] Phase 1: Documentation and Release Truth - 2/2 plans complete.
- [x] Phase 2: Management API Hardening and Observability - 3/3 plans complete.
- [x] Phase 3: Lifecycle and Reliable Transport Coverage - 3/3 plans complete.
- [x] Phase 4: Schema, UI Type Safety, and Configuration Parity - 3/3 plans complete.
- [x] Phase 5: Security Roadmap and Future Protocol Planning - 2/2 plans complete.

Full milestone details are archived in `.planning/milestones/v1-maintenance-hardening-ROADMAP.md`.

</details>

## Progress

| Milestone                    | Phases | Plans | Status  | Completed  |
| ---------------------------- | ------ | ----- | ------- | ---------- |
| v1 Maintenance and Hardening | 1-5    | 13/13 | Shipped | 2026-05-01 |

## Backlog

### Phase 999.1: Online Key Rotation and Key Agreement Design (BACKLOG)

**Goal:** Design an opt-in future key rotation/key agreement path without changing current v1/v2/v3 behavior.
**Requirements:** FUT-SEC-001, FUT-PROTO-001
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with gsd-review-backlog when ready)

### Phase 999.2: Protocol-v4 Compatibility and Migration Plan (BACKLOG)

**Goal:** Define version-gated protocol migration, mixed-version behavior, rollback, and downgrade resistance before any major wire-format change.
**Requirements:** FUT-PROTO-001
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with gsd-review-backlog when ready)

### Phase 999.3: Distributed Management Controls Architecture (BACKLOG)

**Goal:** Evaluate external and optional in-plugin approaches for global management rate limits and auth telemetry aggregation.
**Requirements:** FUT-SCALE-001
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with gsd-review-backlog when ready)

### Phase 999.4: Metrics History Storage Architecture (BACKLOG)

**Goal:** Evaluate Prometheus-first and database-backed metrics-history options with retention, cardinality, privacy, and failure-mode boundaries.
**Requirements:** FUT-OPS-001
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with gsd-review-backlog when ready)

## Next Action

Start the next milestone with fresh requirements by running `gsd-new-milestone`.
