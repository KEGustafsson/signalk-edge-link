# Phase 5: Security Roadmap and Future Protocol Planning - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 05-security-roadmap-and-future-protocol-planning
**Areas discussed:** Roadmap deliverable shape, Key rotation and key agreement, Protocol compatibility, Scaling limits, Follow-up parking, Validation strategy

---

## Roadmap Deliverable Shape

| Option                           | Description                                                                                          | Selected |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Documentation-first roadmap      | Add or update concise docs that capture options, tradeoffs, boundaries, and follow-up candidates.    | yes      |
| Begin implementation immediately | Start coding online rotation, key agreement, metrics history, or distributed controls in this phase. |          |
| Planning-only internal notes     | Keep all findings only under `.planning/` without operator/contributor-facing documentation.         |          |

**User's choice:** Auto-selected recommended default: Documentation-first roadmap.
**Notes:** Phase 5 exists to stop future security and scaling work from leaking into maintenance phases without design.

---

## Key Rotation and Key Agreement

| Option                               | Description                                                                                              | Selected |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------- |
| Compare options without implementing | Document offline rotation, dual-key grace, PSK ratchet, authenticated ephemeral exchange, and v4 design. | yes      |
| Add dual-key rotation now            | Allow current peers to accept old and new pre-shared keys during a transition window.                    |          |
| Add online key agreement now         | Implement a new handshake and session-key derivation in the current protocols.                           |          |

**User's choice:** Auto-selected recommended default: Compare options without implementing.
**Notes:** Current transport security relies on pre-shared keys, AES-GCM payload auth, and v3 HMAC control auth. Forward secrecy needs protocol design, not a small config tweak.

---

## Protocol Compatibility

| Option                           | Description                                                                                          | Selected |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Explicit version-gated migration | Require new behavior to be additive or new-version gated, opt-in, documented, and clear on rollback. | yes      |
| Silent negotiation and fallback  | Let peers try new behavior and automatically fall back without explicit operator configuration.      |          |
| Break compatibility in place     | Change existing v2/v3 behavior directly and require all deployments to upgrade at once.              |          |

**User's choice:** Auto-selected recommended default: Explicit version-gated migration.
**Notes:** Existing protocol-version pinning and mismatch failures are safer than permissive fallback for security-sensitive changes.

---

## Scaling Limits

| Option                              | Description                                                                                               | Selected |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| Document boundaries and externalize | Clarify in-process limits and recommend reverse proxies, firewalls/VPNs, Prometheus, and log aggregation. | yes      |
| Add distributed stores now          | Introduce Redis/database-backed state for rate limits, auth telemetry, or metrics history.                |          |
| Ignore scaling concerns             | Leave process-local limits undocumented because single-process deployments work today.                    |          |

**User's choice:** Auto-selected recommended default: Document boundaries and externalize.
**Notes:** The plugin has no database dependency today, and global enforcement needs architecture decisions around ownership, privacy, retention, and failure modes.

---

## Follow-Up Parking

| Option                         | Description                                                                                   | Selected |
| ------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| Explicit backlog candidates    | Map future work to deferred requirement IDs and park next-milestone candidates for promotion. | yes      |
| Fold everything into one phase | Treat all future security, protocol, and scaling concerns as one large implementation phase.  |          |
| Leave as informal notes        | Mention future work in prose without creating traceable planning hooks.                       |          |

**User's choice:** Auto-selected recommended default: Explicit backlog candidates.
**Notes:** Key agreement, protocol-v4 migration, distributed controls, and metrics history have different risk profiles and should stay separable.

---

## Validation Strategy

| Option                 | Description                                                                                               | Selected |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| Docs-first consistency | Validate references, deferred requirement coverage, placeholder safety, and release-doc checks if needed. | yes      |
| Full engineering gate  | Run lint, typecheck, build, and full Jest even when only docs/planning artifacts change.                  |          |
| No validation          | Treat roadmap docs as non-validated notes.                                                                |          |

**User's choice:** Auto-selected recommended default: Docs-first consistency.
**Notes:** Full code gates become necessary if Phase 5 changes source, generated schema, tests, package metadata, or build-affecting files.

---

## Agent Discretion

- Exact public doc filename and whether the design note is new or folded into existing docs.
- Whether backlog parking is a dedicated backlog artifact or a roadmap/requirements update, depending on existing planning conventions.
- Final plan count and wave boundaries.
- Whether to run broader validation if docs edits touch release checks or generated public artifacts.

## Deferred Ideas

- Online key rotation, key agreement, forward-secret handshakes, protocol-v4 wire changes, distributed rate-limit state, database-backed metrics history, auth model changes, and UI dashboards.
