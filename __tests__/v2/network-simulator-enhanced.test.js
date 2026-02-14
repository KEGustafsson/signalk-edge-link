"use strict";

const { NetworkSimulator, createSimulatedSockets } = require("../../test/network-simulator");

describe("NetworkSimulator - Enhanced Features", () => {
  let sim;

  afterEach(() => {
    if (sim) {
      sim.destroy();
    }
  });

  describe("Bandwidth Throttling", () => {
    test("allows packets within bandwidth limit", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 10000 }); // 10KB/s
      const packet = Buffer.alloc(100);
      const delivered = [];

      for (let i = 0; i < 5; i++) {
        sim.send(packet, (p) => delivered.push(p));
      }

      expect(delivered.length).toBe(5);
    });

    test("drops packets exceeding bandwidth limit", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 100 }); // 100 bytes/s
      const packet = Buffer.alloc(80);
      const delivered = [];

      // First packet: 80 bytes (within 100 limit)
      sim.send(packet, (p) => delivered.push(p));
      // Second packet: would exceed 100 byte limit
      sim.send(packet, (p) => delivered.push(p));

      expect(delivered.length).toBe(1);
      expect(sim.stats.throttledPackets).toBe(1);
    });

    test("resets bandwidth window after 1 second", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 100 });
      const packet = Buffer.alloc(80);

      sim.send(packet, () => {});
      expect(sim.stats.deliveredPackets).toBe(1);

      // Simulate time passing (reset window)
      sim._windowStart -= 1100;
      sim.send(packet, () => {});
      expect(sim.stats.deliveredPackets).toBe(2);
    });

    test("tracks throttled packets in stats", () => {
      sim = new NetworkSimulator({ bandwidthLimit: 100 });
      const packet = Buffer.alloc(60);

      sim.send(packet, () => {}); // 60 bytes within 100 limit
      sim.send(packet, () => {}); // 120 bytes would exceed 100 limit - throttled

      const stats = sim.getStats();
      expect(stats.throttledPackets).toBe(1);
    });
  });

  describe("Link Down", () => {
    test("drops all packets when link is down", () => {
      sim = new NetworkSimulator({ linkDown: true });
      const delivered = [];

      sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      sim.send(Buffer.alloc(10), (p) => delivered.push(p));

      expect(delivered.length).toBe(0);
      expect(sim.stats.linkDownDrops).toBe(2);
    });

    test("setLinkDown toggles link state", () => {
      sim = new NetworkSimulator();
      const delivered = [];

      sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      expect(delivered.length).toBe(1);

      sim.setLinkDown(true);
      sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      expect(delivered.length).toBe(1);
      expect(sim.stats.linkDownDrops).toBe(1);

      sim.setLinkDown(false);
      sim.send(Buffer.alloc(10), (p) => delivered.push(p));
      expect(delivered.length).toBe(2);
    });
  });

  describe("Link Flapping", () => {
    test("starts and stops flapping", () => {
      sim = new NetworkSimulator();
      sim.startFlapping(100, 100);
      expect(sim._flapping).not.toBeNull();

      sim.stopFlapping();
      expect(sim._flapping).toBeNull();
      expect(sim.linkDown).toBe(false);
    });

    test("flapping cycles link state", (done) => {
      sim = new NetworkSimulator();
      sim.startFlapping(50, 50); // 50ms up, 50ms down

      // Initially up
      expect(sim.linkDown).toBe(false);

      // After 60ms should be down
      setTimeout(() => {
        expect(sim.linkDown).toBe(true);

        // After 120ms should be up again
        setTimeout(() => {
          expect(sim.linkDown).toBe(false);
          sim.stopFlapping();
          done();
        }, 70);
      }, 60);
    });

    test("destroy stops flapping", () => {
      sim = new NetworkSimulator();
      sim.startFlapping(100, 100);
      sim.destroy();
      expect(sim._flapping).toBeNull();
    });
  });

  describe("Dynamic Condition Updates", () => {
    test("updateConditions changes network parameters", () => {
      sim = new NetworkSimulator({ latency: 10, packetLoss: 0 });

      sim.updateConditions({
        latency: 50,
        packetLoss: 0.5,
        bandwidthLimit: 1000
      });

      expect(sim.latency).toBe(50);
      expect(sim.packetLoss).toBe(0.5);
      expect(sim.bandwidthLimit).toBe(1000);
    });

    test("updateConditions only changes specified values", () => {
      sim = new NetworkSimulator({ latency: 10, jitter: 5 });

      sim.updateConditions({ latency: 50 });
      expect(sim.latency).toBe(50);
      expect(sim.jitter).toBe(5); // unchanged
    });

    test("getConditions returns current state", () => {
      sim = new NetworkSimulator({
        packetLoss: 0.1,
        latency: 50,
        jitter: 10,
        bandwidthLimit: 5000
      });

      const conditions = sim.getConditions();
      expect(conditions.packetLoss).toBe(0.1);
      expect(conditions.latency).toBe(50);
      expect(conditions.jitter).toBe(10);
      expect(conditions.bandwidthLimit).toBe(5000);
      expect(conditions.linkDown).toBe(false);
      expect(conditions.flapping).toBeNull();
    });

    test("getConditions reflects flapping state", () => {
      sim = new NetworkSimulator();
      sim.startFlapping(100, 200);

      const conditions = sim.getConditions();
      expect(conditions.flapping).not.toBeNull();
      expect(conditions.flapping.upDuration).toBe(100);
      expect(conditions.flapping.downDuration).toBe(200);

      sim.stopFlapping();
    });
  });

  describe("Enhanced Statistics", () => {
    test("resetStats includes new counters", () => {
      sim = new NetworkSimulator({ linkDown: true });
      sim.send(Buffer.alloc(10), () => {});

      sim.resetStats();
      expect(sim.stats.throttledPackets).toBe(0);
      expect(sim.stats.linkDownDrops).toBe(0);
    });

    test("getStats includes all fields", () => {
      sim = new NetworkSimulator();
      const stats = sim.getStats();
      expect(stats).toHaveProperty("totalPackets");
      expect(stats).toHaveProperty("droppedPackets");
      expect(stats).toHaveProperty("deliveredPackets");
      expect(stats).toHaveProperty("reorderedPackets");
      expect(stats).toHaveProperty("lossRate");
      expect(stats).toHaveProperty("deliveryRate");
    });
  });

  describe("Backward Compatibility", () => {
    test("basic send still works without new features", () => {
      sim = new NetworkSimulator({ latency: 0, packetLoss: 0 });
      const delivered = [];

      sim.send(Buffer.from("hello"), (p) => delivered.push(p));
      expect(delivered.length).toBe(1);
      expect(delivered[0].toString()).toBe("hello");
    });

    test("createSimulatedSockets still works", () => {
      const c2s = new NetworkSimulator();
      const s2c = new NetworkSimulator();
      const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

      const serverReceived = [];
      serverSocket.on("message", (msg) => serverReceived.push(msg));

      clientSocket.send(Buffer.from("test"), 4446, "localhost");
      expect(serverReceived.length).toBe(1);

      c2s.destroy();
      s2c.destroy();
      clientSocket.close();
      serverSocket.close();
    });
  });
});
