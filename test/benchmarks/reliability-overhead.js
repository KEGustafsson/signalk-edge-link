"use strict";

/**
 * Signal K Edge Link v2.0 - Reliability Overhead Benchmarks
 *
 * Measures the performance overhead of the reliability layer:
 * - ACK packet size vs data packet size
 * - NAK packet size vs data packet size
 * - Retransmit queue operations throughput
 * - Memory usage of retransmit queue
 */

const { PacketBuilder, PacketParser, HEADER_SIZE } = require("../../lib/packet");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { NetworkSimulator } = require("../network-simulator");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatRate(count, ms) {
  return `${Math.round((count / ms) * 1000).toLocaleString()} ops/sec`;
}

// ----------------------------
// Benchmark 1: ACK/NAK Overhead
// ----------------------------
function benchACKNAKOverhead() {
  console.log("=== ACK/NAK Overhead ===\n");

  const builder = new PacketBuilder();

  // Typical data packet sizes
  const dataSizes = [100, 500, 1000, 5000];

  for (const size of dataSizes) {
    const dataPayload = Buffer.alloc(size, 0xAB);
    const dataPacket = builder.buildDataPacket(dataPayload);
    const ackPacket = builder.buildACKPacket(0);
    const nakPacket3 = builder.buildNAKPacket([1, 2, 3]);
    const nakPacket10 = builder.buildNAKPacket(Array.from({ length: 10 }, (_, i) => i));

    console.log(`Data payload: ${size} bytes`);
    console.log(`  DATA packet: ${dataPacket.length} bytes (${HEADER_SIZE}B header + ${size}B payload)`);
    console.log(`  ACK packet:  ${ackPacket.length} bytes (${((ackPacket.length / dataPacket.length) * 100).toFixed(1)}% of data)`);
    console.log(`  NAK (3 missing): ${nakPacket3.length} bytes (${((nakPacket3.length / dataPacket.length) * 100).toFixed(1)}% of data)`);
    console.log(`  NAK (10 missing): ${nakPacket10.length} bytes (${((nakPacket10.length / dataPacket.length) * 100).toFixed(1)}% of data)`);
    console.log();
  }

  // ACK overhead at different rates
  console.log("ACK bandwidth overhead (100ms interval):");
  const ackSize = builder.buildACKPacket(0).length;
  const acksPerSecond = 10; // 100ms interval
  const ackBandwidth = ackSize * acksPerSecond;
  console.log(`  ACK size: ${ackSize} bytes`);
  console.log(`  ACKs/sec: ${acksPerSecond}`);
  console.log(`  ACK bandwidth: ${ackBandwidth} bytes/sec (${formatBytes(ackBandwidth)}/s)`);
  console.log(`  At 100 data pkts/sec (500B each): ${((ackBandwidth / (100 * 500)) * 100).toFixed(2)}% overhead`);
  console.log(`  At 10 data pkts/sec (500B each):  ${((ackBandwidth / (10 * 500)) * 100).toFixed(2)}% overhead`);
  console.log();
}

// ----------------------------
// Benchmark 2: Retransmit Queue
// ----------------------------
function benchRetransmitQueue() {
  console.log("=== Retransmit Queue Performance ===\n");

  const iterations = 100000;
  const packet = Buffer.alloc(500, 0xAB);

  // Add performance
  const queue1 = new RetransmitQueue({ maxSize: iterations });
  const addStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    queue1.add(i, packet);
  }
  const addTime = Date.now() - addStart;
  console.log(`Add ${iterations.toLocaleString()} packets: ${addTime}ms (${formatRate(iterations, addTime)})`);

  // Get performance
  const getStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    queue1.get(i);
  }
  const getTime = Date.now() - getStart;
  console.log(`Get ${iterations.toLocaleString()} packets: ${getTime}ms (${formatRate(iterations, getTime)})`);

  // Acknowledge performance
  const queue2 = new RetransmitQueue({ maxSize: iterations });
  for (let i = 0; i < iterations; i++) {
    queue2.add(i, packet);
  }
  const ackStart = Date.now();
  queue2.acknowledge(iterations - 1);
  const ackTime = Date.now() - ackStart;
  console.log(`Acknowledge ${iterations.toLocaleString()} packets: ${ackTime}ms`);

  // Retransmit performance
  const queue3 = new RetransmitQueue({ maxSize: 10000 });
  for (let i = 0; i < 10000; i++) {
    queue3.add(i, packet);
  }
  const retransmitSeqs = Array.from({ length: 100 }, (_, i) => i * 100);
  const retransmitStart = Date.now();
  for (let round = 0; round < 1000; round++) {
    queue3.retransmit(retransmitSeqs);
  }
  const retransmitTime = Date.now() - retransmitStart;
  console.log(`Retransmit 100 seqs x 1000 rounds: ${retransmitTime}ms (${formatRate(100000, retransmitTime)})`);

  console.log();
}

// ----------------------------
// Benchmark 3: Memory Usage
// ----------------------------
function benchMemoryUsage() {
  console.log("=== Memory Usage ===\n");

  const sizes = [1000, 5000, 10000, 50000];

  for (const size of sizes) {
    const queue = new RetransmitQueue({ maxSize: size });
    const packet = Buffer.alloc(500, 0xAB);

    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < size; i++) {
      queue.add(i, packet);
    }
    const after = process.memoryUsage().heapUsed;

    const memUsed = after - before;
    const perPacket = memUsed / size;

    console.log(`Queue size ${size.toLocaleString()}: ${formatBytes(memUsed)} total, ${Math.round(perPacket)} bytes/entry`);
    queue.clear();
  }
  console.log();
}

// ----------------------------
// Benchmark 4: Simulated Loss Recovery
// ----------------------------
function benchLossRecovery() {
  console.log("=== Loss Recovery Performance ===\n");

  const lossRates = [0.01, 0.05, 0.10, 0.20];
  const numPackets = 10000;
  const builder = new PacketBuilder();
  const parser = new PacketParser();

  for (const lossRate of lossRates) {
    const sim = new NetworkSimulator({ packetLoss: lossRate });
    const queue = new RetransmitQueue({ maxRetransmits: 5 });
    const received = new Set();

    // Initial send
    for (let i = 0; i < numPackets; i++) {
      const packet = builder.buildDataPacket(Buffer.alloc(100));
      queue.add(i, packet);
      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    const afterInitial = received.size;

    // Retransmission rounds
    let rounds = 0;
    while (received.size < numPackets && rounds < 10) {
      rounds++;
      const missing = [];
      for (let i = 0; i < numPackets; i++) {
        if (!received.has(i)) missing.push(i);
      }
      if (missing.length === 0) break;

      const retransmitted = queue.retransmit(missing);
      for (const { packet, sequence } of retransmitted) {
        sim.send(packet, (pkt) => {
          const parsed = parser.parseHeader(pkt);
          received.add(parsed.sequence);
        });
      }
    }

    const deliveryRate = (received.size / numPackets * 100).toFixed(2);
    console.log(`Loss ${(lossRate * 100).toFixed(0)}%: initial=${afterInitial}/${numPackets}, final=${received.size}/${numPackets} (${deliveryRate}%), rounds=${rounds}`);

    sim.destroy();
  }

  console.log();
}

// ----------------------------
// Run All Benchmarks
// ----------------------------
console.log("Signal K Edge Link v2.0 - Phase 2 Reliability Benchmarks\n");
console.log("=".repeat(55) + "\n");

benchACKNAKOverhead();
benchRetransmitQueue();
benchMemoryUsage();
benchLossRecovery();

console.log("=".repeat(55));
console.log("Benchmarks complete.");
