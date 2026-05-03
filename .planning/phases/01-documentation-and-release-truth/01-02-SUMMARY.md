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

## Accomplishments

- Added `scripts/check-release-truth.js`, a dependency-free CommonJS guard that checks version markers, stale architecture filenames, package `files`, and publish workflow build/pack ordering.
- Added `check:release-docs` to `package.json`.
- Updated `docs/README.md` current API markers to match `package.json` and linked the release checklist for contributors.
- Added `docs/release-checklist.md` with lint, type-check, webapp type-check, build, test, release-doc, and pack verification commands.
- Added the `Release documentation and package truth` CI step before packing in `.github/workflows/publish-packages.yml`.

## Files Created/Modified

- `scripts/check-release-truth.js` - Static guard for release documentation and package truth.
- `docs/release-checklist.md` - Human release verification sequence.
- `package.json` - Added `check:release-docs`.
- `.github/workflows/publish-packages.yml` - Added CI release-truth guard before packaging.
- `docs/README.md` - Updated current API markers and contributor reading order.

## Decisions Made

- `package.json` `version` is the single source of truth for release version markers.
- Package payload is verified via `package.json.files` rather than committing generated `lib/` or `public/` output.
- Workflow ordering checks stay text-based and dependency-free to avoid adding YAML parsing dependencies for this narrow guard.

## Verification Strategy

- `npm run check:release-docs` is the canonical local and CI command.
- `node scripts/check-release-truth.js` invokes the guard directly.
- Generalized version-marker regex (see `requireNoStaleVersionMarker`) flags any stale `current: x.y.z` against the live `package.json` version, so the guard does not depend on the version active at the time of plan execution.
- `npm run build && npm pack --ignore-scripts` validates the published package payload contains `lib/` and `public/`.

## Next Phase Readiness

Phase 1 can now be verified as a whole. The next project phase can build on release-truth guardrails already enforced locally and in CI.

---

_Phase: 01-documentation-and-release-truth_
