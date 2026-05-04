---
phase: 04-schema-ui-type-safety-and-configuration-parity
plan: "04-02"
subsystem: config
tags: [schema, validation, routes, typescript, jest]

requires:
  - phase: 04-schema-ui-type-safety-and-configuration-parity
    provides: 04-01 webapp type-safety baseline
provides:
  - shared schema exposure for udpMetaPort
  - runtime validation and sanitization parity for udpMetaPort
  - per-connection route update parity for udpMetaPort
  - per-connection managementApiToken removal from ConnectionConfig
affects: [phase-04, configuration-schema, runtime-validation, management-routes]

tech-stack:
  added: []
  patterns:
    - shared schema fields added through commonConnectionProperties
    - route parity tests exercise src route handlers directly

key-files:
  created:
    - .planning/phases/04-schema-ui-type-safety-and-configuration-parity/04-02-SUMMARY.md
  modified:
    - src/shared/connection-schema.ts
    - src/connection-config.ts
    - src/types.ts
    - src/routes/connections.ts
    - __tests__/schema-compat.test.js
    - __tests__/connection-config.test.js
    - __tests__/routes.config-validation.test.js

key-decisions:
  - "Implemented udpMetaPort as an optional public connection field; omission remains valid for all protocols."
  - "Kept managementApiToken typed only at the plugin-level _currentOptions surface."
  - "Moved focused route/config tests to src imports so they validate the edited TypeScript source rather than stale lib output."

patterns-established:
  - "Public connection fields must be represented in shared schema, VALID_CONNECTION_KEYS, runtime validation, sanitizer coverage, and per-instance route allowlists."
  - "Route tests that validate source-level TypeScript edits should import src route modules."

requirements-completed: [V1-UI-002]

duration: 20min
completed: 2026-05-01
---

# Plan 04-02: Schema and Runtime Configuration Parity Summary

**udpMetaPort is now a schema-visible, validated, sanitized, and route-updatable public connection field**

## Performance

- **Duration:** 20 min
- **Started:** 2026-05-01T17:20:00+03:00
- **Completed:** 2026-05-01T17:39:59+03:00
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added optional `udpMetaPort` to the shared connection schema with the v1 metadata port label and 1024-65535 bounds.
- Added runtime validation and sanitizer preservation for `udpMetaPort`, including invalid-port coverage and omitted-field compatibility.
- Removed `managementApiToken` from per-connection `ConnectionConfig` while keeping plugin-level `_currentOptions.managementApiToken`.
- Added route coverage for legacy `/plugin-config` saves and `/instances/:id` PATCH behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose udp metadata port schema** - `0aea994` (feat)
2. **Task 2: Validate udp metadata port config** - `9f9061c` (feat)
3. **Task 3: Cover udp metadata port routes** - `51dcf1e` (test)

**Plan metadata:** `edefede` (docs: create phase plan)

## Files Created/Modified

- `src/shared/connection-schema.ts` - Adds optional `udpMetaPort` to the shared public schema.
- `src/connection-config.ts` - Allows, validates, and sanitizes `udpMetaPort`.
- `src/types.ts` - Removes per-connection `managementApiToken` while retaining plugin-level token typing.
- `src/routes/connections.ts` - Allows `udpMetaPort` in `/instances/:id` updates.
- `__tests__/schema-compat.test.js` - Verifies backend and webapp schema builders expose `udpMetaPort`.
- `__tests__/connection-config.test.js` - Verifies validation, sanitization preservation, and token dropping.
- `__tests__/routes.config-validation.test.js` - Verifies plugin-config and per-connection route acceptance/rejection.

## Decisions Made

- `udpMetaPort` remains optional and is validated only when present, so existing v2/v3 and non-metadata configs continue to pass.
- Focused tests now import `src` modules where they are meant to validate source edits; this avoids false failures from stale `lib` output during no-emit validation.

## Deviations from Plan

None - plan executed as written.

## Issues Encountered

- The first `connection-config` test run used `../lib/connection-config` and therefore exercised stale compiled output. The test was switched to `../src/connection-config`, matching the source-level phase plan, and then passed.
- `rg -n "managementApiToken\\?: string" src/types.ts` still finds the plugin-level `PluginRef._currentOptions` field. That is expected; `ConnectionConfig` no longer declares the token.

## Verification

- `npm.cmd test -- --runTestsByPath __tests__/schema-compat.test.js __tests__/connection-config.test.js __tests__/routes.config-validation.test.js` passed: 3 suites, 112 tests.
- `npm.cmd run check:ts` passed.
- `rg -n "udpMetaPort|v1 Metadata UDP Port" src/shared/connection-schema.ts src/connection-config.ts src/routes/connections.ts __tests__/schema-compat.test.js __tests__/connection-config.test.js __tests__/routes.config-validation.test.js` found implementation and tests.
- `rg -n "managementApiToken\\?: string" src/types.ts` found only plugin-level `_currentOptions.managementApiToken`.
- `npx.cmd prettier --check src/shared/connection-schema.ts src/connection-config.ts src/types.ts src/routes/config.ts src/routes/connections.ts __tests__/schema-compat.test.js __tests__/connection-config.test.js __tests__/routes.config-validation.test.js` passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 04-03 can update public docs and samples against a code contract where `udpMetaPort` is schema-visible, runtime-validated, and route-updatable.

---

_Phase: 04-schema-ui-type-safety-and-configuration-parity_
_Completed: 2026-05-01_
