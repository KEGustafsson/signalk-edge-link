"use strict";

/**
 * Property / fuzz tests for the pure L1 codec layer (rewrite plan doc 06 §6.3
 * "extend the existing fuzz-packet-parser approach to all codecs").
 *
 * Two kinds of invariant per codec:
 *   - round-trip: decode(encode(x)) reconstructs x for randomized inputs;
 *   - robustness: decode/merge never throws an unexpected (non-Error) value
 *     on hostile/random input.
 *
 * Modules are loaded at their NEW codec-layer paths so the rewrite target is
 * what gets fuzzed.
 */

const nodeCrypto = require("crypto");

const { encryptBinary, decryptBinary } = require("../../lib/codec/crypto");
const {
  deltaBuffer,
  compressPayload,
  brotliDecompressAsync
} = require("../../lib/codec/compression");
const {
  createValueDedupState,
  dedupDeltaArray,
  undedupDeltaArray
} = require("../../lib/codec/value-dedup");
const { encodePath, decodePath, getAllPaths } = require("../../lib/codec/path-dictionary");
const { encodeCompactDelta, decodeCompactDelta } = require("../../lib/codec/compact-delta");
const { mergeSourceSnapshot } = require("../../lib/codec/source-codec");

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

// Errors thrown by node's native crypto cross the Jest vm realm boundary, so
// `instanceof Error` (sandbox Error) can be false. Use a realm-agnostic check.
const isError = (e) => e instanceof Error || Object.prototype.toString.call(e) === "[object Error]";

function randomKey() {
  // Exercise all three accepted key formats.
  switch (rand(3)) {
    case 0:
      return nodeCrypto.randomBytes(32).toString("hex"); // 64-char hex
    case 1:
      return nodeCrypto.randomBytes(32).toString("base64"); // 44-char base64
    default:
      return nodeCrypto.randomBytes(16).toString("hex"); // 32-char ASCII (raw)
  }
}

const PATHS = ["navigation.speedOverGround", "environment.wind.speedApparent", "a.b.c", "x"];

function randomValue(depth = 0) {
  switch (rand(depth > 1 ? 4 : 6)) {
    case 0:
      return rand(1000) - 500 + Math.random();
    case 1:
      return nodeCrypto.randomBytes(rand(8)).toString("hex");
    case 2:
      return rand(2) === 0;
    case 3:
      return null;
    case 4:
      return Array.from({ length: rand(4) }, () => randomValue(depth + 1));
    default:
      return { lat: Math.random(), lon: Math.random() };
  }
}

function randomDelta() {
  const ctx = pick(["vessels.self", "vessels.urn:mrn:imo:mmsi:200", undefined]);
  const values = Array.from({ length: 1 + rand(3) }, () => ({
    path: pick(PATHS),
    value: randomValue()
  }));
  const delta = { updates: [{ values }] };
  if (ctx !== undefined) {
    delta.context = ctx;
  }
  return delta;
}

describe("codec fuzz — crypto AES-256-GCM", () => {
  test("round-trips random plaintext under every key format", () => {
    for (let i = 0; i < 300; i++) {
      const key = randomKey();
      // Non-empty: real DATA payloads always carry a delta, and decryptBinary
      // deliberately rejects a zero-length ciphertext (length <= IV+tag).
      const pt = nodeCrypto.randomBytes(1 + rand(2048));
      const out = decryptBinary(encryptBinary(pt, key), key);
      expect(out.equals(pt)).toBe(true);
    }
  });

  test("a wrong key fails authentication (throws, never returns garbage)", () => {
    for (let i = 0; i < 100; i++) {
      const pt = nodeCrypto.randomBytes(1 + rand(256));
      const blob = encryptBinary(pt, randomKey());
      expect(() => decryptBinary(blob, randomKey())).toThrow();
    }
  });

  test("never crashes on random ciphertext", () => {
    const key = randomKey();
    for (let i = 0; i < 300; i++) {
      try {
        decryptBinary(nodeCrypto.randomBytes(rand(80)), key);
      } catch (e) {
        expect(isError(e)).toBe(true);
      }
    }
  });
});

describe("codec fuzz — compression", () => {
  test("compressPayload/brotli round-trips random buffers (text + generic)", async () => {
    for (let i = 0; i < 120; i++) {
      const buf = nodeCrypto.randomBytes(rand(4096));
      const useMsgpack = rand(2) === 0;
      const restored = await brotliDecompressAsync(await compressPayload(buf, useMsgpack));
      expect(Buffer.from(restored).equals(buf)).toBe(true);
    }
  });

  test("deltaBuffer is decodable JSON/MessagePack for random deltas", () => {
    for (let i = 0; i < 200; i++) {
      const delta = randomDelta();
      const json = deltaBuffer(delta, false);
      expect(JSON.parse(json.toString("utf8"))).toEqual(delta);
    }
  });
});

describe("codec fuzz — value dedup", () => {
  test("undedup(dedup(seq)) reconstructs the original delta sequence", () => {
    for (let trial = 0; trial < 80; trial++) {
      const seq = Array.from({ length: 1 + rand(8) }, () => randomDelta());
      const sender = createValueDedupState();
      const receiver = createValueDedupState();
      const encoded = dedupDeltaArray(seq, sender);
      const decoded = undedupDeltaArray(encoded, receiver);
      expect(decoded).toEqual(seq);
    }
  });
});

describe("codec fuzz — path dictionary", () => {
  test("known dictionary paths round-trip through encode/decode", () => {
    for (const path of getAllPaths()) {
      const id = encodePath(path);
      expect(decodePath(id)).toBe(path);
    }
  });

  test("arbitrary path strings are preserved (encode→decode identity)", () => {
    for (let i = 0; i < 300; i++) {
      const path = Array.from({ length: 1 + rand(5) }, () =>
        nodeCrypto.randomBytes(2).toString("hex")
      ).join(".");
      const id = encodePath(path);
      // Unknown paths pass through unchanged; known ones round-trip.
      expect(decodePath(id)).toBe(path);
    }
  });
});

describe("codec fuzz — compact delta", () => {
  test("encode→decode reconstructs generated deltas", () => {
    for (let i = 0; i < 200; i++) {
      const delta = randomDelta();
      const decoded = decodeCompactDelta(encodeCompactDelta(delta));
      // Absent context normalizes (undefined → null/"") through the codec.
      const norm = (c) => (c === undefined || c === null || c === "" ? null : c);
      expect(norm(decoded.context)).toEqual(norm(delta.context));
      expect(decoded.updates[0].values).toEqual(delta.updates[0].values);
    }
  });

  test("decodeCompactDelta never crashes on random arrays", () => {
    for (let i = 0; i < 300; i++) {
      const junk = Array.from({ length: rand(7) }, () => randomValue());
      try {
        decodeCompactDelta(junk);
      } catch (e) {
        expect(isError(e)).toBe(true);
      }
    }
  });
});

describe("codec fuzz — source snapshot merge (DoS / pollution safety)", () => {
  function fakeApp() {
    const root = { sources: {} };
    return {
      debug: () => {},
      signalk: { retrieve: () => root },
      _root: root
    };
  }

  test("merges hostile random input without throwing or polluting the prototype", () => {
    for (let i = 0; i < 200; i++) {
      const app = fakeApp();
      const hostile = {
        __proto__: { polluted: true },
        constructor: { bad: true },
        ["normal" + rand(5)]: randomValue(),
        deep: randomValue()
      };
      expect(() => mergeSourceSnapshot(app, hostile)).not.toThrow();
    }
    expect({}.polluted).toBeUndefined();
  });
});
