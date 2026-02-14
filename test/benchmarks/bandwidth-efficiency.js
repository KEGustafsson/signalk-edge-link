"use strict";

/**
 * Phase 7 Benchmark: Bandwidth Efficiency at Various Delta Timers
 *
 * Measures:
 * - Compression ratios for different payload types
 * - Protocol overhead percentages
 * - Effective bandwidth utilization at different send rates
 * - Bytes-per-delta at different batch sizes
 *
 * Run: node test/benchmarks/bandwidth-efficiency.js
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { PacketBuilder, HEADER_SIZE } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");
const { CongestionControl } = require("../../lib/congestion");

const brotliCompressAsync = promisify(zlib.brotliCompress);

const SECRET_KEY = "12345678901234567890123456789012";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Sample delta payloads of increasing complexity
function generateNavDelta(index) {
  return {
    updates: [{
      source: { label: "gps", type: "NMEA2000" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "navigation.position.latitude", value: 60.1 + index * 0.001 },
        { path: "navigation.position.longitude", value: 24.9 + index * 0.001 }
      ]
    }]
  };
}

function generateFullDelta(index) {
  return {
    updates: [{
      source: { label: "instruments", type: "NMEA2000" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "navigation.position.latitude", value: 60.1 + index * 0.001 },
        { path: "navigation.position.longitude", value: 24.9 + index * 0.001 },
        { path: "navigation.speedOverGround", value: 5.5 + Math.random() },
        { path: "navigation.courseOverGroundTrue", value: 180 + Math.random() * 10 },
        { path: "environment.wind.speedApparent", value: 8.0 + Math.random() * 2 },
        { path: "environment.wind.angleApparent", value: 45 + Math.random() * 5 },
        { path: "environment.depth.belowSurface", value: 15.3 + Math.random() },
        { path: "environment.water.temperature", value: 288.15 + Math.random() },
        { path: "electrical.batteries.main.voltage", value: 12.4 + Math.random() * 0.2 },
        { path: "navigation.headingTrue", value: 178 + Math.random() * 2 }
      ]
    }]
  };
}

async function compressAndEncrypt(payload) {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  const compressed = await brotliCompressAsync(serialized, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
    }
  });
  const encrypted = encryptBinary(compressed, SECRET_KEY);
  return { serialized, compressed, encrypted };
}

// ── Benchmark 1: Compression Ratios ──
async function benchCompressionRatios() {
  console.log("=== Compression Ratios by Payload Type ===\n");

  const builder = new PacketBuilder();

  // Single nav delta
  const navDelta = generateNavDelta(0);
  const navResult = await compressAndEncrypt({ 0: navDelta });
  const navPacket = builder.buildDataPacket(navResult.encrypted, { compressed: true, encrypted: true });

  console.log("Single Navigation Delta (lat/lon):");
  console.log(`  Raw JSON:    ${formatBytes(navResult.serialized.length)}`);
  console.log(`  Compressed:  ${formatBytes(navResult.compressed.length)} (${((navResult.compressed.length / navResult.serialized.length) * 100).toFixed(1)}%)`);
  console.log(`  + Encrypt:   ${formatBytes(navResult.encrypted.length)}`);
  console.log(`  + v2 Header: ${formatBytes(navPacket.length)} (header: ${HEADER_SIZE}B)`);
  console.log(`  Compression ratio: ${(navResult.serialized.length / navPacket.length).toFixed(2)}x`);
  console.log();

  // Full instrument delta
  const fullDelta = generateFullDelta(0);
  const fullResult = await compressAndEncrypt({ 0: fullDelta });
  const fullPacket = builder.buildDataPacket(fullResult.encrypted, { compressed: true, encrypted: true });

  console.log("Full Instrument Delta (10 paths):");
  console.log(`  Raw JSON:    ${formatBytes(fullResult.serialized.length)}`);
  console.log(`  Compressed:  ${formatBytes(fullResult.compressed.length)} (${((fullResult.compressed.length / fullResult.serialized.length) * 100).toFixed(1)}%)`);
  console.log(`  + Encrypt:   ${formatBytes(fullResult.encrypted.length)}`);
  console.log(`  + v2 Header: ${formatBytes(fullPacket.length)} (header: ${HEADER_SIZE}B)`);
  console.log(`  Compression ratio: ${(fullResult.serialized.length / fullPacket.length).toFixed(2)}x`);
  console.log();

  // Batched deltas
  const batchSizes = [1, 5, 10, 20, 50];
  console.log("Batched Navigation Deltas:");
  console.log("  Batch | Raw JSON | Compressed | Packet | Ratio | Bytes/Delta");
  console.log("  ------|----------|------------|--------|-------|------------");

  for (const size of batchSizes) {
    const batch = {};
    for (let i = 0; i < size; i++) {
      batch[i] = generateNavDelta(i);
    }
    const result = await compressAndEncrypt(batch);
    const batchBuilder = new PacketBuilder();
    const packet = batchBuilder.buildDataPacket(result.encrypted, { compressed: true, encrypted: true });

    console.log(`  ${String(size).padStart(5)} | ${formatBytes(result.serialized.length).padStart(8)} | ${formatBytes(result.compressed.length).padStart(10)} | ${formatBytes(packet.length).padStart(6)} | ${(result.serialized.length / packet.length).toFixed(2).padStart(5)}x | ${Math.round(packet.length / size).toString().padStart(5)} B`);
  }
  console.log();
}

// ── Benchmark 2: Protocol Overhead ──
async function benchProtocolOverhead() {
  console.log("=== Protocol Overhead at Various Send Rates ===\n");

  const builder = new PacketBuilder();

  // Simulated sending at different delta timer intervals
  const deltaTimers = [100, 250, 500, 1000, 2000, 5000];
  const avgPayloadSize = 200; // Typical compressed+encrypted delta
  const ackSize = builder.buildACKPacket(0).length;
  const heartbeatSize = builder.buildHeartbeatPacket().length;
  const acksPerSecond = 10; // 100ms ACK interval
  const heartbeatsPerMinute = 2.4; // 25s interval

  console.log("  Delta Timer | Pkts/sec | Data BW    | ACK Overhead | Total BW   | Overhead %");
  console.log("  ------------|----------|------------|--------------|------------|----------");

  for (const timer of deltaTimers) {
    const packetsPerSec = 1000 / timer;
    const dataBandwidth = packetsPerSec * (avgPayloadSize + HEADER_SIZE);
    const ackBandwidth = acksPerSecond * ackSize;
    const heartbeatBandwidth = (heartbeatsPerMinute / 60) * heartbeatSize;
    const totalBandwidth = dataBandwidth + ackBandwidth + heartbeatBandwidth;
    const overheadPercent = ((ackBandwidth + heartbeatBandwidth) / totalBandwidth * 100);

    console.log(`  ${(timer + "ms").padStart(11)} | ${packetsPerSec.toFixed(1).padStart(8)} | ${formatBytes(Math.round(dataBandwidth)).padStart(10)}/s | ${formatBytes(Math.round(ackBandwidth)).padStart(12)}/s | ${formatBytes(Math.round(totalBandwidth)).padStart(10)}/s | ${overheadPercent.toFixed(2).padStart(8)}%`);
  }
  console.log();
}

// ── Benchmark 3: Congestion Control Response ──
async function benchCongestionResponse() {
  console.log("=== Congestion Control Response Time ===\n");

  const scenarios = [
    { name: "Good Network → Congested", rttSequence: [50, 50, 50, 300, 400, 500, 600], lossSequence: [0, 0, 0, 0.02, 0.05, 0.1, 0.15] },
    { name: "Congested → Recovery", rttSequence: [500, 400, 300, 200, 150, 100, 80], lossSequence: [0.1, 0.08, 0.05, 0.02, 0.01, 0.005, 0] },
    { name: "Satellite Link", rttSequence: [600, 620, 610, 630, 600, 640, 620], lossSequence: [0.02, 0.03, 0.02, 0.04, 0.02, 0.03, 0.02] },
    { name: "Cellular LTE", rttSequence: [30, 40, 35, 200, 50, 30, 25], lossSequence: [0, 0, 0.01, 0.05, 0.02, 0, 0] }
  ];

  for (const scenario of scenarios) {
    const cc = new CongestionControl({
      enabled: true,
      adjustInterval: 0, // Allow immediate adjustment
      initialDeltaTimer: 1000
    });

    console.log(`  Scenario: ${scenario.name}`);
    console.log(`  Step | RTT   | Loss   | Delta Timer | Change`);
    console.log(`  -----|-------|--------|-------------|-------`);

    let prevTimer = 1000;
    for (let i = 0; i < scenario.rttSequence.length; i++) {
      cc.updateMetrics({ rtt: scenario.rttSequence[i], packetLoss: scenario.lossSequence[i] });
      cc.lastAdjustment = 0; // Force adjustment
      const newTimer = cc.adjust();
      const change = newTimer - prevTimer;
      const changeStr = change > 0 ? `+${change}` : `${change}`;
      console.log(`  ${String(i + 1).padStart(4)} | ${String(scenario.rttSequence[i]).padStart(5)}ms | ${(scenario.lossSequence[i] * 100).toFixed(1).padStart(5)}% | ${String(newTimer).padStart(11)}ms | ${changeStr.padStart(5)}ms`);
      prevTimer = newTimer;
    }
    console.log();
  }
}

// ── Benchmark 4: MTU Utilization ──
async function benchMTUUtilization() {
  console.log("=== MTU Utilization Analysis ===\n");

  const MTU = 1400;
  const builder = new PacketBuilder();

  console.log("  Batch Size | Packet Size | MTU Usage | Fits MTU | Wasted Space");
  console.log("  -----------|-------------|-----------|----------|-------------");

  for (let batchSize = 1; batchSize <= 50; batchSize += (batchSize < 10 ? 1 : 5)) {
    const batch = {};
    for (let i = 0; i < batchSize; i++) {
      batch[i] = generateNavDelta(i);
    }
    const result = await compressAndEncrypt(batch);
    const batchBuilder = new PacketBuilder();
    const packet = batchBuilder.buildDataPacket(result.encrypted, { compressed: true, encrypted: true });

    const mtuUsage = (packet.length / MTU * 100);
    const fitsMTU = packet.length <= MTU;
    const wasted = fitsMTU ? MTU - packet.length : -(packet.length - MTU);

    console.log(`  ${String(batchSize).padStart(10)} | ${formatBytes(packet.length).padStart(11)} | ${mtuUsage.toFixed(1).padStart(8)}% | ${(fitsMTU ? "Yes" : "NO!").padStart(8)} | ${fitsMTU ? formatBytes(wasted).padStart(8) : ("-" + formatBytes(-wasted)).padStart(8)}`);
  }
  console.log();
}

// ── Run All ──
async function main() {
  console.log("Signal K Edge Link v2.0 - Phase 7: Bandwidth Efficiency Benchmarks");
  console.log("=" .repeat(65) + "\n");

  await benchCompressionRatios();
  await benchProtocolOverhead();
  await benchCongestionResponse();
  await benchMTUUtilization();

  console.log("=" .repeat(65));
  console.log("Bandwidth efficiency benchmarks complete.");
}

main().catch(console.error);
