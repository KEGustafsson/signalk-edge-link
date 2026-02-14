"use strict";

/**
 * Phase 7 Benchmark: Latency Percentiles
 *
 * Measures end-to-end latency distribution across the v2 protocol pipeline:
 * - p50, p95, p99, p99.9 latencies for each pipeline stage
 * - Full pipeline latency under various network conditions
 * - Impact of compression quality on latency
 * - Impact of payload size on latency
 *
 * Run: node test/benchmarks/latency-percentiles.js
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { PacketBuilder, PacketParser } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { NetworkSimulator } = require("../network-simulator");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const SECRET_KEY = "12345678901234567890123456789012";

function generateDelta(index, pathCount) {
  const values = [];
  for (let i = 0; i < pathCount; i++) {
    values.push({
      path: `navigation.path${i}`,
      value: Math.random() * 100
    });
  }
  return {
    updates: [{
      source: { label: "test" },
      timestamp: new Date().toISOString(),
      values
    }]
  };
}

function percentile(sorted, p) {
  const index = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, index)];
}

function printLatencyStats(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  console.log(`  ${label}:`);
  console.log(`    min: ${min.toFixed(3)}ms | avg: ${avg.toFixed(3)}ms | max: ${max.toFixed(3)}ms`);
  console.log(`    p50: ${percentile(sorted, 50).toFixed(3)}ms | p95: ${percentile(sorted, 95).toFixed(3)}ms | p99: ${percentile(sorted, 99).toFixed(3)}ms | p99.9: ${percentile(sorted, 99.9).toFixed(3)}ms`);
}

// ── Benchmark 1: Per-Stage Latency ──
async function benchPerStageLatency() {
  console.log("=== Per-Stage Latency (1000 iterations) ===\n");
  const ITERATIONS = 1000;

  const delta = generateDelta(0, 3);
  const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
  const builder = new PacketBuilder();
  const parser = new PacketParser();
  const tracker = new SequenceTracker();

  // Serialization
  const serializeLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    Buffer.from(JSON.stringify({ 0: generateDelta(i, 3) }), "utf8");
    serializeLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("JSON.stringify (serialize)", serializeLatencies);

  // Compression
  const compressLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await brotliCompressAsync(serialized, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
      }
    });
    compressLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Brotli compress (quality=10)", compressLatencies);

  // Encryption
  const compressed = await brotliCompressAsync(serialized, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 }
  });
  const encryptLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    encryptBinary(compressed, SECRET_KEY);
    encryptLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Encryption", encryptLatencies);

  // Packet building
  const encrypted = encryptBinary(compressed, SECRET_KEY);
  const buildLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
    buildLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Packet build (header + payload)", buildLatencies);

  // Packet parsing
  const packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
  const parseLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    parser.parseHeader(packet);
    parseLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Packet parse (header)", parseLatencies);

  // Decryption
  const decryptLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    decryptBinary(encrypted, SECRET_KEY);
    decryptLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Decryption", decryptLatencies);

  // Decompression
  const decompressLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await brotliDecompressAsync(compressed);
    decompressLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Brotli decompress", decompressLatencies);

  console.log();
}

// ── Benchmark 2: Full Pipeline Latency ──
async function benchFullPipelineLatency() {
  console.log("=== Full Pipeline Latency (TX → RX) ===\n");
  const ITERATIONS = 500;

  const fullLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();

    // TX: serialize → compress → encrypt → build
    const delta = generateDelta(i, 3);
    const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
    const compressed = await brotliCompressAsync(serialized, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 }
    });
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const txBuilder = new PacketBuilder();
    txBuilder.setSequence(i);
    const packet = txBuilder.buildDataPacket(encrypted, { compressed: true, encrypted: true });

    // RX: parse → decrypt → decompress → parse JSON
    const parser = new PacketParser();
    const parsed = parser.parseHeader(packet);
    const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
    const decompressed = await brotliDecompressAsync(decrypted);
    JSON.parse(decompressed.toString());

    fullLatencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  printLatencyStats("Full TX→RX pipeline (no network)", fullLatencies);
  console.log();
}

// ── Benchmark 3: Compression Quality Impact ──
async function benchCompressionQualityImpact() {
  console.log("=== Compression Quality vs Latency ===\n");
  const ITERATIONS = 200;

  const delta = generateDelta(0, 5);
  const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");

  const qualities = [1, 4, 6, 8, 10, 11];

  console.log("  Quality | Avg Latency | p99 Latency | Compressed Size | Ratio");
  console.log("  --------|-------------|-------------|-----------------|------");

  for (const quality of qualities) {
    const latencies = [];
    let compressedSize = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const start = process.hrtime.bigint();
      const compressed = await brotliCompressAsync(serialized, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
        }
      });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      compressedSize = compressed.length;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p99 = percentile(sorted, 99);
    const ratio = (serialized.length / compressedSize).toFixed(2);

    console.log(`  ${String(quality).padStart(7)} | ${avg.toFixed(3).padStart(9)}ms | ${p99.toFixed(3).padStart(9)}ms | ${String(compressedSize).padStart(13)} B | ${ratio.padStart(4)}x`);
  }
  console.log();
}

// ── Benchmark 4: Payload Size Impact ──
async function benchPayloadSizeImpact() {
  console.log("=== Payload Size vs Latency ===\n");
  const ITERATIONS = 200;

  const pathCounts = [1, 3, 5, 10, 20, 50];

  console.log("  Paths | Raw Size | TX Latency (avg) | TX p99    | RX Latency (avg) | RX p99");
  console.log("  ------|----------|------------------|-----------|------------------|--------");

  for (const pathCount of pathCounts) {
    const delta = generateDelta(0, pathCount);
    const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");

    const txLatencies = [];
    const rxLatencies = [];
    let packet;

    for (let i = 0; i < ITERATIONS; i++) {
      // TX
      const txStart = process.hrtime.bigint();
      const compressed = await brotliCompressAsync(serialized, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 }
      });
      const encrypted = encryptBinary(compressed, SECRET_KEY);
      const txBuilder = new PacketBuilder();
      packet = txBuilder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
      txLatencies.push(Number(process.hrtime.bigint() - txStart) / 1e6);

      // RX
      const rxStart = process.hrtime.bigint();
      const parser = new PacketParser();
      const parsed = parser.parseHeader(packet);
      const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
      await brotliDecompressAsync(decrypted);
      rxLatencies.push(Number(process.hrtime.bigint() - rxStart) / 1e6);
    }

    const txSorted = [...txLatencies].sort((a, b) => a - b);
    const rxSorted = [...rxLatencies].sort((a, b) => a - b);
    const txAvg = txLatencies.reduce((a, b) => a + b, 0) / txLatencies.length;
    const rxAvg = rxLatencies.reduce((a, b) => a + b, 0) / rxLatencies.length;

    console.log(`  ${String(pathCount).padStart(5)} | ${String(serialized.length).padStart(6)} B | ${txAvg.toFixed(3).padStart(14)}ms | ${percentile(txSorted, 99).toFixed(3).padStart(7)}ms | ${rxAvg.toFixed(3).padStart(14)}ms | ${percentile(rxSorted, 99).toFixed(3).padStart(5)}ms`);
  }
  console.log();
}

// ── Benchmark 5: Simulated Network Latency Impact ──
async function benchNetworkLatencyImpact() {
  console.log("=== Simulated Network Conditions Impact ===\n");

  const scenarios = [
    { name: "Local (0ms)", latency: 0, jitter: 0, loss: 0 },
    { name: "LAN (1ms)", latency: 1, jitter: 0.5, loss: 0 },
    { name: "LTE (30ms)", latency: 30, jitter: 10, loss: 0.01 },
    { name: "3G (100ms)", latency: 100, jitter: 30, loss: 0.03 },
    { name: "Satellite (600ms)", latency: 600, jitter: 50, loss: 0.02 },
    { name: "Poor cellular (200ms, 10% loss)", latency: 200, jitter: 80, loss: 0.10 }
  ];

  console.log("  Scenario                         | Added Latency | Delivery Rate | Effective p95");
  console.log("  ---------------------------------|---------------|---------------|-------------");

  for (const scenario of scenarios) {
    const sim = new NetworkSimulator({
      latency: scenario.latency,
      jitter: scenario.jitter,
      packetLoss: scenario.loss
    });

    const deliveryTimes = [];
    let delivered = 0;
    const total = 200;

    for (let i = 0; i < total; i++) {
      const start = Date.now();
      const result = sim.send(Buffer.alloc(500), () => {
        deliveryTimes.push(Date.now() - start);
        delivered++;
      });
    }

    // Wait for all delayed deliveries
    await new Promise(resolve => setTimeout(resolve, scenario.latency + scenario.jitter + 100));

    const deliveryRate = (delivered / total * 100).toFixed(1);
    const sorted = [...deliveryTimes].sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? percentile(sorted, 95) : 0;

    console.log(`  ${scenario.name.padEnd(33)} | ${String(scenario.latency).padStart(10)}ms  | ${(deliveryRate + "%").padStart(13)} | ${String(p95).padStart(10)}ms`);

    sim.destroy();
  }
  console.log();
}

// ── Run All ──
async function main() {
  console.log("Signal K Edge Link v2.0 - Phase 7: Latency Percentile Benchmarks");
  console.log("=" .repeat(65) + "\n");

  await benchPerStageLatency();
  await benchFullPipelineLatency();
  await benchCompressionQualityImpact();
  await benchPayloadSizeImpact();
  await benchNetworkLatencyImpact();

  console.log("=" .repeat(65));
  console.log("Latency percentile benchmarks complete.");
}

main().catch(console.error);
