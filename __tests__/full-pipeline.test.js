/* eslint-disable no-undef */
const zlib = require("zlib");
const { encryptBinary, decryptBinary } = require("../lib/crypto");

describe("Full Encryption/Decryption Pipeline", () => {
  const validSecretKey = "12345678901234567890123456789012";

  /**
   * Simulates the new packCrypt function from index.js
   * Serialize -> Compress -> Encrypt (single compression, binary format)
   */
  function packCrypt(delta, secretKey, callback) {
    try {
      // Serialize
      const deltaBuffer = Buffer.from(JSON.stringify(delta), "utf8");
      const brotliOptions = {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: deltaBuffer.length
        }
      };

      // Stage 1: Compress
      zlib.brotliCompress(deltaBuffer, brotliOptions, (err, compressed) => {
        if (err) {
          return callback(err);
        }
        try {
          // Stage 2: Encrypt (binary format)
          const packet = encryptBinary(compressed, secretKey);
          callback(null, packet);
        } catch (encryptError) {
          callback(encryptError);
        }
      });
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Simulates the new unpackDecrypt function from index.js
   * Decrypt -> Decompress -> Parse (single decompression, binary format)
   */
  function unpackDecrypt(packet, secretKey, callback) {
    try {
      // Stage 1: Decrypt (binary format)
      const decrypted = decryptBinary(packet, secretKey);

      // Stage 2: Decompress
      zlib.brotliDecompress(decrypted, (err, decompressed) => {
        if (err) {
          return callback(err);
        }
        try {
          // Stage 3: Parse JSON
          const jsonContent = JSON.parse(decompressed.toString());
          callback(null, jsonContent);
        } catch (parseError) {
          callback(parseError);
        }
      });
    } catch (decryptError) {
      callback(decryptError);
    }
  }

  describe("End-to-End Pipeline Tests", () => {
    test("should successfully pack and unpack a simple delta", (done) => {
      const testDelta = {
        context: "vessels.urn:mrn:imo:mmsi:123456789",
        updates: [
          {
            timestamp: new Date().toISOString(),
            values: [
              {
                path: "navigation.position",
                value: { latitude: 60.1, longitude: 24.9 }
              }
            ]
          }
        ]
      };

      packCrypt(testDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();
        expect(encrypted).toBeInstanceOf(Buffer);

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(testDelta);
          done();
        });
      });
    });

    test("should handle multiple deltas in an array", (done) => {
      const testDeltas = [
        {
          context: "vessels.urn:mrn:imo:mmsi:123456789",
          updates: [
            {
              timestamp: "2024-01-01T00:00:00Z",
              values: [{ path: "navigation.speedOverGround", value: 5.2 }]
            }
          ]
        },
        {
          context: "vessels.urn:mrn:imo:mmsi:123456789",
          updates: [
            {
              timestamp: "2024-01-01T00:00:01Z",
              values: [{ path: "navigation.courseOverGroundTrue", value: 1.57 }]
            }
          ]
        }
      ];

      packCrypt(testDeltas, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(testDeltas);
          done();
        });
      });
    });

    test("should handle large delta batches (realistic scenario)", (done) => {
      const largeDeltaBatch = Array(50)
        .fill(null)
        .map((_, i) => ({
          context: "vessels.urn:mrn:imo:mmsi:123456789",
          updates: [
            {
              timestamp: new Date(Date.now() + i * 1000).toISOString(),
              values: [
                {
                  path: "navigation.position",
                  value: { latitude: 60.1 + i * 0.001, longitude: 24.9 + i * 0.001 }
                },
                { path: "navigation.speedOverGround", value: 5.2 + i * 0.1 },
                { path: "navigation.courseOverGroundTrue", value: 1.57 + i * 0.01 },
                { path: "environment.wind.speedApparent", value: 10.5 + i * 0.2 },
                { path: "environment.wind.angleApparent", value: 0.785 + i * 0.01 }
              ]
            }
          ]
        }));

      const originalSize = Buffer.from(JSON.stringify(largeDeltaBatch), "utf8").length;

      packCrypt(largeDeltaBatch, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();
        expect(encrypted).toBeInstanceOf(Buffer);

        // Check compression effectiveness
        const compressionRatio = (1 - encrypted.length / originalSize) * 100;
        expect(compressionRatio).toBeGreaterThan(0);

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(largeDeltaBatch);
          expect(decrypted.length).toBe(50);
          done();
        });
      });
    });

    test("should handle special characters and unicode", (done) => {
      const specialDelta = {
        context: "vessels.urn:mrn:imo:mmsi:123456789",
        updates: [
          {
            timestamp: "2024-01-01T00:00:00Z",
            values: [
              { path: "navigation.destination.name", value: "Café Ñoño 世界 🌍" },
              {
                path: "navigation.notes",
                value: "Test with special chars: !@#$%^&*()_+-=[]{}|;':\"\\,.<>?/~`"
              }
            ]
          }
        ]
      };

      packCrypt(specialDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(specialDelta);
          done();
        });
      });
    });

    test("should fail with wrong secret key", (done) => {
      const testDelta = {
        context: "vessels.self",
        updates: [{ timestamp: "2024-01-01T00:00:00Z", values: [{ path: "test", value: 1 }] }]
      };

      packCrypt(testDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        const wrongKey = "wrongkey12345678901234567890123";
        unpackDecrypt(encrypted, wrongKey, (err, _decrypted) => {
          expect(err).toBeTruthy();
          done();
        });
      });
    });

    test("should fail with corrupted data", (done) => {
      const corruptedData = Buffer.from("corrupted data that is not valid", "utf8");

      unpackDecrypt(corruptedData, validSecretKey, (err, _decrypted) => {
        expect(err).toBeTruthy();
        done();
      });
    });

    test("should handle hello message format", (done) => {
      const helloMessage = {
        context: "vessels.urn:mrn:imo:mmsi:123456789",
        updates: [
          {
            timestamp: new Date().toISOString(),
            values: [
              {
                path: "networking.modem.latencyTime",
                value: new Date()
              }
            ]
          }
        ]
      };

      packCrypt(helloMessage, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted.context).toBe(helloMessage.context);
          expect(decrypted.updates[0].values[0].path).toBe("networking.modem.latencyTime");
          done();
        });
      });
    });

    test("should handle empty arrays", (done) => {
      const emptyDelta = [];

      packCrypt(emptyDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual([]);
          done();
        });
      });
    });

    test("should verify data integrity for GSV sentences (filtered out in real code)", (done) => {
      const gsvDelta = {
        context: "vessels.self",
        updates: [
          {
            source: { sentence: "GSV" },
            timestamp: "2024-01-01T00:00:00Z",
            values: [{ path: "navigation.gnss.satellites", value: 12 }]
          }
        ]
      };

      packCrypt(gsvDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(gsvDelta);
          done();
        });
      });
    });
  });

  describe("Performance and Size Tests", () => {
    test("should demonstrate compression effectiveness", (done) => {
      const realisticDelta = Array(82)
        .fill(null)
        .map((_, i) => ({
          context: "vessels.urn:mrn:imo:mmsi:123456789",
          updates: [
            {
              timestamp: new Date(Date.now() + i * 100).toISOString(),
              values: [
                { path: "navigation.position.latitude", value: 60.123456 + i * 0.0001 },
                { path: "navigation.position.longitude", value: 24.987654 + i * 0.0001 }
              ]
            }
          ]
        }));

      const originalBuffer = Buffer.from(JSON.stringify(realisticDelta), "utf8");

      packCrypt(realisticDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        const compressionRatio = ((1 - encrypted.length / originalBuffer.length) * 100).toFixed(2);
        console.log(
          `Original: ${originalBuffer.length} bytes, Encrypted+Compressed: ${encrypted.length} bytes, Reduction: ${compressionRatio}%`
        );

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(realisticDelta);
          done();
        });
      });
    });
  });

  describe("Edge Cases", () => {
    test("should handle very small deltas", (done) => {
      const tinyDelta = { a: 1 };

      packCrypt(tinyDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(tinyDelta);
          done();
        });
      });
    });

    test("should handle deeply nested objects", (done) => {
      const nestedDelta = {
        context: "vessels.self",
        updates: [
          {
            timestamp: "2024-01-01T00:00:00Z",
            values: [
              {
                path: "environment.depth.belowTransducer",
                value: {
                  meta: {
                    units: "m",
                    description: "Depth below transducer",
                    zones: [
                      { lower: 0, upper: 2, state: "alarm" },
                      { lower: 2, upper: 5, state: "warn" },
                      { lower: 5, upper: 1000, state: "normal" }
                    ]
                  }
                }
              }
            ]
          }
        ]
      };

      packCrypt(nestedDelta, validSecretKey, (err, encrypted) => {
        expect(err).toBeNull();

        unpackDecrypt(encrypted, validSecretKey, (err, decrypted) => {
          expect(err).toBeNull();
          expect(decrypted).toEqual(nestedDelta);
          done();
        });
      });
    });
  });
});
