---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Codebase Structure

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

- **`src/`** - Source of truth for runtime and buildable code: plugin entry, instance runtime, protocol pipelines, crypto, metrics, monitoring, route handlers, shared schemas, CLI, scripts, and webapp.
- **`src/routes/`** - REST route modules behind the common route context. Add new route groups here and register them from `src/routes.ts`.
- **`src/shared/`** - Code shared between backend plugin and webapp bundle. Use this directory when a config/schema constant must stay identical across backend and frontend.
- **`src/webapp/`** - Browser UI for runtime management and plugin configuration. Built by webpack into `public/`.
- **`__tests__/`** - Primary Jest test suites. `__tests__/v2/` concentrates v2/v3 protocol behavior, bonding, congestion, metadata, monitoring, fuzz, and coverage tests.
- **`test/`** - Integration, simulation, and benchmark-style validation outside the main unit-test tree (`test/integration/`, `test/benchmarks/`).
- **`docs/`** - Human-readable product, protocol, security, API, and operational documentation. Subdirectories capture planning notes, performance reports, PR records, and image assets.
- **`samples/`** - Example JSON configs for common deployment profiles.

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

_Update when directory structure or ownership boundaries change._
