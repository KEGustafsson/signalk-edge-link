# CLAUDE.md

## Purpose

This file is a **general Claude/AI-agent playbook** designed to be reused across projects.

## Working model

- Start with intent: restate the problem in concrete terms.
- Map impact: identify files, tests, and docs likely to change.
- Execute incrementally: small edits, frequent checks.
- Finish with evidence: report commands run and observed outcomes.

## Engineering guardrails

1. Make minimal, high-signal changes.
2. Avoid hidden behavior changes.
3. Preserve existing interfaces unless explicitly migrating.
4. Keep security controls intact (auth, secrets handling, input validation).
5. Keep operational visibility intact (logs/metrics/errors).

## Generic command checklist

Use the repository's equivalent commands for:

- install dependencies,
- build/compile,
- static checks (types/lint),
- unit tests,
- integration/end-to-end tests.

## Test-selection matrix (generic)

- Small local change:
  - run targeted tests for touched module(s).
- Behavior change across boundaries:
  - run targeted + related integration tests.
- Cross-cutting/refactor/release prep:
  - run full static checks and full test suite.

## Risk and release checklist

Before merge/release:

- confirm no accidental breaking changes,
- confirm docs/config examples are still accurate,
- confirm observability/error paths still make sense,
- call out any residual risk or deferred follow-up.

## Final response template

When reporting completion, include:

- summary of changes,
- exact validation commands,
- pass/fail status,
- known limitations or environment constraints.
