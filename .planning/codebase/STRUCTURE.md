---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Codebase Structure

**Analysis Date:** 2026-04-30

## Directory Layout

```text
signalk-edge-link/
|-- src/                    # TypeScript source for plugin, pipelines, routes, CLI, and webapp
|   |-- routes/             # REST route modules
|   |-- shared/             # Shared schema/crypto constants used by backend and webapp
|   |-- webapp/             # Browser UI and React configuration panel
|   |-- bin/                # Packaged CLI entry point
|   |-- scripts/            # Utility scripts such as config migration
|   `-- icons/              # Source icon assets copied into public/
|-- __tests__/              # Jest unit/component tests
|   `-- v2/                 # Protocol v2/v3 focused tests
|-- test/                   # Integration tests, benchmarks, and simulation utilities
|   |-- integration/        # Multi-module integration suites
|   `-- benchmarks/         # Performance/fuzz/benchmark scripts
|-- docs/                   # Operator, protocol, security, API, architecture, and planning docs
|   |-- planning/           # Historical design/completion notes
|   |-- performance/        # Performance reports and tuning data
|   `-- pr-records/         # Release/change records
|-- samples/                # Example plugin configuration JSON files
|-- .github/                # GitHub Actions and Dependabot config
|-- lib/                    # Generated TypeScript output, ignored by git
|-- public/                 # Generated web bundle output, ignored by git
|-- coverage/               # Generated test coverage output, ignored by git
|-- package.json            # npm metadata, scripts, dependencies, Jest config, bin
|-- tsconfig.json           # Backend TypeScript config
|-- tsconfig.webapp.json    # Webapp TypeScript config
|-- webpack.config.js       # Browser bundle and Module Federation config
|-- README.md               # User-facing project overview
|-- AGENTS.md               # Generic agent/contributor guidance
`-- CLAUDE.md               # Generic AI-agent working guide
```

## Directory Purposes

**`src/`:**

- Purpose: Source of truth for all runtime and buildable code.
- Contains: plugin entry, instance runtime, protocol pipelines, crypto, metrics, monitoring, route handlers, shared schemas, CLI, scripts, and webapp.
- Key files: `src/index.ts`, `src/instance.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/routes.ts`, `src/types.ts`.
- Subdirectories: `routes/`, `shared/`, `webapp/`, `bin/`, `scripts/`, and `icons/`.

**`src/routes/`:**

- Purpose: REST route modules behind the common route context.
- Contains: `config.ts`, `connections.ts`, `control.ts`, `metrics.ts`, `monitoring.ts`, `config-validation.ts`, and route types.
- Add new route groups here and register them from `src/routes.ts`.

**`src/shared/`:**

- Purpose: Code shared between backend plugin and webapp bundle.
- Key files: `src/shared/connection-schema.ts` and `src/shared/crypto-constants.ts`.
- Use this directory when a config/schema constant must stay identical across backend and frontend.

**`src/webapp/`:**

- Purpose: Browser UI for runtime management and plugin configuration.
- Contains: `index.ts`, `index.html`, `styles.css`, `components/PluginConfigurationPanel.tsx`, and `utils/apiFetch.ts`.
- Built by webpack into `public/`.

**`__tests__/`:**

- Purpose: Primary Jest test suites.
- Contains: unit tests for routes, config, crypto, metrics, pipeline APIs, webapp helpers, source replication, and v2/v3 protocol behavior.
- `__tests__/v2/` concentrates reliable protocol, bonding, congestion, metadata, monitoring, fuzz, and coverage tests.

**`test/`:**

- Purpose: Integration, simulation, and benchmark-style validation outside the main unit-test tree.
- Contains: `test/integration/`, `test/benchmarks/`, and `test/network-simulator.js`.

**`docs/`:**

- Purpose: Human-readable product, protocol, security, API, and operational documentation.
- Key files: `docs/api-reference.md`, `docs/architecture-overview.md`, `docs/configuration-reference.md`, `docs/security.md`, `docs/protocol-v2-spec.md`, `docs/protocol-v3-spec.md`.
- Subdirectories capture planning notes, performance reports, PR records, and image assets.

**`samples/`:**

- Purpose: Example JSON configs for common deployment profiles.
- Files include `minimal-config.json`, `development.json`, `v2-with-bonding.json`, and `v3-authenticated-control.json`.

## Key File Locations

**Entry Points:**

- `src/index.ts` - Signal K plugin factory, lifecycle, schema, route registration, and instance registry.
- `src/bin/edge-link-cli.ts` - Package CLI for migration and management API workflows.
- `src/webapp/index.ts` - Runtime browser UI entry.
- `src/webapp/components/PluginConfigurationPanel.tsx` - Admin configuration panel exposed through Module Federation.

**Configuration:**

- `package.json` - scripts, dependencies, package metadata, Jest config, npm bin.
- `tsconfig.json` - backend TypeScript build.
- `tsconfig.webapp.json` - webapp TypeScript build.
- `webpack.config.js` - browser bundle, module federation, static asset copy.
- `.eslintrc.js` - lint rules.
- `.prettierrc.js` - formatting rules.
- `.gitignore` - excludes generated outputs, local env files, and coverage.

**Core Logic:**

- `src/instance.ts` - per-connection runtime orchestration.
- `src/pipeline.ts` - v1 transport.
- `src/pipeline-v2-client.ts` and `src/pipeline-v2-server.ts` - reliable client/server transport.
- `src/packet.ts` - v2/v3 binary packet format.
- `src/crypto.ts` - AES-GCM, key normalization, and control packet HMAC helpers.
- `src/connection-config.ts` - connection validation, sanitization, and identity derivation.

**Testing:**

- `__tests__/*.test.js` - broad unit and route tests.
- `__tests__/v2/*.test.js` - v2/v3 focused unit and behavior tests.
- `test/integration/*.test.js` - integration-level suites.
- `test/benchmarks/*.js` - benchmarking, fuzzing, and profiling helpers.

**Documentation:**

- `README.md` - install, quick start, API summary, security notes, and doc map.
- `docs/README.md` - documentation index.
- `docs/security.md` - security guide.
- `docs/management-tools.md` - operator and CLI examples.
- `docs/planning/` - historical design and phase completion documents.

## Naming Conventions

**Files:**

- Kebab-case for most modules: `pipeline-v2-client.ts`, `source-replication.ts`, `config-watcher.ts`.
- PascalCase only where established by type/component identity: `CircularBuffer.ts`, `PluginConfigurationPanel.tsx`.
- Tests use `*.test.js`, mostly under `__tests__/`, with v2-specific tests under `__tests__/v2/`.
- Root docs use uppercase names: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`.

**Directories:**

- Lowercase collection names: `src/`, `docs/`, `samples/`, `test/`.
- Special Jest test directory: `__tests__/`.
- Generated outputs: `lib/`, `public/`, and `coverage/`.

**Special Patterns:**

- `src/routes/*.ts` files export `register(router, ctx)`.
- Shared backend/frontend config belongs in `src/shared/`.
- Runtime route request/response types belong in `src/routes/types.ts`.

## Where to Add New Code

**New protocol feature:**

- Implementation: `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, `src/packet.ts`, or focused helpers in `src/`.
- Types: `src/types.ts`.
- Tests: `__tests__/v2/` plus `test/integration/` if cross-pipeline behavior changes.
- Docs: `docs/protocol-v2-spec.md`, `docs/protocol-v3-spec.md`, or relevant operational docs.

**New management endpoint:**

- Common auth/rate-limit helpers: `src/routes.ts`.
- Route implementation: new or existing file under `src/routes/`.
- Shared types: `src/routes/types.ts`.
- Tests: route-specific `__tests__/routes.*.test.js`.
- Docs: `docs/api-reference.md` and `docs/management-tools.md`.

**New connection config field:**

- Schema: `src/shared/connection-schema.ts`.
- Runtime validation/sanitization: `src/connection-config.ts`.
- Types: `src/types.ts`.
- UI behavior: `src/webapp/components/PluginConfigurationPanel.tsx` if needed.
- Docs/tests: `docs/configuration-reference.md`, `__tests__/connection-config.test.js`, and UI/schema tests.

**New webapp feature:**

- Implementation: `src/webapp/`.
- API helper changes: `src/webapp/utils/apiFetch.ts`.
- Tests: `__tests__/PluginConfigurationPanel.test.js`, `__tests__/webapp.test.js`, or `__tests__/apiFetch.test.js`.

**New operator documentation or examples:**

- Docs: `docs/`.
- Samples: `samples/`.
- README summary: `README.md` when the workflow is user-visible.

## Special Directories

**`lib/`:**

- Purpose: TypeScript build output from `npm run build:ts`.
- Source: generated from `src/`.
- Committed: no, ignored by `.gitignore`, but included in package files.

**`public/`:**

- Purpose: Webpack output from `npm run build:web`.
- Source: generated from `src/webapp/` and `src/icons/`.
- Committed: no, ignored by `.gitignore`, but included in package files.

**`coverage/`:**

- Purpose: Jest coverage reports.
- Source: generated by `npm run test:coverage`.
- Committed: no.

**`.planning/codebase/`:**

- Purpose: GSD codebase map generated by `$gsd-map-codebase`.
- Source: this mapping pass.
- Committed: yes, planning/reference artifact.

---

_Structure analysis: 2026-04-30_
_Update when directory structure or ownership boundaries change_
