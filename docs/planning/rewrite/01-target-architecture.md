# 01 — Target Architecture

## Layering

A strict, dependency-inward layered design. A module may import only from
its own layer or layers below it. The codec layer is pure (no I/O, no
timers). Enforced with an ESLint import-boundary rule and a dependency-cru
check in CI.

```
┌──────────────────────────────────────────────────────────────────────┐
│ L6 Presentation   webapp/ (React 18 components + hooks)                │
│                   bin/edge-link-cli.ts                                 │
├──────────────────────────────────────────────────────────────────────┤
│ L5 Interface      plugin.ts (SignalK entrypoint, schema registration) │
│                   api/router.ts · api/auth.ts · api/rate-limit.ts      │
│                   api/routes/*.ts                                      │
├──────────────────────────────────────────────────────────────────────┤
│ L4 Application    ConnectionManager (registry, lifecycle ordering)     │
│                   Connection (orchestrator + explicit FSM)             │
├──────────────────────────────────────────────────────────────────────┤
│ L3 Domain         SubscriptionManager · DeltaBatcher · KeepaliveMgr    │
│   services        MetadataStreamer · SourceSnapshotService             │
│                   MonitoringService · MetricsRegistry · BondingManager │
├──────────────────────────────────────────────────────────────────────┤
│ L2 Transport      Pipeline interface  →  v1 | v3 implementations       │
│                   ReliabilityEngine (sequence · ack-nak · retransmit)  │
│                   CongestionController · UdpSocketManager              │
├──────────────────────────────────────────────────────────────────────┤
│ L1 Codec / wire   PacketCodec · Crypto · Compression                  │
│  (PURE)           PathDictionary · CompactDelta · ValueDedup          │
│                   DeltaSanitizer · MetadataCodec · SourceCodec         │
├──────────────────────────────────────────────────────────────────────┤
│ L0 Foundation     types/ · constants.ts · config-io.ts · logger.ts    │
│                   result.ts · circular-buffer.ts                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Dependency rules

- L1 (codec) imports only L0. It is pure and deterministic — same input,
  same output, no sockets, no clocks (clock injected where needed). This is
  what makes the golden-vector conformance suite (doc 03) possible.
- L2 (transport) composes L1; owns sockets, timers, sequence state.
- L3 (domain) composes L2 + L1; each service owns its own state/timers and
  exposes a small API; no service reaches into another's internals.
- L4 (application) composes L3; `Connection` is an orchestrator that wires
  services together and owns the lifecycle FSM. It holds no protocol logic.
- L5 (interface) reads through `ConnectionManager` / `Connection` public
  APIs only — never touches L3/L2 internals directly (today routes poke
  `pipeline.sendHello()` and `plugin._currentOptions`; that stops).
- L6 (presentation) talks to L5 over HTTP only.

## The Connection lifecycle FSM

Replaces the boolean soup (`stopped`, `readyToSend`,
`socketRecoveryInProgress`, `subscribing`) with one explicit machine. A
single `canSend()` predicate derives from state; illegal transitions throw
in dev and are logged+counted in prod.

```
            ┌─────────┐  start()   ┌──────────┐  bound+subscribed  ┌───────┐
            │ Created │ ─────────▶ │ Starting │ ─────────────────▶ │ Ready │
            └─────────┘            └──────────┘                    └───────┘
                                        │                          │   ▲
                                        │ start error              │   │ recovered
                                        ▼                          ▼   │
                                   ┌─────────┐  socket error  ┌────────────┐
                                   │ Stopped │ ◀───────────── │ Recovering │
                                   └─────────┘   stop()       └────────────┘
                                        ▲                          │
                                        │ stop()  ┌──────────┐     │ stop()
                                        └──────── │ Stopping │ ◀───┘
                                                  └──────────┘
```

States: `Created → Starting → Ready ⇄ Recovering → Stopping → Stopped`.

- `canSend()` is true only in `Ready`.
- `stop()` is valid from any state and is idempotent.
- Recovery is a guarded sub-state, not a free-floating boolean; a `stop()`
  during `Recovering` cancels recovery deterministically.
- Each transition is the single place timers/sockets are created or torn
  down, eliminating the 3× duplicated socket setup and the 12-timer manual
  teardown in today's `stop()`.

## Composition model (killing the God Object)

`Connection` (L4) constructs and owns these services and wires their
callbacks; it contains orchestration only, no protocol/transport logic:

- `UdpSocketManager` — create / bind / recover / close one socket; emits
  `message` / `error` / `listening`; owns the recovery timer.
- `Pipeline` (v1|v3 via factory) — the only construction path; encode/
  decode/send/receive + transport metrics.
- `SubscriptionManager` — subscribe/unsubscribe, normalize subscription
  config, exponential-backoff retry, staged meta-config commit on success.
- `DeltaBatcher` — buffer, smart-batch sizing, schedule/flush, retry,
  high-water-mark + drop accounting.
- `KeepaliveManager` — HELLO interval (v3 `sendHello`, v1 empty-delta),
  heartbeat handle.
- `MetadataStreamer` — snapshot/diff scheduling, MetaCache diff, envelope
  build, rate-limit; responds to META_REQUEST.
- `SourceSnapshotService` — periodic /sources snapshot, FULL_STATUS replay,
  values-snapshot replay on subscribe/retry/recovery.
- `MonitoringService` — packet-loss heatmap, path latency, retransmit
  history, alert manager, capture/inspector.
- `MetricsRegistry` — the single sink; nothing computes metrics inline.

Each service receives its dependencies explicitly (constructor injection):
`app`, a typed `logger`, the `MetricsRegistry`, relevant config, and a
`clock` where time matters (for deterministic tests). No service captures
another's closure variables.

## Cross-cutting concerns

- **Errors:** an L0 `Result<T,E>` / typed-error convention at module
  boundaries. No swallowed exceptions. Every drop/failure increments a
  named metric. The `stretchAsciiKey` silent-failure becomes a typed
  `DecryptError` surfaced to logs/metrics/UI (see doc 03 §key handling).
- **Logging:** one `logger.ts` wrapping `app.debug/error` with consistent
  prefixes per module; no ad-hoc `console`.
- **Time:** injectable `clock` (default `Date.now`/timers) so batching,
  retransmit aging, congestion intervals, and rate limits are testable
  without real waits.
- **Config:** one schema module (L5/`config/schema.ts`) drives the SignalK
  plugin schema, the HTTP validation, the CLI, and the webapp form, plus a
  parity test against the docs. Single `config/validation.ts`; delete the
  mirrored constant in `routes/config-validation.ts`/`metadata.ts`.
- **Observability preserved:** metric names and Prometheus output are an
  external contract (doc 04); the registry maps internal counters to the
  exact existing names.

## Directory layout (target)

```
src/
  foundation/      types/ constants.ts config-io.ts logger.ts result.ts
                   circular-buffer.ts
  codec/           crypto.ts packet-codec.ts compression.ts
                   path-dictionary.ts compact-delta.ts value-dedup.ts
                   delta-sanitizer.ts metadata-codec.ts source-codec.ts
  transport/       udp-socket-manager.ts congestion.ts
                   reliability/ sequence.ts ack-nak.ts retransmit-queue.ts
                   pipeline/ pipeline.ts (interface) v1.ts
                             reliable-client/ reliable-server/ factory.ts
  domain/          subscription-manager.ts delta-batcher.ts
                   keepalive-manager.ts metadata-streamer.ts
                   source-snapshot-service.ts monitoring/ ...
                   metrics/ registry.ts publisher.ts prometheus.ts
                   bonding.ts source-registry.ts
  app/             connection.ts connection-manager.ts lifecycle.ts
                   config/ schema.ts validation.ts migrate.ts watcher.ts
  interface/       plugin.ts api/ router.ts auth.ts rate-limit.ts
                   routes/ metrics.ts control.ts config.ts connections.ts
                           monitoring.ts
  bin/             edge-link-cli.ts
  webapp/          (React 18 component tree — see doc 04 §webapp)
```

Note: directory grouping by layer (vs today's flat `src/`) makes the
import-boundary lint rule trivial and the layering self-documenting.
