# Roadmap: Signal K Edge Link

**Project:** Signal K Edge Link
**Current Planning State:** v2 Fleet Data Sharing implemented and verified; ready to archive
**Updated:** 2026-11-02

## Milestones

- **Complete:** `v1-maintenance-hardening` - v1 Maintenance and Hardening, phases 1-5, shipped 2026-05-01. Archive: `.planning/milestones/v1-maintenance-hardening-ROADMAP.md`.
- **Active:** `v2-fleet-sharing` - v2 Fleet Data Sharing, phases 6-10. Requirements: `.planning/REQUIREMENTS.md`. The milestone number is unrelated to transport protocol v2.

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

### v2 Fleet Data Sharing (Phases 6-10) - active

**Milestone goal:** Each client of one server receives the other clients' vessel data over the session it already opened, never its own vessel, with no inbound port on the vessel and no change to the uplink when the feature is off.

| Phase | Name                                       | Status   | Requirements                                                                       |
| ----- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------- |
| 6     | Fleet Sharing Protocol Design              | Complete | FLEET-PROTO-001                                                                    |
| 7     | Vessel Identity, Scope and Loop Prevention | Complete | FLEET-ID-001, FLEET-ID-002, FLEET-ID-003, FLEET-LOOP-001                           |
| 8     | Server-to-Client Fleet Transport           | Complete | FLEET-PROTO-002 to 005, FLEET-SNAP-001, FLEET-BW-001, FLEET-SEC-001, FLEET-SEC-002 |
| 9     | Fleet Configuration, UI and Observability  | Complete | FLEET-CFG-001, FLEET-CFG-002, FLEET-OPS-001, FLEET-OPS-002                         |
| 10    | Fleet Integration, Security Review, Docs   | Complete | FLEET-SEC-003, FLEET-TEST-001, FLEET-DOC-001                                       |

#### Phase 6: Fleet Sharing Protocol Design

**Goal:** Wire spec for FLEET, FLEET_ACK and FLEET_NAK, the HELLO capability and encrypted `fleetIdentity`, and accepted decisions D-01 to D-08.
**Context:** `.planning/phases/06-fleet-sharing-protocol-design/06-CONTEXT.md`
**Changes:** `docs/` and `.planning/` only.
**Success criteria:** byte layouts and tag inputs specified; every decision marked accepted or replaced; phase 7-10 plans drafted.

#### Phase 7: Vessel Identity, Scope and Loop Prevention

**Goal:** Client sends its encrypted self URN in HELLO; server keeps a per-instance fleet set; scope filter (`fleet` / `all`, `includeServerVessel`); client drops fleet-learned contexts from uplink.
**Likely files:** `src/codec/packet/builder.ts`, `src/transport/pipeline/reliable-server/receive.ts`, `reliable-server/context.ts`, `src/app/connection/process-delta.ts`.
**Success criteria:** URN absent from captured datagrams; own context never selected for its session; AIS context excluded under `fleet` scope; loop test passes with `context: "*"`.

#### Phase 8: Server-to-Client Fleet Transport

**Goal:** Server subscribes to the Signal K tree, batches and coalesces scoped deltas per session, sends FLEET with its own sequence space, retransmits on FLEET_NAK, sends a join snapshot, enforces the per-session rate limit. Client verifies, replay-checks, ACKs/NAKs, caps inbound rate and writes through `handleMessageBySource`.
**Likely files:** `src/codec/packet/{constants,builder,parser}.ts`, new `reliable-server/fleet-sender.ts`, new `reliable-client/fleet-receiver.ts`, `reliable-client/control-packets.ts`, `src/transport/reliability/*` (reuse only).
**Success criteria:** loss/duplicate/reorder/restart tests pass on the fleet direction; tamper, replay, wrong-key and wrong-epoch negative tests pass; `npm run test:v2` passes unmodified.

#### Phase 9: Fleet Configuration, UI and Observability

**Goal:** `fleetSharing` options on client and server in every config surface, validation against bonding and protocol v1, JSON and Prometheus metrics, client fleet state in status and UI.
**Likely files:** `src/index.ts`, `src/shared/connection-schema.ts`, `src/app/config/*`, `src/webapp/`, `src/domain/metrics/{registry,prometheus}.ts`, `docs/configuration-reference.md`, `docs/metrics.md`.
**Success criteria:** schema, route, UI and metrics tests pass; `npm run check:ts` passes.

#### Phase 10: Fleet Integration, Security Review and Docs

**Goal:** One hub + three clients integration test; security review against the AGENTS.md security and reliability checklists; IV budget, NAT keepalive and fleet docs.
**Success criteria:** integration test passes in CI; `npm run check:release-docs` passes; `docs/security.md`, `docs/troubleshooting.md`, `README.md` and `docs/protocol-v3-spec.md` updated.

## Progress

| Milestone                    | Phases | Plans | Status  | Completed  |
| ---------------------------- | ------ | ----- | ------- | ---------- |
| v1 Maintenance and Hardening | 1-5    | 13/13 | Shipped | 2026-05-01 |
| v2 Fleet Data Sharing        | 6-10   | -     | Active  | -          |

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

Archive `v2-fleet-sharing` (all requirements Met in `FLEET-VERIFICATION.md`); bonding support stays in FLEET-FUT-001.
