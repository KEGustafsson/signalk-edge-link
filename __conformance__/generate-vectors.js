"use strict";

/**
 * Golden-vector generator for the frozen conformance suite (rewrite doc 06).
 *
 * Usage:
 *   npm run conformance:generate
 *   (= `npm run build:ts && node __conformance__/generate-vectors.js`)
 *
 * It loads the COMPILED modules from `lib/**` (build first) and writes:
 *
 *   - vectors/golden.json        deterministic wire/codec vectors (always
 *                                regenerated; conformance.test.js asserts the
 *                                SOURCE reproduces these byte-for-byte).
 *   - vectors/crypto-decrypt.json  frozen AEAD ciphertext blobs (written ONCE,
 *                                preserved on subsequent runs). Because the
 *                                AES-256-GCM IV is random per call, these can
 *                                never be "reproduced" — they are an immutable
 *                                record that the current code can still DECRYPT
 *                                them to the known plaintext.
 *
 * Commit the generated files. They are the immutable definition of the wire.
 */

const fs = require("fs");
const path = require("path");

const buildVectors = require("./build-vectors");

const LIB = path.resolve(__dirname, "..", "lib");
if (!fs.existsSync(LIB)) {
  // eslint-disable-next-line no-console
  console.error(
    "lib/ not found. Run `npm run build:ts` first (or use `npm run conformance:generate`)."
  );
  process.exit(1);
}

const mods = {
  crypto: require("../lib/crypto"),
  packet: require("../lib/packet"),
  compactDelta: require("../lib/compact-delta"),
  valueDedup: require("../lib/value-dedup"),
  pathDict: require("../lib/pathDictionary"),
  metadata: require("../lib/metadata")
};

const vectorsDir = path.join(__dirname, "vectors");
fs.mkdirSync(vectorsDir, { recursive: true });

// 1. Deterministic vectors — always regenerated.
const golden = buildVectors(mods);
fs.writeFileSync(path.join(vectorsDir, "golden.json"), JSON.stringify(golden, null, 2) + "\n");

// 2. Frozen AEAD decrypt vectors — generated ONCE, preserved thereafter so the
//    committed ciphertext stays immutable across regenerations.
const cryptoDecryptPath = path.join(vectorsDir, "crypto-decrypt.json");
if (!fs.existsSync(cryptoDecryptPath)) {
  const { encryptBinary } = mods.crypto;
  const plaintext = "conformance-plaintext: the quick brown fox ⚓";
  const ptBuf = Buffer.from(plaintext, "utf8");
  const cases = [
    {
      name: "hex-key",
      key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      options: {}
    },
    {
      name: "base64-key",
      key: Buffer.alloc(32, 7).toString("base64"),
      options: {}
    },
    {
      name: "ascii-key-raw",
      key: "edge-link-conformance-ascii-key!", // 32 chars
      options: {}
    },
    {
      name: "ascii-key-stretched",
      key: "edge-link-conformance-ascii-key!", // 32 chars
      options: { stretchAsciiKey: true }
    }
  ].map((c) => ({
    ...c,
    plaintextUtf8: plaintext,
    ciphertextB64: encryptBinary(ptBuf, c.key, c.options).toString("base64")
  }));

  fs.writeFileSync(
    cryptoDecryptPath,
    JSON.stringify(
      {
        schema: 1,
        description:
          "Frozen AES-256-GCM ciphertext. Random IV is baked in. The current " +
          "code must DECRYPT these to plaintextUtf8. Do not regenerate without a " +
          "reviewed protocol decision (delete the file to force regeneration).",
        cases
      },
      null,
      2
    ) + "\n"
  );
  // eslint-disable-next-line no-console
  console.log("Wrote frozen vectors/crypto-decrypt.json (first generation).");
} else {
  // eslint-disable-next-line no-console
  console.log("Preserved existing vectors/crypto-decrypt.json (immutable).");
}

// eslint-disable-next-line no-console
console.log("Wrote vectors/golden.json");
