# Research Summary

**Date:** 2026-04-30
**Method:** Local brownfield analysis using the committed codebase map

## Recommendation

Initialize GSD around a maintenance and hardening milestone for the existing Signal K Edge Link product.

The first milestone should focus on:

- Documentation and release truth.
- Management API hardening and security observability.
- Lifecycle and reliable transport regression coverage.
- Schema, UI, and configuration parity.
- Future protocol/security planning for larger deferred work.

## Why This Direction

The codebase already has substantial functionality. The highest value next step is to reduce operator confusion, release risk, and regression risk around the parts that are already operationally important.

## Non-Goals For Now

- Redesigning the protocol.
- Adding online key agreement.
- Adding database-backed history.
- Building a separate management application.
- Changing backward-compatible management API defaults without an explicit migration plan.
