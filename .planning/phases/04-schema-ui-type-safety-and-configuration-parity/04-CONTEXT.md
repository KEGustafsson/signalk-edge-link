# Phase 4: Schema, UI Type Safety, and Configuration Parity - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 tightens the webapp configuration surface and proves that user-facing schemas, runtime validation, route behavior, docs, and samples remain aligned. The phase may make targeted TypeScript and test changes around the plugin configuration UI and shared schema helpers, but it should not redesign the configuration shape, add new operator workflows, change protocol behavior, or broaden into future security planning.

</domain>

<decisions>
## Implementation Decisions

### Webapp Type Safety Tightening

- **D-01:** Use an incremental tightening strategy. Start with the configuration UI and schema-facing helpers instead of enabling full webapp `strict` mode in one step.
- **D-02:** Remove or localize avoidable `any` usage in `src/webapp/components/PluginConfigurationPanel.tsx`, especially around RJSF form change data, connection form data, and save payload construction.
- **D-03:** `tsconfig.webapp.json` may become stricter only when the planner confirms the blast radius is small. `noImplicitAny: true` is a reasonable target if focused source updates keep the webapp typecheck passing; full `strict: true` is optional, not required.
- **D-04:** Preserve current operator workflows and UI behavior. Type-safety work should not alter field labels, save semantics, dirty-state behavior, management token behavior, or add/remove connection flows except to fix documented parity drift.

### Schema and Runtime Validation Parity

- **D-05:** Keep `src/shared/connection-schema.ts` as the shared schema source for backend plugin schema and webapp schema generation.
- **D-06:** Runtime validation in `src/connection-config.ts`, `src/routes/config-validation.ts`, route tests, docs, and samples must be checked against `ConnectionConfig` and the shared schema. If drift exists, resolve it with tests that pin the intended public configuration contract.
- **D-07:** Investigate the static-scan mismatch around `udpMetaPort`: it appears in `ConnectionConfig` but not in the shared connection schema or `VALID_CONNECTION_KEYS`. Planning should decide whether this is an intentional internal/non-public field or a missed operator-facing config field, then align schema, validation, docs, and tests accordingly.
- **D-08:** Do not introduce unrelated configuration fields. If a field is added or exposed for parity, update docs, samples, schema compatibility tests, and validation tests in the same plan.
- **D-09:** Preserve secret handling. Management tokens and transport secrets must not leak into docs examples, logs, telemetry labels, or saved connection payloads beyond existing intended behavior.

### UI Configuration Flow Coverage

- **D-10:** Strengthen existing component tests rather than replacing RJSF or rewriting the panel. Keep the current RJSF mock style unless a narrow test requires a more realistic event shape.
- **D-11:** Add focused coverage for server/client schema variants, protocol-version-dependent fields, default extraction, duplicate server-port warnings, dirty-state behavior, and save payload parity.
- **D-12:** Prefer importing or exercising project schema helpers where practical. Avoid tests that reimplement production helper logic unless the production helper is intentionally private and the test clearly documents the behavior under test.

### Documentation and Sample Parity

- **D-13:** Treat docs and samples as parity targets. Update `docs/configuration-reference.md`, `docs/api-reference.md`, `docs/configuration-schema.json`, and JSON samples only when source truth changes or drift is found.
- **D-14:** Keep sample files minimal and operator-realistic. Do not add artificial fields to every sample purely to maximize coverage.

### Validation Expectations

- **D-15:** Validate with focused checks first: webapp typecheck, schema compatibility tests, connection config tests, route validation tests, and plugin configuration panel tests.
- **D-16:** Phase completion should run the standard broad gate when implementation is complete: `npm.cmd run lint`, `npm.cmd run check:ts`, `npx.cmd tsc -p tsconfig.webapp.json --noEmit`, `npm.cmd run build`, and `npm.cmd test`.
- **D-17:** Use `npm.cmd`/`npx.cmd` on Windows PowerShell to avoid script execution policy issues.

### the agent's Discretion

- Exact plan count and wave boundaries are flexible, but likely plans are: UI type-safety tightening, schema/runtime parity fixes, and docs/sample/test parity verification.
- The planner may combine docs/sample updates with the parity plan if the drift is small.
- The planner may leave full webapp strict mode deferred if targeted type gaps are closed and the remaining strict-mode failures are broad or unrelated.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope

- `.planning/PROJECT.md` - Product context, compatibility constraints, and milestone direction.
- `.planning/REQUIREMENTS.md` - Phase 4 requirement IDs `V1-UI-001` and `V1-UI-002`.
- `.planning/ROADMAP.md` - Phase 4 goal, likely work, and success criteria.
- `.planning/STATE.md` - Current workflow state after Phase 4 context gathering.

### Prior Phase Context

- `.planning/phases/02-management-api-hardening-and-observability/02-CONTEXT.md` - Management API compatibility, telemetry, secret redaction, and docs constraints.
- `.planning/phases/03-lifecycle-and-reliable-transport-coverage/03-CONTEXT.md` - Phase 3 deferral of schema/config parity to Phase 4 and standard validation gate expectations.

### Codebase Maps

- `.planning/codebase/CONVENTIONS.md` - Local coding, testing, and validation conventions.
- `.planning/codebase/STRUCTURE.md` - Repository layout and source/test/doc organization.
- `.planning/codebase/STACK.md` - TypeScript, React, Jest, RJSF, and build tooling context.
- `.planning/codebase/CONCERNS.md` - Existing quality concerns and drift risks.

### Schema, Config, and Runtime Source

- `tsconfig.webapp.json` - Current webapp TypeScript settings: `strict: false`, `noImplicitAny: false`, `strictNullChecks: true`.
- `src/shared/connection-schema.ts` - Shared backend/webapp connection schema builders and defaults.
- `src/connection-config.ts` - Runtime connection validation, sanitization, and allowed-key handling.
- `src/types.ts` - `ConnectionConfig`, congestion control config, and shared type comments.
- `src/index.ts` - Plugin schema exposure and plugin config wiring.
- `src/routes/config-validation.ts` - Validation route behavior for legacy and per-connection config payloads.
- `src/routes/config.ts` - Runtime config route behavior and persistence.
- `src/routes/connections.ts` - Connection management route behavior.

### Webapp Source and Tests

- `src/webapp/components/PluginConfigurationPanel.tsx` - Main configuration UI, schema generation, defaults, dirty state, duplicate-port warnings, and save payload construction.
- `src/webapp/utils/apiFetch.ts` - Webapp API fetch helper used by configuration screens.
- `__tests__/PluginConfigurationPanel.test.js` - Existing component coverage for load, add/remove, validation warning, save payload, token behavior, and dirty state.
- `__tests__/webapp.test.js` - Existing webapp helper behavior and schema default extraction coverage.
- `__tests__/schema-compat.test.js` - Shared schema compatibility coverage.
- `__tests__/connection-config.test.js` - Runtime connection config validation/sanitization coverage.
- `__tests__/routes.config-validation.test.js` - Management route validation parity coverage.
- `__tests__/config.test.js` - Plugin config behavior coverage.

### Public Docs and Samples

- `docs/configuration-reference.md` - Operator-facing configuration reference.
- `docs/api-reference.md` - Management API operator-facing reference.
- `docs/configuration-schema.json` - Published configuration schema artifact.
- `samples/minimal-config.json` - Minimal operator config sample.
- `samples/development.json` - Development config sample.
- `samples/v2-with-bonding.json` - Protocol v2/bonding sample.
- `samples/v3-authenticated-control.json` - Protocol v3 authenticated control sample.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `buildConnectionItemSchema()` and `buildWebappConnectionSchema()` in `src/shared/connection-schema.ts` already centralize most connection schema shape and default behavior.
- `validateConnectionConfig()` and `sanitizeConnectionConfig()` in `src/connection-config.ts` provide the runtime parity point for schema fields and saved config payloads.
- `PluginConfigurationPanel.tsx` already computes schema defaults via RJSF helpers, preserves transient `_id` values locally, strips `_id` on save, supports management token behavior, and warns on duplicate server ports.
- Existing route validation tests cover legacy object config, connection-array config, subscription metadata, sentence filters, and delta timer validation.

### Established Patterns

- Component tests mock RJSF and assert panel state through rendered controls and save payloads.
- Runtime config tests prefer direct validation/sanitization calls with precise accepted/rejected payload assertions.
- Route tests create small fake apps and assert HTTP status plus response body shape.
- Schema compatibility tests compare generated schema behavior rather than relying only on snapshots.
- Documentation and samples are updated only when operator-visible behavior changes.

### Integration Points

- The backend plugin schema, webapp form schema, runtime validation, and docs all meet around connection fields such as `mode`, `enabled`, `protocolVersion`, `host`, `port`, `serverPort`, `sourceId`, `sharedKey`, congestion settings, heartbeat/retry settings, and metadata/source replication settings.
- The UI save path converts local connection form data into persisted `connections[]` payloads; tests should continue proving transient `_id` values are not persisted.
- The management API validation route is the runtime-facing proof point for payload acceptance and rejection.
- Sample JSON files are operator-facing examples and should stay compatible with the same schema and validation rules.

</code_context>

<specifics>
## Specific Ideas

- `[auto] Webapp type safety tightening` - Selected incremental type tightening around the configuration UI and schema helpers over a full strict-mode migration.
- `[auto] Schema/runtime parity` - Selected shared schema plus runtime validation reconciliation, with `udpMetaPort` called out for explicit investigation.
- `[auto] UI configuration flow coverage` - Selected focused component and helper tests for schema variants, defaults, dirty state, duplicate warnings, and save payload parity.
- `[auto] Docs and sample parity` - Selected docs/samples as validation targets, updated only when source truth changes or drift is confirmed.
- `[auto] Validation strategy` - Selected focused webapp/schema/config/route tests first, then broad lint/typecheck/build/Jest gates at completion.

</specifics>

<deferred>
## Deferred Ideas

- Full webapp `strict: true` remains optional and should be deferred if it expands beyond the Phase 4 configuration surface.
- New dashboards, new operator workflows, and broad UI redesign are out of scope.
- Protocol redesign, online key rotation, distributed rate limits, and future security planning remain Phase 5 or later work.
- Broad refactors of configuration persistence, route architecture, or the shared schema model are out of scope unless a small refactor is required to remove real drift safely.

</deferred>

---

_Phase: 04-schema-ui-type-safety-and-configuration-parity_
_Context gathered: 2026-05-01_
