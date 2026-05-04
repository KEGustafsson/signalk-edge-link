# Phase 2: Management API Hardening and Observability - Context

<domain>
## Phase Boundary

Phase 2 improves management API security signals and alert-threshold persistence behavior while preserving existing management API defaults, route shapes, token conventions, and operator workflows. It does not introduce a new authentication model, a new UI surface, distributed rate limiting, or transport-protocol security changes.

</domain>

<decisions>
## Implementation Decisions

### Management Auth Behavior

- **D-01:** Preserve current backward compatibility: if no `managementApiToken` is configured and `requireManagementApiToken` is not enabled, management routes remain open.
- **D-02:** Preserve current fail-closed behavior: if `requireManagementApiToken` or `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` requires auth and no token is configured, requests are denied with the existing `403` guidance response.
- **D-03:** Preserve all accepted token sources: `X-Edge-Link-Token`, `Authorization: Bearer <token>`, legacy `X-Management-Token`, and `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`.
- **D-04:** Do not change route authorization requirements or make previously open-by-default deployments fail closed in this phase.

### Auth Telemetry Counters

- **D-05:** Add management auth telemetry as route-level aggregate state owned by `src/routes.ts`, because auth decisions happen before a specific runtime instance is necessarily selected.
- **D-06:** Count every management auth decision as allowed or denied, with low-cardinality reasons such as `open_access`, `valid_token`, `missing_token`, `invalid_token`, and `token_required_unconfigured`.
- **D-07:** Track counters by the bounded action strings already passed to `authorizeManagement(req, res, action)`, such as `status.read`, `metrics.read`, and `instances.list`.
- **D-08:** Do not include IP addresses, tokens, user agents, request paths with parameters, or other high-cardinality/sensitive values in metric labels, JSON fields, logs, or docs.
- **D-09:** Rate-limit `429` events may remain covered by the existing rate-limit tests and responses. They are not required to be part of the auth decision counters unless planning finds a very small additive path.

### Metrics and Prometheus Surfaces

- **D-10:** Surface management auth telemetry additively in JSON management responses without removing or renaming existing fields. Preferred JSON locations are a top-level `managementAuth` or `managementApi` block in `/status` and `/metrics`.
- **D-11:** Surface Prometheus auth counters once per scrape as global management API counters, not duplicated for every connection instance.
- **D-12:** Use Prometheus counter names that are clearly management-scoped, for example `signalk_edge_link_management_auth_requests_total`, with bounded labels for `decision`, `reason`, and `action`.
- **D-13:** Keep existing per-instance transport metrics untouched unless a small type update is needed so TypeScript accepts the new additive response shape.

### Alert Threshold Persistence

- **D-14:** Coalesce `POST /monitoring/alerts` persistence to at most one `app.savePluginOptions()` call per second per connection, matching the recommendation in `docs/code-quality-report.md`.
- **D-15:** Preserve immediate in-memory threshold updates and response shape so operators see the new threshold in the API response immediately.
- **D-16:** Use last-write-wins behavior inside the coalescing window, preserving updates to different metrics in the same connection.
- **D-17:** Keep persistence scoped to the matching connection entry; do not reintroduce root-level `alertThresholds` drift.
- **D-18:** On persistence failure, keep the existing safe behavior of logging through `app.error` without exposing secrets. Planning may add a low-risk observable error counter if it fits naturally, but it is not required.

### Documentation and Tests

- **D-19:** Update docs whenever new counters or coalesced persistence behavior are exposed: `docs/api-reference.md`, `docs/metrics.md`, `docs/management-tools.md`, and `docs/security.md` are the primary docs to check.
- **D-20:** Add focused tests around management auth counters, Prometheus output, no-secret telemetry labels, fail-open/fail-closed compatibility, and alert persistence coalescing with fake timers.
- **D-21:** Keep validation narrow first (`routes.auth-guard`, `routes.rate-limit`, `routes.metrics`, `routes.monitoring`, `v2/prometheus`) and run the broader lint/type/test checks before phase completion.

### the agent's Discretion

- Exact helper names, internal object shape, and file split are flexible as long as the counters remain route-owned, additive, low-cardinality, and covered by tests.
- Exact JSON property name may be `managementAuth` or `managementApi`; prefer the name that fits existing response style once implementation code is inspected.
- Exact test file placement is flexible; prefer extending existing route and Prometheus suites over creating broad new integration tests.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope

- `.planning/PROJECT.md` - Milestone direction, compatibility constraints, and security boundaries.
- `.planning/REQUIREMENTS.md` - Phase 2 requirement IDs and acceptance signals.
- `.planning/ROADMAP.md` - Phase 2 goal, likely work, and success criteria.
- `.planning/STATE.md` - Current workflow state after Phase 1 completion.

### Codebase Maps

- `.planning/codebase/ARCHITECTURE.md` - REST management layer, observability layer, and route context boundaries.
- `.planning/codebase/INTEGRATIONS.md` - Management REST consumers, auth header conventions, Prometheus, and docs touchpoints.
- `.planning/codebase/STACK.md` - Node/TypeScript/Jest/npm stack and runtime constraints.
- `.planning/codebase/CONCERNS.md` - Auth telemetry and alert persistence concerns that Phase 2 addresses.

### Source and Tests

- `src/routes.ts` - Central management auth, rate limiting, shared route context, `/status`, and full metrics response assembly.
- `src/routes/types.ts` - Route context and structural request/response types.
- `src/routes/metrics.ts` - `/metrics`, `/network-metrics`, `/prometheus`, and `/sources` route wiring.
- `src/routes/monitoring.ts` - `GET/POST /monitoring/alerts` and alert threshold persistence path.
- `src/metrics.ts` - Existing metrics state pattern and reset behavior.
- `src/prometheus.ts` - Prometheus text exposition helpers and metric naming conventions.
- `src/types.ts` - `Metrics`, `MetricsApi`, `PluginRef`, and related shared types.
- `__tests__/routes.auth-guard.test.js` - Regression tests for auth guard stop behavior and fail-open/fail-closed compatibility.
- `__tests__/routes.rate-limit.test.js` - Route, auth, redaction, rate-limit, and alert-persistence coverage.
- `__tests__/routes.metrics.test.js` - Focused metrics-route branch tests.
- `__tests__/routes.monitoring.test.js` - Focused monitoring-route branch tests.
- `__tests__/v2/prometheus.test.js` - Prometheus output and validation tests.

### Operator Documentation

- `docs/code-review-2026-04-29.md` - Existing management auth/rate-limit review and auth telemetry recommendation.
- `docs/code-quality-report.md` - Alert persistence coalescing recommendation.
- `docs/api-reference.md` - API response fields, auth notes, and Prometheus endpoint docs.
- `docs/metrics.md` - Runtime metric interpretation and exported surface summary.
- `docs/management-tools.md` - CLI/API management workflows and token usage guidance.
- `docs/security.md` - Management API hardening guidance and token handling.
- `docs/configuration-reference.md` - Existing alert threshold configuration notes.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `authorizeManagement(req, res, action)` in `src/routes.ts`: central place to record allowed/denied management auth decisions.
- `managementAuthMiddleware(action)` in `src/routes.ts`: already provides bounded action strings for route-specific telemetry.
- `buildFullMetricsResponse(bundle)` in `src/routes.ts`: existing JSON metrics assembly point that can receive additive management telemetry.
- `formatPrometheusMetrics()` helpers in `src/prometheus.ts`: established counter/gauge formatting, label escaping, and metric metadata patterns.
- `persistAlertThresholds()` and `POST /monitoring/alerts` in `src/routes/monitoring.ts`: current persistence behavior to coalesce.
- Existing route test harnesses: router collectors and mock responses already make focused branch tests cheap.

### Established Patterns

- Routes use dependency injection through `RouteContext`, keeping route modules testable without Express runtime dependencies.
- Management route auth is centralized and action-labeled; route modules should continue to use `managementAuthMiddleware`.
- Sensitive values are redacted in response config and should never be surfaced in telemetry.
- Metrics additions should be additive and preserve existing JSON fields and Prometheus naming style.
- Tests are primarily Jest unit/route harness tests, with broader integration suites reserved for transport behavior.

### Integration Points

- Add route-owned telemetry state in `src/routes.ts`, then pass read-only access through `RouteContext` if route modules need to expose it.
- Add JSON telemetry to `/status` and `/metrics`; add Prometheus telemetry to `/prometheus` once per scrape.
- Add or extend shared types in `src/types.ts` and `src/routes/types.ts` as needed to keep backend TypeScript strict.
- Update docs that describe management auth, metrics, Prometheus, and alert threshold persistence.

</code_context>

<specifics>
## Specific Ideas

- Auto-selected default: prioritize operator visibility without changing security posture. The phase should make existing auth behavior more observable, not stricter by default.
- Auto-selected default: use one-second per-connection alert persistence coalescing because `docs/code-quality-report.md` explicitly recommends that bound.
- Auto-selected default: avoid labels that identify clients. Operators can correlate client/IP detail from reverse proxy or Signal K logs; plugin metrics should remain bounded and secret-free.

</specifics>

<deferred>
## Deferred Ideas

- Online key rotation or key agreement remains deferred to the future protocol/security design phase.
- Distributed or cluster-wide API rate limiting remains deferred; production deployments should continue using reverse-proxy controls.
- New UI dashboards for auth telemetry are out of scope for Phase 2 unless implementation discovers an existing low-risk text-only display path.
- Changing the default management API behavior from fail-open to fail-closed is out of scope for this compatibility-focused phase.

</deferred>

---

_Phase: 02-management-api-hardening-and-observability_  
_Context gathered: 2026-04-30_
