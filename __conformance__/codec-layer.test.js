"use strict";

/**
 * Phase 1 exit gate (rewrite plan doc 07): the NEW codec layer reproduces the
 * frozen golden vectors byte-for-byte.
 *
 * The main `conformance.test.js` proves the wire via the legacy import paths
 * (which are now re-export shims into `src/codec/**`). This file additionally
 * asserts the codec modules at their NEW layered paths directly, so the gate
 * keeps proving the real implementation even after the shims are deleted at
 * cutover.
 *
 * Modules are loaded through the `lib/** -> src/**` moduleNameMapper, i.e. the
 * TypeScript source.
 */

const buildVectors = require("./build-vectors");
const golden = require("./vectors/golden.json");

// Direct codec-layer paths (not the legacy shims).
const codecMods = {
  crypto: require("../lib/codec/crypto"),
  packet: require("../lib/codec/packet-codec"),
  compactDelta: require("../lib/codec/compact-delta"),
  valueDedup: require("../lib/codec/value-dedup"),
  pathDict: require("../lib/codec/path-dictionary"),
  metadata: require("../lib/codec/metadata-codec")
};

describe("Conformance: new codec layer reproduces golden vectors", () => {
  test("codec/* modules reproduce the full golden vector set", () => {
    const produced = buildVectors(codecMods);
    expect(JSON.parse(JSON.stringify(produced))).toEqual(golden);
  });
});
