# CLAUDE.md

## Purpose

This repository contains **Signal K Edge Link**, a Signal K plugin that transports deltas over encrypted UDP links between Signal K instances.

## Verified project facts

- Language/runtime: TypeScript on Node.js (`engines.node >=16`).
- Package version: `2.5.0`.
- Build output: `lib/` and `public/`.
- Supports multiple independent connections via `options.connections[]`.
- Protocol selection is runtime-based:
  - v1 pipeline: `src/pipeline.ts`
  - v2/v3 client pipeline: `src/pipeline-v2-client.ts`
  - v2/v3 server pipeline: `src/pipeline-v2-server.ts`

## Source-of-truth files

- Plugin bootstrap/schema/router registration: `src/index.ts`
- Per-connection lifecycle + pipeline wiring: `src/instance.ts`
- Crypto primitives and key handling: `src/crypto.ts`
- Packet/header parsing + builders: `src/packet.ts`
- Reliability and sequencing: `src/retransmit-queue.ts`, `src/sequence.ts`
- Congestion/bonding: `src/congestion.ts`, `src/bonding.ts`
- Monitoring/alerts/prometheus: `src/monitoring.ts`, `src/prometheus.ts`
- Route handlers: `src/routes.ts`, `src/routes/*`
- Web runtime/admin UI: `src/webapp/*`

## Commands (validated from package.json)

- Install: `npm install`
- Build: `npm run build`
- Type check: `npm run check:ts`
- Lint: `npm run lint`
- Unit/integration tests:
  - `npm test`
  - `npm run test:v2`
  - `npm run test:integration`
- CLI helper (built output): `npm run cli -- <args>`

## Engineering rules for safe changes

1. **Keep protocol compatibility explicit.**
   - v3 behavior should preserve v2 data-plane semantics and add control-packet authentication.
2. **Avoid partial-start regressions.**
   - `src/index.ts` validates connections before instance creation; keep all-or-nothing startup behavior.
3. **Preserve multi-instance isolation.**
   - Metrics, sockets, timers, and watchers should remain scoped per instance.
4. **Preserve management API auth expectations.**
   - Changes affecting `managementApiToken` / fail-closed behavior must include route tests.
5. **Do not weaken crypto defaults or key-format support** (ASCII/hex/base64 handling).

## Test-selection matrix

- `src/pipeline.ts` or v1 behavior changes:
  - run `npm test` + related pipeline tests.
- `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/packet.ts`, `src/retransmit-queue.ts`, `src/sequence.ts`:
  - run `npm run test:v2` and targeted integration tests.
- Routes/API (`src/routes*`) or monitoring changes:
  - run route tests + `npm test`.
- Broad/refactor/release prep:
  - run `npm run check:ts && npm run lint && npm test && npm run test:integration`.

## Release-readiness checklist

- Build succeeds (`npm run build`).
- Static validation succeeds (`npm run check:ts`, `npm run lint`).
- Test suites relevant to touched areas pass.
- Docs are updated when API/config/protocol behavior changes:
  - `README.md`
  - `docs/api-reference.md`
  - `docs/configuration-reference.md`
  - `docs/architecture-overview.md`
