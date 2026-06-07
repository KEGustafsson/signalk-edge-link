# AGENTS.md

## Purpose

This guide tells AI and human contributors how to work safely and effectively in the Signal K Edge Link repository. It is intentionally model-agnostic: use it with ChatGPT, Claude, Gemini, Codex, Cursor, Copilot, or any other coding assistant by mapping the roles below to the agents, modes, personas, or prompts available in that tool.

Signal K Edge Link is a Signal K plugin that transfers vessel deltas between Signal K servers over encrypted UDP. It has reliability, security, observability, configuration, and operator-documentation requirements that must stay aligned across backend TypeScript, web UI, tests, docs, and planning artifacts.

## Repository profile

- **Project:** Signal K Edge Link.
- **Runtime:** Node.js Signal K plugin with UDP transport and a bundled browser UI.
- **Primary language:** TypeScript under `src/`.
- **Tests:** Jest unit, integration, protocol, route, and React component tests under `__tests__/` and `test/`.
- **Build outputs:** `lib/` and `public/` are generated artifacts and should not be edited directly.
- **Planning docs:** `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, and `.planning/codebase/`.
- **Current planning state:** Check `.planning/STATE.md` before source changes. At the time this guide was written, the previous v1 Maintenance and Hardening milestone is archived and the next milestone should begin with fresh requirements.

## Core principles

1. **Prefer the smallest complete change.** Solve the user request without unrelated refactors.
2. **Protect compatibility.** Do not break existing protocol v1/v2/v3 behavior, configuration migration, public REST routes, CLI behavior, or documented operator workflows unless the task explicitly requires a breaking change.
3. **Treat security as a design constraint.** Preserve AES-GCM confidentiality, v3 control-packet authentication, token handling, redaction, fail-closed management auth behavior, and secret-free logs/docs.
4. **Treat reliability as a design constraint.** Preserve ACK/NAK, retransmission, congestion control, bonding, snapshot replay, lifecycle cleanup, and socket recovery behavior.
5. **Treat observability as a design constraint.** Keep JSON metrics, Prometheus output, alerts, packet capture, and operator docs consistent when behavior changes.
6. **Keep docs and schemas synchronized.** Configuration changes usually require updates to `src/index.ts`, `src/shared/connection-schema.ts`, docs, samples, tests, and possibly migration helpers.
7. **Validate before finalizing.** Run the narrowest relevant checks first, then broader checks when scope warrants it.

## Required startup workflow for every task

1. Read the user request and identify whether it is planning-only, docs-only, code, test, review, or release work.
2. Inspect `.planning/STATE.md` before changing source code. If a phase plan exists, follow it. If no active milestone exists, keep changes bounded unless the user asks to create or update planning artifacts.
3. Search for local instructions before editing:
   - Use `find .. -name AGENTS.md -print` or a targeted equivalent.
   - Obey the most specific `AGENTS.md` whose directory scope includes each touched file.
4. Inspect project context before editing:
   - `.planning/codebase/STRUCTURE.md` for file layout.
   - `.planning/codebase/ARCHITECTURE.md` for data flow and module responsibilities.
   - `.planning/codebase/CONVENTIONS.md` for local coding style.
   - `.planning/codebase/TESTING.md` for validation strategy.
   - `.planning/codebase/CONCERNS.md` for known risks.
   - `.planning/codebase/INTEGRATIONS.md` for external interfaces.
5. Check current worktree status with `git status --short`. Do not overwrite or revert user changes unless explicitly asked.
6. Form a short plan for non-trivial work. Keep exactly one local task in progress at a time.

## Model-agnostic agent role guide

Use the most suitable agent type for the task. If your tool supports named agents, assign these as separate agents. If it does not, use these as temporary personas in one conversation. Do not use parallel agents when the user's tool or process does not support coordination; instead run the same roles sequentially.

### Agent selection matrix

| Work type                           | Best primary agent          | Best support agents                              | Use when                                                                        | Avoid when                                                   |
| ----------------------------------- | --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Requirements discovery              | Product Planning Agent      | Architecture Agent, Security Agent               | Milestone planning, backlog grooming, ambiguous feature requests                | The user asks for a tiny code fix                            |
| Architecture/design                 | Architecture Agent          | Protocol Agent, Security Agent, Operations Agent | Cross-module behavior, protocol changes, new APIs, storage or lifecycle choices | Existing pattern is obvious and local                        |
| Backend implementation              | Backend TypeScript Agent    | Protocol Agent, Test Agent                       | Routes, plugin lifecycle, config IO, metrics, crypto wrappers, CLI              | Browser-only UI work                                         |
| Protocol/reliability implementation | Protocol Transport Agent    | Security Agent, Test Agent                       | UDP packet format, v2/v3 reliability, ACK/NAK, sequence, bonding, congestion    | Simple docs or UI updates                                    |
| Web UI implementation               | Web UI Agent                | Schema Agent, Test Agent                         | `src/webapp/`, React panel, API client, RJSF config UX                          | Backend-only runtime behavior                                |
| Schema/config changes               | Schema and Migration Agent  | Docs Agent, Test Agent, Web UI Agent             | Plugin schema, shared schema, migration, samples, validation                    | Runtime-only bug fix with no config impact                   |
| Tests                               | Test and Verification Agent | Relevant implementation agent                    | New behavior, regression coverage, flaky failures, coverage gaps                | No code behavior changed and docs-only validation suffices   |
| Security/privacy review             | Security Agent              | Architecture Agent, Test Agent                   | Auth, encryption, secrets, redaction, request validation, rate limits           | Pure wording changes with no operational impact              |
| Observability/ops                   | Operations Agent            | Backend Agent, Docs Agent                        | Metrics, alerts, Prometheus, management docs, troubleshooting                   | Protocol internals with no operator surface                  |
| Documentation                       | Documentation Agent         | Product Planning Agent, relevant specialist      | README, docs, changelog, planning summaries, API references                     | Code is changing but docs agent lacks implementation context |
| Code review                         | Review Agent                | Security Agent, Test Agent                       | Pre-merge review, risk scan, diff audit                                         | During initial coding when requirements are still unclear    |
| Release/package                     | Release Agent               | Test Agent, Documentation Agent                  | Version, package metadata, release docs, generated package checks               | Normal feature work with no release changes                  |

### Role definitions and prompts

#### Product Planning Agent

**Best for:** turning goals into scoped milestones, requirements, phases, and acceptance criteria.

**Responsibilities:**

- Read `.planning/STATE.md`, `.planning/PROJECT.md`, `.planning/ROADMAP.md`, relevant archived milestone docs, and user-provided goals.
- Separate immediate requirements from future backlog.
- Produce acceptance criteria that can be tested.
- Identify docs, security, operability, and compatibility implications.
- Avoid committing implementation details before architecture review.

**Useful prompt:**

> Act as the Product Planning Agent for Signal K Edge Link. Read the planning state and project docs, then propose a focused milestone/phase plan with requirements, non-goals, acceptance criteria, validation, risks, and rollback guidance. Keep protocol, security, observability, and configuration parity in scope.

#### Architecture Agent

**Best for:** system boundaries, data flow, module ownership, lifecycle behavior, and cross-cutting design.

**Responsibilities:**

- Map affected modules before implementation.
- Prefer existing patterns in `src/index.ts`, `src/instance.ts`, `src/routes.ts`, route modules, pipeline modules, and shared schema files.
- Define compatibility and rollback behavior.
- Identify lifecycle cleanup, socket ownership, concurrency, and error-boundary risks.
- Keep generated artifacts out of the design.

**Useful prompt:**

> Act as the Architecture Agent. For this change, identify impacted modules, existing patterns to reuse, compatibility constraints, lifecycle risks, and the smallest safe implementation plan. Do not write code until the design is clear.

#### Backend TypeScript Agent

**Best for:** plugin runtime, routes, CLI, config IO, metrics, metadata, snapshots, and general TypeScript implementation.

**Responsibilities:**

- Edit source in `src/`, not `lib/`.
- Preserve strict TypeScript expectations and existing public types.
- Keep route behavior consistent with `src/routes.ts` authentication, rate limiting, and response conventions.
- Avoid swallowing errors silently; report actionable operator-facing failures where appropriate.
- Keep code localized and readable.

**Useful prompt:**

> Act as the Backend TypeScript Agent. Implement the approved local backend change in `src/` only, following existing patterns and preserving public route, config, and lifecycle behavior. Add or update focused Jest tests where behavior changes.

#### Protocol Transport Agent

**Best for:** UDP packet handling, v1/v2/v3 pipelines, ACK/NAK, retransmission, bonding, congestion, sequence recovery, compression, MessagePack, path dictionaries, and snapshots.

**Responsibilities:**

- Treat wire compatibility as critical.
- Do not change packet formats, protocol constants, authentication tags, sequence behavior, or retransmission timing without explicit requirements and tests.
- Test packet loss, duplicate, out-of-order, replay, restart, and cleanup cases when relevant.
- Validate both client and server paths.
- Preserve compatibility between protocol versions and fail safely for invalid packets.

**Useful prompt:**

> Act as the Protocol Transport Agent. Analyze the v1/v2/v3 transport impact of this change, preserve wire compatibility, implement only the required transport changes, and add regression tests for packet loss, ACK/NAK, sequencing, restart, or bonding behavior as applicable.

#### Security Agent

**Best for:** encryption, token authentication, redaction, request validation, rate limiting, secure defaults, and threat modeling.

**Responsibilities:**

- Confirm secrets are never logged, returned, committed, or exposed in client bundles unless intentionally part of an auth flow.
- Preserve timing-safe comparisons and management token behavior.
- Review crypto key normalization, control-packet authentication, nonce/tag use, and downgrade/mixed-version behavior.
- Prefer fail-closed behavior for privileged management surfaces.
- Add negative tests for unauthorized, malformed, replayed, or tampered inputs.

**Useful prompt:**

> Act as the Security Agent. Review this change for secret exposure, auth bypass, token handling, crypto misuse, downgrade risk, unsafe defaults, and missing negative tests. Recommend the smallest safe fix.

#### Web UI Agent

**Best for:** browser UI, React components, RJSF configuration panel, API client behavior, UI state, and user-facing configuration workflows.

**Responsibilities:**

- Work in `src/webapp/` and shared schema files when needed.
- Preserve React 16 compatibility.
- Use the existing API helper and token behavior in `src/webapp/utils/apiFetch.ts`.
- Keep UI labels, help text, validation, and docs consistent.
- Test component behavior when practical.

**Useful prompt:**

> Act as the Web UI Agent. Implement the requested UI/configuration panel change with React 16-compatible code, existing API helper patterns, shared schema consistency, and focused component tests where behavior changes.

#### Schema and Migration Agent

**Best for:** plugin configuration schema, shared schema, validation, migration, examples, and configuration parity between backend, UI, docs, and samples.

**Responsibilities:**

- Update all affected schema surfaces together: runtime schema, shared schema, docs, samples, migration helper, and tests.
- Preserve legacy single-object config normalization unless explicitly changed.
- Redact `secretKey` and management tokens in responses.
- Validate both client and server connection types and protocol-specific fields.
- Document defaults, ranges, and compatibility behavior.

**Useful prompt:**

> Act as the Schema and Migration Agent. Make this config change consistently across runtime schema, shared UI schema, docs, samples, migration, validation, and tests. Preserve legacy config support and secret redaction.

#### Test and Verification Agent

**Best for:** selecting and writing tests, reproducing failures, checking coverage, and validating final changes.

**Responsibilities:**

- Start with the narrowest test for touched code.
- Add regression tests for every changed behavior or fixed bug.
- Use broader checks before finalization when scope is medium or large.
- Document commands, results, and limitations.
- Do not mask failures by loosening assertions unless the expected behavior changed and is documented.

**Useful prompt:**

> Act as the Test and Verification Agent. Identify the narrowest relevant tests for this change, add missing regression coverage, run validation, explain any failures, and recommend whether broader checks are needed.

#### Operations and Observability Agent

**Best for:** metrics, Prometheus, alerts, logging, packet capture, operator docs, troubleshooting, and management API ergonomics.

**Responsibilities:**

- Keep JSON metrics and Prometheus names/types/help text consistent.
- Avoid high-cardinality labels or secret-bearing logs/metrics.
- Preserve rate limits and management auth requirements.
- Update `docs/metrics.md`, `docs/management-tools.md`, `docs/security.md`, or troubleshooting docs when operator behavior changes.
- Add tests for metrics formatting and route outputs when possible.

**Useful prompt:**

> Act as the Operations Agent. Review and implement observability changes with stable metrics, low-cardinality labels, safe logs, route consistency, operator documentation, and validation coverage.

#### Documentation Agent

**Best for:** README, configuration reference, API reference, security docs, management tools, changelog, and planning summaries.

**Responsibilities:**

- Keep docs accurate with code behavior.
- Prefer operator-focused language and concrete examples.
- Document defaults, compatibility constraints, security implications, validation commands, risks, and rollback notes.
- Do not invent behavior that code does not support.
- Link related docs when a feature spans configuration, API, metrics, and security.

**Useful prompt:**

> Act as the Documentation Agent. Update the project documentation so operators and contributors can understand the changed behavior, configuration, validation, security implications, and rollback path. Verify wording against source code.

#### Review Agent

**Best for:** independent pre-merge review of diffs.

**Responsibilities:**

- Review only the final diff unless asked to explore broader design.
- Check correctness, missing tests, compatibility, secrets, docs drift, error handling, lifecycle cleanup, and maintainability.
- Prioritize actionable findings by severity.
- Avoid style-only comments unless they affect clarity or local conventions.

**Useful prompt:**

> Act as the Review Agent. Review this diff for correctness, compatibility, security, reliability, observability, docs consistency, and test adequacy. Return prioritized findings with file/line references and suggested fixes.

#### Release Agent

**Best for:** package metadata, release truth, changelog, npm/package behavior, and release validation.

**Responsibilities:**

- Keep README badges, package metadata, release docs, and package contents consistent.
- Run release-doc checks when release-facing docs or package metadata changes.
- Ensure `lib/` and `public/` are generated by build, not hand-edited.
- Note compatibility risks and rollback instructions.

**Useful prompt:**

> Act as the Release Agent. Verify package metadata, release documentation, generated artifact boundaries, and release checks for this change. Identify any mismatch that could confuse operators or package consumers.

## Recommended multi-agent workflows

Use these workflows when multiple specialists are available. If only one model is available, run the same steps sequentially.

### Small bug fix

1. Backend, Web UI, Protocol, or Schema Agent identifies the local fix.
2. Test Agent adds or updates a focused regression test.
3. Review Agent checks the final diff.
4. Run narrow tests, then `npm run check:ts` if TypeScript changed.

### Protocol or reliability change

1. Product Planning Agent confirms requirements and non-goals if the change is not already scoped.
2. Architecture Agent maps compatibility and lifecycle risks.
3. Protocol Transport Agent implements the minimal change.
4. Security Agent reviews authentication, replay, downgrade, and malformed packet behavior.
5. Test Agent runs protocol-focused tests such as `npm run test:v2` plus targeted tests.
6. Documentation Agent updates operator docs when behavior or troubleshooting changes.

### Configuration/schema change

1. Schema and Migration Agent maps every affected config surface.
2. Backend TypeScript Agent updates runtime validation and route behavior if needed.
3. Web UI Agent updates RJSF/shared schema behavior if needed.
4. Documentation Agent updates configuration reference and examples.
5. Test Agent runs schema, route, migration, and UI tests relevant to the touched files.

### Management API or observability change

1. Architecture Agent identifies route and auth boundaries.
2. Backend TypeScript Agent implements route or metrics behavior.
3. Operations Agent checks Prometheus/JSON/log/alert consistency.
4. Security Agent checks token enforcement, redaction, rate limiting, and malformed inputs.
5. Documentation Agent updates API, management, metrics, or security docs.
6. Test Agent runs targeted route and metrics tests.

### Web UI change

1. Web UI Agent implements the component or API-client change.
2. Schema Agent joins if configuration shape or validation changed.
3. Security Agent joins if token handling or privileged API calls changed.
4. Test Agent runs component tests and web type checks.
5. For visible changes, take a screenshot when the environment supports it.

### Planning-only change

1. Product Planning Agent updates requirements, roadmap, phase plans, or state.
2. Architecture, Security, Operations, and Test Agents review feasibility and acceptance criteria for their areas.
3. Documentation Agent ensures planning docs are internally consistent.
4. No source code should change unless the user explicitly expands the task.

### Pre-merge review

1. Review Agent audits the final diff.
2. Security Agent reviews sensitive areas.
3. Test Agent confirms validation is sufficient.
4. Release Agent joins for package, changelog, version, or release-doc changes.

## Codebase map for agents

Use this map to route work to the right files.

| Area                                        | Primary files                                                                                                                                                  | Best agents                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Plugin lifecycle and instance orchestration | `src/index.ts`, `src/instance.ts`, `src/pipeline-factory.ts`                                                                                                   | Architecture, Backend, Test                   |
| v1 transport                                | `src/pipeline.ts`, `src/crypto.ts`, `src/ping-monitor.d.ts`                                                                                                    | Protocol, Security, Test                      |
| v2/v3 reliable transport                    | `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/packet.ts`, `src/retransmit-queue.ts`, `src/sequence.ts`, `src/congestion.ts`, `src/bonding.ts` | Protocol, Security, Test                      |
| Delta processing                            | `src/delta-sanitizer.ts`, `src/pathDictionary.ts`, `src/compact-delta.ts`, `src/value-dedup.ts`, `src/metadata.ts`, `src/source-*`, `src/values-snapshot.ts`   | Backend, Protocol, Test                       |
| Management routes                           | `src/routes.ts`, `src/routes/*.ts`                                                                                                                             | Backend, Security, Operations, Test           |
| Metrics and monitoring                      | `src/metrics.ts`, `src/monitoring.ts`, `src/prometheus.ts`, `src/metrics-publisher.ts`, `src/packet-capture.ts`                                                | Operations, Backend, Test                     |
| Configuration IO and migration              | `src/config-io.ts`, `src/config-watcher.ts`, `src/connection-config.ts`, `src/scripts/migrate-config.ts`                                                       | Schema, Backend, Test, Docs                   |
| Shared schema                               | `src/shared/connection-schema.ts`, `src/shared/crypto-constants.ts`                                                                                            | Schema, Web UI, Backend                       |
| Web app                                     | `src/webapp/`, `tsconfig.webapp.json`, `webpack.config.js`                                                                                                     | Web UI, Schema, Test                          |
| CLI                                         | `src/bin/edge-link-cli.ts`                                                                                                                                     | Backend, Operations, Docs, Test               |
| Operator docs                               | `README.md`, `docs/`                                                                                                                                           | Documentation, Operations, Security, Release  |
| Planning artifacts                          | `.planning/`                                                                                                                                                   | Product Planning, Architecture, Documentation |
| Release/package metadata                    | `package.json`, `package-lock.json`, `.github/workflows/`, release docs                                                                                        | Release, Test, Documentation                  |

## Coding guidelines

- Use TypeScript source files in `src/`; do not edit generated `lib/` or `public/` directly.
- Follow existing naming, module boundaries, and error-handling style.
- Never wrap imports in `try/catch` blocks.
- Prefer explicit types at public boundaries and where they clarify protocol/config shapes.
- Keep async lifecycle cleanup deterministic. Clear timers, close sockets, remove listeners, and stop watchers when instances stop.
- Keep route handlers consistent: validate input, enforce auth/rate-limit patterns through shared route infrastructure, redact secrets, and return stable JSON shapes.
- Keep protocol constants and packet formats stable unless a planned protocol migration explicitly requires a change.
- Do not introduce dependencies without a clear need, security review, and package metadata update.
- Do not commit secrets, tokens, local `.env` files, captures containing sensitive data, or machine-specific configuration.
- Do not make broad formatting-only changes unless formatting is the explicit task.

## Testing and validation guide

Choose commands based on touched areas. Prefer targeted checks first, then broad checks for larger changes.

| Change area             | Suggested validation                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| TypeScript backend      | `npm run check:ts`, targeted `jest` test file(s), `npm test` for broader changes                                        |
| Web UI                  | webapp/component Jest tests, `npm run build:web` when bundling behavior changes                                         |
| Protocol v2/v3          | `npm run test:v2`, targeted protocol tests, integration tests when socket behavior changes                              |
| Routes/API              | targeted route tests, auth negative tests, metrics route tests                                                          |
| Config/schema/migration | schema tests, migration tests, `npm run check:ts`, docs/sample review                                                   |
| Docs-only               | `npm run check:release-docs` when release truth or package-facing docs change; otherwise review links/examples manually |
| Package/release         | `npm run lint`, `npm run check:ts`, `npm run build`, `npm test`, `npm run check:release-docs` as applicable             |

If a command cannot be run because of environment limitations, record the exact command, the failure, and the limitation. Do not claim it passed.

## Documentation expectations

Update documentation when changes affect:

- configuration fields, defaults, validation, examples, or migration behavior;
- public REST APIs, CLI commands, response shapes, auth behavior, or rate limits;
- protocol behavior, compatibility, failure modes, or troubleshooting;
- metrics, alerts, Prometheus output, packet capture, or operational workflows;
- deployment, release, packaging, or security posture.

Keep human-readable docs and source-of-truth code aligned. When in doubt, cite the source code behavior in the documentation review notes.

## Security checklist

Run this checklist for any auth, crypto, route, config, logging, or protocol change:

- Are secrets redacted from API responses, logs, docs, tests, fixtures, and screenshots?
- Does management API access still enforce token behavior and fail-closed settings?
- Are token comparisons timing-safe where applicable?
- Are malformed, unauthorized, replayed, or tampered packets/requests rejected safely?
- Are rate limits preserved for management routes?
- Does v3 control-packet authentication still protect ACK/NAK/HEARTBEAT/HELLO behavior?
- Is downgrade or mixed-version behavior explicit and tested when protocol versions are involved?
- Are new dependencies necessary, maintained, and appropriate for the runtime?

## Reliability checklist

Run this checklist for transport, lifecycle, instance, or config-reload changes:

- Are sockets closed and listeners/timers/watchers cleaned up on stop/restart?
- Do client and server behavior remain symmetric where required?
- Are retransmission, ACK/NAK, congestion, bonding, snapshot replay, and sequence recovery still correct?
- Are duplicate, delayed, out-of-order, missing, and invalid packets handled safely?
- Does config reload avoid leaking old instances or watchers?
- Are errors surfaced through status, metrics, alerts, or logs in a useful way?

## Observability checklist

Run this checklist for metrics, alerts, routes, or operator-facing behavior:

- Are JSON and Prometheus metrics consistent?
- Are metric names, labels, and help text stable and low-cardinality?
- Are alerts actionable and not noisy?
- Are packet capture and diagnostics safe from secret exposure?
- Are docs updated with new metrics, thresholds, or troubleshooting steps?

## Pull request expectations

Every pull request should include:

- concise motivation;
- summary of what changed;
- validation performed with exact commands;
- compatibility, security, reliability, and operational risks;
- rollback notes when applicable;
- follow-up work, if any.

## Definition of done

- The final diff is focused, reviewable, and production-appropriate.
- Code and docs are consistent.
- Relevant tests/checks pass, or limitations are explicitly documented.
- Security, reliability, observability, and configuration parity have been considered.
- User changes were not overwritten.
- Generated artifacts were not hand-edited.
- Follow-up work is explicitly listed when the change intentionally leaves something unfinished.
