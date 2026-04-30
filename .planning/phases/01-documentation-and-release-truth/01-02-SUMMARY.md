---
phase: 01-documentation-and-release-truth
plan: "02"
subsystem: docs-release
tags: [documentation, release-checks, ci, packaging]

requires:
  - phase: 01-documentation-and-release-truth
    plan: "01"
    provides: Corrected documentation truth for release guard enforcement
provides:
  - Dependency-free release documentation/package truth guard
  - CI publish workflow release-truth check before packing
  - Human-readable release checklist
affects: [docs, release-checks, ci, package-metadata]

tech-stack:
  added: []
  patterns:
    - Static release-truth validation uses Node built-ins only
    - package.json remains the release version source of truth
    - CI and human release docs run the same npm script

key-files:
  created:
    - scripts/check-release-truth.js
    - docs/release-checklist.md
  modified:
    - package.json
    - .github/workflows/publish-packages.yml
    - docs/README.md

key-decisions:
  - "Kept the release guard narrow to current-version markers, known stale architecture source names, package files, and publish build/pack ordering."
  - "Placed the CI guard after test execution and before package-name rewriting and tarball packing."
  - "Documented the release sequence with the same command used by CI."

patterns-established:
  - "Release documentation drift checks should be executable locally and reused by CI."
  - "Package payload checks should verify generated artifact directories without committing generated output."

requirements-completed:
  - V1-DOC-001
  - V1-DOC-002
  - V1-REL-001

duration: 22 min
completed: 2026-04-30
---

# Phase 1 Plan 02: Release Truth Guard Summary

**Release documentation and package metadata now have a local and CI-enforced drift guard.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-04-30T18:56:00+03:00
- **Completed:** 2026-04-30T19:18:00+03:00
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 3

## Accomplishments

- Added `scripts/check-release-truth.js`, a dependency-free CommonJS guard that checks version markers, stale architecture filenames, package `files`, and publish workflow build/pack ordering.
- Added `check:release-docs` to `package.json`.
- Updated `docs/README.md` current API markers from `2.1.1` to `2.5.0` and linked the release checklist for contributors.
- Added `docs/release-checklist.md` with lint, type-check, webapp type-check, build, test, release-doc, and pack verification commands.
- Added the `Release documentation and package truth` CI step before packing in `.github/workflows/publish-packages.yml`.

## Task Commits

Each task was committed in the plan execution commit:

1. **Task 1: Add dependency-free release truth check** - `31a2244`
2. **Task 2: Document and wire release verification** - `31a2244`

**Plan metadata:** pending in the summary commit.

## Files Created/Modified

- `scripts/check-release-truth.js` - Static guard for release documentation and package truth.
- `docs/release-checklist.md` - Human release verification sequence.
- `package.json` - Added `check:release-docs`.
- `.github/workflows/publish-packages.yml` - Added CI release-truth guard before packaging.
- `docs/README.md` - Updated current API markers and contributor reading order.

## Decisions Made

- Used `package.json` version `2.5.0` as the only version source of truth.
- Checked package payload configuration through `package.json.files` instead of committing generated `lib/` or `public/` output.
- Kept workflow ordering checks text-based and dependency-free to avoid adding YAML parsing dependencies for this narrow guard.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

- Prettier required mechanical formatting on the new script, `package.json`, and the workflow. Formatting was applied before validation and commit.

## Verification

- `npm run check:release-docs` passed.
- `node scripts/check-release-truth.js` passed.
- `rg -n "current: 2\\.1\\.1" docs/README.md docs/api-reference.md` returned no matches.
- `rg -n "bonding-manager|congestion-control|alert-manager|sequence-tracker" docs/architecture-overview.md` returned no matches.
- `npx prettier --check scripts/check-release-truth.js package.json .github/workflows/publish-packages.yml docs/README.md docs/release-checklist.md` passed.
- `npx eslint scripts/check-release-truth.js` passed.
- `npm run build` passed with the existing webpack asset-size warning for the vendor chunk.
- `npm pack --ignore-scripts` produced `signalk-edge-link-2.5.0.tgz` with `lib/` and `public/` contents.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 1 can now be verified as a whole. The next project phase can build on release-truth guardrails already enforced locally and in CI.

---

_Phase: 01-documentation-and-release-truth_
_Completed: 2026-04-30_
