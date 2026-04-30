# Research: Stack

**Source:** Local codebase map and package metadata
**Date:** 2026-04-30

## Runtime

- Node.js >=16 is the declared runtime floor.
- Signal K server hosts the plugin and calls the exported lifecycle factory.
- UDP transport uses Node built-ins including `dgram`, `crypto`, `zlib`, `fs`, and timers.
- Browser management UI is bundled into `public/` for the Signal K admin/plugin surface.

## Language And Build

- TypeScript is the primary implementation language.
- Backend code builds through `tsc` using `tsconfig.json`.
- Web UI builds through Webpack 5 and `tsconfig.webapp.json`.
- React 16 and RJSF 5 render the configuration panel.

## Validation

- Jest 29 is the main runner, with ts-jest for TypeScript and TSX.
- ESLint and Prettier are configured for source and docs.
- Husky and lint-staged format staged JS, TS, JSON, and Markdown.
- CI publishes packages after lint, type checks, build, and tests.

## Planning Implications

- Documentation-only GSD changes can be validated with formatting and secret checks.
- Source phases should run the narrow Jest suites first, then `npm run check:ts`, `npm run lint`, and `npm test` as scope grows.
- Release-affecting phases should run `npm run build` and package verification before completion.
