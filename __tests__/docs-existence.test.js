"use strict";

/**
 * Doc-existence gate (rewrite plan doc 06 §6.5, doc 07 phases 0 & 9).
 *
 * The README advertises a "Documentation map" of `docs/*.md` files. Today 11
 * of them are missing (the drift this gate exists to prevent from recurring).
 *
 * Phase 0 wires the gate up but does NOT fail the build on the known backlog:
 * docs that already exist are asserted live; the missing ones are marked
 * `test.skip` with a pending note. Phase 9 creates the docs (or corrects the
 * README map) and removes them from KNOWN_MISSING, at which point each becomes
 * a live, enforced assertion automatically.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// Known-missing docs, tracked for Phase 9. Remove an entry once it is created;
// the parser below will then assert its existence live. This list is the
// single place the backlog is acknowledged.
const KNOWN_MISSING = new Set([
  "docs/architecture-overview.md",
  "docs/configuration-reference.md",
  "docs/api-reference.md",
  "docs/protocol-v2.md",
  "docs/protocol-v3-spec.md",
  "docs/bonding.md",
  "docs/congestion-control.md",
  "docs/metrics.md",
  "docs/management-tools.md",
  "docs/security.md",
  "docs/performance-tuning.md",
  "docs/troubleshooting.md"
]);

/** Extract every `docs/<name>.md` path the README references. */
function referencedDocs(text) {
  const found = new Set();
  const re = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0]);
  }
  return [...found].sort();
}

describe("README documentation map", () => {
  const docs = referencedDocs(README);

  test("the README references a documentation map", () => {
    expect(README).toMatch(/##\s+Documentation map/);
    expect(docs.length).toBeGreaterThan(0);
  });

  for (const doc of docs) {
    const exists = fs.existsSync(path.join(ROOT, doc));
    if (KNOWN_MISSING.has(doc)) {
      // Pending Phase 9. Skipped so the known backlog does not fail CI, but it
      // stays visible in the test report.
      test.skip(`${doc} exists (pending Phase 9)`, () => {});
    } else {
      test(`${doc} exists`, () => {
        expect(exists).toBe(true);
      });
    }
  }

  test("KNOWN_MISSING contains no doc that already exists", () => {
    // Forces the backlog to shrink: once a doc is created, it must be removed
    // from KNOWN_MISSING (which flips it to a live assertion above).
    for (const doc of KNOWN_MISSING) {
      expect(fs.existsSync(path.join(ROOT, doc))).toBe(false);
    }
  });
});
