# Research: Pitfalls

**Source:** Local codebase map
**Date:** 2026-04-30

## Documentation Drift

Architecture docs reference legacy file names, and API docs still mention an older version number than `package.json`. This can confuse operators and contributors.

## Management API Defaults

The management API can remain open by default for backward compatibility when no token is configured. Fail-closed behavior exists but must stay well documented and tested.

## Security Telemetry

Auth decisions are visible in logs, but lightweight counters for authorized and denied management requests would improve operations and alerting.

## Alert Persistence

Alert threshold updates currently persist immediately through plugin option saves. Coalescing or debouncing should preserve durability and ordering.

## Lifecycle And Transport Edges

Timers, sockets, watchers, retransmission queues, stale sessions, gaps, reconnects, and stop/start cleanup are the areas most likely to regress.

## Generated Artifacts

`lib/` and `public/` are package payloads but ignored build outputs. Release and packaging checks must keep them current.

## Webapp Type Strictness

Backend TypeScript is strict; webapp TypeScript is looser. Tightening should be incremental and paired with component tests.
