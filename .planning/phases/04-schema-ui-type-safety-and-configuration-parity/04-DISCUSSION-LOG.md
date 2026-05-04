# Phase 4: Schema, UI Type Safety, and Configuration Parity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Phase:** 4-schema-ui-type-safety-and-configuration-parity
**Areas discussed:** Webapp type safety tightening, Schema and runtime validation parity, UI configuration flow coverage, Documentation and sample parity, Validation strategy

---

## Webapp Type Safety Tightening

| Option                          | Description                                                                                         | Selected |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------- |
| Incremental config-surface pass | Tighten types around the configuration panel, RJSF events, schema helpers, and save payloads first. | yes      |
| Full strict-mode migration      | Turn on full webapp `strict` mode and fix every resulting issue in the phase.                       |          |
| Leave tsconfig unchanged        | Add tests only and avoid type-safety work.                                                          |          |

**Selected:** Incremental config-surface pass — the phase should close meaningful type gaps without turning a focused parity phase into a broad frontend migration.

---

## Schema and Runtime Validation Parity

| Option                         | Description                                                                                                     | Selected |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------- |
| Reconcile schema and validator | Compare shared schema, `ConnectionConfig`, runtime validation, routes, docs, and samples; fix drift with tests. | yes      |
| Schema-only update             | Update only generated schema and leave runtime validation/docs untouched.                                       |          |
| Validator-only update          | Update only runtime validation and leave UI/schema/docs untouched.                                              |          |

**Selected:** Reconcile schema and validator — static scan found `udpMetaPort` in `ConnectionConfig` but not in shared schema or allowed runtime keys, so planning should make that contract explicit.

---

## UI Configuration Flow Coverage

| Option                         | Description                                                                                                    | Selected |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------- |
| Focused component/helper tests | Extend existing tests for schema variants, defaults, dirty state, duplicate warnings, and save payload parity. | yes      |
| Replace RJSF in tests          | Move to a more complete form-rendering setup before adding coverage.                                           |          |
| Manual UI verification only    | Rely on manual browser checks for config flow behavior.                                                        |          |

**Selected:** Focused component/helper tests — existing RJSF mocks are good enough for panel behavior; deeper form rendering is not needed unless a selected assertion requires it.

---

## Documentation and Sample Parity

| Option                               | Description                                                                                                   | Selected |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------- |
| Treat docs/samples as parity targets | Check and update operator docs, schema artifact, and samples when source truth changes or drift is confirmed. | yes      |
| Rewrite all config docs              | Broadly rewrite configuration docs regardless of detected drift.                                              |          |
| Skip docs unless tests fail          | Leave docs and samples untouched unless automated tests directly fail.                                        |          |

**Selected:** Treat docs/samples as parity targets — samples should stay realistic; not every field needs to appear in every sample.

---

## Validation Strategy

| Option                  | Description                                                                                                               | Selected |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| Focused then broad gate | Run focused webapp/schema/config/route tests first, then lint, backend typecheck, webapp typecheck, build, and full Jest. | yes      |
| Broad gate only         | Run the full suite after all changes, without focused feedback loops.                                                     |          |
| Typecheck only          | Treat Phase 4 as type-only and skip behavior tests.                                                                       |          |

**Selected:** Focused then broad gate — run focused webapp/schema/config/route tests first, then the full lint/typecheck/build/Jest gate.

---

## the agent's Discretion

- Exact plan boundaries and wave count.
- Whether `noImplicitAny: true` is enabled in this phase or replaced by narrower local type fixes.
- Whether docs/sample updates are grouped with schema parity work or split into their own plan.
- Whether `udpMetaPort` is exposed, documented, or explicitly treated as non-public after investigation.

## Deferred Ideas

- Full webapp strict-mode migration if it expands beyond the configuration surface.
- New UI dashboards, new operator workflows, protocol redesign, future security planning, and broad route/config refactors.
