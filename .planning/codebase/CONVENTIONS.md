---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Coding Conventions

**Analysis Date:** 2026-04-30

## Naming Patterns

**Files:**

- Use kebab-case for most TypeScript modules: `connection-config.ts`, `config-watcher.ts`, `pipeline-v2-server.ts`.
- Preserve established PascalCase names where already used for class/component identity: `CircularBuffer.ts`, `PluginConfigurationPanel.tsx`.
- Keep route groups in `src/routes/` named for the API area: `metrics.ts`, `monitoring.ts`, `connections.ts`.
- Keep tests in `__tests__/` with `.test.js`; v2/v3 protocol tests go under `__tests__/v2/`.

**Functions:**

- Use camelCase for functions and methods.
- Use `createX` for factories: `createInstance`, `createRoutes`, `createPipelineV2Client`.
- Use `validateX`, `sanitizeX`, `normalizeX`, `deriveX`, and `findX` for config helpers in `src/connection-config.ts`.
- Use `handleX` for event/control handlers and `register` for route module setup.

**Variables:**

- Use camelCase for normal variables and state fields.
- Use UPPER_SNAKE_CASE for module constants: `MAX_SAFE_UDP_PAYLOAD`, `RATE_LIMIT_WINDOW`, `AUTH_TAG_LENGTH`.
- Internal private-ish helpers sometimes use a leading underscore in complex modules: `_getOrCreateSession`, `_sendNAK`, `_pruneRetransmitQueue`.

**Types:**

- Use PascalCase interfaces and types without an `I` prefix: `ConnectionConfig`, `InstanceState`, `MetricsApi`, `RouteContext`.
- Keep shared contract interfaces in `src/types.ts` or `src/routes/types.ts`.
- Prefer literal string unions and object constants over TypeScript enums in protocol code.

## Code Style

**Formatting:**

- Prettier config lives in `.prettierrc.js`.
- Use semicolons.
- Use double quotes.
- Use 2-space indentation and no tabs.
- Use trailing commas only when required by syntax; `trailingComma` is `"none"`.
- Keep print width near 100 characters.
- Use LF line endings.

**Linting:**

- ESLint config lives in `.eslintrc.js`.
- Rules enforce `eqeqeq`, `no-var`, `prefer-const`, curly braces, no eval, no implied eval, no throw literals, and double quotes.
- `no-console` is a warning, with `console.warn` and `console.error` allowed.
- Tests allow console and async patterns where useful.
- Run with `npm run lint`.

## Import Organization

**Order:**

1. Node built-ins and external packages.
2. Internal runtime modules.
3. Internal type imports.

**Patterns:**

- Backend modules often use `import * as dgram from "dgram"` or `import crypto from "node:crypto"` depending on the file.
- Use `import type { ... } from "./types"` for type-only imports.
- Keep shared frontend/backend imports from `src/shared/`.
- There are no path aliases; use relative imports.

**Module format:**

- Source is TypeScript but compiled to CommonJS for backend/plugin runtime.
- `src/index.ts` uses `module.exports = function createPlugin(...)` to match Signal K plugin expectations.
- Some modules use `export =` for CommonJS-compatible exports, for example `src/routes.ts`.
- Prefer named exports for most utility modules and classes.

## Error Handling

**Patterns:**

- Validate early at boundaries, especially plugin startup, API routes, runtime config writes, and packet parsing.
- Route handlers wrap logic in `try/catch` and return JSON errors with appropriate status codes.
- Runtime transport errors should log through `app.error` or `app.debug` and record metrics with `recordError` when available.
- Packet parsing/decryption failures drop the packet and increment malformed/encryption/error metrics rather than forwarding partial data.
- Config loading uses discriminated result objects in `src/config-io.ts` where callers need to distinguish not-found from parse/read errors.

**Async and resources:**

- Timers, sockets, watchers, and pipeline intervals must be cleared from `stop()` paths.
- If a change adds a timer or listener to `src/instance.ts`, `src/pipeline-v2-client.ts`, `src/pipeline-v2-server.ts`, or `src/bonding.ts`, add matching cleanup.
- Prefer atomic file writes through `saveConfigFile` rather than direct writes for runtime JSON.

## Logging

**Framework:**

- Use Signal K `app.debug` and `app.error` in plugin/runtime code.
- Include instance context when behavior is per connection: `[${instanceId}]`.
- CLI code may use stdout/stderr for user-facing command output.

**Patterns:**

- Log state transitions, socket errors, config parse/load failures, dropped malformed packets, and recovery attempts.
- Do not log plaintext `secretKey`, management tokens, or full auth headers.
- API responses should redact sensitive fields through helpers like `redactSecretKeys` or `sanitizeOptions`.

## Comments

**When to comment:**

- Explain protocol details, security-sensitive behavior, race prevention, lifecycle ordering, and non-obvious performance tradeoffs.
- Keep comments concise and close to the code they explain.
- Existing code uses JSDoc for public/factory modules and focused inline comments for tricky state transitions.

**TODO comments:**

- No active `TODO`, `FIXME`, `HACK`, or `XXX` markers were found in tracked source during this mapping pass.
- Prefer filing or documenting follow-up work instead of leaving vague markers.

## Function Design

**Size and scope:**

- Small helpers are common for validation and route code.
- Large runtime modules still contain nested helpers; when editing them, keep new helpers focused and local unless they are reused across modules.
- Use guard clauses for invalid inputs and stopped-state checks.

**Parameters:**

- Use options objects for multi-field setup, as in `createWatcherWithRecovery`, `CongestionControl`, `BondingManager`, and pipeline factories.
- Preserve existing function signatures for public pipeline/route APIs unless intentionally migrating tests and docs.

**Return values:**

- Return structured snapshots for API/UI state, for example congestion state, bonding state, metrics responses, and source registry snapshots.
- Return `null` for absent bundle/config lookup patterns already established in route helpers.

## Module Design

**Exports:**

- Keep implementation-specific helpers unexported.
- Export shared primitives and contracts where tests or sibling modules need them: `PacketBuilder`, `PacketParser`, `CongestionControl`, `createBondingManager`, `validateConnectionConfig`.
- For route modules, export only `register`.

**Shared schema pattern:**

- Add connection schema fields in `src/shared/connection-schema.ts`, then use them from both `src/index.ts` and `src/webapp/components/PluginConfigurationPanel.tsx`.
- Mirror runtime validation in `src/connection-config.ts`.

**Backward compatibility:**

- Preserve legacy flat config handling unless a migration deliberately removes it.
- Preserve legacy management token header `X-Management-Token` unless a breaking release documents removal.

---

_Convention analysis: 2026-04-30_
_Update when formatting, linting, export, schema, or lifecycle conventions change_
