# Code Review — 2026-04-29

## Scope

Manual review focused on management API authentication and request throttling logic in:

- `src/routes.ts`

## Summary

No blocking correctness or security defects were identified in the reviewed code path.

## Positive findings

1. **Token comparison uses timing-safe primitives.**
   `safeTokenEquals` hashes both values and compares digests with `crypto.timingSafeEqual`, avoiding straightforward timing side-channel leaks from string comparison.

2. **Authentication behavior is explicitly fail-closed when required.**
   If `requireManagementApiToken` (or env equivalent) is enabled without a configured token, requests are denied with `403` and operator guidance.

3. **Rate-limiting window logic is timestamp-based.**
   The limiter checks `now >= resetTime` per client key and does not rely solely on periodic cleanup cadence, preventing boundary burst bypasses.

## Non-blocking recommendations

1. **Harden client identity selection for rate limiting.**
   Current keying can depend on `req.ip`, which may be unstable or proxy-dependent unless upstream trust-proxy settings are explicit. Consider documenting required reverse-proxy settings and/or supporting a configurable key strategy.

2. **Consider lightweight auth telemetry counters.**
   Exposing counters for authorized/denied management requests (e.g., in existing metrics endpoints) would improve operational visibility and incident response.

## Validation

Validation commands and execution status are tracked in the corresponding PR description and CI job logs for this review cycle.
