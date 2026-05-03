# Phase 2: Management API Hardening and Observability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Phase:** 02-management-api-hardening-and-observability  
**Areas discussed:** Management auth behavior, Auth telemetry counters, Metrics and Prometheus surfaces, Alert threshold persistence, Documentation and tests

---

## Management Auth Behavior

| Option                       | Description                                                            | Selected |
| ---------------------------- | ---------------------------------------------------------------------- | -------- |
| Preserve compatibility       | Keep fail-open default unless token requirement is explicitly enabled. | yes      |
| Force fail-closed by default | Require tokens for all management routes.                              |          |
| Redesign auth model          | Introduce a new auth/session/API-key model.                            |          |

**Selected:** Preserve compatibility — recommended because Phase 2 is a hardening and observability phase, not a breaking security-policy phase.

---

## Auth Telemetry Counters

| Option                         | Description                                                              | Selected |
| ------------------------------ | ------------------------------------------------------------------------ | -------- |
| Route-owned aggregate counters | Count decisions centrally where auth happens, before instance selection. | yes      |
| Per-instance counters only     | Attach auth counters to each runtime connection's `Metrics`.             |          |
| Log-only telemetry             | Keep auth visibility in debug/error logs only.                           |          |

**Selected:** Route-owned aggregate counters — recommended because `/status`, `/metrics`, and `/prometheus` auth decisions do not naturally belong to one connection instance.

---

## Metrics and Prometheus Surfaces

| Option                                        | Description                                                               | Selected |
| --------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| Additive JSON plus global Prometheus counters | Add JSON management auth blocks and one global Prometheus counter family. | yes      |
| JSON only                                     | Expose counters only through `/status` or `/metrics`.                     |          |
| Prometheus only                               | Expose counters only through `/prometheus`.                               |          |

**Selected:** Additive JSON plus global Prometheus counters — recommended because the requirement allows metrics or Prometheus, while operators benefit from both without breaking existing response fields.

---

## Alert Threshold Persistence

| Option                                        | Description                                                         | Selected |
| --------------------------------------------- | ------------------------------------------------------------------- | -------- |
| Coalesce saves once per second per connection | Preserve immediate API response while reducing disk churn.          | yes      |
| Keep synchronous save on every request        | Avoid behavior change but leave the documented churn concern open.  |          |
| Delay all threshold updates until persisted   | Stronger durability feedback but changes operator-visible behavior. |          |

**Selected:** Coalesce saves once per second per connection — recommended because `docs/code-quality-report.md` calls this out directly as low-impact, low-effort hardening.

---

## Documentation and Tests

| Option                              | Description                                                   | Selected |
| ----------------------------------- | ------------------------------------------------------------- | -------- |
| Focused route/Prometheus/docs tests | Extend existing focused suites and docs for changed surfaces. | yes      |
| Broad integration-only validation   | Rely mainly on full Jest integration coverage.                |          |
| Docs-only update                    | Document intent without adding focused tests.                 |          |

**Selected:** Focused route/Prometheus/docs tests — recommended because this phase changes management API surfaces and needs narrow, reviewable regression coverage.

---

## the agent's Discretion

- Exact helper names and internal type names.
- Exact JSON property name for auth telemetry, provided it is additive and documented.
- Exact test-file split, provided existing focused route and Prometheus tests cover the behavior.

## Deferred Ideas

- Online key rotation or key agreement.
- Distributed or cluster-wide API rate limiting.
- New UI dashboards for auth telemetry.
- Changing the default management API behavior from fail-open to fail-closed.
