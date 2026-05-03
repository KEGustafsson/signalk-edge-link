# AGENTS.md

## Purpose

This file provides **generic, reusable contributor guidance** for repositories maintained with AI/code agents.

## Core workflow

1. Understand the task and identify impacted files.
2. Make the smallest change that fully solves the problem.
3. Run relevant validation commands before finalizing.
4. Document what changed, how it was verified, and any known limitations.

## Change principles

- Prefer clarity over cleverness.
- Keep changes localized and easy to review.
- Avoid unrelated refactors in the same commit.
- Preserve backward compatibility unless a breaking change is intentional and documented.
- Treat security, reliability, and operability as first-class concerns.

## Validation strategy

- Run the narrowest tests for touched areas first.
- Run broader checks before merge when change scope is medium/large.
- If a full suite cannot be run, clearly state what was run and why.

## Documentation expectations

Update docs when changes affect:

- configuration,
- public APIs,
- operational behavior,
- deployment/release steps,
- troubleshooting paths.

## Pull request expectations

Each PR should include:

- concise motivation,
- what changed,
- validation performed,
- risks/rollback notes when applicable.

## Definition of done

- Code and docs are consistent.
- Relevant checks pass.
- Any follow-up work is explicitly listed.
- Final diff is focused, reviewable, and production-appropriate.

## GSD project context

- Project: Signal K Edge Link.
- Planning docs live in `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md`.
- Codebase intelligence lives in `.planning/codebase/`.
- Current milestone: see `.planning/STATE.md` for the active milestone and phase.
- Before changing source code, check the active phase in `.planning/STATE.md` and follow the phase plan once one exists.
- Preserve the project's security, reliability, observability, and configuration-parity goals when implementing phases.
