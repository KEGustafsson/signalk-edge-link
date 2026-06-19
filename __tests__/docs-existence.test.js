"use strict";

/**
 * Doc-existence gate (rewrite plan doc 06 §6.5, doc 07 phases 0 & 9).
 *
 * The README advertises a "Documentation map" of `docs/*.md` files. Every
 * referenced doc is a live assertion so `npm test` reports no skipped work.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

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
    test(`${doc} exists`, () => {
      expect(fs.existsSync(path.join(ROOT, doc))).toBe(true);
    });
  }
});
