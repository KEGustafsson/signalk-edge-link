# Signal K Edge Link

**Initialized:** 2026-04-30
**Project Code:** SKEL
**Type:** Brownfield Signal K plugin

## What This Is

Signal K Edge Link is a Signal K server plugin that moves vessel deltas between Signal K instances over encrypted UDP links. It supports client and server modes, multiple isolated connections in one plugin process, and three transport modes: v1 encrypted UDP, v2 reliable UDP, and v3 reliable UDP with authenticated control packets.

The project also includes a schema-driven configuration UI, a CLI, REST management APIs, runtime configuration files, metrics, monitoring, Prometheus output, packet capture, and operator documentation.

## Core Value

Provide reliable, secure, observable Signal K data replication across constrained or unreliable network links, especially links where TCP-based synchronization is undesirable or unavailable.

## Primary Users

- Vessel operators who need telemetry replication between onboard and remote Signal K nodes.
- Signal K administrators managing plugin configuration, runtime health, and operational alerts.
- Integrators who need scriptable management through REST or CLI surfaces.
- Contributors maintaining transport reliability, schema parity, and package release quality.

## Validated Existing Capabilities

- Multi-connection plugin lifecycle with isolated per-connection sockets, timers, watchers, metrics, monitoring, and pipeline state.
- Client and server runtime modes with Signal K delta subscription and forwarding.
- AES-GCM encrypted UDP payload transport with optional Brotli, MessagePack, and path dictionary encoding.
- Reliable UDP behavior in v2/v3 with ACK, NAK, retransmit queues, sequence tracking, bonding, and congestion control.
- v3 authenticated control packets using HMAC tags.
- Schema-driven configuration shared across backend validation, web UI, route validation, docs, and samples.
- Management REST APIs for status, configuration, monitoring, metrics, Prometheus, packet capture, and runtime operations.
- CLI and React/RJSF web UI as management clients over the plugin API.
- Jest, TypeScript, ESLint, Prettier, Husky, lint-staged, and CI workflows for build and validation.

## Active Direction

The first GSD milestone should strengthen the existing product rather than expand scope. The current codebase map highlights documentation drift, release-version drift, management API observability gaps, alert persistence behavior, fragile lifecycle/pipeline branches, generated package artifact risk, and webapp TypeScript looseness.

The near-term direction is therefore:

- Make project documentation and package/release truth consistent.
- Improve management API security observability without breaking backward compatibility.
- Add focused coverage around lifecycle cleanup, transport recovery, and reliable UDP edge cases.
- Preserve schema/configuration parity across backend, API, UI, docs, and samples.
- Capture larger security work, such as online key rotation, as explicit future roadmap rather than implicit scope.

## Constraints

- Preserve Signal K plugin compatibility and existing public configuration shape unless a breaking change is deliberately planned.
- Keep management API fail-open behavior backward compatible unless an operator opts into fail-closed mode.
- Treat `lib/` and `public/` as generated package artifacts and ensure release workflows keep them synchronized.
- Avoid logging or documenting real management tokens, transport secrets, or local environment values.
- Prefer narrow changes with targeted tests for transport, lifecycle, and route behavior.
- Keep Node.js minimum-runtime claims aligned with dependency and CI reality.

## Key Decisions

- Use the existing `.planning/codebase/` map as the project baseline.
- Treat docs, release hygiene, security observability, lifecycle coverage, and schema parity as the first maintenance milestone.
- Defer online key rotation, online key agreement, database-backed metrics history, and distributed rate-limit backends until they receive explicit protocol or architecture design.
- Keep the source of truth for configuration in shared schema and validation code, with docs and UI updated in the same phase when fields change.

## Out Of Scope For The First Milestone

- Replacing the Signal K server or changing the plugin host model.
- Changing the UDP protocol compatibility contract without a dedicated design phase.
- Adding database-backed historical storage.
- Adding cluster-wide rate limiting inside the plugin process.
- Building a new management product separate from the existing Signal K UI and CLI.

## Success Shape

The project is in good shape when operators can trust the docs and package metadata, production deployments have clear management hardening signals, contributors have test coverage around the highest-risk lifecycle and transport paths, and future protocol/security work is explicitly bounded instead of mixed into maintenance changes.

## Current State

The v1 Maintenance and Hardening milestone is complete. Public docs, package/release checks, management auth observability, alert persistence behavior, lifecycle/reliable-transport regression coverage, webapp configuration type safety, and configuration parity have all been validated.

Future security and scaling work remains deliberately unimplemented and documented for later promotion. The 999.x backlog now contains candidates for online key rotation/key agreement, protocol-v4 compatibility and migration, distributed management controls, and metrics-history storage architecture.

## Next Milestone Goals

The next milestone should start with fresh requirements. Good candidates include promoting one 999.x backlog item, tightening remaining operational validation, or preparing a package/release cycle around the completed hardening work.

## Planning Artifacts

- `.planning/codebase/` - Existing codebase map.
- `.planning/research/` - Local brownfield research synthesis.
- `.planning/milestones/v1-maintenance-hardening-REQUIREMENTS.md` - Archived v1 milestone requirements.
- `.planning/milestones/v1-maintenance-hardening-ROADMAP.md` - Archived v1 milestone roadmap.
- `.planning/ROADMAP.md` - Current compact roadmap and backlog.
- `.planning/STATE.md` - Current workflow state and next action.

---

_Last updated: 2026-05-01 after v1-maintenance-hardening milestone_
