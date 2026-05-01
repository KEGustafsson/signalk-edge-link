# Phase 4: Schema, UI Type Safety, and Configuration Parity - Pattern Map

**Mapped:** 2026-05-01
**Scope:** Webapp configuration UI, shared connection schema, runtime validation, routes, docs, samples, and tests.

## File-to-Pattern Map

| Target File                                                   | Role                             | Closest Existing Analog                                                                     | Pattern to Preserve                                                                                                         |
| ------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.webapp.json`                                        | Webapp typecheck settings        | `tsconfig.json`                                                                             | Keep project-local TypeScript settings explicit; use focused tightening before broad strict-mode migration.                 |
| `src/webapp/components/PluginConfigurationPanel.tsx`          | React/RJSF configuration editor  | Existing `ConnectionCard`, `withId`, `withSchemaDefaults`, `connectionsEqual`, `handleSave` | Preserve `_id` as frontend-only, `connectionId` as persistent identity, dirty-state guard, and existing button/status copy. |
| `__tests__/PluginConfigurationPanel.test.js`                  | Component behavior tests         | Current RJSF mock and API fetch mock                                                        | Keep RJSF mocked; expose only enough mock hooks to trigger `onChange` and inspect form schema/form data.                    |
| `src/shared/connection-schema.ts`                             | Shared schema source             | `buildConnectionItemSchema()` and `buildWebappConnectionSchema()`                           | Add field definitions once and consume them from backend/webapp schema builders.                                            |
| `src/connection-config.ts`                                    | Runtime validation/sanitization  | `validateConnectionConfig()`, `sanitizeConnectionConfig()`, `VALID_CONNECTION_KEYS`         | Validate public fields before startup/save; sanitize only known keys; delete client-only fields from server mode.           |
| `src/routes/config.ts`                                        | Plugin config save route         | Existing redacted secret restoration and connection validation loop                         | Preserve top-level management token handling and per-connection validation order.                                           |
| `src/routes/connections.ts`                                   | Per-connection CRUD route        | Existing POST/PATCH validation and mutable-field allowlist                                  | Allow the same public connection fields in route PATCH as in plugin config.                                                 |
| `docs/configuration-schema.json`                              | Published config schema artifact | Existing hand-maintained JSON schema                                                        | Update only the fields needed for parity; keep JSON valid and examples realistic.                                           |
| `docs/configuration-reference.md` and `docs/api-reference.md` | Operator docs                    | Phase 1 docs truth corrections                                                              | Update public field lists and API body examples when source truth changes.                                                  |
| `samples/*.json`                                              | Operator examples                | Existing minimal/development/v2/v3 samples                                                  | Keep samples valid and realistic; do not add every optional field to every sample.                                          |

## Concrete Code Excerpts

### Webapp RJSF Boundary

```ts
function handleFormChange(e: any) {
  const next: ConnectionData = e.formData;
  if (next.serverType !== conn.serverType) {
    const base = next.serverType === "server"
      ? defaultServerConnection(next.name)
      : defaultClientConnection(next.name);
```

Replace the explicit `any` with a local event shape and guard `formData` before use. Preserve the existing server/client mode switch logic.

### Runtime Sanitization Boundary

```ts
export const VALID_CONNECTION_KEYS: string[] = [
  "connectionId",
  "name",
  "serverType",
  "udpPort",
  "secretKey",
  ...
];
```

Any public connection key must appear here or it will be dropped when saved through route/config flows.

### Webapp Schema Builder

```ts
export function buildWebappConnectionSchema(
  isClient: boolean,
  protocolVersion: number | undefined
): SchemaFragment {
  const isReliableProtocol = Number(protocolVersion) >= 2;
  const props: Record<string, SchemaFragment> = { ...commonConnectionProperties };
```

Use this function for protocol-sensitive UI schema tests; do not duplicate field-selection logic in tests.

### Plugin Config Save Route

```ts
const finalConfig: Record<string, unknown> = {
  connections: connectionList.map((connection: Record<string, unknown>) =>
    sanitizeConnectionConfig(connection)
  )
};
```

Per-connection fields must survive `sanitizeConnectionConfig()` before persisted plugin config is restarted.

## Test Pattern Map

| New/Changed Test                | Existing Pattern                                                      | Notes                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| RJSF onChange dirty-state tests | `__tests__/PluginConfigurationPanel.test.js` API/RJSF mocks           | Extend the mock to capture `onChange` or render a deterministic test control.                                                      |
| Schema field parity tests       | `__tests__/schema-compat.test.js`                                     | Prefer importing `buildConnectionItemSchema()` / `buildWebappConnectionSchema()` over reimplementing schema logic.                 |
| Runtime config field tests      | `__tests__/connection-config.test.js`                                 | Use `makeValidClient()` and `makeValidServer()` helpers.                                                                           |
| Route validation parity         | `__tests__/routes.config-validation.test.js`                          | Existing tests compare legacy and per-connection 400 payloads. Add positive/negative cases for public connection fields as needed. |
| Docs/sample parity              | New `__tests__/config-docs-parity.test.js` or `schema-compat.test.js` | Read real docs schema and sample JSON; no new dependency required.                                                                 |

## Constraints

- Do not rewrite the legacy `src/webapp/index.ts` dashboard to satisfy full strict mode.
- Do not replace RJSF or change the form rendering library.
- Do not persist frontend `_id`.
- Do not move `managementApiToken` into per-connection config.
- Do not add a database schema push task; this repository has no ORM schema files in Phase 4 scope.

## PATTERN MAPPING COMPLETE
