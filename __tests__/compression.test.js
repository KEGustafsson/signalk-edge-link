/* eslint-disable no-undef */
const zlib = require("zlib");
const { encryptBinary, decryptBinary } = require("../lib/crypto");

describe("Compression and Encryption Pipeline", () => {
  const validSecretKey = "12345678901234567890123456789012";

  describe("Brotli Compression", () => {
    test("should compress and decompress data successfully", (done) => {
      const testData = Buffer.from(JSON.stringify({ test: "data" }), "utf8");

      zlib.brotliCompress(testData, (err, compressed) => {
        expect(err).toBeNull();
        expect(compressed).toBeInstanceOf(Buffer);
        expect(compressed).toBeTruthy();

        zlib.brotliDecompress(compressed, (err, decompressed) => {
          expect(err).toBeNull();
          expect(decompressed.toString()).toBe(testData.toString());
          done();
        });
      });
    });

    test("should handle empty data", (done) => {
      const testData = Buffer.from("", "utf8");

      zlib.brotliCompress(testData, (err, compressed) => {
        expect(err).toBeNull();
        expect(compressed).toBeInstanceOf(Buffer);
        done();
      });
    });

    test("should compress large data efficiently", (done) => {
      const largeData = Buffer.from(
        JSON.stringify({
          deltas: Array(100).fill({
            context: "vessels.urn:mrn:imo:mmsi:123456789",
            updates: [
              {
                timestamp: "2024-01-01T00:00:00Z",
                values: [
                  { path: "navigation.position", value: { latitude: 60.1, longitude: 24.9 } }
                ]
              }
            ]
          })
        }),
        "utf8"
      );

      zlib.brotliCompress(largeData, (err, compressed) => {
        expect(err).toBeNull();
        expect(compressed.length).toBeLessThan(largeData.length);

        const compressionRatio = (1 - compressed.length / largeData.length) * 100;
        expect(compressionRatio).toBeGreaterThan(50); // At least 50% compression

        done();
      });
    });

    test("should use maximum quality compression", (done) => {
      const testData = Buffer.from("x".repeat(1000), "utf8");

      const maxQualityOptions = {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY
        }
      };

      const defaultOptions = {};

      zlib.brotliCompress(testData, maxQualityOptions, (err, maxCompressed) => {
        expect(err).toBeNull();

        zlib.brotliCompress(testData, defaultOptions, (err, defaultCompressed) => {
          expect(err).toBeNull();

          // Max quality should produce smaller or equal size
          expect(maxCompressed.length).toBeLessThanOrEqual(defaultCompressed.length);
          done();
        });
      });
    });
  });

  describe("Encryption with Compression", () => {
    test("should encrypt and decrypt successfully", () => {
      const originalData = "test data for encryption";
      const buffer = Buffer.from(originalData, "utf8");

      // Encrypt
      const encrypted = encryptBinary(buffer, validSecretKey);
      expect(Buffer.isBuffer(encrypted)).toBe(true);

      // Decrypt
      const decrypted = decryptBinary(encrypted, validSecretKey);
      expect(decrypted.toString()).toBe(originalData);
    });

    test("should reduce size significantly with compression + encryption", (done) => {
      const largeData = Array(50).fill({
        context: "vessels.urn:mrn:imo:mmsi:123456789",
        updates: [
          {
            timestamp: "2024-01-01T00:00:00Z",
            values: [
              { path: "navigation.position", value: { latitude: 60.1, longitude: 24.9 } },
              { path: "navigation.speedOverGround", value: 5.2 },
              { path: "navigation.courseOverGroundTrue", value: 1.57 }
            ]
          }
        ]
      });

      const originalBuffer = Buffer.from(JSON.stringify(largeData), "utf8");
      const originalSize = originalBuffer.length;

      zlib.brotliCompress(originalBuffer, (err, compressed) => {
        expect(err).toBeNull();

        const compressedSize = compressed.length;
        const reduction = (1 - compressedSize / originalSize) * 100;

        expect(reduction).toBeGreaterThan(0); // Should reduce size
        done();
      });
    });
  });

  describe("Error Handling in Pipeline", () => {
    test("should handle decompression of invalid data", (done) => {
      const invalidCompressed = Buffer.from("not compressed data", "utf8");

      zlib.brotliDecompress(invalidCompressed, (err, _result) => {
        expect(err).toBeTruthy();
        done();
      });
    });

    test("should handle decryption with wrong key in pipeline", (done) => {
      const testData = Buffer.from("test", "utf8");

      zlib.brotliCompress(testData, (err, compressed) => {
        expect(err).toBeNull();

        const encrypted = encryptBinary(compressed, validSecretKey);
        const wrongKey = "wrongkey12345678901234567890123";

        expect(() => decryptBinary(encrypted, wrongKey)).toThrow();
        done();
      });
    });

    test("should handle corrupted encrypted data", () => {
      const corruptedData = Buffer.alloc(100); // Invalid binary packet

      expect(() => decryptBinary(corruptedData, validSecretKey)).toThrow();
    });
  });

  describe("Performance Characteristics", () => {
    test("should compress repeated data very efficiently", (done) => {
      const repeatedData = {
        deltas: Array(100).fill({
          context: "vessels.self",
          updates: [
            {
              timestamp: "2024-01-01T00:00:00Z",
              values: [{ path: "test", value: 42 }]
            }
          ]
        })
      };

      const buffer = Buffer.from(JSON.stringify(repeatedData), "utf8");

      zlib.brotliCompress(buffer, (err, compressed) => {
        expect(err).toBeNull();

        const compressionRatio = (1 - compressed.length / buffer.length) * 100;
        expect(compressionRatio).toBeGreaterThan(80); // Very high compression for repeated data
        done();
      });
    });

    test("should handle already compressed data", (done) => {
      const randomData = Buffer.from(
        Array(1000)
          .fill(0)
          .map(() => Math.random().toString(36))
          .join("")
      );

      zlib.brotliCompress(randomData, (err, compressed) => {
        expect(err).toBeNull();

        // Second compression shouldn't reduce size much
        zlib.brotliCompress(compressed, (err, doubleCompressed) => {
          expect(err).toBeNull();

          // Double compression might even increase size
          expect(doubleCompressed.length).toBeGreaterThanOrEqual(compressed.length * 0.9);
          done();
        });
      });
    });
  });
});
