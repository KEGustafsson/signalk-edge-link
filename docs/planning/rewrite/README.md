# SignalK Edge Link — Rewrite Plan (Detailed)

This directory is the complete, productization rewrite plan. It is split
into focused documents (deliberately modeling the "no monolith" principle
the rewrite itself enforces). Read in order, or jump to the part you need.

| #   | Document                                                                    | What it covers                                                                   |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 00  | [overview-and-principles.md](./00-overview-and-principles.md)               | Goals, scope, the "rewrite structure / preserve core" contract, success criteria |
| 01  | [target-architecture.md](./01-target-architecture.md)                       | Layered architecture, dependency rules, lifecycle FSM, cross-cutting concerns    |
| 02  | [module-catalog.md](./02-module-catalog.md)                                 | Every target module: responsibility, public API, size budget, derives-from       |
| 03  | [frozen-conformance-spec.md](./03-frozen-conformance-spec.md)               | Wire format, crypto, constants, algorithms that MUST NOT change                  |
| 04  | [external-contracts.md](./04-external-contracts.md)                         | HTTP API, plugin schema, CLI, config files, metrics/Prometheus names, webapp     |
| 05  | [old-to-new-mapping.md](./05-old-to-new-mapping.md)                         | File-by-file migration map: reuse verbatim / reference / rewrite                 |
| 06  | [test-strategy.md](./06-test-strategy.md)                                   | Test porting, golden vectors, coverage gates, new tests                          |
| 07  | [phase-plan.md](./07-phase-plan.md)                                         | Phased execution with tasks, exit criteria, effort, sequencing                   |
| 08  | [risks-decisions-open-questions.md](./08-risks-decisions-open-questions.md) | Risk register, decisions needed, open questions                                  |

The shorter executive summary lives at
[../productization-rewrite-plan.md](../productization-rewrite-plan.md).

## How to use this plan

1. Confirm the open questions in doc 08 before writing code.
2. Stand up the conformance harness (doc 06 + doc 03) — this is the safety net.
3. Execute phase by phase (doc 07), building modules per doc 02, preserving
   the contracts in doc 03 and doc 04, following the migration map in doc 05.
4. Keep `npm run verify` (type-check + lint + test) green at every commit.
