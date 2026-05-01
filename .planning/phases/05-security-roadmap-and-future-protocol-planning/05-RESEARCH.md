# Phase 5: Security Roadmap and Future Protocol Planning - Research

**Researched:** 2026-05-01
**Domain:** Brownfield future security, protocol migration, and scaling roadmap planning
**Confidence:** HIGH

<user_constraints>

## User Constraints

Phase 5 has a captured context file. The decisions in that file are binding for planning:

- Produce documentation and planning artifacts, not implementation changes.
- Compare future online key rotation and key agreement options without changing current wire protocols.
- Preserve current v1/v2/v3 protocol behavior and explicit version pinning.
- Document compatibility, migration, rollback, and mixed-version behavior required before any future protocol change.
- Document current process-local scaling limits and recommend external controls for global enforcement or retention.
- Park follow-up candidates explicitly with deferred requirement IDs.
- Keep all examples secret-safe and placeholder-only.

</user_constraints>

<architectural_responsibility_map>

## Architectural Responsibility Map

| Capability                         | Primary Artifact                                                     | Supporting Artifacts                                                                | Rationale                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Future security roadmap            | `docs/future-security-and-protocol-roadmap.md`                       | `docs/security.md`, `docs/architecture-overview.md`                                 | A focused public doc gives operators and future implementers a durable place to find tradeoffs.        |
| Key rotation/key agreement options | `docs/future-security-and-protocol-roadmap.md`                       | `src/crypto.ts`, `src/packet.ts`, `docs/security.md`                                | Current crypto helpers show the present shared-secret boundary that future designs must move beyond.   |
| Protocol compatibility constraints | `docs/future-security-and-protocol-roadmap.md`                       | `src/packet.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`           | Version pinning and v3 authenticated control behavior define the migration contract to preserve.       |
| Scaling and retention boundaries   | `docs/future-security-and-protocol-roadmap.md`                       | `src/routes.ts`, `src/constants.ts`, `src/pipeline-v2-server.ts`, `docs/metrics.md` | Current rate limits, sessions, telemetry, and metrics are process-local by design.                     |
| Follow-up parking                  | `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `999.x` folders | `.planning/phases/05-security-roadmap-and-future-protocol-planning/05-CONTEXT.md`   | GSD backlog convention uses 999.x roadmap entries and matching phase directories for future promotion. |
| Validation                         | `05-VALIDATION.md` and plan verification commands                    | `package.json`, `scripts/check-release-truth.js`, docs/static `rg` checks, Prettier | A docs/planning phase needs reference, coverage, and formatting checks rather than runtime tests.      |

</architectural_responsibility_map>

<research_summary>

## Summary

Phase 5 should be planned as two dependent documentation/planning plans.

First, create one focused future roadmap doc under `docs/`. The document should capture the current security and scaling baseline, then compare future online key rotation and key agreement options. It should explicitly separate operational key rotation, dual-key grace windows, PSK ratchets, authenticated ephemeral key agreement, and a future protocol-version handshake. The document should not recommend a quick implementation. It should instead specify design criteria: replay protection, downgrade resistance, peer authentication, failure behavior, observability, operator rollout steps, rollback behavior, and mixed-version behavior.

Second, park future work as GSD backlog candidates. The repository has no existing backlog section, but the GSD backlog convention uses `999.x` roadmap entries plus matching `.planning/phases/999.x-slug/.gitkeep` directories. Four separable candidates map cleanly to the deferred requirements: key rotation/key agreement design, protocol-v4 compatibility and migration, distributed management controls, and metrics history storage architecture.

External reference check: future protocol design should consult primary protocol specifications rather than inventing a handshake from scratch. RFC 8446 (TLS 1.3) is relevant for key update, HKDF-based key schedules, downgrade protection, and the limits of PSK-only forward secrecy. The Noise Protocol Framework is relevant as a compact way to reason about authenticated Diffie-Hellman handshake patterns and PSK modifiers. These are references for a future design phase, not dependencies for Phase 5 execution.

**Primary recommendation:** execute two plans in order: public future security/protocol roadmap documentation, then backlog/requirements parking and validation.

</research_summary>

<standard_stack>

## Standard Stack

| Tool / Pattern                   | Current Use                              | Phase Use                                                                 |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Markdown docs                    | Operator and contributor documentation   | Add focused future roadmap and link it from existing docs.                |
| GSD roadmap/backlog              | Phase sequencing and future work parking | Add 999.x backlog entries with matching `.gitkeep` phase directories.     |
| Requirements table               | Active/deferred requirement tracking     | Map `V1-PLAN-001` completion and deferred IDs to future backlog entries.  |
| `rg`                             | Fast static verification                 | Prove required strings and deferred IDs appear in docs/planning surfaces. |
| `npm.cmd run check:release-docs` | Release/doc truth guard                  | Catch stale current-version/package references after doc edits.           |
| Prettier                         | Markdown/JSON formatting                 | Format/check planning and docs artifacts.                                 |

</standard_stack>

<architecture_patterns>

## Architecture Patterns

### Pattern: Focused Public Design Note

```text
docs/security.md
  -> links to future roadmap for non-current behavior
docs/architecture-overview.md
  -> links to future roadmap for protocol migration constraints
docs/future-security-and-protocol-roadmap.md
  -> captures options, tradeoffs, non-goals, and promotion criteria
```

Keep current-behavior docs concise; place future protocol details in the new roadmap doc so they do not blur current operator instructions.

### Pattern: GSD Backlog Parking

```text
.planning/ROADMAP.md
  -> ## Backlog
  -> ### Phase 999.x: Name (BACKLOG)
.planning/phases/999.x-slug/.gitkeep
  -> directory exists for future context accumulation
```

Use sparse 999.x numbering and keep backlog items unsequenced. Promotion is handled later by `$gsd-review-backlog`.

### Pattern: Deferred Requirement Traceability

```text
FUT-SEC-001
  -> docs/future-security-and-protocol-roadmap.md
  -> Phase 999.1 backlog candidate
V1-PLAN-001
  -> completed evidence after roadmap/backlog artifacts exist
```

Every deferred concern should have a visible doc section and a future planning hook.

</architecture_patterns>

<validation_architecture>

## Validation Architecture

Focused validation should run in this order:

1. `rg -n "Online key rotation|key agreement|dual-key grace|PSK ratchet|authenticated ephemeral|protocol-v4|downgrade resistance|mixed-version" docs/future-security-and-protocol-roadmap.md`
2. `rg -n "FUT-SEC-001|FUT-OPS-001|FUT-SCALE-001|FUT-PROTO-001|999.1|999.2|999.3|999.4" docs/future-security-and-protocol-roadmap.md .planning/ROADMAP.md .planning/REQUIREMENTS.md`
3. `rg -n "future-security-and-protocol-roadmap.md" docs/security.md docs/architecture-overview.md docs/metrics.md docs/performance-tuning.md`
4. `npm.cmd run check:release-docs`
5. `npx.cmd prettier --check docs/future-security-and-protocol-roadmap.md docs/security.md docs/architecture-overview.md docs/metrics.md docs/performance-tuning.md .planning/ROADMAP.md .planning/REQUIREMENTS.md`

Full lint/type/build/Jest gates are not required for this documentation-only phase unless execution changes source, generated schemas, tests, package metadata, or build-affecting files.

</validation_architecture>

<risks>

## Risks

| Risk                                                                | Mitigation                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Future roadmap reads like current behavior                          | Label the new doc as future planning and keep current operator docs limited to current features plus links.     |
| Key agreement guidance becomes shallow or unsafe                    | Require future design criteria and reference primary protocol specs instead of prescribing an ad hoc handshake. |
| Backlog items are too broad to promote later                        | Split candidates by risk area: key agreement, protocol migration, distributed controls, and metrics history.    |
| Docs leak concrete secrets or deployment identifiers                | Use placeholders only and run static searches for token/key-like examples during execution.                     |
| Planning marks `V1-PLAN-001` complete without covering deferred IDs | Gate completion on `FUT-SEC-001`, `FUT-OPS-001`, `FUT-SCALE-001`, and `FUT-PROTO-001` appearing in docs/plans.  |

</risks>

<output_recommendation>

## Recommended Plan Breakdown

| Plan  | Wave | Objective                                                                    |
| ----- | ---- | ---------------------------------------------------------------------------- |
| 05-01 | 1    | Create and link future security/protocol roadmap documentation.              |
| 05-02 | 2    | Add backlog candidates, update requirement traceability, and run validation. |

</output_recommendation>

## RESEARCH COMPLETE

External references used:

- RFC 8446, The Transport Layer Security Protocol Version 1.3: https://www.rfc-editor.org/rfc/rfc8446
- The Noise Protocol Framework, Revision 34: https://noiseprotocol.org/noise.html
