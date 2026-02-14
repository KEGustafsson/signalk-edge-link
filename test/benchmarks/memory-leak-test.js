"use strict";

/**
 * Phase 7 Benchmark: Memory Leak Testing
 *
 * Long-running stability tests that monitor memory usage over time.
 * Detects memory leaks in:
 * - Retransmit queue (with bounded growth)
 * - Sequence tracker (with cleanup)
 * - Monitoring trackers (with bounded buffers)
 * - Packet builder (sequence number growth)
 * - Congestion control (EMA doesn't accumulate)
 *
 * Run: node test/benchmarks/memory-leak-test.js
 */

const { PacketBuilder, PacketParser } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { CongestionControl } = require("../../lib/congestion");
const { PacketLossTracker, PathLatencyTracker, RetransmissionTracker, AlertManager } = require("../../lib/monitoring");

function formatMB(bytes) {
  return (bytes / 1048576).toFixed(2) + " MB";
}

function getHeapUsed() {
  global.gc && global.gc();
  return process.memoryUsage().heapUsed;
}

function printMemorySnapshot(label) {
  const mem = process.memoryUsage();
  console.log(`  [${label}] heap: ${formatMB(mem.heapUsed)}, rss: ${formatMB(mem.rss)}, external: ${formatMB(mem.external)}`);
  return mem.heapUsed;
}

// ── Test 1: RetransmitQueue Bounded Growth ──
function testRetransmitQueue() {
  console.log("=== RetransmitQueue Bounded Growth ===\n");

  const maxSize = 5000;
  const queue = new RetransmitQueue({ maxSize });
  const packet = Buffer.alloc(500, 0xab);

  const heapBefore = getHeapUsed();
  printMemorySnapshot("Before");

  // Add 20,000 packets (4x the max size)
  for (let i = 0; i < 20000; i++) {
    queue.add(i, packet);
  }

  const heapAfterFill = getHeapUsed();
  printMemorySnapshot("After 20k adds (max 5k retained)");

  console.log(`  Queue size: ${queue.getSize()} (max: ${maxSize})`);

  // Acknowledge all
  queue.acknowledge(19999);
  const heapAfterAck = getHeapUsed();
  printMemorySnapshot("After acknowledge all");

  console.log(`  Queue size after ack: ${queue.getSize()}`);

  // Second round
  for (let i = 20000; i < 40000; i++) {
    queue.add(i, packet);
  }
  const heapSecondRound = getHeapUsed();
  printMemorySnapshot("After second 20k adds");

  queue.acknowledge(39999);
  queue.clear();
  const heapFinal = getHeapUsed();
  printMemorySnapshot("After clear");

  const leaked = heapFinal - heapBefore;
  const leakMB = leaked / 1048576;
  console.log(`\n  Memory delta: ${leakMB > 0 ? "+" : ""}${leakMB.toFixed(2)} MB`);
  console.log(`  Status: ${Math.abs(leakMB) < 5 ? "PASS (bounded)" : "WARN (potential leak)"}`);
  console.log();
}

// ── Test 2: SequenceTracker Cleanup ──
function testSequenceTracker() {
  console.log("=== SequenceTracker Cleanup ===\n");

  const tracker = new SequenceTracker({ nakTimeout: 999999 });

  const heapBefore = getHeapUsed();
  printMemorySnapshot("Before");

  // Process 50,000 in-order sequences
  for (let i = 0; i < 50000; i++) {
    tracker.processSequence(i);
  }

  const heapInOrder = getHeapUsed();
  printMemorySnapshot("After 50k in-order sequences");
  console.log(`  receivedSeqs size: ${tracker.receivedSeqs.size}`);
  console.log(`  expectedSeq: ${tracker.expectedSeq}`);

  // Process with gaps (creates out-of-order buffer entries)
  for (let i = 50000; i < 100000; i += 2) {
    tracker.processSequence(i); // Skip every other
  }

  const heapWithGaps = getHeapUsed();
  printMemorySnapshot("After 25k with gaps");

  tracker.reset();
  const heapAfterReset = getHeapUsed();
  printMemorySnapshot("After reset");

  const leaked = heapAfterReset - heapBefore;
  const leakMB = leaked / 1048576;
  console.log(`\n  Memory delta: ${leakMB > 0 ? "+" : ""}${leakMB.toFixed(2)} MB`);
  console.log(`  Status: ${Math.abs(leakMB) < 5 ? "PASS (bounded)" : "WARN (potential leak)"}`);
  console.log();
}

// ── Test 3: Monitoring Trackers Bounded Buffers ──
function testMonitoringTrackers() {
  console.log("=== Monitoring Trackers Bounded Buffers ===\n");

  const heapBefore = getHeapUsed();
  printMemorySnapshot("Before");

  // PacketLossTracker
  const lossTracker = new PacketLossTracker({ maxBuckets: 60, bucketDuration: 1 });
  for (let i = 0; i < 100000; i++) {
    lossTracker.record(Math.random() < 0.05);
  }
  const heapAfterLoss = getHeapUsed();
  printMemorySnapshot("After 100k loss records");
  console.log(`  Loss tracker buckets: ${lossTracker.buckets.length} (max: 60)`);

  // PathLatencyTracker
  const latencyTracker = new PathLatencyTracker({ windowSize: 50, maxPaths: 200 });
  const paths = [];
  for (let i = 0; i < 500; i++) {
    paths.push(`navigation.path.${i}`);
  }
  for (let i = 0; i < 100000; i++) {
    latencyTracker.record(paths[i % paths.length], Math.random() * 200);
  }
  const heapAfterLatency = getHeapUsed();
  printMemorySnapshot("After 100k latency records (500 paths, max 200)");
  console.log(`  Tracked paths: ${latencyTracker.paths.size} (max: 200)`);

  // RetransmissionTracker
  const retransmitTracker = new RetransmissionTracker({ maxEntries: 120 });
  for (let i = 0; i < 10000; i++) {
    retransmitTracker._lastSnapshot.timestamp = Date.now() - 1000;
    retransmitTracker.snapshot(i * 10, Math.floor(i * 0.05));
  }
  const heapAfterRetransmit = getHeapUsed();
  printMemorySnapshot("After 10k retransmit snapshots");
  console.log(`  Retransmit history entries: ${retransmitTracker.history.length} (max: 120)`);

  // Cleanup
  lossTracker.reset();
  latencyTracker.reset();
  retransmitTracker.reset();
  const heapAfterReset = getHeapUsed();
  printMemorySnapshot("After reset all");

  const leaked = heapAfterReset - heapBefore;
  const leakMB = leaked / 1048576;
  console.log(`\n  Memory delta: ${leakMB > 0 ? "+" : ""}${leakMB.toFixed(2)} MB`);
  console.log(`  Status: ${Math.abs(leakMB) < 5 ? "PASS (bounded)" : "WARN (potential leak)"}`);
  console.log();
}

// ── Test 4: PacketBuilder Sequence Growth ──
function testPacketBuilder() {
  console.log("=== PacketBuilder Sequence Growth ===\n");

  const builder = new PacketBuilder();
  const payload = Buffer.alloc(200, 0xab);

  const heapBefore = getHeapUsed();
  printMemorySnapshot("Before");

  // Build 100,000 packets
  for (let i = 0; i < 100000; i++) {
    builder.buildDataPacket(payload, { compressed: true, encrypted: true });
  }

  const heapAfter = getHeapUsed();
  printMemorySnapshot("After 100k packets built");
  console.log(`  Current sequence: ${builder.getCurrentSequence()}`);

  const leaked = heapAfter - heapBefore;
  const leakMB = leaked / 1048576;
  console.log(`\n  Memory delta: ${leakMB > 0 ? "+" : ""}${leakMB.toFixed(2)} MB`);
  console.log(`  Status: ${Math.abs(leakMB) < 2 ? "PASS (no accumulation)" : "WARN (possible leak)"}`);
  console.log();
}

// ── Test 5: CongestionControl Stability ──
function testCongestionControl() {
  console.log("=== CongestionControl Memory Stability ===\n");

  const cc = new CongestionControl({ enabled: true, adjustInterval: 0 });

  const heapBefore = getHeapUsed();
  printMemorySnapshot("Before");

  // Simulate 1M metric updates
  for (let i = 0; i < 1000000; i++) {
    cc.updateMetrics({ rtt: 50 + Math.random() * 200, packetLoss: Math.random() * 0.1 });
    if (i % 100 === 0) {
      cc.lastAdjustment = 0;
      cc.adjust();
    }
  }

  const heapAfter = getHeapUsed();
  printMemorySnapshot("After 1M metric updates + 10k adjustments");

  const leaked = heapAfter - heapBefore;
  const leakMB = leaked / 1048576;
  console.log(`\n  Memory delta: ${leakMB > 0 ? "+" : ""}${leakMB.toFixed(2)} MB`);
  console.log(`  Status: ${Math.abs(leakMB) < 1 ? "PASS (constant memory)" : "WARN (growing)"}`);
  console.log();
}

// ── Test 6: Sustained Operation Simulation ──
function testSustainedOperation() {
  console.log("=== Sustained Operation (simulated 24h) ===\n");

  // Simulate a condensed version of 24 hours of operation
  const builder = new PacketBuilder();
  const parser = new PacketParser();
  const tracker = new SequenceTracker();
  const queue = new RetransmitQueue({ maxSize: 5000, maxRetransmits: 3 });
  const lossTracker = new PacketLossTracker();
  const cc = new CongestionControl({ enabled: true, adjustInterval: 0 });

  const packet = Buffer.alloc(500, 0xab);
  const snapshots = [];

  const heapStart = getHeapUsed();
  snapshots.push({ time: 0, heap: heapStart });

  // Simulate 86,400 seconds = 86,400 packet cycles (1 per second)
  // Condensed to 100,000 iterations
  const TOTAL_ITERATIONS = 100000;
  const SNAPSHOT_INTERVAL = 20000;

  for (let i = 0; i < TOTAL_ITERATIONS; i++) {
    // Build and queue packet
    const built = builder.buildDataPacket(packet, { compressed: true, encrypted: true });
    queue.add(i, built);

    // Parse on "server" side
    const parsed = parser.parseHeader(built);
    tracker.processSequence(parsed.sequence);

    // Simulate loss tracking
    lossTracker.record(Math.random() < 0.02);

    // Simulate ACKs (acknowledge every 10th packet)
    if (i % 10 === 0 && i > 0) {
      queue.acknowledge(i - 5);
    }

    // Update congestion control
    if (i % 100 === 0) {
      cc.updateMetrics({ rtt: 50 + Math.random() * 100, packetLoss: 0.02 });
      cc.lastAdjustment = 0;
      cc.adjust();
    }

    // Memory snapshot
    if (i > 0 && i % SNAPSHOT_INTERVAL === 0) {
      const heap = getHeapUsed();
      snapshots.push({ time: i, heap });
    }
  }

  const heapEnd = getHeapUsed();
  snapshots.push({ time: TOTAL_ITERATIONS, heap: heapEnd });

  console.log("  Time (iterations) | Heap Used    | Delta from Start");
  console.log("  ------------------|--------------|------------------");
  for (const snap of snapshots) {
    const delta = snap.heap - heapStart;
    console.log(`  ${String(snap.time).padStart(17)} | ${formatMB(snap.heap).padStart(12)} | ${(delta > 0 ? "+" : "") + formatMB(delta)}`);
  }

  const totalGrowth = (heapEnd - heapStart) / 1048576;
  console.log(`\n  Total memory growth: ${totalGrowth.toFixed(2)} MB over ${TOTAL_ITERATIONS.toLocaleString()} iterations`);
  console.log(`  Growth rate: ${(totalGrowth / (TOTAL_ITERATIONS / 1000)).toFixed(4)} MB per 1k iterations`);
  console.log(`  Status: ${totalGrowth < 10 ? "PASS (bounded growth)" : "WARN (memory growing)"}`);

  // Cleanup
  queue.clear();
  tracker.reset();
  lossTracker.reset();
  console.log();
}

// ── Run All ──
function main() {
  console.log("Signal K Edge Link v2.0 - Phase 7: Memory Leak Testing");
  console.log("=" .repeat(55) + "\n");

  testRetransmitQueue();
  testSequenceTracker();
  testMonitoringTrackers();
  testPacketBuilder();
  testCongestionControl();
  testSustainedOperation();

  console.log("=" .repeat(55));
  console.log("Memory leak tests complete.");
}

main();
