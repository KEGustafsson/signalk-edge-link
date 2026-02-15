"use strict";

const { NetworkSimulator, createSimulatedSockets } = require("../network-simulator");
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { SequenceTracker } = require("../../lib/sequence");

// ============================================================
// Network Simulator Tests
// ============================================================

describe("NetworkSimulator", () => {
  test("delivers all packets with 0% loss", () => {
    const sim = new NetworkSimulator({ packetLoss: 0 });
    const delivered = [];

    for (let i = 0; i < 100; i++) {
      sim.send(Buffer.from(`packet ${i}`), (pkt) => delivered.push(pkt));
    }

    expect(delivered).toHaveLength(100);
    expect(sim.getStats().deliveredPackets).toBe(100);
    expect(sim.getStats().droppedPackets).toBe(0);
    sim.destroy();
  });

  test("drops all packets with 100% loss", () => {
    const sim = new NetworkSimulator({ packetLoss: 1.0 });
    const delivered = [];

    for (let i = 0; i < 100; i++) {
      sim.send(Buffer.from(`packet ${i}`), (pkt) => delivered.push(pkt));
    }

    expect(delivered).toHaveLength(0);
    expect(sim.getStats().droppedPackets).toBe(100);
    sim.destroy();
  });

  test("drops approximately correct percentage", () => {
    const sim = new NetworkSimulator({ packetLoss: 0.5 });
    const delivered = [];
    const total = 10000;

    for (let i = 0; i < total; i++) {
      sim.send(Buffer.from("x"), (pkt) => delivered.push(pkt));
    }

    // With 10000 packets and 50% loss, expect between 40% and 60%
    const lossRate = sim.getStats().lossRate;
    expect(lossRate).toBeGreaterThan(0.4);
    expect(lossRate).toBeLessThan(0.6);
    sim.destroy();
  });

  test("adds latency to delivery", (done) => {
    const sim = new NetworkSimulator({ latency: 50, jitter: 0 });
    const startTime = Date.now();

    sim.send(Buffer.from("test"), () => {
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow slight timer imprecision
      sim.destroy();
      done();
    });
  });

  test("tracks statistics correctly", () => {
    const sim = new NetworkSimulator({ packetLoss: 0 });

    for (let i = 0; i < 5; i++) {
      sim.send(Buffer.from("x"), () => {});
    }

    const stats = sim.getStats();
    expect(stats.totalPackets).toBe(5);
    expect(stats.deliveredPackets).toBe(5);
    expect(stats.droppedPackets).toBe(0);
    expect(stats.deliveryRate).toBe(1.0);
    expect(stats.lossRate).toBe(0);
    sim.destroy();
  });

  test("resetStats clears counters", () => {
    const sim = new NetworkSimulator({ packetLoss: 0 });

    sim.send(Buffer.from("x"), () => {});
    sim.resetStats();

    const stats = sim.getStats();
    expect(stats.totalPackets).toBe(0);
    sim.destroy();
  });

  test("destroy cancels pending deliveries", (done) => {
    const sim = new NetworkSimulator({ latency: 500 });
    const delivered = [];

    sim.send(Buffer.from("x"), (pkt) => delivered.push(pkt));
    sim.destroy();

    setTimeout(() => {
      expect(delivered).toHaveLength(0);
      done();
    }, 600);
  });
});

describe("createSimulatedSockets", () => {
  test("routes packets through simulator", (done) => {
    const c2s = new NetworkSimulator({ packetLoss: 0 });
    const s2c = new NetworkSimulator({ packetLoss: 0 });
    const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

    serverSocket.on("message", (msg, rinfo) => {
      expect(msg.toString()).toBe("hello server");
      expect(rinfo.address).toBe("127.0.0.1");
      c2s.destroy();
      s2c.destroy();
      done();
    });

    clientSocket.send(Buffer.from("hello server"), 5000, "127.0.0.1");
  });

  test("routes server replies back to client", (done) => {
    const c2s = new NetworkSimulator({ packetLoss: 0 });
    const s2c = new NetworkSimulator({ packetLoss: 0 });
    const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

    clientSocket.on("message", (msg, _rinfo) => {
      expect(msg.toString()).toBe("hello client");
      c2s.destroy();
      s2c.destroy();
      done();
    });

    serverSocket.send(Buffer.from("hello client"), 6000, "127.0.0.1");
  });
});

// ============================================================
// ACK/NAK Handler Tests (Client Pipeline Logic)
// ============================================================

describe("Client ACK/NAK Handling", () => {
  let builder;
  let parser;
  let retransmitQueue;

  beforeEach(() => {
    builder = new PacketBuilder();
    parser = new PacketParser();
    retransmitQueue = new RetransmitQueue({ maxRetransmits: 3 });
  });

  test("ACK removes acknowledged packets from retransmit queue", () => {
    // Simulate sending 5 packets
    for (let i = 0; i < 5; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      retransmitQueue.add(i, packet);
    }
    expect(retransmitQueue.getSize()).toBe(5);

    // Simulate receiving ACK for seq 2
    const ackBuilder = new PacketBuilder();
    const ackPacket = ackBuilder.buildACKPacket(2);
    const parsed = parser.parseHeader(ackPacket);
    const ackedSeq = parser.parseACKPayload(parsed.payload);

    const removed = retransmitQueue.acknowledge(ackedSeq);

    expect(removed).toBe(3); // 0, 1, 2
    expect(retransmitQueue.getSize()).toBe(2);
    expect(retransmitQueue.get(3)).toBeDefined();
    expect(retransmitQueue.get(4)).toBeDefined();
  });

  test("NAK triggers retransmission of missing packets", () => {
    // Simulate sending 5 packets
    const sentPackets = [];
    for (let i = 0; i < 5; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      sentPackets.push(packet);
      retransmitQueue.add(i, packet);
    }

    // Simulate receiving NAK for [1, 3]
    const nakBuilder = new PacketBuilder();
    const nakPacket = nakBuilder.buildNAKPacket([1, 3]);
    const parsed = parser.parseHeader(nakPacket);
    const missingSeqs = parser.parseNAKPayload(parsed.payload);

    const toRetransmit = retransmitQueue.retransmit(missingSeqs);

    expect(toRetransmit).toHaveLength(2);
    expect(toRetransmit[0].sequence).toBe(1);
    expect(toRetransmit[0].attempt).toBe(1);
    expect(toRetransmit[1].sequence).toBe(3);
  });

  test("retransmit queue handles max attempts correctly", () => {
    const queue = new RetransmitQueue({ maxRetransmits: 2 });
    const packet = builder.buildDataPacket(Buffer.from("test"));
    queue.add(0, packet);

    queue.retransmit([0]); // attempt 1
    queue.retransmit([0]); // attempt 2
    const result = queue.retransmit([0]); // attempt 3 = exceeds max

    expect(result).toHaveLength(0);
    expect(queue.get(0)).toBeUndefined();
  });

  test("progressive ACKs clear queue incrementally", () => {
    for (let i = 0; i < 10; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      retransmitQueue.add(i, packet);
    }

    retransmitQueue.acknowledge(2); // Clear 0, 1, 2
    expect(retransmitQueue.getSize()).toBe(7);

    retransmitQueue.acknowledge(5); // Clear 3, 4, 5
    expect(retransmitQueue.getSize()).toBe(4);

    retransmitQueue.acknowledge(9); // Clear 6, 7, 8, 9
    expect(retransmitQueue.getSize()).toBe(0);
  });
});

// ============================================================
// Server ACK Generation Tests
// ============================================================

describe("Server ACK Generation", () => {
  let sequenceTracker;
  let packetBuilder;
  let parser;

  beforeEach(() => {
    sequenceTracker = new SequenceTracker({ nakTimeout: 100 });
    packetBuilder = new PacketBuilder();
    parser = new PacketParser();
  });

  afterEach(() => {
    sequenceTracker.reset();
  });

  test("ACK packet correctly encodes cumulative sequence", () => {
    // Process sequences 0-4
    for (let i = 0; i < 5; i++) {
      sequenceTracker.processSequence(i);
    }

    // Server should ACK up to expectedSeq - 1 = 4
    const ackSeq = sequenceTracker.expectedSeq - 1;
    expect(ackSeq).toBe(4);

    const ackPacket = packetBuilder.buildACKPacket(ackSeq);
    const parsed = parser.parseHeader(ackPacket);
    expect(parsed.type).toBe(PacketType.ACK);
    expect(parser.parseACKPayload(parsed.payload)).toBe(4);
  });

  test("ACK reflects gap in sequence", () => {
    // Process 0, 1, skip 2, process 3
    sequenceTracker.processSequence(0);
    sequenceTracker.processSequence(1);
    sequenceTracker.processSequence(3); // gap at 2

    // expectedSeq is still 2 (waiting for seq 2)
    expect(sequenceTracker.expectedSeq).toBe(2);

    const ackSeq = sequenceTracker.expectedSeq - 1;
    expect(ackSeq).toBe(1); // Can only ACK up to 1
  });

  test("ACK advances after gap is filled", () => {
    sequenceTracker.processSequence(0);
    sequenceTracker.processSequence(1);
    sequenceTracker.processSequence(3); // gap at 2

    expect(sequenceTracker.expectedSeq).toBe(2);

    sequenceTracker.processSequence(2); // fill gap

    // Now expectedSeq should jump to 4
    expect(sequenceTracker.expectedSeq).toBe(4);

    const ackSeq = sequenceTracker.expectedSeq - 1;
    expect(ackSeq).toBe(3);
  });
});

// ============================================================
// Server NAK Generation Tests
// ============================================================

describe("Server NAK Generation", () => {
  test("NAK generated on gap detection", (done) => {
    const naksSent = [];

    const tracker = new SequenceTracker({
      nakTimeout: 50,
      onLossDetected: (missing) => {
        naksSent.push(missing);
      }
    });

    tracker.processSequence(0);
    tracker.processSequence(1);
    tracker.processSequence(3); // gap at 2

    // Wait for NAK timeout
    setTimeout(() => {
      expect(naksSent.length).toBeGreaterThan(0);
      expect(naksSent[0]).toContain(2);
      tracker.reset();
      done();
    }, 100);
  });

  test("NAK cancelled if missing packet arrives", (done) => {
    const naksSent = [];

    const tracker = new SequenceTracker({
      nakTimeout: 100,
      onLossDetected: (missing) => {
        naksSent.push(missing);
      }
    });

    tracker.processSequence(0);
    tracker.processSequence(2); // gap at 1

    // Fill gap before timeout
    setTimeout(() => {
      tracker.processSequence(1);
    }, 30);

    // Check after NAK timeout
    setTimeout(() => {
      // NAK for seq 1 should have been cancelled
      const hasSeq1NAK = naksSent.some(arr => arr.includes(1));
      expect(hasSeq1NAK).toBe(false);
      tracker.reset();
      done();
    }, 200);
  });

  test("NAK packet encodes missing sequences correctly", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const missingSeqs = [5, 8, 12, 15];
    const nakPacket = builder.buildNAKPacket(missingSeqs);
    const parsed = parser.parseHeader(nakPacket);

    expect(parsed.type).toBe(PacketType.NAK);
    expect(parser.parseNAKPayload(parsed.payload)).toEqual(missingSeqs);
  });
});

// ============================================================
// End-to-End Reliability Flow Tests
// ============================================================

describe("End-to-End Reliability Flow", () => {
  let clientBuilder;
  let serverBuilder;
  let parser;
  let clientQueue;
  let serverTracker;

  beforeEach(() => {
    clientBuilder = new PacketBuilder();
    serverBuilder = new PacketBuilder();
    parser = new PacketParser();
    clientQueue = new RetransmitQueue({ maxRetransmits: 3 });
    serverTracker = new SequenceTracker({ nakTimeout: 50 });
  });

  afterEach(() => {
    serverTracker.reset();
  });

  test("full flow: send → receive → ACK → queue cleanup", () => {
    // Client sends 5 packets
    const sentPackets = [];
    for (let i = 0; i < 5; i++) {
      const packet = clientBuilder.buildDataPacket(Buffer.from(`delta ${i}`));
      sentPackets.push(packet);
      clientQueue.add(i, packet);
    }
    expect(clientQueue.getSize()).toBe(5);

    // Server receives all 5 and tracks sequences
    for (const pkt of sentPackets) {
      const parsed = parser.parseHeader(pkt);
      serverTracker.processSequence(parsed.sequence);
    }
    expect(serverTracker.expectedSeq).toBe(5);

    // Server sends ACK for seq 4
    const ackPacket = serverBuilder.buildACKPacket(4);
    const ackParsed = parser.parseHeader(ackPacket);
    const ackedSeq = parser.parseACKPayload(ackParsed.payload);

    // Client processes ACK
    clientQueue.acknowledge(ackedSeq);
    expect(clientQueue.getSize()).toBe(0);
  });

  test("full flow: send → loss → NAK → retransmit → receive", (done) => {
    const naksSent = [];

    const tracker = new SequenceTracker({
      nakTimeout: 30,
      onLossDetected: (missing) => {
        naksSent.push(missing);
      }
    });

    // Client sends packets 0, 1, 2, 3, 4
    for (let i = 0; i < 5; i++) {
      const packet = clientBuilder.buildDataPacket(Buffer.from(`delta ${i}`));
      clientQueue.add(i, packet);
    }

    // Server receives 0, 1, 3, 4 (packet 2 lost)
    tracker.processSequence(0);
    tracker.processSequence(1);
    tracker.processSequence(3); // gap at 2
    tracker.processSequence(4);

    // Wait for NAK timeout
    setTimeout(() => {
      expect(naksSent.length).toBeGreaterThan(0);

      // Build NAK packet for missing
      const nakPacket = serverBuilder.buildNAKPacket([2]);
      const nakParsed = parser.parseHeader(nakPacket);
      const missingSeqs = parser.parseNAKPayload(nakParsed.payload);

      // Client retransmits
      const retransmitted = clientQueue.retransmit(missingSeqs);
      expect(retransmitted).toHaveLength(1);
      expect(retransmitted[0].sequence).toBe(2);

      // Server receives retransmitted packet
      const retransmitParsed = parser.parseHeader(retransmitted[0].packet);
      tracker.processSequence(retransmitParsed.sequence);

      // Now expectedSeq should be 5 (all received)
      expect(tracker.expectedSeq).toBe(5);

      // Server ACKs up to 4
      const ackPacket = new PacketBuilder().buildACKPacket(4);
      const ackParsed = parser.parseHeader(ackPacket);
      clientQueue.acknowledge(parser.parseACKPayload(ackParsed.payload));
      expect(clientQueue.getSize()).toBe(0);

      tracker.reset();
      done();
    }, 100);
  });

  test("multiple losses and retransmissions", (done) => {
    const naksSent = [];

    const tracker = new SequenceTracker({
      nakTimeout: 30,
      onLossDetected: (missing) => {
        naksSent.push(...missing);
      }
    });

    // Send 10 packets
    for (let i = 0; i < 10; i++) {
      const packet = clientBuilder.buildDataPacket(Buffer.from(`delta ${i}`));
      clientQueue.add(i, packet);
    }

    // Server receives 0, 1, 4, 5, 8, 9 (lost 2, 3, 6, 7)
    tracker.processSequence(0);
    tracker.processSequence(1);
    tracker.processSequence(4);
    tracker.processSequence(5);
    tracker.processSequence(8);
    tracker.processSequence(9);

    setTimeout(() => {
      // Client retransmits all missing
      const missingAll = [2, 3, 6, 7];
      const retransmitted = clientQueue.retransmit(missingAll);
      expect(retransmitted).toHaveLength(4);

      // Server receives retransmitted packets
      for (const { packet: pkt } of retransmitted) {
        const p = parser.parseHeader(pkt);
        tracker.processSequence(p.sequence);
      }

      expect(tracker.expectedSeq).toBe(10);

      tracker.reset();
      done();
    }, 100);
  });

  test("retransmit queue preserves packet integrity", () => {
    const payload = Buffer.from(JSON.stringify({ path: "nav.position", value: 42 }));
    const packet = clientBuilder.buildDataPacket(payload, {
      compressed: true,
      encrypted: true
    });

    clientQueue.add(0, packet);

    // Retransmit
    const [retransmitted] = clientQueue.retransmit([0]);

    // Parse retransmitted packet
    const parsed = parser.parseHeader(retransmitted.packet);
    expect(parsed.type).toBe(PacketType.DATA);
    expect(parsed.flags.compressed).toBe(true);
    expect(parsed.flags.encrypted).toBe(true);
    expect(parsed.sequence).toBe(0);
    expect(parsed.payload.toString()).toBe(payload.toString());
  });
});

// ============================================================
// Network Simulator Integration Tests
// ============================================================

describe("Reliability Under Simulated Network Loss", () => {
  test("retransmit queue handles 5% loss scenario", () => {
    const sim = new NetworkSimulator({ packetLoss: 0.05 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const queue = new RetransmitQueue({ maxRetransmits: 3 });
    const tracker = new SequenceTracker({ nakTimeout: 0 });

    const received = new Set();
    const numPackets = 1000;

    // Send packets through lossy network
    for (let i = 0; i < numPackets; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      queue.add(i, packet);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
        tracker.processSequence(parsed.sequence);
      });
    }

    // Identify missing and retransmit
    const missing = [];
    for (let i = 0; i < numPackets; i++) {
      if (!received.has(i)) {
        missing.push(i);
      }
    }

    // Retransmit missing (through perfect network for simplicity)
    const retransmitted = queue.retransmit(missing);
    for (const entry of retransmitted) {
      received.add(entry.sequence);
    }

    // With retransmission, should have very high delivery
    const deliveryRate = received.size / numPackets;
    expect(deliveryRate).toBeGreaterThan(0.999);

    sim.destroy();
  });

  test("retransmit queue handles 20% loss with multiple rounds", () => {
    const sim = new NetworkSimulator({ packetLoss: 0.2 });
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const queue = new RetransmitQueue({ maxRetransmits: 5 });

    const received = new Set();
    const numPackets = 500;

    // Initial send
    for (let i = 0; i < numPackets; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      queue.add(i, packet);

      sim.send(packet, (pkt) => {
        const parsed = parser.parseHeader(pkt);
        received.add(parsed.sequence);
      });
    }

    // Multiple retransmission rounds
    for (let round = 0; round < 3; round++) {
      const missing = [];
      for (let i = 0; i < numPackets; i++) {
        if (!received.has(i)) {missing.push(i);}
      }
      if (missing.length === 0) {break;}

      const retransmitted = queue.retransmit(missing);
      for (const { packet } of retransmitted) {
        sim.send(packet, (pkt) => {
          const parsed = parser.parseHeader(pkt);
          received.add(parsed.sequence);
        });
      }
    }

    const deliveryRate = received.size / numPackets;
    // After multiple retransmission rounds, should recover most packets
    expect(deliveryRate).toBeGreaterThan(0.98);

    sim.destroy();
  });

  test("simulated socket pair delivers ACK/NAK", (done) => {
    const c2s = new NetworkSimulator({ packetLoss: 0 });
    const s2c = new NetworkSimulator({ packetLoss: 0 });
    const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

    const builder = new PacketBuilder();
    const parser = new PacketParser();

    // Client listens for ACK
    clientSocket.on("message", (msg) => {
      const parsed = parser.parseHeader(msg);
      expect(parsed.type).toBe(PacketType.ACK);
      expect(parser.parseACKPayload(parsed.payload)).toBe(5);
      c2s.destroy();
      s2c.destroy();
      done();
    });

    // Server sends ACK
    const ackPacket = builder.buildACKPacket(5);
    serverSocket.send(ackPacket, 5555, "127.0.0.1");
  });
});

// ============================================================
// Queue Statistics Tests
// ============================================================

describe("Reliability Metrics", () => {
  test("tracks retransmission attempts in statistics", () => {
    const queue = new RetransmitQueue({ maxRetransmits: 5 });
    const builder = new PacketBuilder();

    for (let i = 0; i < 10; i++) {
      queue.add(i, builder.buildDataPacket(Buffer.from(`data ${i}`)));
    }

    // Retransmit some packets
    queue.retransmit([2, 5, 8]); // 3 retransmissions
    queue.retransmit([2, 5]); // 2 more

    const stats = queue.getStats();
    expect(stats.size).toBe(10);
    expect(stats.totalAttempts).toBe(5); // 3 + 2
    expect(stats.maxAttempts).toBe(2); // seq 2 and 5 have 2 attempts
  });

  test("queue depth decreases with ACK", () => {
    const queue = new RetransmitQueue();
    const builder = new PacketBuilder();

    for (let i = 0; i < 100; i++) {
      queue.add(i, builder.buildDataPacket(Buffer.from(`data ${i}`)));
    }
    expect(queue.getSize()).toBe(100);

    queue.acknowledge(49);
    expect(queue.getSize()).toBe(50);

    queue.acknowledge(99);
    expect(queue.getSize()).toBe(0);
  });
});
