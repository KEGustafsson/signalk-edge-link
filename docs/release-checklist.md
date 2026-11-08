# Release Checklist

Run these in order before publishing a package or changing release automation:

1. `npm run lint`
2. `npm run format:check`
3. `npm run check:ts`
4. `npx tsc -p tsconfig.webapp.json --noEmit`
5. `npm run build`
6. `npm test`
7. `npm run check:release-docs`
8. `npm pack --ignore-scripts`

`npm run check:release-docs` (`scripts/check-release-truth.js`) fails when:

- `docs/GUIDE.md`, `docs/README.md` or `docs/api-reference.md` lacks `current: <package.json version>` or carries a different `current:` version;
- `docs/GUIDE.md` names a retired source file (`bonding-manager.ts`, `congestion-control.ts`, `alert-manager.ts`, `sequence-tracker.ts`) or lacks `bonding.ts`, `congestion.ts`, `monitoring.ts`, `sequence.ts`;
- `package.json` `files` omits `lib/` or `public/`;
- the text of `.github/workflows/publish-packages.yml` lacks `npm run build`, `npm run check:release-docs` or `npm pack`, or the first occurrence of either of the first two comes after the first `npm pack`. This is a text search; it does not check that the commands run or in which step;
- `docs/configuration-reference.md` does not state the fleet `pathFilter` limits from `src/foundation/constants.ts`.
