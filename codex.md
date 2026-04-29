# codex.md

## Repository profile

Signal K Edge Link is a multi-instance Signal K plugin for secure UDP transport of deltas with optional reliable protocol features (v2/v3).

## Architecture snapshot

- Entry point and plugin schema: `src/index.ts`
- Per-connection runtime orchestration: `src/instance.ts`
- Protocol modules:
  - v1: `src/pipeline.ts`
  - v2/v3 client: `src/pipeline-v2-client.ts`
  - v2/v3 server: `src/pipeline-v2-server.ts`
- Support subsystems:
  - crypto/key handling: `src/crypto.ts`
  - packet format/parsing: `src/packet.ts`
  - monitoring/alerts: `src/monitoring.ts`
  - API routes: `src/routes.ts`, `src/routes/*`
  - web UI: `src/webapp/*`

## Golden workflow

1. Make minimal, localized changes.
2. Run the narrowest meaningful tests first.
3. Run broader checks before finalizing.
4. Update docs for external behavior changes.

## Build and validation commands

- `npm run build`
- `npm run check:ts`
- `npm run lint`
- `npm test`
- `npm run test:v2`
- `npm run test:integration`

## Production-grade change policy

- Preserve backward compatibility unless migration is explicit.
- Keep connection startup robust (no partial apply on invalid connection arrays).
- Keep auth and security controls strict (management token behavior, encryption integrity).
- Ensure operational observability remains intact (metrics/alerts/routes).

## Definition of done

- Code compiles and build passes.
- Type-check and lint pass.
- Relevant tests pass (including v2/integration when transport logic is touched).
- Documentation updated when behavior/config/API is changed.
