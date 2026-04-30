---
phase: 02-management-api-hardening-and-observability
plan: "01"
subsystem: api
tags: [management-api, auth, telemetry, metrics, jest]
requires:
  - phase: 02-management-api-hardening-and-observability
    provides: Captured Phase 2 auth telemetry decisions
provides:
  - Route-owned management auth decision counters
  - Additive `managementAuth` JSON block on `/status` and `/metrics`
  - Focused auth compatibility and telemetry redaction coverage
affects: [management-api, metrics, prometheus, security-docs]
tech-stack:
  added: []
  patterns:
    - Route-level aggregate telemetry for pre-instance management decisions
    - Bounded auth decision/reason/action telemetry labels
key-files:
  created: []
  modified:
    - src/routes.ts
    - src/routes/types.ts
    - __tests__/routes.auth-guard.test.js
    - __tests__/routes.rate-limit.test.js
key-decisions:
  - "Auth telemetry is recorded centrally in `authorizeManagement()` so denied requests are counted before handlers run."
  - "The JSON exposure uses a top-level `managementAuth` block with totals, reason counts, and action counts."
  - "Management auth log lines no longer include client IP addresses, matching the Phase 2 low-cardinality/no-client-identity constraint."
patterns-established:
  - "Management auth telemetry snapshots are exposed through `getManagementAuthSnapshot()` for route modules and future Prometheus formatting."
requirements-completed:
  - V1-SEC-001
  - V1-SEC-002
  - V1-SEC-003
  - V1-OPS-002
duration: 14min
completed: 2026-04-30
---

# Phase 2 Plan 01: Management Auth Telemetry Core Summary

**Route-owned management auth counters with additive status and metrics JSON exposure**

## Performance

- **Duration:** 14 min
- **Started:** 2026-04-30T19:28:00Z
- **Completed:** 2026-04-30T19:42:32Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added route-owned auth decision telemetry in `src/routes.ts`.
- Recorded bounded `allowed`/`denied` decisions with `open_access`, `valid_token`, `missing_token`, `invalid_token`, and `token_required_unconfigured` reasons.
- Exposed a top-level `managementAuth` block in `/status` and `/metrics`.
- Added focused route tests for compatibility, fail-closed behavior, JSON telemetry shape, and no token/secret/IP/user-agent values in telemetry.

## Task Commits

1. **Task 1: Add route-owned auth decision telemetry** - `c356ed6` (feat)
2. **Task 2: Expose management auth telemetry in JSON responses** - `c356ed6` (feat)

**Plan metadata:** this summary commit

## Files Created/Modified

- `src/routes.ts` - Added telemetry state, auth decision recording, sanitized action handling, and JSON snapshot exposure.
- `src/routes/types.ts` - Added `ManagementAuthSnapshot` and route-context access for future route modules.
- `__tests__/routes.auth-guard.test.js` - Added decision counter coverage for missing, invalid, valid, and required-unconfigured auth paths.
- `__tests__/routes.rate-limit.test.js` - Added JSON telemetry assertions and redaction regression coverage.

## Decisions Made

- Used route-level aggregate state instead of per-instance metrics because auth decisions can happen before an instance is selected.
- Kept action labels restricted to existing bounded route action strings.
- Removed client IPs from management auth log lines touched by this plan to preserve the no-client-identity telemetry boundary.

## Deviations from Plan

None - plan executed exactly as written.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- Initial focused Jest command used Windows backslashes and matched no tests. Re-ran with `--runTestsByPath`.
- Two new `/metrics` assertions initially called only the final route handler and bypassed auth middleware, so no telemetry event was recorded. Updated those tests to call the route auth middleware before the final handler.

## Verification

- `npm run build:ts` passed.
- `npm test -- --runTestsByPath __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js` passed.
- `npm run check:ts` passed.
- `rg -n "open_access|valid_token|missing_token|invalid_token|token_required_unconfigured" src/routes.ts __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js` showed implementation and coverage.
- `rg -n "managementAuth" src/routes.ts src/routes/types.ts __tests__/routes.rate-limit.test.js` showed JSON exposure and tests.
- `npx prettier --check src/routes.ts src/routes/types.ts __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js` passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 02 can now format the route-owned `managementAuth` snapshot into a global Prometheus counter and document the JSON/Prometheus surfaces.

## Self-Check: PASSED

All Plan 01 acceptance criteria and verification commands passed after the test harness correction.

---

_Phase: 02-management-api-hardening-and-observability_
_Completed: 2026-04-30_
