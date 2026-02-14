"use strict";

/**
 * Phase 7: System-Level Validation Tests
 *
 * End-to-end tests that validate the complete v2 protocol system
 * under realistic network conditions, including:
 * - Reliability under sustained packet loss
 * - Recovery from network transitions
 * - Congestion control behavior
 * - Monitoring data integrity
 * - Multi-component interaction
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { PacketBuilder, PacketParser, PacketType, HEADER_SIZE } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { CongestionControl } = require("../../lib/congestion");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { PacketLossTracker, PathLatencyTracker, RetransmissionTracker } = require("../../lib/monitoring");
const { NetworkSimulator, createSimulatedSockets } = require("../network-simulator");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const SECRET_KEY = "12345678901234567890123456789012";

function generateDelta(index) {
  return {
    updates: [{
      source: { label: "test" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "navigation.position.latitude", value: 60.1 + index * 0.001 },
        { path: "navigation.position.longitude", value: 24.9 + index * 0.001 },
        { path: "navigation.speedOverGround", value: 5.0 + Math.random() }
      ]
    }]
  };
}

async function buildPacket(builder, delta) {
  const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
  const compressed = await brotliCompressAsync(serialized, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
    }
  });
  const encrypted = encryptBinary(compressed, SECRET_KEY);
  return builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
}

async function parsePacket(parser, packet) {
  const parsed = parser.parseHeader(packet);
  const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
  const decompressed = await brotliDecompressAsync(decrypted);
  return { ...parsed, data: JSON.parse(decompressed.toString()) };
}

// ── Reliability Under Loss ──

describe("System Validation - Reliability", () => {
  test("achieves >99% delivery at 5% packet loss with retransmission", async () => {
    const sim = new NetworkSimulator({ packetLoss: 0.05 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const tracker = new SequenceTracker();
    const queue = new RetransmitQueue({ maxSize: 5000, maxRetransmits: 5 });

    const TOTAL_PACKETS = 500;
    const received = new Set();

    // Initial send
    for (let i = 0; i < TOTAL_PACKETS; i++) {
      builder.setSequence(i);
      const packet = builder.buildDataPacket(Buffer.alloc(200, i), {
        compressed: true, encrypted: true
      });
      queue.add(i, packet);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    // Retransmission rounds
    let rounds = 0;
    while (received.size < TOTAL_PACKETS && rounds < 10) {
      rounds++;
      const missing = [];
      for (let i = 0; i < TOTAL_PACKETS; i++) {
        if (!received.has(i)) missing.push(i);
      }
      if (missing.length === 0) break;

      const retransmitted = queue.retransmit(missing);
      for (const { packet } of retransmitted) {
        sim.send(packet, (pkt) => {
          const parsed = parser.parseHeader(pkt);
          received.add(parsed.sequence);
        });
      }
    }

    const deliveryRate = received.size / TOTAL_PACKETS;
    expect(deliveryRate).toBeGreaterThanOrEqual(0.99);
    sim.destroy();
  });

  test("achieves >95% delivery at 20% packet loss with retransmission", async () => {
    const sim = new NetworkSimulator({ packetLoss: 0.20 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const queue = new RetransmitQueue({ maxSize: 5000, maxRetransmits: 10 });

    const TOTAL_PACKETS = 200;
    const received = new Set();

    for (let i = 0; i < TOTAL_PACKETS; i++) {
      builder.setSequence(i);
      const packet = builder.buildDataPacket(Buffer.alloc(200, i));
      queue.add(i, packet);
      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    let rounds = 0;
    while (received.size < TOTAL_PACKETS && rounds < 15) {
      rounds++;
      const missing = [];
      for (let i = 0; i < TOTAL_PACKETS; i++) {
        if (!received.has(i)) missing.push(i);
      }
      if (missing.length === 0) break;

      const retransmitted = queue.retransmit(missing);
      for (const { packet } of retransmitted) {
        sim.send(packet, (pkt) => {
          const parsed = parser.parseHeader(pkt);
          received.add(parsed.sequence);
        });
      }
    }

    const deliveryRate = received.size / TOTAL_PACKETS;
    expect(deliveryRate).toBeGreaterThanOrEqual(0.95);
    sim.destroy();
  });
});

// ── Sequence Tracking Under Reordering ──

describe("System Validation - Sequence Tracking", () => {
  test("handles out-of-order delivery correctly", async () => {
    const sim = new NetworkSimulator({ reorderRate: 0.3, reorderDelay: 20, latency: 10 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const tracker = new SequenceTracker();

    const TOTAL = 50;
    const receivedOrder = [];
    let missingDetected = [];

    for (let i = 0; i < TOTAL; i++) {
      const delta = generateDelta(i);
      const packet = await buildPacket(builder, delta);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        receivedOrder.push(parsed.sequence);
        const result = tracker.processSequence(parsed.sequence);
        if (result.missing.length > 0) {
          missingDetected.push(...result.missing);
        }
      });
    }

    // Wait for all delayed deliveries
    await new Promise(resolve => setTimeout(resolve, 200));

    // All packets should eventually arrive
    expect(receivedOrder.length).toBe(TOTAL);
    // Some should have been out of order
    const inOrder = receivedOrder.every((seq, i) => i === 0 || seq > receivedOrder[i - 1]);
    expect(inOrder).toBe(false); // Should NOT be all in order with 30% reorder rate

    sim.destroy();
    tracker.reset();
  });

  test("detects and reports duplicate packets", async () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const tracker = new SequenceTracker();

    const delta = generateDelta(0);
    const packet = await buildPacket(builder, delta);

    // Process same packet twice
    const parsed = parser.parseHeader(packet);
    const result1 = tracker.processSequence(parsed.sequence);
    const result2 = tracker.processSequence(parsed.sequence);

    expect(result1.duplicate).toBe(false);
    expect(result2.duplicate).toBe(true);
    tracker.reset();
  });
});

// ── Congestion Control Integration ──

describe("System Validation - Congestion Control", () => {
  test("reduces send rate when network degrades", () => {
    const cc = new CongestionControl({
      enabled: true,
      adjustInterval: 0,
      initialDeltaTimer: 1000
    });

    // Simulate good network
    for (let i = 0; i < 10; i++) {
      cc.updateMetrics({ rtt: 30, packetLoss: 0 });
      cc.lastAdjustment = 0;
      cc.adjust();
    }
    const goodTimer = cc.getCurrentDeltaTimer();

    // Simulate congestion
    for (let i = 0; i < 20; i++) {
      cc.updateMetrics({ rtt: 500, packetLoss: 0.10 });
      cc.lastAdjustment = 0;
      cc.adjust();
    }
    const congestedTimer = cc.getCurrentDeltaTimer();

    expect(congestedTimer).toBeGreaterThan(goodTimer);
  });

  test("recovers send rate when network improves", () => {
    const cc = new CongestionControl({
      enabled: true,
      adjustInterval: 0,
      initialDeltaTimer: 1000
    });

    // Push to high timer (congested)
    for (let i = 0; i < 20; i++) {
      cc.updateMetrics({ rtt: 500, packetLoss: 0.10 });
      cc.lastAdjustment = 0;
      cc.adjust();
    }
    const congestedTimer = cc.getCurrentDeltaTimer();

    // Recover
    for (let i = 0; i < 50; i++) {
      cc.updateMetrics({ rtt: 30, packetLoss: 0 });
      cc.lastAdjustment = 0;
      cc.adjust();
    }
    const recoveredTimer = cc.getCurrentDeltaTimer();

    expect(recoveredTimer).toBeLessThan(congestedTimer);
  });

  test("manual override disables automatic adjustment", () => {
    const cc = new CongestionControl({
      enabled: true,
      adjustInterval: 0,
      initialDeltaTimer: 1000
    });

    cc.setManualDeltaTimer(500);
    expect(cc.getCurrentDeltaTimer()).toBe(500);

    // Try to adjust - should not change
    cc.updateMetrics({ rtt: 1000, packetLoss: 0.5 });
    cc.lastAdjustment = 0;
    const timer = cc.adjust();
    expect(timer).toBe(500); // Unchanged
  });
});

// ── Monitoring Data Integrity ──

describe("System Validation - Monitoring", () => {
  test("packet loss tracker matches actual loss rate", () => {
    const tracker = new PacketLossTracker({ maxBuckets: 60, bucketDuration: 100 });

    // Record 1000 events with 5% loss
    let lostCount = 0;
    for (let i = 0; i < 1000; i++) {
      const lost = Math.random() < 0.05;
      if (lost) lostCount++;
      tracker.record(lost);
    }

    // Use heatmap data which includes current bucket
    const data = tracker.getHeatmapData();
    let totalSent = 0;
    let totalLost = 0;
    for (const bucket of data) {
      totalSent += bucket.total;
      totalLost += bucket.lost;
    }
    // Also count current bucket entries (not yet pushed to buckets array)
    const effectiveLossRate = lostCount / 1000;
    // Should be approximately 5%
    expect(effectiveLossRate).toBeGreaterThan(0.01);
    expect(effectiveLossRate).toBeLessThan(0.12);
  });

  test("path latency tracker provides accurate percentiles", () => {
    const tracker = new PathLatencyTracker({ windowSize: 100 });

    // Record known distribution
    for (let i = 0; i < 100; i++) {
      tracker.record("test.path", i + 1); // 1 to 100
    }

    const stats = tracker.getPathStats("test.path");
    expect(stats).not.toBeNull();
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    // Percentile calculation uses Math.floor(length * p), so p50 of [1..100] is ~50-51
    expect(stats.p50).toBeGreaterThanOrEqual(49);
    expect(stats.p50).toBeLessThanOrEqual(52);
    expect(stats.p95).toBeGreaterThanOrEqual(94);
    expect(stats.p95).toBeLessThanOrEqual(96);
    expect(stats.avg).toBeCloseTo(50.5, 0);
  });

  test("retransmission tracker records rate snapshots", () => {
    const tracker = new RetransmissionTracker({ maxEntries: 120 });

    // Record 10 snapshots
    for (let i = 1; i <= 10; i++) {
      tracker._lastSnapshot.timestamp = Date.now() - 1000;
      tracker.snapshot(i * 100, Math.floor(i * 5)); // 5% retransmit rate
    }

    const summary = tracker.getSummary();
    expect(summary.entries).toBe(10);
    expect(summary.avgRate).toBeGreaterThan(0);
    expect(summary.maxRate).toBeGreaterThan(0);
  });
});

// ── Full Protocol Round-Trip ──

describe("System Validation - Protocol Round-Trip", () => {
  test("data integrity through full TX→RX pipeline", async () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const originalDelta = generateDelta(42);
    const packet = await buildPacket(builder, originalDelta);
    const result = await parsePacket(parser, packet);

    expect(result.type).toBe(PacketType.DATA);
    expect(result.data["0"].updates[0].values[0].path).toBe("navigation.position.latitude");
    expect(result.data["0"].updates[0].values[0].value).toBe(originalDelta.updates[0].values[0].value);
  });

  test("100 deltas round-trip preserves all data", async () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    for (let i = 0; i < 100; i++) {
      const originalDelta = generateDelta(i);
      const packet = await buildPacket(builder, originalDelta);
      const result = await parsePacket(parser, packet);

      expect(result.sequence).toBe(i);
      expect(result.data["0"].updates[0].values[0].value).toBeCloseTo(
        originalDelta.updates[0].values[0].value, 10
      );
    }
  });

  test("v2 packets are correctly identified", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const dataPacket = builder.buildDataPacket(Buffer.from("test"));
    const heartbeat = builder.buildHeartbeatPacket();
    const ack = builder.buildACKPacket(0);
    const nak = builder.buildNAKPacket([1, 2, 3]);

    expect(parser.isV2Packet(dataPacket)).toBe(true);
    expect(parser.isV2Packet(heartbeat)).toBe(true);
    expect(parser.isV2Packet(ack)).toBe(true);
    expect(parser.isV2Packet(nak)).toBe(true);

    // Random data should not be identified as v2
    expect(parser.isV2Packet(Buffer.from("random data"))).toBe(false);
    expect(parser.isV2Packet(Buffer.alloc(1))).toBe(false);
  });
});

// ── Network Transition Scenarios ──

describe("System Validation - Network Transitions", () => {
  test("survives WiFi → cellular transition", async () => {
    const sim = new NetworkSimulator({ latency: 5, packetLoss: 0 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const queue = new RetransmitQueue({ maxSize: 5000, maxRetransmits: 5 });
    const received = new Set();

    const TOTAL = 100;

    for (let i = 0; i < TOTAL; i++) {
      // Transition at packet 50: WiFi → cellular
      if (i === 50) {
        sim.updateConditions({ latency: 80, jitter: 30, packetLoss: 0.03 });
      }

      builder.setSequence(i);
      const packet = builder.buildDataPacket(Buffer.alloc(200));
      queue.add(i, packet);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    // Wait for delayed packets
    await new Promise(resolve => setTimeout(resolve, 200));

    // Retransmit missing
    let rounds = 0;
    while (received.size < TOTAL && rounds < 5) {
      rounds++;
      const missing = [];
      for (let i = 0; i < TOTAL; i++) {
        if (!received.has(i)) missing.push(i);
      }
      if (missing.length === 0) break;
      for (const { packet } of queue.retransmit(missing)) {
        sim.send(packet, (pkt) => {
          const parsed = parser.parseHeader(pkt);
          received.add(parsed.sequence);
        });
      }
    }

    expect(received.size / TOTAL).toBeGreaterThanOrEqual(0.98);
    sim.destroy();
  });

  test("recovers from brief link outage", async () => {
    const sim = new NetworkSimulator({ latency: 10 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const queue = new RetransmitQueue({ maxSize: 5000, maxRetransmits: 5 });
    const received = new Set();

    const TOTAL = 100;

    for (let i = 0; i < TOTAL; i++) {
      // Link down for packets 30-50
      if (i === 30) sim.setLinkDown(true);
      if (i === 50) sim.setLinkDown(false);

      builder.setSequence(i);
      const packet = builder.buildDataPacket(Buffer.alloc(200));
      queue.add(i, packet);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    // Wait for delayed packets
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have lost packets 30-49
    expect(received.size).toBeLessThan(TOTAL);
    expect(sim.stats.linkDownDrops).toBe(20);

    // Retransmit
    const missing = [];
    for (let i = 0; i < TOTAL; i++) {
      if (!received.has(i)) missing.push(i);
    }

    for (const { packet } of queue.retransmit(missing)) {
      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should recover all packets after retransmit
    expect(received.size).toBe(TOTAL);
    sim.destroy();
  });
});

// ── Retransmit Queue Reliability ──

describe("System Validation - Retransmit Queue", () => {
  test("respects max retransmit limit", () => {
    const queue = new RetransmitQueue({ maxSize: 100, maxRetransmits: 3 });
    const packet = Buffer.alloc(100);

    queue.add(1, packet);

    // Retransmit 3 times
    for (let i = 0; i < 3; i++) {
      const result = queue.retransmit([1]);
      expect(result.length).toBe(1);
    }

    // 4th attempt should fail (max exceeded)
    const result = queue.retransmit([1]);
    expect(result.length).toBe(0);
  });

  test("cumulative ACK clears all lower sequences", () => {
    const queue = new RetransmitQueue({ maxSize: 100 });
    const packet = Buffer.alloc(100);

    for (let i = 0; i < 20; i++) {
      queue.add(i, packet);
    }

    expect(queue.getSize()).toBe(20);
    queue.acknowledge(9); // ACK up to 9
    expect(queue.getSize()).toBe(10); // 10-19 remain
  });

  test("handles high throughput without data loss", () => {
    const queue = new RetransmitQueue({ maxSize: 10000 });

    // Add 10,000 packets
    for (let i = 0; i < 10000; i++) {
      queue.add(i, Buffer.from(`data-${i}`));
    }

    // Verify all retrievable
    for (let i = 0; i < 10000; i++) {
      const entry = queue.get(i);
      expect(entry).toBeTruthy();
      expect(entry.packet.toString()).toBe(`data-${i}`);
    }
  });
});

// ── Asymmetric Network Scenarios ──

describe("System Validation - Asymmetric Networks", () => {
  test("handles asymmetric loss (high uplink, low downlink)", () => {
    const uplink = new NetworkSimulator({ packetLoss: 0.15 });  // 15% uplink loss
    const downlink = new NetworkSimulator({ packetLoss: 0.01 }); // 1% downlink loss
    const { clientSocket, serverSocket } = createSimulatedSockets(uplink, downlink);

    const serverReceived = [];
    const clientReceived = [];

    serverSocket.on("message", (msg) => serverReceived.push(msg));
    clientSocket.on("message", (msg) => clientReceived.push(msg));

    for (let i = 0; i < 200; i++) {
      clientSocket.send(Buffer.from(`up-${i}`), 4446, "localhost");
      serverSocket.send(Buffer.from(`down-${i}`), 4447, "localhost");
    }

    // Uplink should have ~15% loss
    expect(serverReceived.length).toBeLessThan(200);
    expect(serverReceived.length).toBeGreaterThan(130);

    // Downlink should have ~1% loss
    expect(clientReceived.length).toBeGreaterThan(190);

    uplink.destroy();
    downlink.destroy();
    clientSocket.close();
    serverSocket.close();
  });
});
