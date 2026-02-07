const {
  encryptBinary,
  decryptBinary,
  validateSecretKey,
  IV_LENGTH,
  AUTH_TAG_LENGTH
} = require("../lib/crypto");

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
        expect(() => encryptBinary(data, "short")).toThrow(
          "Secret key must be exactly 32 characters"
        );
        expect(() => encryptBinary(data, null)).toThrow("Secret key must be exactly 32 characters");
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
        expect(() => decryptBinary(packet, "short")).toThrow(
          "Secret key must be exactly 32 characters"
        );
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
      expect(() => validateSecretKey("short")).toThrow("Secret key must be exactly 32 characters");
    });

    test("should throw error for long key", () => {
      expect(() => validateSecretKey("123456789012345678901234567890123")).toThrow(
        "Secret key must be exactly 32 characters"
      );
    });

    test("should throw error for null/undefined key", () => {
      expect(() => validateSecretKey(null)).toThrow("Secret key must be exactly 32 characters");
      expect(() => validateSecretKey(undefined)).toThrow(
        "Secret key must be exactly 32 characters"
      );
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

    test("should accept key with exactly 8 unique characters", () => {
      const key8Chars = "abcdefgh" + "a".repeat(24); // 8 unique chars, 32 total
      expect(validateSecretKey(key8Chars)).toBe(true);
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
});
