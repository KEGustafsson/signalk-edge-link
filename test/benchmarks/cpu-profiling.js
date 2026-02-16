"use strict";

/**
 * Phase 7 Benchmark: CPU Profiling Under Load
 *
 * Measures CPU usage characteristics of all v2 protocol components:
 * - Packet building throughput under sustained load
 * - Compression pipeline CPU cost
 * - Encryption pipeline CPU cost
 * - Full pipeline (build + compress + encrypt + parse) under load
 * - Congestion control overhead
 * - Monitoring overhead
 *
 * Run: node test/benchmarks/cpu-profiling.js
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { PacketBuilder, PacketParser } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { CongestionControl } = require("../../lib/congestion");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { PacketLossTracker, PathLatencyTracker, RetransmissionTracker } = require("../../lib/monitoring");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const SECRET_KEY = "12345678901234567890123456789012";

function generateDelta(index) {
  return {
    updates: [{
      source: { label: "test", type: "NMEA2000" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "navigation.position.latitude", value: 60.1 + index * 0.001 },
        { path: "navigation.position.longitude", value: 24.9 + index * 0.001 },
        { path: "navigation.speedOverGround", value: 5.5 + Math.random() }
      ]
    }]
  };
}

function measureCPU(fn, iterations) {
  const startCPU = process.cpuUsage();
  const startTime = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    fn(i);
  }

  const endTime = process.hrtime.bigint();
  const endCPU = process.cpuUsage(startCPU);

  const wallMs = Number(endTime - startTime) / 1e6;
  const userMs = endCPU.user / 1000;
  const systemMs = endCPU.system / 1000;

  return {
    wallMs,
    userMs,
    systemMs,
    totalCpuMs: userMs + systemMs,
    cpuPercent: ((userMs + systemMs) / wallMs * 100),
    opsPerSec: Math.round(iterations / wallMs * 1000)
  };
}

async function measureCPUAsync(fn, iterations) {
  const startCPU = process.cpuUsage();
  const startTime = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    await fn(i);
  }

  const endTime = process.hrtime.bigint();
  const endCPU = process.cpuUsage(startCPU);

  const wallMs = Number(endTime - startTime) / 1e6;
  const userMs = endCPU.user / 1000;
  const systemMs = endCPU.system / 1000;

  return {
    wallMs,
    userMs,
    systemMs,
    totalCpuMs: userMs + systemMs,
    cpuPercent: ((userMs + systemMs) / wallMs * 100),
    opsPerSec: Math.round(iterations / wallMs * 1000)
  };
}

function printResult(name, result) {
  console.log(`  ${name}:`);
  console.log(`    Wall time: ${result.wallMs.toFixed(0)}ms | CPU time: ${result.totalCpuMs.toFixed(0)}ms (user: ${result.userMs.toFixed(0)}, sys: ${result.systemMs.toFixed(0)})`);
  console.log(`    CPU usage: ${result.cpuPercent.toFixed(1)}% | Throughput: ${result.opsPerSec.toLocaleString()} ops/sec`);
}

// ── Benchmark 1: Packet Building ──
function benchPacketBuilding() {
  console.log("=== Packet Building CPU Cost ===\n");
  const ITERATIONS = 100000;

  const builder = new PacketBuilder();
  const payload = Buffer.alloc(500, 0xab);

  printResult("buildDataPacket (500B)", measureCPU(
    () => builder.buildDataPacket(payload, { compressed: true, encrypted: true }),
    ITERATIONS
  ));

  printResult("buildACKPacket", measureCPU(
    () => builder.buildACKPacket(42),
    ITERATIONS
  ));

  printResult("buildHeartbeatPacket", measureCPU(
    () => builder.buildHeartbeatPacket(),
    ITERATIONS
  ));

  console.log();
}

// ── Benchmark 2: Compression Pipeline ──
async function benchCompression() {
  console.log("=== Compression Pipeline CPU Cost ===\n");
  const ITERATIONS = 5000;

  const delta = generateDelta(0);
  const payload = Buffer.from(JSON.stringify({ 0: delta }), "utf8");

  printResult("Brotli compress (single delta)", await measureCPUAsync(
    async () => {
      await brotliCompressAsync(payload, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length
        }
      });
    },
    ITERATIONS
  ));

  // Batched compression
  const batch = {};
  for (let i = 0; i < 10; i++) {batch[i] = generateDelta(i);}
  const batchPayload = Buffer.from(JSON.stringify(batch), "utf8");

  printResult("Brotli compress (10-delta batch)", await measureCPUAsync(
    async () => {
      await brotliCompressAsync(batchPayload, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: batchPayload.length
        }
      });
    },
    ITERATIONS
  ));

  // Lower quality compression (faster)
  printResult("Brotli compress (quality=4)", await measureCPUAsync(
    async () => {
      await brotliCompressAsync(payload, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length
        }
      });
    },
    ITERATIONS
  ));

  console.log();
}

// ── Benchmark 3: Encryption Pipeline ──
function benchEncryption() {
  console.log("=== Encryption Pipeline CPU Cost ===\n");
  const ITERATIONS = 50000;
  const payloadSizes = [100, 500, 1000, 1400];

  for (const size of payloadSizes) {
    const data = Buffer.alloc(size, 0xab);

    printResult(`encrypt (${size}B)`, measureCPU(
      () => encryptBinary(data, SECRET_KEY),
      ITERATIONS
    ));
  }

  // Decrypt benchmark
  const encrypted = encryptBinary(Buffer.alloc(500, 0xab), SECRET_KEY);
  printResult("decrypt (500B)", measureCPU(
    () => decryptBinary(encrypted, SECRET_KEY),
    ITERATIONS
  ));

  console.log();
}

// ── Benchmark 4: Full Pipeline Under Load ──
async function benchFullPipeline() {
  console.log("=== Full Pipeline Under Load ===\n");
  const ITERATIONS = 2000;

  const builder = new PacketBuilder();
  const parser = new PacketParser();
  const tracker = new SequenceTracker();

  printResult("Full TX pipeline (serialize+compress+encrypt+build)", await measureCPUAsync(
    async (i) => {
      const delta = generateDelta(i);
      const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
      const compressed = await brotliCompressAsync(serialized, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 10
        }
      });
      const encrypted = encryptBinary(compressed, SECRET_KEY);
      builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
    },
    ITERATIONS
  ));

  // Pre-build packets for RX benchmark
  const txBuilder = new PacketBuilder();
  const packets = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const delta = generateDelta(i);
    const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
    const compressed = await brotliCompressAsync(serialized, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 }
    });
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    packets.push(txBuilder.buildDataPacket(encrypted, { compressed: true, encrypted: true }));
  }

  printResult("Full RX pipeline (parse+track+decrypt+decompress)", await measureCPUAsync(
    async (i) => {
      const parsed = parser.parseHeader(packets[i]);
      tracker.processSequence(parsed.sequence);
      const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
      await brotliDecompressAsync(decrypted);
    },
    ITERATIONS
  ));

  tracker.reset();
  console.log();
}

// ── Benchmark 5: Congestion Control Overhead ──
function benchCongestionControl() {
  console.log("=== Congestion Control Overhead ===\n");
  const ITERATIONS = 100000;

  const cc = new CongestionControl({ enabled: true, adjustInterval: 0 });

  printResult("updateMetrics", measureCPU(
    (_i) => cc.updateMetrics({ rtt: 50 + Math.random() * 100, packetLoss: Math.random() * 0.05 }),
    ITERATIONS
  ));

  printResult("shouldAdjust + adjust", measureCPU(
    () => {
      cc.lastAdjustment = 0;
      cc.adjust();
    },
    ITERATIONS
  ));

  console.log();
}

// ── Benchmark 6: Monitoring Overhead ──
function benchMonitoring() {
  console.log("=== Monitoring Overhead ===\n");
  const ITERATIONS = 100000;

  const lossTracker = new PacketLossTracker();
  printResult("PacketLossTracker.record", measureCPU(
    () => lossTracker.record(Math.random() < 0.05),
    ITERATIONS
  ));

  const latencyTracker = new PathLatencyTracker();
  const paths = [
    "navigation.position", "navigation.speed", "environment.wind",
    "environment.depth", "electrical.batteries"
  ];
  printResult("PathLatencyTracker.record", measureCPU(
    (i) => latencyTracker.record(paths[i % paths.length], 50 + Math.random() * 100),
    ITERATIONS
  ));

  const retransmitTracker = new RetransmissionTracker();
  printResult("RetransmissionTracker.snapshot", measureCPU(
    (i) => {
      retransmitTracker._lastSnapshot.timestamp = Date.now() - 1000;
      retransmitTracker.snapshot(i * 10, Math.floor(i * 0.05));
    },
    10000 // fewer iterations, heavier operation
  ));

  const retransmitQueue = new RetransmitQueue({ maxSize: 10000 });
  const packet = Buffer.alloc(500);
  printResult("RetransmitQueue.add + get", measureCPU(
    (i) => {
      retransmitQueue.add(i, packet);
      retransmitQueue.get(i);
    },
    ITERATIONS
  ));

  console.log();
}

// ── Run All ──
async function main() {
  console.log("Signal K Edge Link v2.0 - Phase 7: CPU Profiling Under Load");
  console.log("=" .repeat(60) + "\n");

  benchPacketBuilding();
  await benchCompression();
  benchEncryption();
  await benchFullPipeline();
  benchCongestionControl();
  benchMonitoring();

  console.log("=" .repeat(60));
  console.log("CPU profiling benchmarks complete.");
}

main().catch(console.error);
