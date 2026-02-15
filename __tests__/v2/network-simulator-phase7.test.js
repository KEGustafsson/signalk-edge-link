"use strict";

const { NetworkSimulator, createSimulatedSockets, ThrottlePattern } = require("../../test/network-simulator");

describe("NetworkSimulator - Phase 7 Enhancements", () => {
  let sim;

  afterEach(() => {
    if (sim) {
      sim.destroy();
    }
  });

  // ── Step 23.1: Link Flapping Patterns ──

  describe("Advanced Link Flapping", () => {
    test("rapid flapping drops significant packets", (done) => {
      sim = new NetworkSimulator();
      sim.startFlapping(30, 30); // 30ms up, 30ms down

      const delivered = [];
      const dropped = [];
      let sendCount = 0;

      const interval = setInterval(() => {
        sendCount++;
        const result = sim.send(Buffer.alloc(100), (p) => delivered.push(p));
        if (!result) {dropped.push(sendCount);}
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        sim.stopFlapping();
        // With rapid flapping, some packets should be dropped
        expect(dropped.length).toBeGreaterThan(0);
        expect(delivered.length).toBeGreaterThan(0);
        expect(dropped.length + delivered.length).toBe(sendCount);
        done();
      }, 200);
    });

    test("asymmetric flapping (long up, short down)", (done) => {
      sim = new NetworkSimulator();
      sim.startFlapping(200, 20); // 200ms up, 20ms down

      const results = [];

      // Send packets every 10ms
      const interval = setInterval(() => {
        results.push(sim.send(Buffer.alloc(10), () => {}));
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        sim.stopFlapping();
        const deliveryRate = results.filter(r => r).length / results.length;
        // With 200ms up / 20ms down, most packets should get through
        expect(deliveryRate).toBeGreaterThan(0.7);
        done();
      }, 300);
    });

    test("flapping preserves packet content", (done) => {
      sim = new NetworkSimulator();
      sim.startFlapping(100, 50);

      const received = [];
      const sent = [];

      for (let i = 0; i < 20; i++) {
        const data = Buffer.from(`packet-${i}`);
        sent.push(data.toString());
        sim.send(data, (p) => received.push(p.toString()));
      }

      setTimeout(() => {
        sim.stopFlapping();
        // All received packets should match what was sent
        for (const pkt of received) {
          expect(sent).toContain(pkt);
        }
        done();
      }, 200);
    });
  });

  // ── Step 23.2: Asymmetric Loss ──

  describe("Asymmetric Loss (different rates per direction)", () => {
    test("different loss rates per direction", () => {
      const c2s = new NetworkSimulator({ packetLoss: 0.5 }); // 50% loss client→server
      const s2c = new NetworkSimulator({ packetLoss: 0.0 }); // 0% loss server→client
      const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

      const serverReceived = [];
      const clientReceived = [];

      serverSocket.on("message", (msg) => serverReceived.push(msg));
      clientSocket.on("message", (msg) => clientReceived.push(msg));

      // Send 100 packets in each direction
      for (let i = 0; i < 100; i++) {
        clientSocket.send(Buffer.from(`c2s-${i}`), 4446, "localhost");
        serverSocket.send(Buffer.from(`s2c-${i}`), 4447, "localhost");
      }

      // Client→server should have ~50% loss
      expect(serverReceived.length).toBeLessThan(80);
      expect(serverReceived.length).toBeGreaterThan(20);

      // Server→client should have 0% loss
      expect(clientReceived.length).toBe(100);

      c2s.destroy();
      s2c.destroy();
      clientSocket.close();
      serverSocket.close();
    });

    test("asymmetric latency per direction", (done) => {
      const c2s = new NetworkSimulator({ latency: 10 });  // 10ms client→server
      const s2c = new NetworkSimulator({ latency: 200 }); // 200ms server→client
      const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

      const serverReceived = [];
      const clientReceived = [];

      serverSocket.on("message", () => serverReceived.push(Date.now()));
      clientSocket.on("message", () => clientReceived.push(Date.now()));

      const sendTime = Date.now();
      clientSocket.send(Buffer.from("ping"), 4446, "localhost");
      serverSocket.send(Buffer.from("pong"), 4447, "localhost");

      setTimeout(() => {
        // Server should have received quickly
        expect(serverReceived.length).toBe(1);

        // Client may still be waiting for the high-latency path
        if (clientReceived.length > 0) {
          const clientDelay = clientReceived[0] - sendTime;
          expect(clientDelay).toBeGreaterThanOrEqual(150);
        }

        c2s.destroy();
        s2c.destroy();
        clientSocket.close();
        serverSocket.close();
        done();
      }, 300);
    });

    test("asymmetric bandwidth per direction", () => {
      const c2s = new NetworkSimulator({ bandwidthLimit: 100 });  // 100 bytes/s
      const s2c = new NetworkSimulator({ bandwidthLimit: 10000 }); // 10KB/s
      const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

      const serverReceived = [];
      const clientReceived = [];

      serverSocket.on("message", (msg) => serverReceived.push(msg));
      clientSocket.on("message", (msg) => clientReceived.push(msg));

      const packet = Buffer.alloc(80);

      // Send 5 packets each direction
      for (let i = 0; i < 5; i++) {
        clientSocket.send(packet, 4446, "localhost");
        serverSocket.send(packet, 4447, "localhost");
      }

      // Client→server is bandwidth limited: only 1 packet fits in 100 bytes
      expect(serverReceived.length).toBe(1);
      // Server→client has high bandwidth: all packets fit
      expect(clientReceived.length).toBe(5);

      c2s.destroy();
      s2c.destroy();
      clientSocket.close();
      serverSocket.close();
    });
  });

  // ── Step 23.3: Bandwidth Throttling Patterns ──

  describe("Bandwidth Throttling Patterns", () => {
    test("step-down pattern reduces bandwidth over cycle", () => {
      sim = new NetworkSimulator({
        bandwidthLimit: 10000,
        throttlePattern: {
          type: "step-down",
          cycleDuration: 4000,
          minBandwidth: 1000,
          maxBandwidth: 10000,
          steps: 4
        }
      });

      // At the start of cycle (position ~0), bandwidth should be near max
      const bw1 = sim._getEffectiveBandwidth();
      expect(bw1).toBe(10000);

      // Simulate advancing to 75% through cycle
      sim._throttlePatternStart = Date.now() - 3000;
      const bw2 = sim._getEffectiveBandwidth();
      expect(bw2).toBe(1000);
    });

    test("sawtooth pattern ramps bandwidth linearly", () => {
      sim = new NetworkSimulator({
        throttlePattern: {
          type: "sawtooth",
          cycleDuration: 1000,
          minBandwidth: 1000,
          maxBandwidth: 5000
        }
      });

      // At start of cycle: near min
      sim._throttlePatternStart = Date.now();
      const bw1 = sim._getEffectiveBandwidth();
      // Should be close to minBandwidth (within rounding)
      expect(bw1).toBeGreaterThanOrEqual(1000);
      expect(bw1).toBeLessThan(2000);

      // At 50% of cycle: roughly midpoint
      sim._throttlePatternStart = Date.now() - 500;
      const bw2 = sim._getEffectiveBandwidth();
      expect(bw2).toBeGreaterThanOrEqual(2500);
      expect(bw2).toBeLessThanOrEqual(3500);
    });

    test("burst pattern alternates between full and limited", () => {
      sim = new NetworkSimulator({
        throttlePattern: {
          type: "burst",
          cycleDuration: 2000,
          minBandwidth: 500,
          maxBandwidth: 10000
        }
      });

      // First half of cycle: max bandwidth
      sim._throttlePatternStart = Date.now(); // position = 0% (first half)
      const bw1 = sim._getEffectiveBandwidth();
      expect(bw1).toBe(10000);

      // Second half of cycle: min bandwidth
      sim._throttlePatternStart = Date.now() - 1500; // position = 75% (second half)
      const bw2 = sim._getEffectiveBandwidth();
      expect(bw2).toBe(500);
    });

    test("constant pattern returns fixed bandwidth", () => {
      sim = new NetworkSimulator({
        bandwidthLimit: 5000,
        throttlePattern: {
          type: "constant",
          maxBandwidth: 5000
        }
      });

      expect(sim._getEffectiveBandwidth()).toBe(5000);
    });

    test("setThrottlePattern changes pattern dynamically", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 10000 });
      expect(sim._throttlePattern).toBeNull();

      sim.setThrottlePattern("step-down", {
        cycleDuration: 5000,
        minBandwidth: 1000,
        maxBandwidth: 10000,
        steps: 5
      });

      expect(sim._throttlePattern).not.toBeNull();
      expect(sim._throttlePattern.type).toBe("step-down");
      expect(sim._throttlePattern.steps).toBe(5);
    });

    test("clearThrottlePattern removes pattern", () => {
      sim = new NetworkSimulator({
        throttlePattern: {
          type: "sawtooth",
          cycleDuration: 1000,
          minBandwidth: 100,
          maxBandwidth: 5000
        }
      });

      expect(sim._throttlePattern).not.toBeNull();
      sim.clearThrottlePattern();
      expect(sim._throttlePattern).toBeNull();
    });

    test("throttle pattern affects packet delivery", () => {
      sim = new NetworkSimulator({
        throttlePattern: {
          type: "burst",
          cycleDuration: 2000,
          minBandwidth: 50,  // Very low
          maxBandwidth: 100000
        }
      });

      // In second half (limited bandwidth)
      sim._throttlePatternStart = Date.now() - 1500;

      const packet = Buffer.alloc(100);
      const delivered = [];
      // Try to send many packets
      for (let i = 0; i < 10; i++) {
        sim.send(packet, (p) => delivered.push(p));
      }

      // Should be throttled
      expect(delivered.length).toBeLessThan(10);
      expect(sim.stats.throttledPackets).toBeGreaterThan(0);
    });

    test("without throttle pattern, uses bandwidthLimit directly", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 500 });

      const bw = sim._getEffectiveBandwidth();
      expect(bw).toBe(500);
    });
  });

  // ── Burst/Correlated Loss ──

  describe("Burst Loss (Gilbert-Elliott Model)", () => {
    test("burst loss drops consecutive packets", () => {
      sim = new NetworkSimulator({
        burstLoss: {
          burstLength: 5,
          burstRate: 1.0 // Always enter burst
        }
      });

      const delivered = [];
      for (let i = 0; i < 20; i++) {
        sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      }

      // First packet triggers burst (5 consecutive drops), then next packet
      // triggers another burst, etc.
      expect(sim.stats.burstLossPackets).toBeGreaterThan(0);
      expect(delivered.length).toBeLessThan(20);
    });

    test("burst loss with low rate mostly delivers", () => {
      sim = new NetworkSimulator({
        burstLoss: {
          burstLength: 3,
          burstRate: 0.01 // Very low burst entry rate
        }
      });

      const delivered = [];
      for (let i = 0; i < 1000; i++) {
        sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      }

      // Most packets should get through with 1% burst entry rate
      expect(delivered.length).toBeGreaterThan(800);
    });

    test("setBurstLoss configures burst dynamically", () => {
      sim = new NetworkSimulator();
      expect(sim._burstLoss).toBeNull();

      sim.setBurstLoss(5, 0.1);
      expect(sim._burstLoss).not.toBeNull();
      expect(sim._burstLoss.burstLength).toBe(5);
      expect(sim._burstLoss.burstRate).toBe(0.1);
    });

    test("setBurstLoss with 0 disables burst loss", () => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 3, burstRate: 0.1 }
      });
      expect(sim._burstLoss).not.toBeNull();

      sim.setBurstLoss(0, 0);
      expect(sim._burstLoss).toBeNull();
    });

    test("burst loss stats tracked separately", () => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 3, burstRate: 1.0 }
      });

      for (let i = 0; i < 10; i++) {
        sim.send(Buffer.alloc(10), () => {});
      }

      expect(sim.stats.burstLossPackets).toBeGreaterThan(0);
      expect(sim.stats.burstLossPackets).toBeLessThanOrEqual(sim.stats.droppedPackets);
    });
  });

  // ── Latency Spike Simulation ──

  describe("Latency Spike Simulation", () => {
    test("simulateLatencySpike adds extra delay", (done) => {
      sim = new NetworkSimulator({ latency: 0 });
      sim.simulateLatencySpike(200, 500); // +200ms for 500ms

      const start = Date.now();
      sim.send(Buffer.alloc(10), () => {
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(sim.stats.latencySpikes).toBe(1);
        done();
      });
    });

    test("no spike effect after duration expires", (done) => {
      sim = new NetworkSimulator({ latency: 0 });
      // Spike that already ended
      sim._latencySpike = {
        extraLatency: 500,
        startTime: Date.now() - 2000,
        endTime: Date.now() - 1000
      };

      const delivered = [];
      sim.send(Buffer.alloc(10), (p) => delivered.push(p));

      // Should deliver immediately (no spike active)
      setTimeout(() => {
        expect(delivered.length).toBe(1);
        expect(sim.stats.latencySpikes).toBe(0);
        done();
      }, 50);
    });

    test("clearLatencySpike removes active spike", () => {
      sim = new NetworkSimulator();
      sim.simulateLatencySpike(100, 5000);
      expect(sim._latencySpike).not.toBeNull();

      sim.clearLatencySpike();
      expect(sim._latencySpike).toBeNull();
    });
  });

  // ── Enhanced getConditions ──

  describe("Enhanced Conditions Reporting", () => {
    test("getConditions includes burst loss", () => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 3, burstRate: 0.1 }
      });
      const conditions = sim.getConditions();
      expect(conditions.burstLoss).not.toBeNull();
      expect(conditions.burstLoss.burstLength).toBe(3);
    });

    test("getConditions includes throttle pattern", () => {
      sim = new NetworkSimulator({
        throttlePattern: {
          type: "sawtooth",
          cycleDuration: 1000,
          minBandwidth: 100,
          maxBandwidth: 5000
        }
      });
      const conditions = sim.getConditions();
      expect(conditions.throttlePattern).not.toBeNull();
      expect(conditions.throttlePattern.type).toBe("sawtooth");
    });

    test("getConditions includes latency spike", () => {
      sim = new NetworkSimulator();
      sim.simulateLatencySpike(100, 5000);
      const conditions = sim.getConditions();
      expect(conditions.latencySpike).not.toBeNull();
      expect(conditions.latencySpike.extraLatency).toBe(100);
    });

    test("resetStats includes new counters", () => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 3, burstRate: 1.0 }
      });
      sim.send(Buffer.alloc(10), () => {});
      expect(sim.stats.burstLossPackets).toBeGreaterThan(0);

      sim.resetStats();
      expect(sim.stats.burstLossPackets).toBe(0);
      expect(sim.stats.latencySpikes).toBe(0);
    });
  });

  // ── ThrottlePattern Enum ──

  describe("ThrottlePattern enum", () => {
    test("exports all pattern types", () => {
      expect(ThrottlePattern.CONSTANT).toBe("constant");
      expect(ThrottlePattern.STEP_DOWN).toBe("step-down");
      expect(ThrottlePattern.SAWTOOTH).toBe("sawtooth");
      expect(ThrottlePattern.BURST).toBe("burst");
    });
  });

  // ── Combined Scenarios ──

  describe("Combined Network Conditions", () => {
    test("flapping + burst loss", (done) => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 2, burstRate: 0.3 }
      });
      sim.startFlapping(50, 30);

      const delivered = [];
      let sent = 0;
      const interval = setInterval(() => {
        sent++;
        sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      }, 5);

      setTimeout(() => {
        clearInterval(interval);
        sim.stopFlapping();
        // Combination of flapping + burst should drop more than either alone
        const deliveryRate = delivered.length / sent;
        expect(deliveryRate).toBeLessThan(0.9);
        expect(sim.stats.linkDownDrops).toBeGreaterThan(0);
        done();
      }, 250);
    });

    test("bandwidth throttling + packet loss", () => {
      sim = new NetworkSimulator({
        packetLoss: 0.2,
        bandwidthLimit: 500 // Very limited
      });

      const delivered = [];
      const packet = Buffer.alloc(100);
      for (let i = 0; i < 50; i++) {
        sim.send(packet, (p) => delivered.push(p));
      }

      // Both bandwidth and loss should reduce delivery
      expect(delivered.length).toBeLessThan(40);
      expect(sim.stats.throttledPackets + sim.stats.droppedPackets).toBeGreaterThan(10);
    });

    test("latency spike + jitter", (done) => {
      sim = new NetworkSimulator({ latency: 10, jitter: 5 });
      sim.simulateLatencySpike(100, 500);

      const start = Date.now();
      sim.send(Buffer.alloc(10), () => {
        const elapsed = Date.now() - start;
        // Base latency (10) + spike (100) + jitter (-5 to +5)
        expect(elapsed).toBeGreaterThanOrEqual(90);
        done();
      });
    });
  });

  // ── Destroy Cleanup ──

  describe("Destroy Cleanup", () => {
    test("destroy clears burst loss state", () => {
      sim = new NetworkSimulator({
        burstLoss: { burstLength: 5, burstRate: 0.1 }
      });
      sim._inBurst = true;
      sim._burstRemaining = 3;

      sim.destroy();
      expect(sim._burstLoss).toBeNull();
      expect(sim._inBurst).toBe(false);
    });

    test("destroy clears throttle pattern", () => {
      sim = new NetworkSimulator({
        throttlePattern: { type: "sawtooth", cycleDuration: 1000, minBandwidth: 0, maxBandwidth: 5000 }
      });
      sim.destroy();
      expect(sim._throttlePattern).toBeNull();
    });

    test("destroy clears latency spike", () => {
      sim = new NetworkSimulator();
      sim.simulateLatencySpike(100, 5000);
      sim.destroy();
      expect(sim._latencySpike).toBeNull();
    });
  });
});
