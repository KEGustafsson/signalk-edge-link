# 05 — Old → New File Mapping

How every current `src/` file maps into the target layout, and whether its
logic is reused verbatim (♻), used as a reference re-implementation proven
by golden vectors (🔎), or rewritten/split (✏). Ordered roughly by the
phase that touches it (doc 07).

## Codec / wire (mostly reuse — this is the proven core)

| Current file (LOC)                                      | → Target                                                                    | Action | Notes                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `crypto.ts` (355)                                       | `codec/crypto.ts`                                                           | 🔎     | Security-critical; re-home, prove every vector. Add typed `DecryptError`. |
| `shared/crypto-constants.ts` (18)                       | `foundation/constants.ts` (crypto section)                                  | ♻      | Fold in or keep separate file.                                            |
| `packet.ts` (701)                                       | `codec/packet-codec.ts` (+ optional `packet-builder.ts`/`packet-parser.ts`) | 🔎     | Split builder/parser if >400 after move. CRC table reused.                |
| `pipeline-utils.ts` (compression bits)                  | `codec/compression.ts`                                                      | ♻      | `deltaBuffer`, `compressPayload`, brotli async.                           |
| `pipeline-utils.ts` (`udpSendAsync`)                    | `transport/udp-socket-manager.ts`                                           | ✏      | Becomes part of socket manager.                                           |
| `pathDictionary.ts` (516)                               | `codec/path-dictionary.ts`                                                  | ♻      | Data table + fns verbatim.                                                |
| `compact-delta.ts` (201)                                | `codec/compact-delta.ts`                                                    | ♻      |                                                                           |
| `value-dedup.ts` (250)                                  | `codec/value-dedup.ts`                                                      | ♻      |                                                                           |
| `delta-sanitizer.ts` (601)                              | `codec/delta-sanitizer.ts` (consider split filter/throttle/quantize)        | ♻/✏    | Large; split by concern.                                                  |
| `metadata.ts` (585)                                     | `codec/metadata-codec.ts` (split cache vs collect)                          | ♻      | ReDoS check + MetaCache.                                                  |
| `source-dispatch.ts` (228) + `source-snapshot.ts` (198) | `codec/source-codec.ts`                                                     | ♻      | Merge two small files.                                                    |
| `values-snapshot.ts` (301)                              | `codec/values-snapshot.ts`                                                  | ♻      |                                                                           |
| `CircularBuffer.ts` (43)                                | `foundation/circular-buffer.ts`                                             | ♻      |                                                                           |
| `constants.ts` (157)                                    | `foundation/constants.ts`                                                   | ♻      | Verbatim.                                                                 |

## Transport (reuse algorithms, rewrite composition)

> Per doc 08 Q3 (remove v2): the target `v2-client`/`v2-server` directories
> are named `reliable-client`/`reliable-server` (they implement protocol v3,
> the reliable binary stack). The shared reliability machinery (sequence,
> retransmit, congestion, bonding, metadata) is reused unchanged — only the
> v2 CRC control path is dropped.

| Current file (LOC)             | → Target                                                                           | Action | Notes                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `sequence.ts` (287)            | `transport/reliability/sequence.ts`                                                | ♻      |                                                                |
| `retransmit-queue.ts` (310)    | `transport/reliability/retransmit-queue.ts`                                        | ♻      |                                                                |
| `congestion.ts` (298)          | `transport/congestion.ts`                                                          | ♻      |                                                                |
| `pipeline.ts` (380, v1)        | `transport/pipeline/v1.ts`                                                         | 🔎     | Keep v1 behind interface.                                      |
| `pipeline-factory.ts` (59)     | `transport/pipeline/factory.ts`                                                    | ✏      | Becomes the _only_ construction path (today bypassed).         |
| `pipeline-v2-client.ts` (1490) | `transport/pipeline/v2-client/{send-path,reliability,metrics,index}.ts`            | ✏      | Split; extract `ack-nak.ts` scheduler. Reuse algorithm bodies. |
| `pipeline-v2-server.ts` (1515) | `transport/pipeline/v2-server/{session-manager,handlers,metadata-ingest,index}.ts` | ✏      | Split; ClientSession struct → `session-manager.ts`.            |

## Domain services (extracted from the God Object)

| Current source                                                                                                                                                     | → Target                                                                      | Action | Notes                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------ | -------------------------------------- |
| `instance.ts` subscription fns (`handleSubscriptionChange`, `scheduleSubscriptionRetry`, `normalizeSubscriptionConfig`, `createSubscriptionDeltaHandler`)          | `domain/subscription-manager.ts`                                              | ✏      |                                        |
| `instance.ts` batching fns (`processDelta`, `flushDeltaBatch`, `sendDeltaBatch`, `scheduleBatchRetry`, `scheduleDeltaTimer`, `filterOutboundDelta`)                | `domain/delta-batcher.ts`                                                     | ✏      |                                        |
| `instance.ts` keepalive (hello interval, heartbeat handle)                                                                                                         | `domain/keepalive-manager.ts`                                                 | ✏      |                                        |
| `instance.ts` metadata fns (`sendMetaEntries`, `sendMetadataSnapshot`, `enqueueMetaDiff`, `restartMetadataTimer`, `scheduleMetadataSnapshot`, `handleMetaRequest`) | `domain/metadata-streamer.ts`                                                 | ✏      |                                        |
| `instance.ts` snapshot fns (`sendSourceSnapshot`, `replayValuesSnapshot`, `recordSnapshotReplay`, `restartSourceSnapshotTimer`, `handleFullStatusRequest`)         | `domain/source-snapshot-service.ts`                                           | ✏      |                                        |
| `source-replication.ts` (411)                                                                                                                                      | `domain/source-registry.ts`                                                   | ♻      |                                        |
| `bonding.ts` (938)                                                                                                                                                 | `domain/bonding.ts` (consider split health/failover)                          | 🔎     | High test coverage; re-home carefully. |
| `monitoring.ts` (778)                                                                                                                                              | `domain/monitoring/{packet-loss,path-latency,retransmission,alerts,index}.ts` | ♻      | 4 trackers + AlertManager → files.     |
| `packet-capture.ts` (366)                                                                                                                                          | `domain/monitoring/capture.ts` + `inspector.ts`                               | ♻      |                                        |
| `metrics.ts` (434)                                                                                                                                                 | `domain/metrics/registry.ts`                                                  | ♻      |                                        |
| `metrics-publisher.ts` (334)                                                                                                                                       | `domain/metrics/publisher.ts`                                                 | ♻      |                                        |
| `prometheus.ts` (424)                                                                                                                                              | `domain/metrics/prometheus.ts`                                                | ♻      | Names frozen (doc 04 §5).              |

## Application

| Current source                                                    | → Target                                            | Action | Notes                                         |
| ----------------------------------------------------------------- | --------------------------------------------------- | ------ | --------------------------------------------- |
| `instance.ts` (1983) orchestration + lifecycle                    | `app/connection.ts` + `app/lifecycle.ts`            | ✏      | God Object → thin orchestrator + FSM.         |
| `index.ts` (380) registry/start/stop/aggregation                  | `app/connection-manager.ts` + `interface/plugin.ts` | ✏      | Split lifecycle mgmt from SignalK entrypoint. |
| `shared/connection-schema.ts` (696) + inline schema in `index.ts` | `app/config/schema.ts`                              | ♻      | One schema source.                            |
| `connection-config.ts` (607) + `routes/config-validation.ts` (80) | `app/config/validation.ts`                          | ✏      | Merge; remove mirrored constant.              |
| `scripts/migrate-config.ts`                                       | `app/config/migrate.ts`                             | ♻      |                                               |
| `config-watcher.ts` (400)                                         | `app/config/watcher.ts`                             | ♻      |                                               |
| `config-io.ts` (129)                                              | `foundation/config-io.ts`                           | ♻      |                                               |

## Interface

| Current source                               | → Target                                                   | Action | Notes                 |
| -------------------------------------------- | ---------------------------------------------------------- | ------ | --------------------- |
| `routes.ts` (782) auth + rate-limit + router | `interface/api/{auth,rate-limit,router}.ts`                | ✏      | Split the 3 concerns. |
| `routes/metrics.ts` (199)                    | `interface/api/routes/metrics.ts`                          | ♻      |                       |
| `routes/control.ts` (236)                    | `interface/api/routes/control.ts`                          | ♻      |                       |
| `routes/config.ts` (430)                     | `interface/api/routes/config.ts`                           | ♻      |                       |
| `routes/connections.ts` (606)                | `interface/api/routes/connections.ts` (split CRUD/metrics) | ♻/✏    |                       |
| `routes/monitoring.ts` (598)                 | `interface/api/routes/monitoring.ts`                       | ♻      |                       |
| `routes/types.ts`                            | `interface/api/types.ts`                                   | ♻      |                       |

## Presentation

| Current source                                         | → Target                                     | Action | Notes                                   |
| ------------------------------------------------------ | -------------------------------------------- | ------ | --------------------------------------- |
| `bin/edge-link-cli.ts` (461)                           | `bin/edge-link-cli.ts` (+ `cli/commands/*`)  | ♻/✏    | Split per command.                      |
| `webapp/index.ts` (2341)                               | `webapp/` React 18 component tree + hooks    | ✏      | Full rewrite (doc 04 §6.3).             |
| `webapp/components/PluginConfigurationPanel.tsx` (831) | `webapp/components/PluginConfigForm/*`       | ✏      | Decompose; keep federation export name. |
| `webapp/utils/apiFetch.ts` (123)                       | `webapp/hooks/useApi.ts` + `lib/apiFetch.ts` | ♻/✏    | Keep token-injection contract.          |

## Tests

All `__tests__/*.js` → ported to TypeScript co-located or under
`__tests__/` retargeted at new `src/` modules. See doc 06 for the porting
strategy, including the new `__conformance__/` golden-vector suite (which
does not exist today).

## Files that disappear

- `ping-monitor.d.ts` stays only if v1 ping monitor is retained (doc 08 Q3).
- The 2341-line string-template UI engine is deleted wholesale.
- The mirrored validation constant in `routes/config-validation.ts` is
  deleted (single source in `app/config/validation.ts`).
