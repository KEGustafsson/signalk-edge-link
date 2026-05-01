# Phase 5: Security Roadmap and Future Protocol Planning - Pattern Map

**Mapped:** 2026-05-01
**Scope:** Future security/protocol docs, scaling boundaries, deferred requirement traceability, and backlog parking.

## File-to-Pattern Map

| Target File / Artifact                         | Role                             | Closest Existing Analog                                                      | Pattern to Preserve                                                                                      |
| ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `docs/future-security-and-protocol-roadmap.md` | Focused future roadmap doc       | `docs/security.md`, `docs/architecture-overview.md`                          | Describe current behavior first, then isolate future options, tradeoffs, non-goals, and design criteria. |
| `docs/security.md`                             | Current security guide           | Existing "Key rotation" and "Known limitations" sections                     | Keep current operational guidance concise; link to future planning without implying implemented support. |
| `docs/architecture-overview.md`                | Current architecture summary     | Existing "Protocol v1 vs v2/v3" section                                      | Preserve v3-as-v2-plus-authenticated-control wording and add a pointer for future protocol work.         |
| `docs/metrics.md`                              | Current metrics reference        | Existing management auth telemetry and monitoring sections                   | Explain current in-memory/process-local surfaces and link to future history/scaling planning.            |
| `docs/performance-tuning.md`                   | Operational scaling/tuning guide | Existing deployment profiles and regression checks                           | Keep runtime tuning practical; link to external controls for global enforcement or retention.            |
| `.planning/ROADMAP.md`                         | Milestone and backlog registry   | `gsd-add-backlog` 999.x convention                                           | Add `## Backlog` entries with `### Phase 999.x: Name (BACKLOG)` and matching `.gitkeep` directories.     |
| `.planning/REQUIREMENTS.md`                    | Requirement traceability         | Existing "Completed Requirement Evidence" and "Deferred Requirements" tables | Add completion evidence and deferred-to-backlog mapping without changing validated requirement wording.  |
| `.planning/phases/999.x-*/.gitkeep`            | Backlog phase placeholders       | `gsd-add-backlog` directory convention                                       | Create directories immediately so future discuss/plan commands can accumulate context.                   |

## Concrete Content Patterns

### Future Roadmap Doc Shape

```markdown
# Future Security and Protocol Roadmap

## Current Baseline

## Non-Goals for the Current Release Line

## Online Key Rotation and Key Agreement Options

## Protocol Compatibility and Migration Constraints

## Scaling Limits and External Controls

## Promotion Criteria for Future Work
```

Use explicit section names so `rg` checks can prove the expected topics exist.

### Backlog Entry Shape

```markdown
## Backlog

### Phase 999.1: Online Key Rotation and Key Agreement Design (BACKLOG)

**Goal:** Design an opt-in future key rotation/key agreement path without changing current v1/v2/v3 behavior.
**Requirements:** FUT-SEC-001, FUT-PROTO-001
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with $gsd-review-backlog when ready)
```

Use the same shape for each future candidate, varying only the phase number, title, goal, and deferred IDs.

### Requirement Evidence Shape

```markdown
| V1-PLAN-001 | 2026-05-01 | Future security/protocol roadmap and 999.x backlog candidates document key rotation, key agreement, distributed limits, and metrics-history tradeoffs. |
```

Completion evidence belongs in `Completed Requirement Evidence` only after execution creates the docs and backlog entries.

## Test Pattern Map

| Check                     | Existing Pattern                                  | Notes                                                                                 |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Release-doc truth         | `npm.cmd run check:release-docs`                  | Use after public docs are touched.                                                    |
| Static topic coverage     | `rg -n` over docs and planning files              | Require exact terms for key agreement, protocol-v4, deferred IDs, and backlog phases. |
| Placeholder/secret safety | Existing docs avoid real tokens and redacted keys | Search for token/key-like concrete values in new docs and planning edits.             |
| Formatting                | `npx.cmd prettier --check <files>`                | Keep Markdown and planning artifacts consistent with lint-staged behavior.            |

## Constraints

- Do not modify source protocol, crypto, route, or metrics code in Phase 5.
- Do not add a database, distributed cache, package dependency, or generated build artifact.
- Do not add UI dashboards or management API behavior changes.
- Do not place real tokens, real transport keys, public IPs, user agents, or environment-local values in docs.
- Do not silently mark deferred requirements as implemented; park them as backlog candidates.

## PATTERN MAPPING COMPLETE
