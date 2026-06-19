const crypto = require("crypto");
const {
  encryptBinary,
  decryptBinary,
  validateSecretKey,
  normalizeKey,
  deriveKeyFromPassphrase,
  createControlPacketAuthTag,
  verifyControlPacketAuthTag,
  IV_LENGTH,
  AUTH_TAG_LENGTH
} = require("../lib/crypto");
const { DecryptError } = require("../lib/foundation/result");

describe("Crypto Module", () => {
  const validSecretKey = "12345678901234567890123456789012"; // 32 characters
  const testData = "Hello, World!";

  describe("Binary Encryption (New API)", () => {
    describe("encryptBinary", () => {
      test("should encrypt data to binary format", () => {
        const data = Buffer.from(testData, "utf8");
        const packet = encryptBinary(data, validSecretKey);

        expect(Buffer.isBuffer(packet)).toBe(true);
        expect(packet.length).toBeGreaterThan(IV_LENGTH + AUTH_TAG_LENGTH);
      });

      test("should include IV and auth tag in packet", () => {
        const data = Buffer.from(testData, "utf8");
        const packet = encryptBinary(data, validSecretKey);

        // Packet format: [IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]
        const minSize = IV_LENGTH + AUTH_TAG_LENGTH;
        expect(packet.length).toBeGreaterThanOrEqual(minSize);
      });

      test("should generate unique IV for each encryption", () => {
        const data = Buffer.from(testData, "utf8");
        const packet1 = encryptBinary(data, validSecretKey);
        const packet2 = encryptBinary(data, validSecretKey);

        // IVs are first 12 bytes
        const iv1 = packet1.slice(0, IV_LENGTH);
        const iv2 = packet2.slice(0, IV_LENGTH);

        expect(iv1.equals(iv2)).toBe(false);
        expect(packet1.equals(packet2)).toBe(false);
      });

      test("should accept string and convert to Buffer", () => {
        const packet = encryptBinary(testData, validSecretKey);

        expect(Buffer.isBuffer(packet)).toBe(true);
        expect(packet.length).toBeGreaterThan(IV_LENGTH + AUTH_TAG_LENGTH);
      });

      test("should throw error for invalid secret key", () => {
        const data = Buffer.from(testData);
        expect(() => encryptBinary(data, "short")).toThrow("Secret key must be exactly 32 bytes");
        expect(() => encryptBinary(data, null)).toThrow("Secret key must be a non-empty string");
      });

      test("should throw error for empty data", () => {
        expect(() => encryptBinary(Buffer.alloc(0), validSecretKey)).toThrow(
          "Data to encrypt cannot be empty"
        );
        expect(() => encryptBinary("", validSecretKey)).toThrow("Data to encrypt cannot be empty");
      });
    });

    describe("decryptBinary", () => {
      test("should decrypt binary packet successfully", () => {
        const data = Buffer.from(testData, "utf8");
        const packet = encryptBinary(data, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(Buffer.isBuffer(decrypted)).toBe(true);
        expect(decrypted.toString()).toBe(testData);
      });

      test("should handle complex JSON data", () => {
        const complexData = { name: "Test", value: 123, nested: { key: "value" } };
        const dataBuffer = Buffer.from(JSON.stringify(complexData));
        const packet = encryptBinary(dataBuffer, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(JSON.parse(decrypted.toString())).toEqual(complexData);
      });

      test("should throw error for invalid packet size", () => {
        const tooSmall = Buffer.alloc(IV_LENGTH + AUTH_TAG_LENGTH - 1);
        expect(() => decryptBinary(tooSmall, validSecretKey)).toThrow("Invalid packet size");
      });

      test("should throw error for tampered packet", () => {
        const data = Buffer.from(testData);
        const packet = encryptBinary(data, validSecretKey);

        // Tamper with encrypted data
        const tamperedPacket = Buffer.from(packet);
        tamperedPacket[IV_LENGTH + 5] ^= 0xff;

        expect(() => decryptBinary(tamperedPacket, validSecretKey)).toThrow();
      });

      test("should throw error for tampered auth tag", () => {
        const data = Buffer.from(testData);
        const packet = encryptBinary(data, validSecretKey);

        // Tamper with auth tag (last 16 bytes)
        const tamperedPacket = Buffer.from(packet);
        tamperedPacket[packet.length - 1] ^= 0xff;

        expect(() => decryptBinary(tamperedPacket, validSecretKey)).toThrow();
      });

      test("should throw error with wrong key", () => {
        const data = Buffer.from(testData);
        const packet = encryptBinary(data, validSecretKey);
        const wrongKey = "wrongkey12345678901234567890123";

        expect(() => decryptBinary(packet, wrongKey)).toThrow();
      });

      test("should throw error for invalid secret key", () => {
        const packet = Buffer.alloc(100);
        expect(() => decryptBinary(packet, "short")).toThrow("Secret key must be exactly 32 bytes");
      });
    });

    describe("encryptBinary/decryptBinary round-trip", () => {
      test("should handle large data", () => {
        const largeData = Buffer.from("x".repeat(100000));
        const packet = encryptBinary(largeData, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(decrypted.equals(largeData)).toBe(true);
      });

      test("should handle unicode characters", () => {
        const unicode = "Hello 世界 🌍 Ñoño";
        const packet = encryptBinary(unicode, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(decrypted.toString()).toBe(unicode);
      });

      test("should handle special characters", () => {
        const specialChars = "!@#$%^&*()_+-=[]{}|;:'\",.<>?/~`";
        const packet = encryptBinary(specialChars, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(decrypted.toString()).toBe(specialChars);
      });

      test("should handle binary data", () => {
        const binaryData = Buffer.from([0, 1, 2, 255, 254, 253]);
        const packet = encryptBinary(binaryData, validSecretKey);
        const decrypted = decryptBinary(packet, validSecretKey);

        expect(decrypted.equals(binaryData)).toBe(true);
      });
    });

    describe("Binary format security", () => {
      test("binary format should provide built-in authentication", () => {
        const data = Buffer.from(testData);
        const packet = encryptBinary(data, validSecretKey);

        // Tamper with packet
        const tamperedPacket = Buffer.from(packet);
        tamperedPacket[IV_LENGTH + 1] ^= 0xff;

        // Should throw due to failed authentication (built into GCM)
        expect(() => decryptBinary(tamperedPacket, validSecretKey)).toThrow();
      });
    });
  });

  describe("validateSecretKey", () => {
    test("should accept valid 32-character key", () => {
      expect(validateSecretKey(validSecretKey)).toBe(true);
    });

    test("should accept key with diverse characters", () => {
      const diverseKey = "Abc123!@#XYZ456$%^uvw789&*()pqr0"; // 32 chars
      expect(validateSecretKey(diverseKey)).toBe(true);
    });

    test("should throw error for short key", () => {
      expect(() => validateSecretKey("short")).toThrow("Secret key must be exactly 32 bytes");
    });

    test("should throw error for long key", () => {
      expect(() => validateSecretKey("123456789012345678901234567890123")).toThrow(
        "Secret key must be exactly 32 bytes"
      );
    });

    test("should throw error for null/undefined key", () => {
      expect(() => validateSecretKey(null)).toThrow("Secret key must be a non-empty string");
      expect(() => validateSecretKey(undefined)).toThrow("Secret key must be a non-empty string");
    });

    test("should throw error for all same character (weak)", () => {
      const weakKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      expect(() => validateSecretKey(weakKey)).toThrow(
        "Secret key has insufficient entropy (all same character)"
      );
    });

    test("should throw error for insufficient diversity", () => {
      const lowDiversityKey = "ababababababababababababababab12"; // Only 4 unique chars
      expect(() => validateSecretKey(lowDiversityKey)).toThrow(
        "Secret key has insufficient diversity"
      );
    });

    test("should reject syntactically valid but trivially weak encoded keys", () => {
      // 64 hex zeros and base64-encoded all-zero bytes decode to 32 zero bytes.
      const allZeroHex = "0".repeat(64);
      const allZeroBase64 = Buffer.alloc(32).toString("base64").replace(/=+$/, ""); // 43 chars
      expect(() => validateSecretKey(allZeroHex)).toThrow("insufficient binary entropy");
      expect(() => validateSecretKey(allZeroBase64)).toThrow("insufficient binary entropy");
    });

    test("should still accept a strong hex key", () => {
      const strongHex = require("crypto").randomBytes(32).toString("hex");
      expect(validateSecretKey(strongHex)).toBe(true);
    });

    test("should accept key with 8 unique characters uniformly distributed", () => {
      // Palindrome + repeat (not a simple period-1..8 pattern): 8 unique chars,
      // each appearing 4 times → Shannon entropy = log2(8) = 3.0 bits/char
      const key8Uniform = "abcdefghhgfedcbaabcdefghhgfedcba"; // 32 chars, 8 unique
      expect(validateSecretKey(key8Uniform)).toBe(true);
    });

    test("should reject key with 8 unique characters but heavily skewed distribution", () => {
      // 'a' appears 25/32 times → Shannon entropy ≈ 1.37 bits/char < 3.0 threshold
      const keySkewed = "abcdefgh" + "a".repeat(24);
      expect(() => validateSecretKey(keySkewed)).toThrow("insufficient entropy");
    });
  });

  describe("Constants", () => {
    test("IV_LENGTH should be 12 bytes (GCM standard)", () => {
      expect(IV_LENGTH).toBe(12);
    });

    test("AUTH_TAG_LENGTH should be 16 bytes (GCM standard)", () => {
      expect(AUTH_TAG_LENGTH).toBe(16);
    });
  });

  describe("normalizeKey ASCII path", () => {
    test("default behaviour uses raw ASCII bytes (no KDF)", () => {
      const normalized = normalizeKey(validSecretKey);
      expect(Buffer.isBuffer(normalized)).toBe(true);
      expect(normalized.length).toBe(32);
      expect(normalized.equals(Buffer.from(validSecretKey))).toBe(true);
    });

    test("stretchAsciiKey:true routes the key through PBKDF2-SHA256 with the documented salt", () => {
      const ascii = validSecretKey;
      const expected = deriveKeyFromPassphrase(ascii);
      const normalized = normalizeKey(ascii, { stretchAsciiKey: true });

      expect(Buffer.isBuffer(normalized)).toBe(true);
      expect(normalized.length).toBe(32);
      expect(normalized.equals(expected)).toBe(true);
      // Sanity: the derived key must NOT equal the raw ASCII bytes when
      // stretching is enabled — otherwise the opt-in is a no-op.
      expect(normalized.equals(Buffer.from(ascii))).toBe(false);
    });

    test("the same ASCII key with vs without stretching yields different bytes", () => {
      const raw = normalizeKey(validSecretKey);
      const stretched = normalizeKey(validSecretKey, { stretchAsciiKey: true });
      expect(raw.equals(stretched)).toBe(false);
    });

    test("64-char hex key is decoded raw regardless of stretchAsciiKey", () => {
      const hex = "a".repeat(64);
      const expected = Buffer.from(hex, "hex");
      expect(normalizeKey(hex).equals(expected)).toBe(true);
      expect(normalizeKey(hex, { stretchAsciiKey: true }).equals(expected)).toBe(true);
    });

    test("44-char base64 key is decoded raw regardless of stretchAsciiKey", () => {
      const raw = crypto.randomBytes(32);
      const b64 = raw.toString("base64");
      expect(b64.length).toBe(44);
      expect(normalizeKey(b64).equals(raw)).toBe(true);
      expect(normalizeKey(b64, { stretchAsciiKey: true }).equals(raw)).toBe(true);
    });

    test("43-char URL-safe base64 key (base64url) is accepted and matches its bytes", () => {
      // Use bytes that produce '-' and '_' in the URL-safe alphabet.
      const raw = Buffer.from(
        "fbff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e",
        "hex"
      );
      const b64url = raw.toString("base64url"); // 43 chars, no padding, uses -/_
      expect(b64url.length).toBe(43);
      expect(/[-_]/.test(b64url)).toBe(true);
      expect(normalizeKey(b64url).equals(raw)).toBe(true);
    });

    test("identical ASCII keys with stretchAsciiKey produce the same derived key", () => {
      const a = normalizeKey(validSecretKey, { stretchAsciiKey: true });
      const b = normalizeKey(validSecretKey, { stretchAsciiKey: true });
      expect(a.equals(b)).toBe(true);
    });

    test("different ASCII keys with stretchAsciiKey produce different derived keys", () => {
      const a = normalizeKey(validSecretKey, { stretchAsciiKey: true });
      const b = normalizeKey("Abc123!@#XYZ456$%^uvw789&*()pqr0", {
        stretchAsciiKey: true
      });
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("encryptBinary / decryptBinary stretchAsciiKey round-trip", () => {
    test("encrypt+decrypt with stretchAsciiKey on both ends recovers data", () => {
      const data = Buffer.from("hello stretch");
      const packet = encryptBinary(data, validSecretKey, { stretchAsciiKey: true });
      const decrypted = decryptBinary(packet, validSecretKey, { stretchAsciiKey: true });
      expect(decrypted.equals(data)).toBe(true);
    });

    test("mismatched stretchAsciiKey settings cause AES-GCM auth failure", () => {
      const data = Buffer.from("hello mismatch");
      const packet = encryptBinary(data, validSecretKey, { stretchAsciiKey: true });
      expect(() => decryptBinary(packet, validSecretKey, { stretchAsciiKey: false })).toThrow();
    });

    test("stretchAsciiKey mismatch throws DecryptError with keyMismatchHint", () => {
      const data = Buffer.from("hello mismatch typed");
      const packet = encryptBinary(data, validSecretKey, { stretchAsciiKey: true });
      let caught;
      try {
        decryptBinary(packet, validSecretKey, { stretchAsciiKey: false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      expect(caught.keyMismatchHint).toBe(true);
      expect(caught.code).toBe("DECRYPT_FAILED");
    });

    test("wrong-key decrypt throws DecryptError with keyMismatchHint", () => {
      const data = Buffer.from("secret data");
      const packet = encryptBinary(data, validSecretKey);
      const wrongKey = "zY9#xW8!vU7@tS6$rQ5%pO4^nM3&lK2*";
      let caught;
      try {
        decryptBinary(packet, wrongKey);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      expect(caught.keyMismatchHint).toBe(true);
    });

    test("default (no options) round-trip still works with raw ASCII bytes", () => {
      const data = Buffer.from("hello legacy");
      const packet = encryptBinary(data, validSecretKey);
      const decrypted = decryptBinary(packet, validSecretKey);
      expect(decrypted.equals(data)).toBe(true);
    });
  });

  describe("verifyControlPacketAuthTag DecryptError", () => {
    const header = Buffer.alloc(13, 0xab);
    const payload = Buffer.from("control payload");

    test("wrong auth tag throws DecryptError with keyMismatchHint", () => {
      const tag = createControlPacketAuthTag(header, payload, validSecretKey);
      // Flip the first byte to invalidate it
      const badTag = Buffer.from(tag);
      badTag[0] ^= 0xff;
      let caught;
      try {
        verifyControlPacketAuthTag(header, payload, badTag, validSecretKey);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      expect(caught.keyMismatchHint).toBe(true);
      expect(caught.code).toBe("DECRYPT_FAILED");
    });

    test("wrong key throws DecryptError with keyMismatchHint", () => {
      const tag = createControlPacketAuthTag(header, payload, validSecretKey);
      const wrongKey = "zY9#xW8!vU7@tS6$rQ5%pO4^nM3&lK2*";
      let caught;
      try {
        verifyControlPacketAuthTag(header, payload, tag, wrongKey);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      expect(caught.keyMismatchHint).toBe(true);
    });

    test("correct auth tag returns true", () => {
      const tag = createControlPacketAuthTag(header, payload, validSecretKey);
      expect(verifyControlPacketAuthTag(header, payload, tag, validSecretKey)).toBe(true);
    });
  });
});
