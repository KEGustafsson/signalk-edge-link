# Project Milestones: Signal K Edge Link

## v1-maintenance-hardening: v1 Maintenance and Hardening (Shipped: 2026-05-01)

**Delivered:** A focused maintenance and hardening cycle that aligned public docs and release truth, improved management API observability, added lifecycle and reliable transport regression coverage, tightened configuration parity, and parked future security/protocol work for later design.

**Phases completed:** 1-5 (13 plans total)

**Key accomplishments:**

- Corrected documentation and release metadata drift with `check:release-docs` and publish workflow coverage.
- Added management auth telemetry across JSON and Prometheus surfaces while preserving backward-compatible auth behavior and redaction boundaries.
- Added focused lifecycle and v2/v3 reliable transport regression coverage for cleanup, ACK/NAK, retransmit, sequence recovery, duplicate handling, and metadata/source recovery.
- Tightened webapp configuration type safety and preserved schema/runtime/API/UI/docs/sample parity for `udpMetaPort`.
- Created `docs/future-security-and-protocol-roadmap.md` and parked deferred security, protocol, scaling, and metrics-history work as 999.x backlog candidates.

**Stats:**

- 117 files created or modified
- 9,856 insertions and 267 deletions in the milestone git range
- 5 phases, 13 plans, 37 planned tasks
- 2 calendar days from start to ship (2026-04-30 to 2026-05-01)

**Git range:** `5ad90e6` -> `8d780ec`

**Known deferred items at close:** 0 open artifacts found by manual fallback audit. Future work is intentionally parked under the 999.x backlog candidates.

**Archive:**

- `.planning/milestones/v1-maintenance-hardening-ROADMAP.md`
- `.planning/milestones/v1-maintenance-hardening-REQUIREMENTS.md`

**What's next:** Start the next milestone with fresh requirements and decide whether to promote any 999.x backlog candidate.

---
