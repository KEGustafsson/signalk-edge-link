# Phase 2: Management API Hardening and Observability - Research

**Researched:** 2026-04-30
**Domain:** Brownfield management API security telemetry and alert persistence hardening
**Confidence:** HIGH

<user_constraints>

## User Constraints

Phase 2 has a captured context file. The decisions in that file are binding for planning:

- Preserve backward compatibility: management routes remain open when no token is configured and auth is not required.
- Preserve fail-closed behavior when `requireManagementApiToken` or `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` requires a token and none is configured.
- Preserve all existing token sources: `X-Edge-Link-Token`, `Authorization: Bearer <token>`, legacy `X-Management-Token`, and `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`.
- Add management auth telemetry as route-level aggregate state owned by `src/routes.ts`.
- Surface telemetry additively in JSON management responses and Prometheus output.
- Keep telemetry labels and docs low-cardinality and secret-free.
- Coalesce `POST /monitoring/alerts` persistence to at most one `app.savePluginOptions()` call per second per connection while preserving immediate in-memory updates.
- Do not introduce a new auth model, UI dashboard, distributed rate limiting, online key rotation, or transport security redesign.

</user_constraints>

<architectural_responsibility_map>

## Architectural Responsibility Map

| Capability                         | Primary Tier                 | Secondary Tier                 | Rationale                                                                                    |
| ---------------------------------- | ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Auth decision recording            | REST management layer        | Route context types            | `authorizeManagement()` is the single decision point before route handlers run.              |
| JSON auth telemetry                | Status and metrics responses | Operator docs                  | `/status` and `/metrics` already expose operational state to management clients.             |
| Prometheus auth counters           | Metrics route and formatter  | Prometheus docs/tests          | `/prometheus` is the scrape surface and must emit global counters once per scrape.           |
| Alert threshold save coalescing    | Monitoring route persistence | Fake-timer route tests         | `POST /monitoring/alerts` owns threshold mutation and currently calls `savePluginOptions()`. |
| Secret/redaction preservation      | Route responses and docs     | Existing redaction tests       | New telemetry must not expose tokens, IPs, user agents, or secret-like values.               |
| Validation and regression sampling | Jest route suites            | TypeScript/ESLint/Prettier/npm | Existing focused suites already cover auth, metrics, monitoring, and Prometheus behavior.    |

</architectural_responsibility_map>

<research_summary>

## Summary

The current code already centralizes management authorization in `src/routes.ts`, passes bounded action names through `managementAuthMiddleware(action)`, and exposes JSON and Prometheus management surfaces through existing route modules. This makes Phase 2 a small additive hardening phase rather than an auth redesign.

`docs/code-review-2026-04-29.md` recommends lightweight counters for allowed and denied management requests. The safest implementation point is the central auth decision function, because recording inside individual route handlers would miss denied requests and invite inconsistent labels.

`docs/code-quality-report.md` flags alert-threshold persistence churn. The current `POST /monitoring/alerts` path updates in-memory thresholds and persists plugin options on every request. A per-connection one-second coalescing window can keep operator responses immediate while reducing write churn. Last-write-wins within the window is acceptable as long as updates to different metrics are merged before the delayed save.

**Primary recommendation:** add route-owned auth telemetry first, expose it through JSON and Prometheus second, then coalesce alert threshold persistence with fake-timer coverage. Keep all new surfaces additive, bounded, and documented.

</research_summary>

<standard_stack>

## Standard Stack

| Tool / Pattern          | Current Use                        | Phase Use                                                                |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| TypeScript              | Strict backend source              | Add typed telemetry state, context accessors, and monitoring helpers.    |
| Jest 29                 | Route and Prometheus unit coverage | Extend focused route suites and use fake timers for save coalescing.     |
| RouteContext            | Dependency injection for routes    | Pass read-only auth telemetry snapshots to metrics routes if needed.     |
| Prometheus text helpers | Existing metric exposition         | Reuse counter/gauge formatting conventions and bounded label escaping.   |
| Prettier                | Markdown/TS formatting             | Keep code, docs, and planning artifacts consistently formatted.          |
| npm scripts             | Validation entrypoints             | Run focused Jest suites first, then lint, type checks, build, and tests. |

</standard_stack>

<architecture_patterns>

## Architecture Patterns

### Pattern: Route-Owned Auth Telemetry

```text
request
  -> rate limit
  -> authorizeManagement(req, res, action)
       -> decide allowed/denied and reason
       -> increment route-owned counter { decision, reason, action }
       -> return existing auth result and response status
  -> route handler
```

Store the aggregate in `src/routes.ts`, not in per-instance `Metrics`, because auth decisions can occur before a specific connection bundle is selected.

### Pattern: Additive JSON Exposure

Use a top-level `managementAuth` block in `/status` and `/metrics` so existing fields remain stable. Include totals and bounded per-action/per-reason counters. Do not include client identity, request path, token source, header values, IP address, or user agent.

### Pattern: Global Prometheus Counter

Emit `signalk_edge_link_management_auth_requests_total{decision,reason,action}` once per scrape. The metric belongs to the management API process, not to each connection instance, so it should be prepended or appended once around the existing per-instance Prometheus output.

### Pattern: Per-Connection Save Coalescing

```text
POST /monitoring/alerts
  -> update in-memory threshold immediately
  -> merge pending persisted thresholds for this connection
  -> schedule one save at most one second later
  -> save matching connection entry only
  -> delete pending entry after flush
```

Use fake timers in tests to prove repeated requests produce one save and persist the latest merged thresholds.

</architecture_patterns>

<dont_hand_roll>

## Don't Hand-Roll

| Problem                 | Don't Build                     | Use Instead                                       | Why                                                              |
| ----------------------- | ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Auth model              | New credentials or route policy | Existing `authorizeManagement()` behavior         | The phase is observability hardening, not auth semantics change. |
| Metrics framework       | New dependency                  | Existing JSON and Prometheus helpers              | Keeps package and runtime surface small.                         |
| Client attribution      | IP/path/user-agent labels       | Bounded `decision`, `reason`, and `action` labels | Avoids sensitive and high-cardinality telemetry.                 |
| Alert durability system | Database or background worker   | Per-connection timer coalescing                   | Matches the documented churn risk without new infrastructure.    |
| Broad route rewrite     | Replace route module structure  | Extend existing route context and focused files   | Keeps review localized and minimizes behavior risk.              |

</dont_hand_roll>

<common_pitfalls>

## Common Pitfalls

### Pitfall 1: Duplicating Global Counters Per Instance

**What goes wrong:** `/prometheus` emits the same management auth total once for every connection bundle.
**How to avoid:** Format auth counters once outside the instance loop in `src/routes/metrics.ts`.

### Pitfall 2: Accidentally Tightening Backward-Compatible Defaults

**What goes wrong:** Deployments without a management token become fail-closed even when `requireManagementApiToken` is false.
**How to avoid:** Add tests for open access, required-unconfigured 403, missing-token 401, invalid-token 401, and valid-token allowed paths.

### Pitfall 3: Leaking Sensitive Or High-Cardinality Labels

**What goes wrong:** Metrics or docs include tokens, IPs, user agents, route params, or raw paths.
**How to avoid:** Limit stored labels to `decision`, `reason`, and existing bounded action strings. Add docs/tests that inspect the exposed JSON and Prometheus text.

### Pitfall 4: Dropping Alert Threshold Updates During Coalescing

**What goes wrong:** Two quick updates to different metrics produce a saved config that contains only the last metric.
**How to avoid:** Merge pending thresholds per connection and make last-write-wins apply per metric key.

### Pitfall 5: Leaving Timers Behind

**What goes wrong:** Pending alert save timers survive test teardown or keep Node alive.
**How to avoid:** Delete pending entries after flush, clear/replace timers carefully, and call `unref()` when available.

</common_pitfalls>

<validation_architecture>

## Validation Architecture

Phase 2 validation should start with the narrow suites that cover the touched behavior:

- Auth telemetry core: `npm test -- __tests__/routes.auth-guard.test.js __tests__/routes.rate-limit.test.js`
- JSON and Prometheus metrics: `npm test -- __tests__/routes.metrics.test.js __tests__/v2/prometheus.test.js`
- Alert persistence coalescing: `npm test -- __tests__/routes.monitoring.test.js`
- Static/type checks: `npm run check:ts`, `npm run lint`, and `npx tsc -p tsconfig.webapp.json --noEmit`
- Full phase check before verification: `npm run lint && npm run check:ts && npx tsc -p tsconfig.webapp.json --noEmit && npm test`

Formatting should include touched source, tests, docs, and planning files through Prettier.

</validation_architecture>

<sources>

## Sources

### Primary

- `.planning/phases/02-management-api-hardening-and-observability/02-CONTEXT.md` - binding decisions D-01 through D-21.
- `.planning/REQUIREMENTS.md` - Phase 2 requirement IDs and acceptance signals.
- `.planning/ROADMAP.md` - Phase 2 goal and success criteria.
- `.planning/codebase/ARCHITECTURE.md` - REST management and observability boundaries.
- `.planning/codebase/CONCERNS.md` - auth telemetry and alert persistence concerns.
- `src/routes.ts`, `src/routes/types.ts`, `src/routes/metrics.ts`, `src/routes/monitoring.ts`, `src/prometheus.ts` - planned source touchpoints.
- `__tests__/routes.auth-guard.test.js`, `__tests__/routes.rate-limit.test.js`, `__tests__/routes.metrics.test.js`, `__tests__/routes.monitoring.test.js`, `__tests__/v2/prometheus.test.js` - focused validation suites.

### Secondary

- `docs/code-review-2026-04-29.md` - management auth/rate-limit review and telemetry recommendation.
- `docs/code-quality-report.md` - alert persistence coalescing recommendation.
- `docs/api-reference.md`, `docs/metrics.md`, `docs/management-tools.md`, `docs/security.md`, `docs/configuration-reference.md` - operator documentation touchpoints.

</sources>

<metadata>

## Metadata

**Research scope:** local repository only; no network research needed.
**Confidence breakdown:**

- Standard stack: HIGH - uses existing TypeScript, Jest, route context, and npm checks.
- Architecture: HIGH - management auth and monitoring persistence have clear central files.
- Pitfalls: HIGH - derived from explicit context decisions and existing codebase concerns.
- Code examples: MEDIUM - plan specifies behavior and file ownership; executor will write exact implementation.

**Research date:** 2026-04-30
**Valid until:** Stable until route auth, metrics, or monitoring persistence ownership changes.

</metadata>

---

_Phase: 02-management-api-hardening-and-observability_
_Research completed: 2026-04-30_
_Ready for planning: yes_
