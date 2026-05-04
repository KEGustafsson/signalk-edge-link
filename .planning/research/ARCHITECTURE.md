# Research: Architecture

**Source:** Local codebase map
**Date:** 2026-04-30

## Shape

Signal K Edge Link is a plugin monolith with isolated per-connection runtimes. `src/index.ts` adapts the repo to the Signal K plugin lifecycle, while `src/instance.ts` owns each configured connection and coordinates sockets, timers, subscriptions, watchers, metrics, monitoring, and transport pipelines.

## Main Boundaries

- Plugin bootstrap and registry: `src/index.ts`.
- Instance runtime: `src/instance.ts`.
- Transport pipelines: `src/pipeline.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, and packet/reliability helpers.
- Protocol utilities: crypto, compression, packet parsing, path dictionary, metadata, source replication, and delta sanitation.
- REST management layer: `src/routes.ts` and `src/routes/`.
- UI and CLI clients: `src/webapp/` and `src/bin/edge-link-cli.ts`.
- Observability: metrics, monitoring, Prometheus, and packet capture modules.

## Fragile Boundaries

- `src/instance.ts` has high lifecycle responsibility concentration.
- v2/v3 pipeline modules combine reliability, telemetry, metadata snapshots, congestion, and bonding.
- Config schema must remain aligned across shared schema, validation, webapp, REST routes, docs, and samples.
- Generated package artifacts are ignored in git but required in npm package output.

## Planning Implications

Plan phases around narrow boundaries. Add tests before reshaping lifecycle or reliable transport code. Treat docs and schema parity as implementation requirements, not cleanup.
