# Phase 1: Documentation and Release Truth - Research

**Researched:** 2026-04-30
**Domain:** Brownfield documentation drift and npm package release verification
**Confidence:** HIGH

<user_constraints>

## User Constraints

No `CONTEXT.md` exists for this phase. The plan uses roadmap requirements, the committed codebase map, and current repository files. All implementation decisions are at the agent's discretion, with these hard boundaries from project docs:

- Preserve existing runtime behavior and protocol compatibility.
- Do not change public configuration semantics in this phase.
- Keep the work focused on documentation, release truth, and package verification.
- Do not touch secrets, local environment values, or unrelated package-lock changes.

</user_constraints>

<architectural_responsibility_map>

## Architectural Responsibility Map

| Capability                         | Primary Tier            | Secondary Tier             | Rationale                                                                                   |
| ---------------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Architecture source-name accuracy  | Documentation           | TypeScript source map      | Docs must point contributors at actual source files.                                        |
| API release-version accuracy       | Documentation           | `package.json`             | `package.json` is the release metadata source of truth.                                     |
| Release truth checking             | Node/npm tooling        | GitHub Actions             | A local script can run in both developer shells and CI without adding dependencies.         |
| Package artifact verification      | npm package workflow    | Generated `lib/`/`public/` | `npm pack` is the authoritative package-content check after build.                          |
| Validation and regression sampling | Existing npm/Jest stack | Prettier/ESLint/TypeScript | The repo already has validation commands; the phase should compose them rather than invent. |

</architectural_responsibility_map>

<research_summary>

## Summary

The codebase map identifies two concrete documentation drift issues: `docs/architecture-overview.md` points at legacy source filenames, and `docs/api-reference.md` claims the current API reference is `2.1.1` while `package.json` declares `2.5.0`. A quick repository scan also found matching stale `current: 2.1.1` references in `docs/README.md`.

The existing GitHub Packages workflow already installs dependencies, lints, type-checks backend and webapp code, builds, tests, and packs a tarball. The missing piece is a lightweight release-truth guard that fails early when docs drift from package metadata or when package artifact assumptions stop being true.

**Primary recommendation:** fix known stale docs first, then add a dependency-free Node script wired into npm and the publish workflow to enforce release documentation and package-artifact truth.

</research_summary>

<standard_stack>

## Standard Stack

| Tool                   | Current Use              | Phase Use                                                               |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Node.js                | Runtime and tooling      | Implement release-truth check with built-in `fs` and `path`.            |
| npm scripts            | Local command entrypoint | Add `check:release-docs` so developers can run the guard locally.       |
| GitHub Actions         | Publish workflow         | Run the guard before packing/publishing.                                |
| Prettier               | Markdown/JSON formatting | Keep planning and docs formatted.                                       |
| `npm pack`             | Package payload check    | Verify `lib/` and `public/` are present after `npm run build`.          |
| Existing docs/code map | Source of truth          | Use codebase map and current source files to correct architecture docs. |

</standard_stack>

<architecture_patterns>

## Architecture Patterns

### Release Truth Flow

```text
package.json version/files
  -> release-truth script reads source of truth
  -> docs/api-reference.md and docs/README.md checked for current version
  -> docs/architecture-overview.md checked for current source filenames
  -> publish workflow runs guard before npm pack
  -> npm pack verifies built lib/ and public/ package payload
```

### Pattern: Dependency-Free Guard Script

Use a small Node script under `scripts/` with clear assertion helpers. Keep checks explicit and stable:

- `package.json` version equals documented `current: X.Y.Z` markers.
- Legacy source filenames are absent from architecture docs.
- Current source filenames are present in architecture docs.
- `package.json.files` includes `lib/` and `public/`.
- Publish workflow includes build before pack.

### Pattern: Sequential Wave For Dependent Validation

The release-truth script should run after the stale docs are corrected. Put documentation corrections in Wave 1 and the release guard in Wave 2 so execution does not fail because the guard runs before the docs are fixed.

</architecture_patterns>

<dont_hand_roll>

## Don't Hand-Roll

| Problem             | Don't Build                       | Use Instead                                          | Why                                             |
| ------------------- | --------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Markdown formatting | Custom whitespace rewrites        | Prettier                                             | Already configured and used by hooks.           |
| Package inspection  | Manual tarball file parsing first | `npm pack --ignore-scripts` output and package files | Matches actual npm packaging behavior.          |
| Release metadata    | Hard-coded version strings        | Read `package.json`                                  | Prevents a second source of truth.              |
| CI enforcement      | New workflow framework            | Existing GitHub Actions publish workflow             | Keeps the release path visible and reviewable.  |
| Broad doc audit     | Rewrite all docs at once          | Target known stale references first                  | Keeps Phase 1 small and production-appropriate. |

</dont_hand_roll>

<common_pitfalls>

## Common Pitfalls

### Pitfall 1: Checking Docs Before Fixing Them

**What goes wrong:** The new release guard fails immediately during execution if it runs before the stale docs are updated.
**How to avoid:** Make the release guard plan depend on the documentation correction plan.

### Pitfall 2: Treating Historical Mentions As Drift

**What goes wrong:** A check flags legitimate historical release notes, migration notes, or troubleshooting entries that mention older versions.
**How to avoid:** Scope version checks to "current:" markers in current reference docs, not every version string in the repo.

### Pitfall 3: Creating A Fragile CI Check

**What goes wrong:** The guard depends on shell-specific behavior or network access and becomes noisy.
**How to avoid:** Use a dependency-free Node script for deterministic local and CI behavior.

### Pitfall 4: Forgetting Generated Package Artifacts

**What goes wrong:** Docs pass, but `npm pack` publishes stale or missing runtime payloads.
**How to avoid:** Keep `npm run build` before `npm pack` and verify package `files` includes `lib/` and `public/`.

</common_pitfalls>

<validation_architecture>

## Validation Architecture

Phase 1 validation should sample both static truth and package behavior:

- Fast validation: `npm run check:release-docs`.
- Formatting: `npx prettier --check docs/architecture-overview.md docs/api-reference.md docs/README.md docs/release-checklist.md scripts/check-release-truth.js package.json .github/workflows/publish-packages.yml`.
- Broader release validation: `npm run lint`, `npm run check:ts`, `npx tsc -p tsconfig.webapp.json --noEmit`, `npm run build`, `npm test`, and `npm pack --ignore-scripts`.
- Focused grep checks for legacy source filenames and stale current-version markers.

</validation_architecture>

<sources>

## Sources

### Primary

- `.planning/codebase/CONCERNS.md` - documented architecture and release-version drift.
- `.planning/REQUIREMENTS.md` - Phase 1 requirement IDs.
- `.planning/ROADMAP.md` - Phase 1 goal and success criteria.
- `package.json` - package version, scripts, package payload configuration.
- `.github/workflows/publish-packages.yml` - current publish validation and pack flow.
- `docs/architecture-overview.md`, `docs/api-reference.md`, `docs/README.md` - affected docs.

### Secondary

- `README.md` and other docs scanned for stale markers and release references.

</sources>

<metadata>

## Metadata

**Research scope:** local repository only; no network research needed.
**Confidence breakdown:**

- Standard stack: HIGH - uses existing npm, Node, GitHub Actions, and Prettier.
- Architecture: HIGH - drift items are explicitly visible in current docs.
- Pitfalls: HIGH - derived from existing workflow order and package behavior.
- Code examples: MEDIUM - plan specifies script behavior, executor will write exact code.

**Research date:** 2026-04-30
**Valid until:** Stable until package workflow, docs structure, or versioning policy changes.

</metadata>

---

_Phase: 01-documentation-and-release-truth_
_Research completed: 2026-04-30_
_Ready for planning: yes_
