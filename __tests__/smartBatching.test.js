/* eslint-disable no-undef */
const zlib = require("zlib");
const { encryptBinary, decryptBinary } = require("../lib/crypto");

describe("Smart Batching", () => {
  const validSecretKey = "12345678901234567890123456789012";

  // Constants matching index.js
  const MAX_SAFE_UDP_PAYLOAD = 1400;
  const SMART_BATCH_SAFETY_MARGIN = 0.85;
  const SMART_BATCH_SMOOTHING = 0.2;
  const SMART_BATCH_INITIAL_ESTIMATE = 200;
  const SMART_BATCH_MIN_DELTAS = 1;
  const SMART_BATCH_MAX_DELTAS = 50;

  /**
   * Simulates packCrypt and returns packet size info
   */
  function packCryptSync(delta, secretKey) {
    const deltaBuffer = Buffer.from(JSON.stringify(delta), "utf8");
    const compressed = zlib.brotliCompressSync(deltaBuffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: deltaBuffer.length
      }
    });
    const packet = encryptBinary(compressed, secretKey);
    return {
      packet,
      rawSize: deltaBuffer.length,
      compressedSize: compressed.length,
      packetSize: packet.length
    };
  }

  /**
   * Simulates unpackDecrypt
   */
  function unpackDecryptSync(packet, secretKey) {
    const decrypted = decryptBinary(packet, secretKey);
    const decompressed = zlib.brotliDecompressSync(decrypted);
    return JSON.parse(decompressed.toString());
  }

  /**
   * Creates a realistic SignalK delta
   */
  function createDelta(index = 0) {
    return {
      context: "vessels.urn:mrn:imo:mmsi:123456789",
      updates: [
        {
          timestamp: new Date(Date.now() + index * 1000).toISOString(),
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60.1 + index * 0.001, longitude: 24.9 + index * 0.001 }
            },
            { path: "navigation.speedOverGround", value: 5.2 + index * 0.1 },
            { path: "navigation.courseOverGroundTrue", value: 1.57 + index * 0.01 }
          ]
        }
      ]
    };
  }

  describe("Rolling Average Calculation", () => {
    test("should calculate rolling average correctly", () => {
      let avgBytesPerDelta = SMART_BATCH_INITIAL_ESTIMATE;

      // Simulate several packets and update rolling average
      const measurements = [150, 180, 200, 220, 190];

      measurements.forEach((bytesPerDelta) => {
        avgBytesPerDelta =
          (1 - SMART_BATCH_SMOOTHING) * avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;
      });

      // After 5 measurements, average should be influenced but smoothed
      expect(avgBytesPerDelta).toBeGreaterThan(SMART_BATCH_INITIAL_ESTIMATE * 0.8);
      expect(avgBytesPerDelta).toBeLessThan(300);
    });

    test("should converge to actual value over time", () => {
      let avgBytesPerDelta = SMART_BATCH_INITIAL_ESTIMATE;
      const actualValue = 300;

      // Simulate many packets with consistent size
      for (let i = 0; i < 50; i++) {
        avgBytesPerDelta =
          (1 - SMART_BATCH_SMOOTHING) * avgBytesPerDelta + SMART_BATCH_SMOOTHING * actualValue;
      }

      // Should converge close to actual value
      expect(avgBytesPerDelta).toBeGreaterThan(actualValue * 0.95);
      expect(avgBytesPerDelta).toBeLessThan(actualValue * 1.05);
    });
  });

  describe("Max Deltas Per Batch Calculation", () => {
    test("should calculate maxDeltasPerBatch correctly", () => {
      const avgBytesPerDelta = 200;
      const targetSize = MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN;
      let maxDeltasPerBatch = Math.floor(targetSize / avgBytesPerDelta);
      maxDeltasPerBatch = Math.max(
        SMART_BATCH_MIN_DELTAS,
        Math.min(SMART_BATCH_MAX_DELTAS, maxDeltasPerBatch)
      );

      // With 200 bytes/delta and 1190 byte target, should be ~5 deltas
      expect(maxDeltasPerBatch).toBe(5);
    });

    test("should respect minimum deltas limit", () => {
      const avgBytesPerDelta = 2000; // Very large deltas
      const targetSize = MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN;
      let maxDeltasPerBatch = Math.floor(targetSize / avgBytesPerDelta);
      maxDeltasPerBatch = Math.max(
        SMART_BATCH_MIN_DELTAS,
        Math.min(SMART_BATCH_MAX_DELTAS, maxDeltasPerBatch)
      );

      expect(maxDeltasPerBatch).toBe(SMART_BATCH_MIN_DELTAS);
    });

    test("should respect maximum deltas limit", () => {
      const avgBytesPerDelta = 10; // Very small deltas
      const targetSize = MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN;
      let maxDeltasPerBatch = Math.floor(targetSize / avgBytesPerDelta);
      maxDeltasPerBatch = Math.max(
        SMART_BATCH_MIN_DELTAS,
        Math.min(SMART_BATCH_MAX_DELTAS, maxDeltasPerBatch)
      );

      expect(maxDeltasPerBatch).toBe(SMART_BATCH_MAX_DELTAS);
    });
  });

  describe("Packet Size Verification", () => {
    test("single delta should be well under MTU", () => {
      const delta = createDelta(0);
      const result = packCryptSync([delta], validSecretKey);

      expect(result.packetSize).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);
      console.log(`Single delta: ${result.packetSize} bytes`);
    });

    test("5 deltas should typically be under MTU", () => {
      const deltas = Array(5)
        .fill(null)
        .map((_, i) => createDelta(i));
      const result = packCryptSync(deltas, validSecretKey);

      expect(result.packetSize).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);
      console.log(`5 deltas: ${result.packetSize} bytes`);
    });

    test("should measure bytes per delta accurately", () => {
      const deltaCounts = [1, 2, 5, 10, 20];
      const results = [];

      deltaCounts.forEach((count) => {
        const deltas = Array(count)
          .fill(null)
          .map((_, i) => createDelta(i));
        const result = packCryptSync(deltas, validSecretKey);
        const bytesPerDelta = result.packetSize / count;
        results.push({ count, packetSize: result.packetSize, bytesPerDelta });
      });

      console.log("\nBytes per delta at different batch sizes:");
      results.forEach((r) => {
        console.log(`  ${r.count} deltas: ${r.packetSize} bytes (${r.bytesPerDelta.toFixed(1)} bytes/delta)`);
      });

      // Bytes per delta should decrease with larger batches (compression benefit)
      expect(results[results.length - 1].bytesPerDelta).toBeLessThan(results[0].bytesPerDelta);
    });

    test("should find optimal batch size that stays under MTU", () => {
      let optimalBatchSize = 1;

      for (let count = 1; count <= 50; count++) {
        const deltas = Array(count)
          .fill(null)
          .map((_, i) => createDelta(i));
        const result = packCryptSync(deltas, validSecretKey);

        if (result.packetSize > MAX_SAFE_UDP_PAYLOAD) {
          optimalBatchSize = count - 1;
          break;
        }
        optimalBatchSize = count;
      }

      console.log(`\nOptimal batch size (under ${MAX_SAFE_UDP_PAYLOAD} bytes): ${optimalBatchSize} deltas`);
      expect(optimalBatchSize).toBeGreaterThan(0);

      // Verify optimal size stays under MTU
      const optimalDeltas = Array(optimalBatchSize)
        .fill(null)
        .map((_, i) => createDelta(i));
      const optimalResult = packCryptSync(optimalDeltas, validSecretKey);
      expect(optimalResult.packetSize).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);
    });
  });

  describe("Smart Batching Simulation", () => {
    test("should simulate smart batching behavior", () => {
      let avgBytesPerDelta = SMART_BATCH_INITIAL_ESTIMATE;
      let maxDeltasPerBatch = Math.floor(
        (MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN) / avgBytesPerDelta
      );

      const batches = [];
      let currentBatch = [];
      const totalDeltas = 30;

      // Simulate receiving deltas and smart batching
      for (let i = 0; i < totalDeltas; i++) {
        currentBatch.push(createDelta(i));

        // Check if batch is "full"
        if (currentBatch.length >= maxDeltasPerBatch) {
          // Send batch
          const result = packCryptSync(currentBatch, validSecretKey);
          batches.push({
            deltaCount: currentBatch.length,
            packetSize: result.packetSize,
            underMTU: result.packetSize <= MAX_SAFE_UDP_PAYLOAD
          });

          // Update rolling average
          const bytesPerDelta = result.packetSize / currentBatch.length;
          avgBytesPerDelta =
            (1 - SMART_BATCH_SMOOTHING) * avgBytesPerDelta + SMART_BATCH_SMOOTHING * bytesPerDelta;

          // Recalculate max deltas
          const targetSize = MAX_SAFE_UDP_PAYLOAD * SMART_BATCH_SAFETY_MARGIN;
          maxDeltasPerBatch = Math.floor(targetSize / avgBytesPerDelta);
          maxDeltasPerBatch = Math.max(
            SMART_BATCH_MIN_DELTAS,
            Math.min(SMART_BATCH_MAX_DELTAS, maxDeltasPerBatch)
          );

          currentBatch = [];
        }
      }

      // Send remaining deltas
      if (currentBatch.length > 0) {
        const result = packCryptSync(currentBatch, validSecretKey);
        batches.push({
          deltaCount: currentBatch.length,
          packetSize: result.packetSize,
          underMTU: result.packetSize <= MAX_SAFE_UDP_PAYLOAD
        });
      }

      console.log("\nSmart batching simulation:");
      batches.forEach((b, i) => {
        console.log(
          `  Batch ${i + 1}: ${b.deltaCount} deltas, ${b.packetSize} bytes, ${b.underMTU ? "OK" : "OVER MTU"}`
        );
      });
      console.log(`Final avgBytesPerDelta: ${avgBytesPerDelta.toFixed(1)}`);
      console.log(`Final maxDeltasPerBatch: ${maxDeltasPerBatch}`);

      // All batches should be under MTU
      const allUnderMTU = batches.every((b) => b.underMTU);
      expect(allUnderMTU).toBe(true);
    });
  });

  describe("End-to-End with Smart Batching", () => {
    test("should successfully send and receive batched deltas", () => {
      const batchSizes = [1, 3, 5, 7];

      batchSizes.forEach((size) => {
        const deltas = Array(size)
          .fill(null)
          .map((_, i) => createDelta(i));

        const result = packCryptSync(deltas, validSecretKey);
        const received = unpackDecryptSync(result.packet, validSecretKey);

        expect(received).toEqual(deltas);
        expect(received.length).toBe(size);
      });
    });

    test("should handle varying delta sizes", () => {
      // Create deltas with varying amounts of data
      const mixedDeltas = [
        {
          context: "vessels.self",
          updates: [{ timestamp: new Date().toISOString(), values: [{ path: "a", value: 1 }] }]
        },
        {
          context: "vessels.urn:mrn:imo:mmsi:123456789",
          updates: [
            {
              timestamp: new Date().toISOString(),
              values: [
                { path: "navigation.position", value: { latitude: 60.123456, longitude: 24.987654 } },
                { path: "navigation.speedOverGround", value: 5.2 },
                { path: "navigation.courseOverGroundTrue", value: 1.57 },
                { path: "environment.wind.speedApparent", value: 10.5 },
                { path: "environment.wind.angleApparent", value: 0.785 }
              ]
            }
          ]
        },
        {
          context: "vessels.self",
          updates: [{ timestamp: new Date().toISOString(), values: [{ path: "b", value: 2 }] }]
        }
      ];

      const result = packCryptSync(mixedDeltas, validSecretKey);
      const received = unpackDecryptSync(result.packet, validSecretKey);

      expect(received).toEqual(mixedDeltas);
      expect(result.packetSize).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);
    });
  });
});
