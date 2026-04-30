---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Architecture

**Analysis Date:** 2026-04-30

## Pattern Overview

**Overall:** Signal K plugin monolith with isolated multi-instance transport runtimes.

**Key Characteristics:**

- One plugin process can run multiple independent client/server connections.
- Each connection owns its own UDP sockets, timers, file watchers, metrics, monitoring, source registry, and pipeline state.
- Transport supports three protocol modes: v1 encrypted UDP, v2 reliable UDP, and v3 reliable UDP with authenticated control packets.
- REST route handlers expose management, monitoring, runtime config, and metrics APIs under the Signal K plugin route prefix.
- Browser UI and CLI are secondary management clients over the same REST surface.

## Layers

**Plugin Bootstrap and Registry:**

- Purpose: Adapt the repository to the Signal K plugin lifecycle.
- Contains: plugin metadata, route registration, connection config normalization, duplicate-port checks, validation, and instance registry.
- Location: `src/index.ts`.
- Depends on: `src/instance.ts`, `src/routes.ts`, `src/connection-config.ts`, and `src/shared/connection-schema.ts`.
- Used by: Signal K plugin loader.

**Instance Runtime:**

- Purpose: Own one configured connection and its lifecycle.
- Contains: mutable `InstanceState`, UDP sockets, Signal K subscriptions, timers, config watchers, metadata/source snapshot loops, monitoring objects, and pipeline selection.
- Location: `src/instance.ts`.
- Depends on: config I/O, crypto validation, metrics, monitoring, packet capture, metadata, source replication, and pipeline modules.
- Used by: plugin registry and REST route registry.

**Transport Pipelines:**

- Purpose: Convert Signal K deltas and metadata into encrypted UDP packets and back.
- Contains: v1 pipeline, v2/v3 client pipeline, v2/v3 server pipeline, retransmit handling, ACK/NAK, bonding, congestion control, and protocol telemetry.
- Locations: `src/pipeline.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/packet.ts`, `src/retransmit-queue.ts`, `src/sequence.ts`, `src/bonding.ts`, and `src/congestion.ts`.
- Depends on: crypto, Brotli helpers, MessagePack, path dictionary, metrics, and dgram sockets.
- Used by: `src/instance.ts`.

**Protocol and Encoding Utilities:**

- Purpose: Provide reusable primitives for packet structure, encryption, compression, path compaction, metadata, source tracking, and delta sanitation.
- Locations: `src/crypto.ts`, `src/packet.ts`, `src/pathDictionary.ts`, `src/metadata.ts`, `src/source-replication.ts`, `src/source-snapshot.ts`, `src/source-dispatch.ts`, `src/delta-sanitizer.ts`, and `src/pipeline-utils.ts`.
- Used by: pipelines, instance runtime, tests, and docs.

**REST Management Layer:**

- Purpose: Expose runtime state and mutation endpoints.
- Contains: auth, rate limiting, common route context, and route modules.
- Locations: `src/routes.ts` and `src/routes/*.ts`.
- Depends on: active instance registry, plugin restart callback, config I/O, validators, metrics, monitoring, and Prometheus formatting.
- Used by: web UI, CLI, operators, and automated tools.

**UI and CLI Management Clients:**

- Purpose: Provide human and scriptable management workflows.
- Locations: `src/webapp/`, `src/bin/edge-link-cli.ts`, and `src/scripts/migrate-config.ts`.
- Depends on: shared connection schema, REST API shape, and auth token conventions.

**Observability:**

- Purpose: Keep runtime behavior inspectable and alertable.
- Locations: `src/metrics.ts`, `src/metrics-publisher.ts`, `src/prometheus.ts`, `src/monitoring.ts`, and `src/packet-capture.ts`.
- Depends on: instance state, pipeline telemetry, and Signal K app APIs.

## Data Flow

**Plugin Startup:**

1. Signal K loads `src/index.ts` and calls the plugin factory.
2. Routes are created once by `src/routes.ts` and registered through `plugin.registerWithRouter`.
3. `plugin.start` receives options and restart callback.
4. Options are normalized to `connections[]`, then every connection is validated by `validateConnectionConfig`.
5. One `createInstance` call creates each instance; all instances start concurrently.
6. Aggregated status reflects all active connections.

**Client Delta Send:**

1. A client instance subscribes to local Signal K deltas from `subscription.json`.
2. `src/instance.ts` sanitizes deltas and applies optional own-data filtering.
3. Batches are driven by `delta_timer.json`, smart batching, and optional congestion control.
4. v1 sends through `src/pipeline.ts`; v2/v3 sends through `src/pipeline-v2-client.ts`.
5. Payloads can be path-dictionary encoded, MessagePack encoded, Brotli-compressed, AES-GCM encrypted, packetized, queued for retransmit, and sent by UDP.

**Server Packet Receive:**

1. UDP socket receives a packet in server mode.
2. v1 decrypts/decompresses in `src/pipeline.ts`; v2/v3 parses headers in `src/packet.ts` and processes in `src/pipeline-v2-server.ts`.
3. Sequence tracking detects duplicates and gaps; server emits ACK/NAK control packets.
4. Payloads are decrypted, decompressed, decoded, sanitized, and source-normalized.
5. Valid deltas are forwarded to Signal K with `app.handleMessage`.

**Management API Request:**

1. A request enters a route registered by `src/routes.ts`.
2. Rate limiting keys the request by client identity.
3. Management auth checks configured token state and request headers.
4. Route modules fetch instance state, metrics, config files, or trigger restart flows.
5. Responses redact sensitive configuration fields where applicable.

## State Management

- Main persistent runtime state is Signal K plugin options plus per-connection JSON files.
- Active process state is in memory: `InstanceState`, metrics, retransmit queues, session maps, trackers, timers, and socket references.
- Runtime JSON files are atomically saved through `src/config-io.ts` and watched through `src/config-watcher.ts`.
- Metrics are reset when an instance stops; no database-backed history is maintained.

## Key Abstractions

**ConnectionConfig:**

- Purpose: Defines one server/client connection.
- Location: `src/types.ts` and validation in `src/connection-config.ts`.
- Pattern: validated plain object, also rendered by shared JSON schema.

**EdgeLink Instance:**

- Purpose: Isolated runtime unit for one connection.
- Location: `src/instance.ts`.
- Pattern: factory returning `{ start, stop, getId, getName, getStatus, getState, getMetricsApi }`.

**PacketBuilder / PacketParser:**

- Purpose: v2/v3 binary packet creation and parsing.
- Location: `src/packet.ts`.
- Pattern: class-based protocol primitive with sequence state.

**SequenceTracker and RetransmitQueue:**

- Purpose: Reliable delivery bookkeeping.
- Locations: `src/sequence.ts` and `src/retransmit-queue.ts`.
- Pattern: focused state containers used by server/client pipelines.

**CongestionControl and BondingManager:**

- Purpose: Link adaptation and primary/backup failover.
- Locations: `src/congestion.ts` and `src/bonding.ts`.
- Pattern: classes with explicit state snapshots for API/UI exposure.

**RouteContext:**

- Purpose: Shared dependency bundle passed to route modules.
- Location: `src/routes/types.ts` and constructed in `src/routes.ts`.
- Pattern: dependency injection for route handlers.

## Entry Points

**Signal K Plugin:**

- Location: `src/index.ts`.
- Triggers: Signal K plugin loader calls exported factory, then lifecycle methods.
- Responsibilities: normalize config, validate connections, create instances, aggregate status, register routes.

**HTTP Routes:**

- Location: `src/routes.ts`.
- Triggers: Signal K router requests under `/plugins/signalk-edge-link`.
- Responsibilities: auth, rate limiting, route module registration, shared helpers.

**CLI:**

- Location: `src/bin/edge-link-cli.ts`.
- Triggers: `edge-link-cli` package binary or `npm run cli`.
- Responsibilities: migration command routing and management API client calls.

**Web UI:**

- Location: `src/webapp/index.ts` and `src/webapp/components/PluginConfigurationPanel.tsx`.
- Triggers: Signal K plugin/admin page loads built assets from `public/`.
- Responsibilities: display metrics/config state and submit management/config updates.

## Error Handling

**Strategy:** Boundary-local `try/catch`, Signal K logging, metrics counters, and fail-fast validation before creating runtime resources.

**Patterns:**

- Route handlers catch exceptions and return JSON error responses.
- `plugin.start` validates all connections before starting any instance to avoid partial startup.
- Pipeline errors increment category counters via `recordError`.
- Malformed/unauthenticated packets are dropped and counted rather than forwarded.
- Socket, watcher, timer, and pipeline cleanup is centralized in instance `stop()`.

## Cross-Cutting Concerns

**Logging:**

- Use `app.debug` and `app.error`; CLI code may write to stdout/stderr.
- Instance log messages usually include `[${instanceId}]`.

**Validation:**

- Config validation is centralized in `src/connection-config.ts` and `src/routes/config-validation.ts`.
- Packet validation is enforced in `src/packet.ts` and pipeline receive paths.

**Authentication:**

- Management API token checks live in `src/routes.ts`.
- Transport payload auth uses AES-GCM; v3 control auth uses HMAC tags.

**Observability:**

- Metrics, recent errors, Prometheus output, monitoring alerts, packet capture, and Signal K metric publishing are first-class runtime concerns.

---

_Architecture analysis: 2026-04-30_
_Update when lifecycle, protocol, route, or instance boundaries change_
