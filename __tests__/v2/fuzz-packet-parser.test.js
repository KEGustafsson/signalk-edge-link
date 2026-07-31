"use strict";

const { PacketBuilder, PacketParser, HEADER_SIZE, MAGIC } = require("../../lib/packet");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { createSeededRandom, iters, logSeed } = require("../helpers/seeded-random");

// Module-scoped so every describe block in this file shares one reproducible
// generator. Seeded from FUZZ_SEED (see helpers/seeded-random).
const rng = createSeededRandom();
beforeAll(() => logSeed("fuzz-packet-parser", rng.seed));

describe("PacketParser fuzz tests", () => {
  const parser = new PacketParser();
  const builder = new PacketBuilder();

  function randomBuffer(minLen, maxLen) {
    const len = minLen + Math.floor(rng.random() * (maxLen - minLen + 1));
    return rng.bytes(len);
  }

  test("should not crash on completely random buffers", () => {
    for (let i = 0; i < iters(500); i++) {
      const buf = randomBuffer(0, 2000);
      try {
        parser.parseHeader(buf);
      } catch (e) {
        // Errors are expected and acceptable — crashes are not
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("should not crash on buffers with valid magic but random payload", () => {
    for (let i = 0; i < iters(500); i++) {
      const buf = randomBuffer(2, 200);
      buf[0] = MAGIC[0];
      buf[1] = MAGIC[1];
      try {
        parser.parseHeader(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("should not crash on buffers with valid magic and version but random rest", () => {
    for (let i = 0; i < iters(500); i++) {
      const buf = randomBuffer(HEADER_SIZE, 500);
      buf[0] = MAGIC[0];
      buf[1] = MAGIC[1];
      buf[2] = 0x02; // valid version
      try {
        parser.parseHeader(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("should not crash on truncated valid packets", () => {
    const payload = Buffer.from("test data");
    const validPacket = builder.buildDataPacket(payload, { compressed: false });

    for (let len = 0; len < validPacket.length; len++) {
      const truncated = validPacket.subarray(0, len);
      try {
        parser.parseHeader(truncated);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  // NOTE: these assertions are deliberately NOT inside a try/catch. Asserting
  // in a catch block means the test passes silently when the parser stops
  // throwing at all — i.e. exactly when the integrity check has regressed.
  test("rejects packets with corrupted CRC", () => {
    for (let i = 0; i < iters(100); i++) {
      const payload = randomBuffer(1, 100);
      const validPacket = builder.buildDataPacket(payload, { compressed: false });
      const corrupted = Buffer.from(validPacket);
      // Flip a random bit in the CRC field (bytes 13-14)
      const crcOffset = 13 + Math.floor(rng.random() * 2);
      corrupted[crcOffset] ^= 1 << Math.floor(rng.random() * 8);
      // Any bit flip in the CRC field must fail header validation.
      expect(() => parser.parseHeader(corrupted)).toThrow(/CRC/i);
    }
  });

  test("rejects packets whose declared payload length does not match the body", () => {
    for (let i = 0; i < iters(100); i++) {
      const payload = randomBuffer(1, 50);
      const validPacket = builder.buildDataPacket(payload, { compressed: false });
      const corrupted = Buffer.from(validPacket);
      // Corrupt payload length field (bytes 9-12) to a value that cannot match
      // the actual body length, so the outcome is deterministic.
      const actualPayloadLength = validPacket.length - 15;
      let bogus = Math.floor(rng.random() * 100000);
      if (bogus === actualPayloadLength) {
        bogus += 1;
      }
      corrupted.writeUInt32BE(bogus, 9);
      // Rewriting the length also invalidates the CRC, so either check may fire
      // first — but one of them must.
      expect(() => parser.parseHeader(corrupted)).toThrow(/CRC|[Pp]ayload length/);
    }
  });

  test("should not crash on zero-length buffer", () => {
    expect(() => parser.parseHeader(Buffer.alloc(0))).toThrow();
  });

  test("should not crash on non-buffer input", () => {
    const inputs = [null, undefined, 42, "string", {}, [], true];
    for (const input of inputs) {
      expect(() => parser.parseHeader(input)).toThrow();
    }
  });

  test("should not crash with all possible packet type values", () => {
    for (let type = 0; type <= 255; type++) {
      const buf = Buffer.alloc(HEADER_SIZE + 4);
      buf[0] = MAGIC[0];
      buf[1] = MAGIC[1];
      buf[2] = 0x02;
      buf[3] = type;
      buf[4] = 0; // flags
      buf.writeUInt32BE(0, 5); // seq
      buf.writeUInt32BE(4, 9); // payload length
      try {
        parser.parseHeader(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("should not crash with all possible flag combinations", () => {
    for (let flags = 0; flags <= 255; flags++) {
      const buf = Buffer.alloc(HEADER_SIZE + 4);
      buf[0] = MAGIC[0];
      buf[1] = MAGIC[1];
      buf[2] = 0x02;
      buf[3] = 0x01; // DATA
      buf[4] = flags;
      buf.writeUInt32BE(0, 5); // seq
      buf.writeUInt32BE(4, 9); // payload length
      try {
        parser.parseHeader(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("isV2Packet should handle random inputs without crashing", () => {
    for (let i = 0; i < iters(500); i++) {
      const buf = randomBuffer(0, 100);
      const result = parser.isV2Packet(buf);
      expect(typeof result).toBe("boolean");
    }
    // Non-buffer inputs
    expect(parser.isV2Packet(null)).toBe(false);
    expect(parser.isV2Packet(undefined)).toBe(false);
    expect(parser.isV2Packet("string")).toBe(false);
    expect(parser.isV2Packet(42)).toBe(false);
  });

  test("parseACKPayload either returns a uint32 or throws — never garbage", () => {
    for (let i = 0; i < iters(100); i++) {
      const buf = randomBuffer(0, 10);
      let result;
      let threw = false;
      try {
        result = parser.parseACKPayload(buf);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(Error);
      }
      if (!threw) {
        // A successful parse must yield a valid uint32 sequence.
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });

  test("parseNAKPayload either returns uint32 sequences or throws", () => {
    for (let i = 0; i < iters(100); i++) {
      const buf = randomBuffer(0, 30);
      let result;
      let threw = false;
      try {
        result = parser.parseNAKPayload(buf);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(Error);
      }
      if (!threw) {
        expect(Array.isArray(result)).toBe(true);
        for (const seq of result) {
          expect(Number.isInteger(seq)).toBe(true);
          expect(seq).toBeGreaterThanOrEqual(0);
          expect(seq).toBeLessThanOrEqual(0xffffffff);
        }
      }
    }
  });
});

describe("decryptBinary fuzz tests", () => {
  const validKey = "a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "d".repeat(8);

  test("should not crash on random buffers", () => {
    for (let i = 0; i < iters(500); i++) {
      const buf = rng.bytes(Math.floor(rng.random() * 200));
      try {
        decryptBinary(buf, validKey);
      } catch (e) {
        // OpenSSL errors may not pass instanceof Error across realms
        expect(e).toBeTruthy();
      }
    }
  });

  test("should not crash on buffers shorter than IV+AuthTag", () => {
    for (let len = 0; len <= 28; len++) {
      const buf = rng.bytes(len);
      try {
        decryptBinary(buf, validKey);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("rejects every corrupted ciphertext (bit flips)", () => {
    const plaintext = Buffer.from("test data for encryption");
    const encrypted = encryptBinary(plaintext, validKey);

    for (let i = 0; i < iters(100); i++) {
      const corrupted = Buffer.from(encrypted);
      const pos = Math.floor(rng.random() * corrupted.length);
      corrupted[pos] ^= 1 << Math.floor(rng.random() * 8);
      // AES-GCM has NO unused padding: the layout is [IV][ciphertext][tag], and
      // every byte is covered by authentication. A flip anywhere must fail.
      // This assertion is unconditional on purpose — the previous version
      // asserted inside a catch and treated "did not throw" as acceptable, so
      // it would have passed even if setAuthTag were removed entirely.
      expect(() => decryptBinary(corrupted, validKey)).toThrow();
    }
  });

  test("should reject decryption with wrong key", () => {
    const plaintext = Buffer.from("secret message");
    const encrypted = encryptBinary(plaintext, validKey);
    const wrongKey = "x".repeat(8) + "y".repeat(8) + "z".repeat(8) + "w".repeat(8);

    expect(() => decryptBinary(encrypted, wrongKey)).toThrow();
  });

  test("should not crash on non-buffer input", () => {
    const inputs = [null, undefined, 42, "string", {}, []];
    for (const input of inputs) {
      try {
        decryptBinary(input, validKey);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test("should round-trip correctly with valid data", () => {
    for (let i = 0; i < iters(100); i++) {
      const plaintext = rng.bytes(1 + Math.floor(rng.random() * 500));
      const encrypted = encryptBinary(plaintext, validKey);
      const decrypted = decryptBinary(encrypted, validKey);
      expect(decrypted).toEqual(plaintext);
    }
  });
});
