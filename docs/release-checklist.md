# Release Checklist

Run this sequence before publishing a package or changing release automation.

1. `npm run lint`
2. `npm run format:check`
3. `npm run check:ts`
4. `npx tsc -p tsconfig.webapp.json --noEmit`
5. `npm run build`
6. `npm test`
7. `npm run check:release-docs`
8. `npm pack --ignore-scripts`

The release documentation check verifies that public docs use the package
version declared in `package.json`, that architecture references point at the
current source modules, and that the publish workflow builds before packing.
