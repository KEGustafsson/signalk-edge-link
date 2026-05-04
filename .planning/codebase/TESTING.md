---
last_mapped_commit: a75c933eae70417f99a23fd041cbc7960b26ac6d
mapped_at: 2026-04-30
scope: full repo
---

# Testing Patterns

**Analysis Date:** 2026-04-30

## Test Framework

**Runner:**

- Jest 29, configured in `package.json`.
- Default environment is `node`.
- `ts-jest` transforms TypeScript and TSX.
- `babel-jest` transforms JavaScript.
- `jest-environment-jsdom` is available for browser/component tests.

**Assertion Library:**

- Jest built-in `expect`.
- Common matchers include `toBe`, `toEqual`, `toMatchObject`, `toThrow`, `rejects.toThrow`, `toHaveBeenCalledWith`, and Testing Library DOM matchers.

**Run Commands:**

```bash
npm test
npm run test:v2
npm run test:integration
npm run test:watch
npm run test:coverage
npm run check:ts
npx tsc -p tsconfig.webapp.json --noEmit
npm run lint
```

## Test File Organization

**Location:**

- Main tests live in `__tests__/`.
- Protocol v2/v3 focused tests live in `__tests__/v2/`.
- Integration suites live in `test/integration/`.
- Benchmarks and stress tools live in `test/benchmarks/`.
- Shared simulator helper lives in `test/network-simulator.js`.

**Naming:**

- Unit and component tests use `*.test.js`.
- Integration tests under `test/integration/` also use `*.test.js`.
- v2 protocol tests are grouped by subsystem, such as `packet.test.js`, `bonding.test.js`, `pipeline-v2-server.test.js`, and `meta-end-to-end.test.js`.

**Structure:**

```text
__tests__/
|-- routes.*.test.js
|-- connection-config.test.js
|-- PluginConfigurationPanel.test.js
|-- pipeline-v2-client.test.js
`-- v2/
    |-- packet.test.js
    |-- pipeline-v2-client-auth.test.js
    |-- pipeline-v2-server-coverage.test.js
    |-- bonding-failover-recovery.test.js
    `-- meta-end-to-end.test.js

test/
|-- integration/
`-- benchmarks/
```

## Test Structure

**Suite Organization:**

```javascript
describe("Module or behavior", () => {
  beforeEach(() => {
    // reset mocks, timers, state, or fixtures
  });

  test("handles the expected case", async () => {
    const result = await subjectUnderTest();
    expect(result).toEqual(expected);
  });

  test("rejects invalid input", () => {
    expect(() => subjectUnderTest(null)).toThrow("expected message");
  });
});
```

**Patterns:**

- Use `describe` blocks by module, function, route, or behavior.
- Prefer focused tests for validation and protocol primitives.
- Use fake route/router objects for route registration tests.
- Use mock Signal K `app` objects for plugin/runtime tests.
- Use network simulators and fake sockets for reliability behavior instead of real external services.

## Mocking

**Framework:**

- Jest built-in mocks: `jest.fn`, spies, fake timers, and module mocks where needed.
- React component tests use React Testing Library patterns with DOM assertions.

**Patterns:**

- Route tests build fake `req`, `res`, `next`, router, and instance registry objects.
- Pipeline tests create mock metrics APIs and mock `dgram`-like sockets.
- Time-dependent modules use fake timers or explicit timer control.
- Avoid mocking pure protocol helpers such as `PacketBuilder`, `PacketParser`, `SequenceTracker`, and `CongestionControl` when testing their behavior directly.

## Fixtures and Factories

**Test Data:**

- Tests commonly define local factory helpers inside the test file.
- Secret keys in tests are synthetic constants or repeated strings, not production secrets.
- Connection configs are built inline with overrides to exercise validation paths.
- Network simulation fixtures live under `test/` and `__tests__/v2/`.

**Where to add shared fixtures:**

- Prefer local helpers first.
- Put reusable simulation utilities under `test/`.
- Keep highly specific fixture setup next to the test file that uses it.

## Coverage

**Requirements:**

- Global Jest thresholds in `package.json`:
  - branches: 60
  - functions: 65
  - lines: 65
  - statements: 65

**Configuration:**

- Coverage directory: `coverage/`.
- `collectCoverageFrom` targets `lib/**/*.js` and excludes built webapp/component/utils directories.
- Generated output and coverage are ignored by `.gitignore`.

**Known coverage shape:**

- `docs/code-quality-report.md` states that `sequence.ts`, `packet.ts`, and `congestion.ts` are comparatively strong.
- The same report calls out `pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`, and `config-watcher.ts` as important coverage gaps.

## Test Types

**Unit Tests:**

- Scope: validation helpers, crypto, packet parsing/building, metrics, route helpers, source replication, config I/O, UI helper functions.
- Location: `__tests__/`.

**Protocol Behavior Tests:**

- Scope: v2/v3 ACK/NAK, sequence tracking, retransmit queue, control authentication, metadata packets, bonding, congestion, monitoring, and fuzzed packet parsing.
- Location: `__tests__/v2/`.

**Integration Tests:**

- Scope: multi-module pipeline behavior, reliability flows, protocol round trips, and system validation.
- Location: `test/integration/`.

**Benchmarks / Stress Tools:**

- Scope: reliability overhead, packet fuzzing, memory, latency, CPU, bandwidth efficiency, and baseline performance.
- Location: `test/benchmarks/`.

**Component/UI Tests:**

- Scope: plugin configuration panel, auth error handling, duplicate port validation, dirty state, and webapp helper functions.
- Location: `__tests__/PluginConfigurationPanel.test.js`, `__tests__/webapp.test.js`, and `__tests__/apiFetch.test.js`.

## Common Patterns

**Async Testing:**

```javascript
test("handles async operation", async () => {
  await expect(operation()).resolves.toMatchObject({ success: true });
});
```

**Error Testing:**

```javascript
test("throws on invalid input", () => {
  expect(() => validateConnectionConfig({})).toThrow;
});

test("rejects async failures", async () => {
  await expect(operation()).rejects.toThrow("expected");
});
```

**Route Testing:**

- Register route handlers into a fake router.
- Invoke the captured handler with fake request/response objects.
- Assert status code and JSON body.

**Snapshot Testing:**

- No snapshot testing convention was observed.

## Validation Strategy

**Narrow changes:**

- Run the relevant test file first, for example `npm test -- __tests__/connection-config.test.js`.
- Add route tests for endpoint behavior changes and config validation tests for schema/range changes.

**Protocol or lifecycle changes:**

- Run the touched unit test plus `npm run test:v2`.
- Add integration coverage from `test/integration/` when behavior crosses client/server boundaries.

**Release or broad changes:**

- Run `npm run lint`, `npm run check:ts`, `npx tsc -p tsconfig.webapp.json --noEmit`, `npm run build`, and `npm test`.

---

_Testing analysis: 2026-04-30_
_Update when test runner, coverage thresholds, or test organization changes_
