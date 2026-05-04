---
phase: 02-management-api-hardening-and-observability
plan: "02"
subsystem: observability
tags: [prometheus, management-api, auth, docs, jest]
requires:
  - phase: 02-management-api-hardening-and-observability
    provides: Route-owned `managementAuth` snapshot from Plan 01
provides:
  - Global Prometheus management auth counter
  - Formatter-level management auth Prometheus helper
  - Operator documentation for JSON and Prometheus auth telemetry
affects: [metrics, prometheus, api-docs, security-docs]
tech-stack:
  added: []
  patterns:
    - Global management API Prometheus counters emitted outside per-instance loops
    - Shared Prometheus HELP/TYPE metadata suppression through `sharedMeta`
key-files:
  created: []
  modified:
    - src/routes/metrics.ts
    - src/prometheus.ts
    - __tests__/routes.metrics.test.js
    - __tests__/v2/prometheus.test.js
    - docs/api-reference.md
    - docs/metrics.md
    - docs/management-tools.md
    - docs/security.md
key-decisions:
  - "Prometheus management auth counters are emitted once before the per-instance metric loop."
  - "The counter uses bounded `decision`, `reason`, and `action` labels."
  - "Docs explicitly separate global management API counters from per-instance transport metrics."
patterns-established:
  - "Use `formatManagementAuthPrometheusMetrics()` for future management auth Prometheus output."
requirements-completed:
  - V1-SEC-002
  - V1-SEC-003
  - V1-OPS-002
duration: 8min
completed: 2026-04-30
---

# Phase 2 Plan 02: Management Auth Prometheus Summary

**Global management auth Prometheus counter with aligned API, metrics, tools, and security docs**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-30T19:42:32Z
- **Completed:** 2026-04-30T19:50:41Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Added `formatManagementAuthPrometheusMetrics()` to format `signalk_edge_link_management_auth_requests_total`.
- Emitted management auth counters once per `/prometheus` scrape, outside the per-instance transport metric loop.
- Added route and formatter tests for allowed/denied samples, label sanitization, and no duplicate HELP/TYPE lines.
- Updated API, metrics, management tools, and security docs for `managementAuth` and Prometheus auth telemetry.

## Task Commits

1. **Task 1: Add global Prometheus auth counters** - `3da05bf` (feat)
2. **Task 2: Document management auth telemetry surfaces** - `3da05bf` (feat)

**Plan metadata:** this summary commit

## Files Created/Modified

- `src/routes/metrics.ts` - Adds the global management auth Prometheus block before per-instance metrics.
- `src/prometheus.ts` - Adds the management auth counter formatter and label sanitization.
- `__tests__/routes.metrics.test.js` - Covers multi-instance scrape behavior and no per-instance duplication.
- `__tests__/v2/prometheus.test.js` - Covers formatter output, sanitization, and shared metadata behavior.
- `docs/api-reference.md` - Documents `managementAuth` JSON and the Prometheus counter.
- `docs/metrics.md` - Adds interpretation guidance for management auth telemetry.
- `docs/management-tools.md` - Adds operator workflow guidance for auth telemetry.
- `docs/security.md` - Adds security notes for auth defaults and telemetry boundaries.

## Decisions Made

- Inferred `decision` from the bounded reason when formatting Prometheus samples because the route-owned snapshot stores reason counts by action.
- Sanitized management auth Prometheus label values separately from metric-name components so action strings can retain dots.

## Deviations from Plan

None - plan executed exactly as written.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

None.

## Verification

- `npm run build:ts` passed.
- `npm test -- --runTestsByPath __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js` passed.
- `npm run check:ts` passed.
- `rg -n "signalk_edge_link_management_auth_requests_total|management_auth_requests_total" src/routes/metrics.ts src/prometheus.ts __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js` showed implementation and tests.
- `rg -n "managementAuth|signalk_edge_link_management_auth_requests_total|token_required_unconfigured|open_access" docs/api-reference.md docs/metrics.md docs/management-tools.md docs/security.md` showed docs coverage.
- `npx prettier --check src/routes/metrics.ts src/prometheus.ts __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js docs/api-reference.md docs/metrics.md docs/management-tools.md docs/security.md` passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 03 can now focus on alert threshold persistence coalescing without needing to touch the Prometheus auth counter files.

## Self-Check: PASSED

All Plan 02 acceptance criteria and verification commands passed.

---

_Phase: 02-management-api-hardening-and-observability_
_Completed: 2026-04-30_
