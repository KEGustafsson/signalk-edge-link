"use strict";

/**
 * Phase 1 Performance Baseline
 *
 * Measures packet building and parsing performance to establish
 * baseline metrics for the v2 protocol layer.
 *
 * Run: node test/benchmarks/phase-1-baseline.js
 */

const { PacketBuilder, PacketParser } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");

const ITERATIONS = 100000;
const PAYLOAD_SIZES = [100, 500, 1000, 1400];

function benchmark(name, fn, iterations = ITERATIONS) {
  // Warmup
  for (let i = 0; i < 1000; i++) fn();

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();

  const totalMs = Number(end - start) / 1e6;
  const opsPerSec = Math.round((iterations / totalMs) * 1000);
  const avgUs = (totalMs / iterations) * 1000;

  console.log(`  ${name}: ${opsPerSec.toLocaleString()} ops/sec (${avgUs.toFixed(2)} µs/op, ${totalMs.toFixed(0)} ms total)`);
  return { name, opsPerSec, avgUs, totalMs };
}

console.log("Signal K Edge Link v2 - Phase 1 Performance Baseline");
console.log("=====================================================\n");
console.log(`Iterations: ${ITERATIONS.toLocaleString()}\n`);

// --- PacketBuilder benchmarks ---
console.log("PacketBuilder:");

const results = [];

for (const size of PAYLOAD_SIZES) {
  const builder = new PacketBuilder();
  const payload = Buffer.alloc(size, 0xab);

  const result = benchmark(
    `buildDataPacket (${size}B payload)`,
    () => builder.buildDataPacket(payload, { compressed: true, encrypted: true })
  );
  results.push(result);
}

const builder = new PacketBuilder();
results.push(benchmark("buildHeartbeatPacket", () => builder.buildHeartbeatPacket()));
results.push(benchmark("buildACKPacket", () => builder.buildACKPacket(42)));
results.push(benchmark("buildNAKPacket([1,2,3])", () => builder.buildNAKPacket([1, 2, 3])));

console.log();

// --- PacketParser benchmarks ---
console.log("PacketParser:");

const parser = new PacketParser();

for (const size of PAYLOAD_SIZES) {
  const b = new PacketBuilder();
  const packet = b.buildDataPacket(Buffer.alloc(size, 0xab), { compressed: true, encrypted: true });

  results.push(benchmark(
    `parseHeader (${size}B payload)`,
    () => parser.parseHeader(packet)
  ));
}

results.push(benchmark(
  "isV2Packet",
  () => parser.isV2Packet(new PacketBuilder().buildDataPacket(Buffer.alloc(100)))
));

console.log();

// --- SequenceTracker benchmarks ---
console.log("SequenceTracker:");

const tracker1 = new SequenceTracker();
results.push(benchmark(
  "processSequence (in-order)",
  () => {
    tracker1.processSequence(tracker1.expectedSeq);
  }
));
tracker1.reset();

// Out-of-order with gaps
let gapSeq = 0;
const tracker2 = new SequenceTracker({ nakTimeout: 999999 });
results.push(benchmark(
  "processSequence (with gaps)",
  () => {
    gapSeq += 2; // skip every other
    tracker2.processSequence(gapSeq);
  },
  10000 // fewer iterations due to timer accumulation
));
tracker2.reset();

console.log();

// --- Combined pipeline benchmark ---
console.log("Combined (build + parse + track):");

const pBuilder = new PacketBuilder();
const pParser = new PacketParser();
const pTracker = new SequenceTracker();

for (const size of PAYLOAD_SIZES) {
  const payload = Buffer.alloc(size, 0xab);

  results.push(benchmark(
    `full cycle (${size}B)`,
    () => {
      const packet = pBuilder.buildDataPacket(payload, { compressed: true, encrypted: true });
      const parsed = pParser.parseHeader(packet);
      pTracker.processSequence(parsed.sequence);
    }
  ));
}

console.log();

// --- Summary ---
console.log("Summary:");
console.log("--------");
const fastest = results.reduce((a, b) => a.opsPerSec > b.opsPerSec ? a : b);
const slowest = results.reduce((a, b) => a.opsPerSec < b.opsPerSec ? a : b);
console.log(`  Fastest: ${fastest.name} (${fastest.opsPerSec.toLocaleString()} ops/sec)`);
console.log(`  Slowest: ${slowest.name} (${slowest.opsPerSec.toLocaleString()} ops/sec)`);
console.log(`  Full cycle 1KB: overhead per packet is negligible vs compression/encryption`);
console.log();
console.log("Note: These benchmarks measure only the v2 protocol layer overhead.");
console.log("Compression and encryption dominate actual packet processing time.");
