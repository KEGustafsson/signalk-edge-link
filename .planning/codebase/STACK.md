---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Technology Stack

**Analysis Date:** 2026-04-30

## Languages

**Primary:**

- TypeScript 5.9.3 - Runtime source under `src/`, including the Signal K plugin, transport pipelines, REST routes, shared schemas, CLI, and React webapp.

**Secondary:**

- JavaScript - Jest tests under `__tests__/`, integration/benchmark harnesses under `test/`, and root tooling files such as `.eslintrc.js`, `.prettierrc.js`, and `webpack.config.js`.
- JSON / Markdown - Samples, configuration schema, package metadata, and operator documentation under `samples/`, `docs/`, `README.md`, and `CHANGELOG.md`.

## Runtime

**Environment:**

- Node.js >=16 - Declared in `package.json` and used for the plugin runtime, UDP sockets, filesystem watchers, crypto, compression, CLI, and tests.
- Signal K server plugin runtime - `src/index.ts` exports the plugin factory expected by Signal K and registers routes through `plugin.registerWithRouter`.
- Browser admin/runtime UI - Web assets are built from `src/webapp/` into `public/` for the Signal K admin/plugin UI.

**Package Manager:**

- npm - `package-lock.json` is present.
- Package output is constrained to `lib/` and `public/` through `package.json` `files`.

## Frameworks

**Core:**

- Signal K plugin API - Plugin lifecycle, status, options, app message handling, and router registration are all driven from `src/index.ts`.
- Node built-ins - `dgram`, `crypto`, `zlib`, `fs`, `path`, and timers underpin the UDP, AES-GCM, Brotli, config, and lifecycle behavior.
- React 16 - Used by the bundled configuration panel in `src/webapp/components/PluginConfigurationPanel.tsx`.
- RJSF 5 - `@rjsf/core`, `@rjsf/utils`, and `@rjsf/validator-ajv8` render and validate the configuration UI.
- Webpack 5 Module Federation - `webpack.config.js` exposes `./PluginConfigurationPanel` as a Signal K admin UI module.

**Testing:**

- Jest 29 - Main runner configured in `package.json`.
- ts-jest 29 - Transforms TypeScript and TSX tests.
- babel-jest - Transforms JavaScript tests.
- React Testing Library - Component tests for the webapp panel.

**Build/Dev:**

- TypeScript compiler - `npm run build:ts`, `npm run check:ts`, and `tsconfig.json` for backend code.
- ts-loader + webpack - Webapp build uses `tsconfig.webapp.json`.
- ESLint 8 - Root `.eslintrc.js` defines lint rules for source and tests.
- Prettier 3 - Root `.prettierrc.js` defines formatting.
- Husky + lint-staged - `prepare` installs hooks and `lint-staged` formats staged JS/TS/JSON/Markdown.

## Key Dependencies

**Critical:**

- `@msgpack/msgpack` - Optional binary serialization for delta payloads.
- `ping-monitor` - v1 client reachability and RTT checks.
- `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8` - Shared schema-driven config UI.
- `react`, `react-dom`, `react-test-renderer` - Admin UI rendering and tests.

**Internal Node capabilities:**

- `node:crypto` / `crypto` - AES-256-GCM payload encryption, HMAC control-packet authentication, PBKDF2 key stretching, and timing-safe token checks.
- `node:zlib` / `zlib` - Brotli compression and decompression.
- `dgram` - UDP client/server sockets.
- `fs` and `fs.promises` - Runtime config files, atomic saves, file watchers, and migration helpers.

## Configuration

**Environment:**

- `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` can provide the management API token.
- `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` can force fail-closed management API behavior when no token is configured.
- `.env*` files are ignored by `.gitignore`; do not copy local values into docs or commits.

**Build:**

- `tsconfig.json` - Strict backend TypeScript compilation from `src/**/*.ts` to `lib/`, excluding `src/webapp`.
- `tsconfig.webapp.json` - Browser/React TypeScript compilation for `src/webapp/**/*.ts`, `src/webapp/**/*.tsx`, and `src/shared/**/*.ts`.
- `webpack.config.js` - Browser bundle, Module Federation remote, copied icons, and production CSS extraction.
- `.babelrc` - Babel preset config for JavaScript test transforms.

**Runtime configuration:**

- Main plugin schema is built in `src/index.ts` from shared schema fragments in `src/shared/connection-schema.ts`.
- Human-readable configuration docs live in `docs/configuration-reference.md`.
- Example configurations live in `samples/`.

## Platform Requirements

**Development:**

- Windows, macOS, or Linux with Node.js >=16 and npm.
- `npm install`, `npm run build`, `npm test`, `npm run lint`, and `npm run check:ts` are the main local checks.

**Production:**

- Installed as a Signal K plugin package.
- Runtime artifacts are `lib/` and `public/`.
- Requires UDP reachability between peers and matching per-connection `secretKey`, `protocolVersion`, and encoding flags.

---

_Stack analysis: 2026-04-30_
_Update after major dependency, runtime, or package-layout changes_
