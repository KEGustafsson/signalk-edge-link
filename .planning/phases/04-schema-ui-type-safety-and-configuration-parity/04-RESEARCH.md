# Phase 4: Schema, UI Type Safety, and Configuration Parity - Research

**Researched:** 2026-05-01
**Domain:** Brownfield TypeScript webapp configuration UI and schema/runtime parity
**Confidence:** HIGH

<user_constraints>

## User Constraints

Phase 4 has a captured context file. The decisions in that file are binding for planning:

- Tighten the webapp incrementally, starting with the configuration UI and schema-facing helpers.
- Preserve current operator workflows, visible copy, management token behavior, add/remove flows, and save semantics.
- Keep `src/shared/connection-schema.ts` as the schema source for backend plugin schema and webapp schema generation.
- Reconcile shared schema, `ConnectionConfig`, runtime validation, routes, docs, and samples when drift is found.
- Investigate `udpMetaPort`, which is runtime-supported and documented for v1 metadata transport but absent from shared schema and `VALID_CONNECTION_KEYS`.
- Treat `managementApiToken` as secret-bearing plugin-level configuration; do not leak it through per-connection surfaces or examples.
- Use focused validation first, then the broad lint/type/build/Jest gate.

</user_constraints>

<architectural_responsibility_map>

## Architectural Responsibility Map

| Capability                      | Primary Tier                                                                                                   | Secondary Tier                                                                             | Rationale                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Webapp config type safety       | `src/webapp/components/PluginConfigurationPanel.tsx`                                                           | `tsconfig.webapp.json`, `__tests__/PluginConfigurationPanel.test.js`                       | The React panel owns RJSF form events, connection form data, transient `_id`, dirty state, and save payloads. |
| Shared schema truth             | `src/shared/connection-schema.ts`                                                                              | `src/index.ts`, `__tests__/schema-compat.test.js`                                          | Plugin schema and webapp schema already share one builder module.                                             |
| Runtime validation/sanitization | `src/connection-config.ts`                                                                                     | `src/routes/config.ts`, `src/routes/connections.ts`, `__tests__/connection-config.test.js` | Startup, plugin-config saves, and connection routes rely on the same validation/sanitization contract.        |
| Route parity                    | `src/routes/config-validation.ts`, `src/routes/connections.ts`                                                 | `__tests__/routes.config-validation.test.js`                                               | Legacy and per-connection route behavior must accept/reject the same config payloads.                         |
| Public truth                    | `docs/configuration-reference.md`, `docs/api-reference.md`, `docs/configuration-schema.json`, `samples/*.json` | `__tests__/config-docs-parity.test.js`                                                     | Operator-facing docs and examples should remain compatible with the same runtime validator.                   |

</architectural_responsibility_map>

<research_summary>

## Summary

Phase 4 should be planned as three dependent waves. First, tighten the webapp configuration panel locally: current `tsconfig.webapp.json` already passes with `--noImplicitAny true`, and the only explicit `any` inside `PluginConfigurationPanel.tsx` is the RJSF change event. The broader legacy dashboard file still has explicit `Record<string, any>` shapes, so this phase should not attempt a full strict-mode migration. Enabling `noImplicitAny` plus typing the configuration-panel event/save seams is a low-risk improvement for `V1-UI-001`.

Second, reconcile schema and runtime parity. Static scan found `udpMetaPort` is not speculative: `src/instance.ts` and `src/pipeline.ts` use it for v1 metadata transport, and docs already mention it. It should be treated as a public optional connection field with validation, sanitization, route PATCH support, and schema coverage. In contrast, `managementApiToken` is plugin-level secret configuration in `src/index.ts` and route config, not a per-connection field; keeping it in `ConnectionConfig` invites drift. The safer parity move is to remove it from per-connection typing and add tests that per-connection sanitization does not preserve it.

Third, update docs/schema artifacts and add sample parity tests. `docs/configuration-schema.json` currently omits top-level management auth fields and `udpMetaPort`. Existing samples parse as JSON, but there is no direct test that all sample connection entries pass runtime validation. A small docs/samples parity test can prevent future drift without adding new dependencies.

**Primary recommendation:** execute three plans in order: webapp type safety and UI flow coverage, schema/runtime parity, then docs/sample parity with full validation.

</research_summary>

<standard_stack>

## Standard Stack

| Tool / Pattern     | Current Use                                            | Phase Use                                                                |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| TypeScript         | Backend strict typecheck and separate webapp typecheck | Enable webapp `noImplicitAny` and keep focused config-panel types green. |
| React 16 + RJSF v5 | Plugin configuration panel                             | Type RJSF change data without replacing RJSF.                            |
| Jest 29            | Unit, route, component, and sample tests               | Add focused component/schema/config/route/docs parity coverage.          |
| Prettier           | Formatting for docs and source                         | Run on touched source, docs, tests, and planning artifacts.              |
| ESLint             | Repository-wide lint gate                              | Keep plan changes lint-clean and run in phase completion.                |

</standard_stack>

<architecture_patterns>

## Architecture Patterns

### Pattern: RJSF Event Boundary

```text
RJSF onChange event
  -> read typed `formData`
  -> preserve frontend `_id` and persistent `connectionId`
  -> rebuild defaults only when `serverType` changes
  -> skip dirty propagation for equivalent form data
```

This is the seam for typing `handleFormChange()` and testing dirty-state behavior.

### Pattern: Config Field Parity Chain

```text
ConnectionConfig type
  -> shared connection schema
  -> validateConnectionConfig()
  -> sanitizeConnectionConfig()
  -> plugin-config and connections routes
  -> docs/configuration-schema.json
  -> docs and samples
```

Any public connection field should be present, documented, validated, sanitized, and covered across this chain.

### Pattern: Optional Legacy Compatibility

```text
Legacy flat config
  -> normalized to one connection
  -> validated with the same connection validator
  -> persisted through sanitized connection array
```

Plan work must preserve flat-config compatibility and array-based config compatibility.

</architecture_patterns>

<validation_architecture>

## Validation Architecture

Focused validation should run in this order:

1. `npx.cmd tsc -p tsconfig.webapp.json --noEmit --noImplicitAny true`
2. `npm.cmd test -- --runTestsByPath __tests__/PluginConfigurationPanel.test.js __tests__/webapp.test.js`
3. `npm.cmd test -- --runTestsByPath __tests__/schema-compat.test.js __tests__/connection-config.test.js __tests__/routes.config-validation.test.js`
4. `npm.cmd test -- --runTestsByPath __tests__/config-docs-parity.test.js` if that file is created.
5. Phase completion gate: `npm.cmd run lint`, `npm.cmd run check:ts`, `npx.cmd tsc -p tsconfig.webapp.json --noEmit`, `npm.cmd run build`, and `npm.cmd test`.

Current baseline observation: `npx.cmd tsc -p tsconfig.webapp.json --noEmit` and `npx.cmd tsc -p tsconfig.webapp.json --noEmit --noImplicitAny true` both exit 0 before Phase 4 source changes.

</validation_architecture>

<risks>

## Risks

| Risk                                                                             | Mitigation                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Full webapp strict mode expands into the legacy dashboard and delays parity work | Enable `noImplicitAny` and type the config-panel seam; defer full `strict: true` unless it stays local.   |
| `udpMetaPort` exposure changes existing v1 metadata behavior                     | Add it as optional, validate only numeric port range, and preserve omission as "metadata disabled on v1". |
| Management token leaks into per-connection docs/tests                            | Treat token as top-level plugin config only and add sanitization coverage.                                |
| Docs schema drifts from runtime validator                                        | Add docs/samples parity tests that read real JSON artifacts and sample files.                             |

</risks>

<output_recommendation>

## Recommended Plan Breakdown

| Plan  | Wave | Objective                                                            |
| ----- | ---- | -------------------------------------------------------------------- |
| 04-01 | 1    | Tighten webapp configuration-panel types and UI flow coverage.       |
| 04-02 | 2    | Reconcile connection schema, runtime validation, and route parity.   |
| 04-03 | 3    | Update docs/samples/schema artifacts and run phase-level validation. |

</output_recommendation>

## RESEARCH COMPLETE
