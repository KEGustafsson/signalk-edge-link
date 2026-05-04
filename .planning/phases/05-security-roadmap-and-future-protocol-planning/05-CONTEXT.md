# Phase 5: Security Roadmap and Future Protocol Planning - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 5 turns deferred security, scaling, and future protocol concerns into explicit design notes, tradeoffs, compatibility constraints, and follow-up candidates. The phase should document what would be required for online key rotation, online key agreement, distributed rate limits, metrics history, and any larger protocol redesign, but it should not implement wire-protocol changes, add a database, add a distributed cache, change management API behavior, or alter existing operator workflows.

</domain>

<decisions>
## Implementation Decisions

### Roadmap Deliverable Shape

- **D-01:** Use a documentation-first deliverable. Create or update concise repo documentation that operators and future implementers can find, then connect it back to `.planning/REQUIREMENTS.md` and follow-up planning artifacts.
- **D-02:** Keep the phase centered on tradeoffs and boundaries. The output should explain why deferred items matter, what options exist, what compatibility work each option would require, and what remains out of scope for the current maintenance milestone.
- **D-03:** Prefer small, durable docs over a large speculative architecture rewrite. A likely target is a future security/protocol roadmap note that references current `docs/security.md`, `docs/architecture-overview.md`, and existing deferred requirements.

### Online Key Rotation and Key Agreement

- **D-04:** Compare multiple options without implementing them: coordinated offline rotation, dual-key grace windows, pre-shared-key ratchets, authenticated ephemeral key agreement, and a future protocol version with an explicit handshake.
- **D-05:** Treat forward secrecy as a protocol-design requirement, not a tweak to the current `secretKey` field. Current AES-256-GCM payload encryption and v3 HMAC control authentication depend on both peers sharing the same long-lived key and `stretchAsciiKey` setting.
- **D-06:** Any online rotation or key agreement proposal must specify replay protection, downgrade resistance, peer authentication, failure behavior, observability, operator rollout steps, and how mixed-version peers behave.
- **D-07:** Do not silently negotiate security posture. Existing protocol-version pinning and clear mismatch failures are safer than permissive fallback for security-sensitive changes.

### Protocol Compatibility and Migration Constraints

- **D-08:** Preserve v1/v2/v3 behavior unless a later dedicated phase deliberately introduces a new version. Protocol v3 currently reuses v2 data packets and adds authenticated control packets; that compatibility boundary should remain clear.
- **D-09:** Future protocol changes should be version-gated, additive where possible, disabled by default until both peers opt in, and documented with migration steps and rollback behavior.
- **D-10:** Migration docs should call out all peer-matching settings that can break a link: `protocolVersion`, `secretKey`, `stretchAsciiKey`, `useMsgpack`, `usePathDictionary`, and transport port settings.

### Scaling Limits and External Controls

- **D-11:** Document current in-process scaling boundaries instead of building distributed state in this phase. Relevant limits include process-local management API rate limiting, process-local management auth telemetry, in-memory runtime metrics, per-server client sessions, and per-session UDP rate limiting.
- **D-12:** Recommend external controls for deployments that need global enforcement or retention: reverse proxy or API gateway rate limits, Signal K auth/TLS, firewall/VPN allowlists, Prometheus/Grafana for history, and external log aggregation.
- **D-13:** Treat database-backed metrics history and cluster-wide rate-limit state as future architecture decisions. If promoted, they need storage ownership, retention, cardinality, privacy, failure-mode, and migration design before implementation.

### Follow-Up Parking

- **D-14:** Park next-milestone candidates explicitly rather than leaving them as loose notes. Candidate backlog items should map to deferred requirement IDs such as `FUT-SEC-001`, `FUT-OPS-001`, `FUT-SCALE-001`, and `FUT-PROTO-001`.
- **D-15:** Split future work by design risk: key agreement/rotation design, protocol-v4 compatibility plan, distributed management controls, and metrics-history architecture should remain separate unless a later milestone deliberately merges them.

### Documentation Safety and Validation

- **D-16:** Keep all examples secret-safe. Use placeholders only; do not introduce real management tokens, transport keys, public IPs, user agents, or environment-local values.
- **D-17:** Validate Phase 5 with documentation and planning consistency checks first: inspect deferred requirement coverage, verify links/references, search for unsafe placeholder drift, and run release-doc checks if public docs are edited.
- **D-18:** Full lint/typecheck/build/Jest gates are optional for a documentation-only phase, but become required if source code, generated schemas, tests, or build-affecting files change.

### Agent Discretion

- The planner may choose the exact doc filename and whether to update existing docs or add one focused future-roadmap document.
- The planner may decide whether backlog parking lives in `.planning/ROADMAP.md`, `.planning/backlog/`, or another established planning artifact after checking local conventions.
- The planner may group Phase 5 into one documentation plan if the implementation surface is small, or split docs and backlog/requirement updates if reviewability improves.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope

- `.planning/PROJECT.md` - Product context, compatibility constraints, milestone direction, and explicit deferrals.
- `.planning/REQUIREMENTS.md` - Phase 5 requirement `V1-PLAN-001` plus deferred IDs `FUT-SEC-001`, `FUT-OPS-001`, `FUT-SCALE-001`, and `FUT-PROTO-001`.
- `.planning/ROADMAP.md` - Phase 5 goal, likely work, success criteria, and milestone constraints.
- `.planning/STATE.md` - Current workflow state after Phase 5 context gathering.

### Prior Phase Context

- `.planning/phases/02-management-api-hardening-and-observability/02-CONTEXT.md` - Management API compatibility, auth telemetry, rate-limit, and redaction constraints.
- `.planning/phases/03-lifecycle-and-reliable-transport-coverage/03-CONTEXT.md` - Reliable transport coverage, protocol-version pinning, and deferral of protocol-security redesign.
- `.planning/phases/04-schema-ui-type-safety-and-configuration-parity/04-CONTEXT.md` - Configuration parity, schema safety, and repeated deferral of future security/protocol planning to Phase 5.

### Codebase Maps

- `.planning/codebase/ARCHITECTURE.md` - Current plugin architecture, protocol modes, state ownership, and security boundaries.
- `.planning/codebase/CONCERNS.md` - Shared-secret, process-local rate-limit, and deferred future-work concerns.
- `.planning/codebase/INTEGRATIONS.md` - External integrations, Signal K API, UDP peer integration, management API, auth, and storage boundaries.
- `.planning/codebase/STACK.md` - Runtime, testing, build tooling, and production deployment context.

### Operator Docs

- `docs/security.md` - Current crypto primitives, key handling, protocol pinning, key rotation limitations, and deployment guidance.
- `docs/architecture-overview.md` - Current v1/v2/v3 pipeline architecture and data flow.
- `docs/api-reference.md` - Current management rate-limit and management auth telemetry API shape.
- `docs/metrics.md` - Runtime metrics, management auth telemetry, and current in-memory monitoring surfaces.
- `docs/management-tools.md` - CLI/UI auth behavior, token handling, and management endpoint guidance.
- `docs/performance-tuning.md` - Current performance/scaling knobs and deployment profiles.

### Security, Protocol, and Scaling Source

- `src/crypto.ts` - AES-256-GCM payload encryption, key normalization, optional ASCII key stretching, and v3 control-packet HMAC helpers.
- `src/packet.ts` - v2/v3 packet headers, protocol-version support, authenticated v3 control packet construction/parsing, and HELLO capability payloads.
- `src/pipeline.ts` - v1 encrypted UDP behavior.
- `src/pipeline-v2-client.ts` - v2/v3 client send, HELLO, ACK/NAK, retransmit, bonding, and telemetry behavior.
- `src/pipeline-v2-server.ts` - v2/v3 server sessions, protocol-version pinning, per-session UDP rate limits, session caps, metadata/source handling, and network metrics.
- `src/routes.ts` - Management auth behavior, process-local rate limiting, route-level auth telemetry, and status/metrics aggregation.
- `src/constants.ts` - Current management API and UDP rate-limit constants, client session cap, and UDP payload safety limits.

</canonical_refs>

<code_context>

## Existing Code Insights

### Current Security Baseline

- Payloads use AES-256-GCM with per-packet random IVs, and data packets are authenticated by the GCM tag.
- v3 control packets use truncated HMAC-SHA256 tags over header and payload. v2 control packets rely on CRC integrity, so v3 remains the safer WAN recommendation.
- `secretKey` can be hex, base64, or 32-byte ASCII. `stretchAsciiKey` is opt-in and both peers must match it.
- Changing the transport secret today requires coordinated config changes and plugin restart on both ends.
- Current protocol docs state no forward secrecy and no online key agreement.

### Current Protocol Compatibility Baseline

- v1 uses encrypted UDP payloads without v2/v3 reliable packet headers.
- v2/v3 use a 15-byte packet header with version, packet type, flags, sequence, payload length, and CRC.
- v3 uses the v2 data packet format and adds authenticated control packets. It does not currently introduce a separate data-packet format.
- Servers pin their configured reliable protocol version and reject mismatched v2/v3 packets, incrementing malformed packet metrics and logging a rate-limited operator error.
- Mixed peer settings for `protocolVersion`, `secretKey`, `stretchAsciiKey`, `useMsgpack`, and `usePathDictionary` are expected to fail rather than silently degrade.

### Current Scaling Baseline

- Management API rate limiting is process-local: 120 requests per minute per IP by default.
- Management auth telemetry is route-level aggregate process memory and intentionally avoids client identity labels.
- v2/v3 server sessions are in memory, keyed by remote address and port, capped globally by `MAX_CLIENT_SESSIONS`, and constrained by a per-source-IP session cap.
- UDP DATA and METADATA receive paths have per-session rate limits. These limits do not coordinate across multiple Signal K processes or nodes.
- Metrics history exposed in JSON is in-memory recent runtime state, while long-term retention belongs in Prometheus/Grafana or another external system today.

### Established Documentation Patterns

- Operator docs use placeholder secrets and environment variables rather than real values.
- API and metrics docs describe bounded auth telemetry labels and avoid sensitive identifiers.
- Architecture docs focus on current behavior and source ownership rather than speculative implementation.
- Requirements distinguish active milestone work from deferred future requirements, which is the right place to park Phase 5 follow-up candidates.

</code_context>

<specifics>
## Specific Ideas

- `[auto] Documentation-first roadmap` - Selected a short future security/protocol design note plus planning links over implementation changes.
- `[auto] Key rotation/key agreement option comparison` - Selected tradeoff comparison and acceptance criteria for a future design, not an online rotation implementation.
- `[auto] Version-gated protocol migration` - Selected additive, explicit, opt-in protocol evolution with clear mixed-version failure behavior.
- `[auto] External controls for scaling` - Selected reverse proxy/API gateway/firewall/VPN/Prometheus guidance over in-plugin distributed state for this milestone.
- `[auto] Follow-up parking` - Selected explicit next-milestone candidates mapped to deferred requirement IDs.
- `[auto] Docs-first validation` - Selected documentation consistency, safe-placeholder search, and release-doc checks unless source code changes expand validation needs.

</specifics>

<deferred>
## Deferred Ideas

- Implementing online key rotation, key agreement, forward-secret handshakes, or a protocol-v4 wire format.
- Adding automatic peer negotiation, silent fallback, or mixed-version compatibility behavior that weakens protocol pinning.
- Adding database-backed metrics history, distributed rate-limit stores, clustered auth telemetry, or new storage dependencies.
- Changing management API auth semantics, token defaults, browser token behavior, or existing operator workflows.
- Adding UI dashboards or broad monitoring screens for future protocol/security concepts.

</deferred>

---

_Phase: 05-security-roadmap-and-future-protocol-planning_
_Context gathered: 2026-05-01_
