"use strict";

const { BondingManager, LinkStatus } = require("../../lib/bonding");
const dgram = require("dgram");

// Mock dgram with proper event emitter behavior
jest.mock("dgram", () => {
  const createMockSocket = () => {
    const listeners = {};
    return {
      send: jest.fn((msg, port, address, cb) => {
        if (cb) {
          cb(null);
        }
      }),
      bind: jest.fn((opts, cb) => {
        if (cb) {
          cb(null);
        }
      }),
      close: jest.fn(),
      on: jest.fn((event, handler) => {
        if (!listeners[event]) {
          listeners[event] = [];
        }
        listeners[event].push(handler);
      }),
      emit: (event, ...args) => {
        if (listeners[event]) {
          listeners[event].forEach((h) => h(...args));
        }
      }
    };
  };

  return {
    createSocket: jest.fn(() => createMockSocket())
  };
});

function createMockApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn()
  };
}

function createDefaultConfig(overrides = {}) {
  return {
    mode: "main-backup",
    primary: {
      address: "10.0.0.1",
      port: 4446
    },
    backup: {
      address: "10.0.1.1",
      port: 4447
    },
    notificationsEnabled: true,
    failover: {
      rttThreshold: 500,
      lossThreshold: 0.1,
      healthCheckInterval: 1000,
      failbackDelay: 30000,
      heartbeatTimeout: 5000,
      ...overrides
    }
  };
}

/**
 * Simulate a heartbeat response on a link's socket.
 * Creates an HBPROBE buffer with the given sequence number
 * and emits it as a "message" event on the link's socket.
 */
function simulateHeartbeatResponse(link, seq) {
  const probe = Buffer.alloc(12);
  probe.write("HBPROBE", 0, 7, "ascii");
  probe.writeUInt32BE(seq, 7);
  probe.writeUInt8(0, 11);
  link.socket.emit("message", probe, {});
}

describe("Bonding Failover & Recovery Lifecycle", () => {
  let bm;
  let app;

  beforeEach(() => {
    jest.useFakeTimers();
    app = createMockApp();
  });

  afterEach(() => {
    if (bm && bm._initialized) {
      bm.stop();
    }
    jest.useRealTimers();
  });

  // ═══════════════════════════════════════════════
  // 1. Heartbeat-Driven Failover and Recovery
  // ═══════════════════════════════════════════════

  describe("Heartbeat-Driven Failover and Recovery", () => {
    test("complete lifecycle: heartbeat timeout causes failover, heartbeat recovery causes failback", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      // Backup link should stay healthy — respond to all its heartbeats
      // so only the primary times out.
      // Let health checks run with no primary responses.
      // After heartbeatTimeout (5000ms) + enough probes (>3), primary should go DOWN.
      for (let t = 0; t < 6; t++) {
        // Respond to backup heartbeats to keep backup healthy
        const backupSeq = bm.links.backup.heartbeatSeq;
        jest.advanceTimersByTime(1000);
        // After advanceTimersByTime, a health check has fired and sent a probe.
        // Simulate backup responding to the probe it just got.
        simulateHeartbeatResponse(bm.links.backup, backupSeq);
      }

      // After 6s with no primary responses, primary should be DOWN
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);
      expect(bm.activeLink).toBe("backup");
      expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);

      // Now simulate primary recovery: respond to heartbeats on primary
      // Need to wait for failbackDelay (30s) while keeping primary healthy
      for (let t = 0; t < 31; t++) {
        const primarySeq = bm.links.primary.heartbeatSeq;
        const backupSeq = bm.links.backup.heartbeatSeq;
        jest.advanceTimersByTime(1000);
        simulateHeartbeatResponse(bm.links.primary, primarySeq);
        simulateHeartbeatResponse(bm.links.backup, backupSeq);
      }

      // Primary should have recovered and failback should have occurred
      expect(bm.activeLink).toBe("primary");
      expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
      expect(bm.links.backup.health.status).toBe(LinkStatus.STANDBY);
    });

    test("primary marked DOWN after heartbeat timeout with no responses triggers automatic failover", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      // Keep backup alive
      for (let t = 0; t < 6; t++) {
        const backupSeq = bm.links.backup.heartbeatSeq;
        jest.advanceTimersByTime(1000);
        simulateHeartbeatResponse(bm.links.backup, backupSeq);
      }

      expect(bm.links.primary.heartbeatsSent).toBeGreaterThan(3);
      expect(bm.links.primary.heartbeatResponses).toBe(0);
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);
      expect(bm.activeLink).toBe("backup");
    });
  });

  // ═══════════════════════════════════════════════
  // 2. Callback Verification During Full Cycle
  // ═══════════════════════════════════════════════

  describe("Callback Verification During Full Cycle", () => {
    test("onFailover and onFailback callbacks fire with correct arguments", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      const failoverCb = jest.fn();
      const failbackCb = jest.fn();
      bm.onFailover(failoverCb);
      bm.onFailback(failbackCb);

      // Trigger failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      expect(failoverCb).toHaveBeenCalledTimes(1);
      expect(failoverCb).toHaveBeenCalledWith("primary", "backup");
      expect(failbackCb).not.toHaveBeenCalled();

      // Trigger recovery and failback using direct methods
      // (_checkHealth recalculates metrics from heartbeat data, so use direct approach)
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(failbackCb).toHaveBeenCalledTimes(1);
      expect(failbackCb).toHaveBeenCalledWith("backup", "primary");
    });

    test("callbacks fire on every failover/failback cycle", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      const failoverCb = jest.fn();
      const failbackCb = jest.fn();
      bm.onFailover(failoverCb);
      bm.onFailback(failbackCb);

      for (let cycle = 0; cycle < 3; cycle++) {
        // Failover
        bm.links.primary.health.status = LinkStatus.DOWN;
        bm._checkHealth();

        // Recovery using direct methods
        bm.links.primary.health.status = LinkStatus.STANDBY;
        bm.links.primary.health.rtt = 50;
        bm.links.primary.health.loss = 0;
        jest.advanceTimersByTime(31000);
        expect(bm._shouldFailback()).toBe(true);
        bm.failback();
      }

      expect(failoverCb).toHaveBeenCalledTimes(3);
      expect(failbackCb).toHaveBeenCalledTimes(3);
    });
  });

  // ═══════════════════════════════════════════════
  // 3. Data Path Switching (getActiveDestination)
  // ═══════════════════════════════════════════════

  describe("Data Path Switching via getActiveDestination", () => {
    test("returns correct socket/address throughout failover and recovery", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Before failover: primary
      const beforeFailover = bm.getActiveDestination();
      expect(beforeFailover.socket).toBe(bm.links.primary.socket);
      expect(beforeFailover.address).toBe("10.0.0.1");
      expect(beforeFailover.port).toBe(4446);

      // Failover to backup
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      const afterFailover = bm.getActiveDestination();
      expect(afterFailover.socket).toBe(bm.links.backup.socket);
      expect(afterFailover.address).toBe("10.0.1.1");
      expect(afterFailover.port).toBe(4447);

      // Recovery and failback (use direct methods to avoid _checkHealth overwriting metrics)
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      const afterFailback = bm.getActiveDestination();
      expect(afterFailback.socket).toBe(bm.links.primary.socket);
      expect(afterFailback.address).toBe("10.0.0.1");
      expect(afterFailback.port).toBe(4446);
    });

    test("getActiveSocket and getActiveAddress are consistent with getActiveDestination", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // On primary
      expect(bm.getActiveSocket()).toBe(bm.getActiveDestination().socket);
      expect(bm.getActiveAddress()).toEqual({
        address: bm.getActiveDestination().address,
        port: bm.getActiveDestination().port
      });

      // After failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      expect(bm.getActiveSocket()).toBe(bm.getActiveDestination().socket);
      expect(bm.getActiveAddress()).toEqual({
        address: bm.getActiveDestination().address,
        port: bm.getActiveDestination().port
      });
    });
  });

  // ═══════════════════════════════════════════════
  // 4. Multiple Failover-Recovery Cycles
  // ═══════════════════════════════════════════════

  describe("Multiple Failover-Recovery Cycles", () => {
    test("handles 3 full failover/recovery cycles without state corruption", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      for (let cycle = 1; cycle <= 3; cycle++) {
        // Failover: primary goes down
        bm.links.primary.health.status = LinkStatus.DOWN;
        bm._checkHealth();

        expect(bm.activeLink).toBe("backup");
        expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);

        // Recovery: primary comes back with good metrics
        bm.links.primary.health.status = LinkStatus.STANDBY;
        bm.links.primary.health.rtt = 50;
        bm.links.primary.health.loss = 0;
        jest.advanceTimersByTime(31000);
        expect(bm._shouldFailback()).toBe(true);
        bm.failback();

        expect(bm.activeLink).toBe("primary");
        expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
        expect(bm.links.backup.health.status).toBe(LinkStatus.STANDBY);
      }
    });

    test("pending heartbeats do not accumulate across cycles", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      for (let cycle = 0; cycle < 3; cycle++) {
        // Add some pending heartbeats
        const now = Date.now();
        bm.links.primary.pendingHeartbeats.set(1000 + cycle, now - 10000); // old

        // Failover
        bm.links.primary.health.status = LinkStatus.DOWN;
        bm._checkHealth(); // Should clean up old pending heartbeats

        // Old heartbeats should be cleaned
        expect(bm.links.primary.pendingHeartbeats.has(1000 + cycle)).toBe(false);

        // Recovery
        bm.links.primary.health.status = LinkStatus.STANDBY;
        bm.links.primary.health.rtt = 50;
        bm.links.primary.health.loss = 0;
        jest.advanceTimersByTime(31000);
        bm._checkHealth();
      }
    });
  });

  // ═══════════════════════════════════════════════
  // 5. Gradual Degradation and Recovery
  // ═══════════════════════════════════════════════

  describe("Gradual Degradation and Recovery", () => {
    test("gradual RTT degradation triggers failover, gradual improvement triggers failback", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Gradual RTT increase — use _shouldFailover directly since _checkHealth
      // recalculates metrics from heartbeat data
      bm.links.primary.health.rtt = 100;
      expect(bm._shouldFailover()).toBe(false);

      bm.links.primary.health.rtt = 200;
      expect(bm._shouldFailover()).toBe(false);

      bm.links.primary.health.rtt = 400;
      expect(bm._shouldFailover()).toBe(false);

      // Crosses threshold (500ms) — trigger failover
      bm.links.primary.health.rtt = 550;
      expect(bm._shouldFailover()).toBe(true);
      bm.failover();
      expect(bm.activeLink).toBe("backup");

      // Gradual improvement — still above hysteresis (400ms)
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);

      bm.links.primary.health.rtt = 450;
      expect(bm._shouldFailback()).toBe(false); // 450 > 400 hysteresis

      bm.links.primary.health.rtt = 410;
      expect(bm._shouldFailback()).toBe(false); // 410 > 400 hysteresis

      // Below hysteresis threshold
      bm.links.primary.health.rtt = 350;
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();
      expect(bm.activeLink).toBe("primary"); // 350 < 400
    });

    test("gradual loss degradation triggers failover, gradual loss improvement triggers failback", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Gradual loss increase
      bm.links.primary.health.loss = 0.03;
      expect(bm._shouldFailover()).toBe(false);

      bm.links.primary.health.loss = 0.08;
      expect(bm._shouldFailover()).toBe(false);

      // Crosses threshold (10%) — trigger failover
      bm.links.primary.health.loss = 0.15;
      expect(bm._shouldFailover()).toBe(true);
      bm.failover();
      expect(bm.activeLink).toBe("backup");

      // Gradual improvement
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      jest.advanceTimersByTime(31000);

      bm.links.primary.health.loss = 0.07;
      expect(bm._shouldFailback()).toBe(false); // 0.07 > 0.05 hysteresis

      bm.links.primary.health.loss = 0.03;
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();
      expect(bm.activeLink).toBe("primary"); // 0.03 < 0.05
    });
  });

  // ═══════════════════════════════════════════════
  // 6. Recovery With Partial Improvement
  // ═══════════════════════════════════════════════

  describe("Recovery With Partial Improvement", () => {
    test("stays on backup when primary recovers from DOWN but metrics remain mediocre", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary comes back but with mediocre metrics
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 420; // Above hysteresis (400)
      bm.links.primary.health.loss = 0.06; // Above hysteresis (0.05)

      jest.advanceTimersByTime(31000);
      // Use _shouldFailback directly to avoid _checkHealth overwriting metrics
      expect(bm._shouldFailback()).toBe(false);
      expect(bm.activeLink).toBe("backup");

      // Now improve metrics below hysteresis
      bm.links.primary.health.rtt = 200;
      bm.links.primary.health.loss = 0.02;
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(bm.activeLink).toBe("primary");
    });

    test("stays on backup when only RTT recovers but loss is still high", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Primary comes back with good RTT but bad loss
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0.08; // Above hysteresis (0.05)

      jest.advanceTimersByTime(31000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });

    test("stays on backup when only loss recovers but RTT is still high", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Primary comes back with good loss but bad RTT
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 450; // Above hysteresis (400)
      bm.links.primary.health.loss = 0.01;

      jest.advanceTimersByTime(31000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });
  });

  // ═══════════════════════════════════════════════
  // 7. Socket Error Recovery
  // ═══════════════════════════════════════════════

  describe("Socket Error Recovery", () => {
    test("_scheduleSocketRecovery recreates socket after error", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      const initialCreateCount = dgram.createSocket.mock.calls.length;

      // Trigger socket error on primary
      bm.links.primary.socket.emit("error", new Error("Connection refused"));

      // Primary should be marked DOWN
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);

      // Advance past socket recovery delay (5000ms)
      jest.advanceTimersByTime(5000);

      // Socket should have been recreated
      expect(dgram.createSocket.mock.calls.length).toBeGreaterThan(initialCreateCount);
    });

    test("socket error on primary triggers failover then socket recovery enables failback", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Socket error → primary DOWN → failover
      bm.links.primary.socket.emit("error", new Error("Connection refused"));
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Socket recovery after 5s
      jest.advanceTimersByTime(5000);

      // After socket recovery, link should be STANDBY (not DOWN)
      expect(bm.links.primary.health.status).toBe(LinkStatus.STANDBY);

      // Simulate good health metrics on recovered primary
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Wait failback delay and check using direct methods
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(bm.activeLink).toBe("primary");
    });

    test("does not schedule multiple socket recoveries simultaneously", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      const initialCreateCount = dgram.createSocket.mock.calls.length;

      // Trigger multiple errors rapidly
      bm.links.primary.socket.emit("error", new Error("Error 1"));
      bm.links.primary.socket.emit("error", new Error("Error 2"));
      bm.links.primary.socket.emit("error", new Error("Error 3"));

      // Advance past recovery delay
      jest.advanceTimersByTime(5000);

      // Only one socket recreation should have happened (not 3)
      const newCreateCount = dgram.createSocket.mock.calls.length - initialCreateCount;
      expect(newCreateCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════
  // 8. Both Links Fail, Primary Recovers First
  // ═══════════════════════════════════════════════

  describe("Both Links Fail, Primary Recovers First", () => {
    test("stays on primary when both links are down (cannot failover to dead backup)", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Both links go down
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm.links.backup.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Should stay on primary since backup is also DOWN
      expect(bm.activeLink).toBe("primary");
    });

    test("primary recovering first when both down keeps primary active", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Both links down
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm.links.backup.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("primary");

      // Primary recovers via heartbeat response
      const seq = bm.links.primary.heartbeatSeq;
      bm.links.primary.pendingHeartbeats.set(seq, Date.now());
      simulateHeartbeatResponse(bm.links.primary, seq);

      // Primary should transition from DOWN to ACTIVE (it's the active link)
      expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
      expect(bm.activeLink).toBe("primary");
    });
  });

  // ═══════════════════════════════════════════════
  // 9. Both Links Fail After Failover, Backup Recovers First
  // ═══════════════════════════════════════════════

  describe("Both Links Fail After Failover, Backup Recovers First", () => {
    test("stays on backup when backup recovers first after both are down", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // First: failover to backup (primary goes down)
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Then backup also goes down
      bm.links.backup.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      // Still on backup (no healthy link to switch to)
      expect(bm.activeLink).toBe("backup");

      // Backup recovers first via heartbeat
      const seq = bm.links.backup.heartbeatSeq;
      bm.links.backup.pendingHeartbeats.set(seq, Date.now());
      simulateHeartbeatResponse(bm.links.backup, seq);

      expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);
      expect(bm.activeLink).toBe("backup");
    });

    test("failback to primary after both down: backup recovers then primary recovers", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover to backup
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Both down
      bm.links.backup.health.status = LinkStatus.DOWN;

      // Backup recovers
      const backupSeq = bm.links.backup.heartbeatSeq;
      bm.links.backup.pendingHeartbeats.set(backupSeq, Date.now());
      simulateHeartbeatResponse(bm.links.backup, backupSeq);
      expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);

      // Primary recovers
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Wait failback delay and check using direct methods
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(bm.activeLink).toBe("primary");
      expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
    });
  });

  // ═══════════════════════════════════════════════
  // 10. Failover During Failback Delay
  // ═══════════════════════════════════════════════

  describe("Failover During Failback Delay", () => {
    test("does not failback if primary degrades again during failback delay", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary recovers with good metrics
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Wait partial failback delay
      jest.advanceTimersByTime(15000);

      // Primary degrades again before failback delay completes
      bm.links.primary.health.rtt = 600;
      bm._checkHealth();

      // Wait remainder of failback delay
      jest.advanceTimersByTime(16000);
      bm._checkHealth();

      // Should still be on backup — primary is degraded
      expect(bm.activeLink).toBe("backup");
    });

    test("does not failback if primary goes DOWN again during failback delay", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary recovers
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Wait partial delay
      jest.advanceTimersByTime(20000);

      // Primary goes DOWN again
      bm.links.primary.health.status = LinkStatus.DOWN;

      // Wait past failback delay
      jest.advanceTimersByTime(11000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });
  });

  // ═══════════════════════════════════════════════
  // 11. Metrics Publisher During Lifecycle
  // ═══════════════════════════════════════════════

  describe("Metrics Publisher During Lifecycle", () => {
    test("metrics publisher receives updates during failover and recovery", async () => {
      const mockPublisher = {
        publishLinkMetrics: jest.fn()
      };

      bm = new BondingManager(createDefaultConfig(), app);
      bm.setMetricsPublisher(mockPublisher);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Run a health check — should publish metrics for both links
      bm._checkHealth();

      expect(mockPublisher.publishLinkMetrics).toHaveBeenCalledWith(
        "primary",
        expect.objectContaining({ status: expect.any(String) })
      );
      expect(mockPublisher.publishLinkMetrics).toHaveBeenCalledWith(
        "backup",
        expect.objectContaining({ status: expect.any(String) })
      );

      mockPublisher.publishLinkMetrics.mockClear();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Should still publish metrics for both links after failover
      const primaryCalls = mockPublisher.publishLinkMetrics.mock.calls.filter(
        (c) => c[0] === "primary"
      );
      const backupCalls = mockPublisher.publishLinkMetrics.mock.calls.filter(
        (c) => c[0] === "backup"
      );
      expect(primaryCalls.length).toBeGreaterThan(0);
      expect(backupCalls.length).toBeGreaterThan(0);

      // Primary metrics should show DOWN status
      const lastPrimaryCall = primaryCalls[primaryCalls.length - 1];
      expect(lastPrimaryCall[1].status).toBe(LinkStatus.DOWN);
    });

    test("metrics publisher receives status changes through full lifecycle", async () => {
      const statusHistory = { primary: [], backup: [] };
      const mockPublisher = {
        publishLinkMetrics: jest.fn((name, metrics) => {
          statusHistory[name].push(metrics.status);
        })
      };

      bm = new BondingManager(createDefaultConfig(), app);
      bm.setMetricsPublisher(mockPublisher);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Initial health check
      bm._checkHealth();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Primary should have gone through DOWN
      expect(statusHistory.primary).toContain(LinkStatus.DOWN);

      // Recovery using direct methods
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      // After failback, run one more health check to publish updated metrics
      bm._checkHealth();

      // Primary should now show ACTIVE in the latest metrics
      const lastPrimaryStatus = statusHistory.primary[statusHistory.primary.length - 1];
      expect(lastPrimaryStatus).toBe(LinkStatus.ACTIVE);
    });
  });

  // ═══════════════════════════════════════════════
  // 12. Failback Delay Resets on Each New Failover
  // ═══════════════════════════════════════════════

  describe("Failback Delay Resets on Each New Failover", () => {
    test("second failover resets the failback delay timer", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover #1
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Wait 20s (not enough for failback delay of 30s)
      jest.advanceTimersByTime(20000);

      // Primary recovers, failback
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(11000); // Total 31s from failover #1
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();
      expect(bm.activeLink).toBe("primary");

      // Failover #2
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary recovers again
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Only 25s since failover #2 — should not failback
      jest.advanceTimersByTime(25000);
      expect(bm._shouldFailback()).toBe(false);

      // 5 more seconds (total 30s since failover #2) — should failback
      jest.advanceTimersByTime(6000);
      expect(bm._shouldFailback()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // 13. Recovered Socket Handlers Process Heartbeats
  // ═══════════════════════════════════════════════

  describe("Recovered Socket Handlers Process Heartbeats", () => {
    test("new socket created by recovery can receive heartbeat responses", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      const responsesBefore = bm.links.primary.heartbeatResponses;

      // Trigger socket error → schedules recovery
      bm.links.primary.socket.emit("error", new Error("test error"));
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);

      // Advance past recovery delay (5s) to create new socket
      jest.advanceTimersByTime(5000);
      expect(bm.links.primary.health.status).toBe(LinkStatus.STANDBY);

      // The new socket should have message handler wired up
      // Add a pending heartbeat and simulate response on the NEW socket
      const seq = 999;
      bm.links.primary.pendingHeartbeats.set(seq, Date.now());
      simulateHeartbeatResponse(bm.links.primary, seq);

      expect(bm.links.primary.heartbeatResponses).toBe(responsesBefore + 1);
    });
  });

  // ═══════════════════════════════════════════════
  // 14. Socket Recovery Not Scheduled When Stopped
  // ═══════════════════════════════════════════════

  describe("Socket Recovery Not Scheduled When Stopped", () => {
    test("does not schedule recovery timer after stop()", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      const primarySocket = bm.links.primary.socket;

      // Stop the manager
      bm.stop();

      // Trigger socket error on the old socket reference
      primarySocket.emit("error", new Error("post-stop error"));

      // Recovery timer should not be set
      expect(bm.links.primary._recoveryTimer).toBeFalsy();

      // Advance past recovery delay — no socket should be created
      const createCountBefore = dgram.createSocket.mock.calls.length;
      jest.advanceTimersByTime(6000);
      expect(dgram.createSocket.mock.calls.length).toBe(createCountBefore);
    });
  });

  // ═══════════════════════════════════════════════
  // 15. Interface Binding During Socket Recovery
  // ═══════════════════════════════════════════════

  describe("Interface Binding During Socket Recovery", () => {
    test("recovered socket binds to configured interface", async () => {
      const config = createDefaultConfig();
      config.primary.interface = "192.168.1.1";
      bm = new BondingManager(config, app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Trigger socket error
      bm.links.primary.socket.emit("error", new Error("test error"));

      // Advance past recovery delay
      jest.advanceTimersByTime(5000);

      // New socket should have been bound with the interface address
      const newSocket = bm.links.primary.socket;
      expect(newSocket.bind).toHaveBeenCalledWith(
        { address: "192.168.1.1", port: 0 },
        expect.any(Function)
      );
    });
  });

  // ═══════════════════════════════════════════════
  // 16. Backup Fails While Active After Failover
  // ═══════════════════════════════════════════════

  describe("Backup Fails While Active After Failover", () => {
    test("stays on backup when it goes DOWN and primary is also DOWN (stuck)", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover to backup
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Backup also goes DOWN
      bm.links.backup.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Stuck — both links down, stays on backup
      expect(bm.activeLink).toBe("backup");
      expect(bm._shouldFailover()).toBe(false); // already on backup
      expect(bm._shouldFailback()).toBe(false); // primary still DOWN
    });
  });

  // ═══════════════════════════════════════════════
  // 17. HMAC-Authenticated Heartbeat Probes
  // ═══════════════════════════════════════════════

  describe("HMAC-Authenticated Heartbeat Probes", () => {
    // 32-char ASCII key for normalizeKey
    const testSecretKey = "abcdefghijklmnopqrstuvwxyz123456";

    test("heartbeat probes include HMAC tag when secretKey is configured", async () => {
      const config = createDefaultConfig();
      config.secretKey = testSecretKey;
      bm = new BondingManager(config, app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Run a health check which sends heartbeat probes
      bm._checkHealth();

      // Check the buffer sent via socket.send on primary
      const sendCalls = bm.links.primary.socket.send.mock.calls;
      expect(sendCalls.length).toBeGreaterThan(0);

      const sentBuffer = sendCalls[sendCalls.length - 1][0];
      // With HMAC: 12-byte header + 8-byte HMAC tag = 20 bytes
      expect(sentBuffer.length).toBe(20);
      // Should still start with HBPROBE
      expect(sentBuffer.toString("ascii", 0, 7)).toBe("HBPROBE");
    });

    test("heartbeat probes are 12 bytes without secretKey", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      bm._checkHealth();

      const sendCalls = bm.links.primary.socket.send.mock.calls;
      const sentBuffer = sendCalls[sendCalls.length - 1][0];
      expect(sentBuffer.length).toBe(12);
    });
  });

  // ═══════════════════════════════════════════════
  // 18. HMAC Verification Rejects Invalid Responses
  // ═══════════════════════════════════════════════

  describe("HMAC Verification Rejects Invalid Responses", () => {
    const testSecretKey = "abcdefghijklmnopqrstuvwxyz123456";

    test("rejects heartbeat response with missing HMAC tag", async () => {
      const config = createDefaultConfig();
      config.secretKey = testSecretKey;
      bm = new BondingManager(config, app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Send a probe first
      bm._checkHealth();
      const seq = bm.links.primary.heartbeatSeq - 1;
      const responsesBefore = bm.links.primary.heartbeatResponses;

      // Send response without HMAC (only 12 bytes) — should be rejected
      const shortResponse = Buffer.alloc(12);
      shortResponse.write("HBPROBE", 0, 7, "ascii");
      shortResponse.writeUInt32BE(seq, 7);
      bm.links.primary.socket.emit("message", shortResponse, {});

      expect(bm.links.primary.heartbeatResponses).toBe(responsesBefore);
    });

    test("rejects heartbeat response with wrong HMAC tag", async () => {
      const config = createDefaultConfig();
      config.secretKey = testSecretKey;
      bm = new BondingManager(config, app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      bm._checkHealth();
      const seq = bm.links.primary.heartbeatSeq - 1;
      const responsesBefore = bm.links.primary.heartbeatResponses;

      // Send response with wrong HMAC (random bytes)
      const header = Buffer.alloc(12);
      header.write("HBPROBE", 0, 7, "ascii");
      header.writeUInt32BE(seq, 7);
      const fakeTag = Buffer.from("deadbeef", "hex").subarray(0, 8);
      // Pad to 8 bytes
      const paddedTag = Buffer.alloc(8);
      fakeTag.copy(paddedTag);
      const badResponse = Buffer.concat([header, paddedTag]);

      bm.links.primary.socket.emit("message", badResponse, {});

      expect(bm.links.primary.heartbeatResponses).toBe(responsesBefore);
    });
  });

  // ═══════════════════════════════════════════════
  // 19. getState() During Transitions
  // ═══════════════════════════════════════════════

  describe("getState() During Transitions", () => {
    test("reflects state changes through failover and recovery", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Initial state
      const initial = bm.getState();
      expect(initial.activeLink).toBe("primary");
      expect(initial.lastFailoverTime).toBe(0);
      expect(initial.enabled).toBe(true);
      expect(initial.mode).toBe("main-backup");

      // After failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      const afterFailover = bm.getState();
      expect(afterFailover.activeLink).toBe("backup");
      expect(afterFailover.lastFailoverTime).toBeGreaterThan(0);

      // After failback
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);
      bm.failback();

      const afterFailback = bm.getState();
      expect(afterFailback.activeLink).toBe("primary");
    });

    test("getLinkHealth reflects correct statuses during failover", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      const health = bm.getLinkHealth();
      expect(health.primary.status).toBe(LinkStatus.DOWN);
      expect(health.backup.status).toBe(LinkStatus.ACTIVE);
    });
  });

  // ═══════════════════════════════════════════════
  // 20. Notifications Disabled During Failover/Recovery
  // ═══════════════════════════════════════════════

  describe("Notifications Disabled During Failover/Recovery", () => {
    test("no notifications emitted when notificationsEnabled is false", async () => {
      const config = createDefaultConfig();
      config.notificationsEnabled = false;
      bm = new BondingManager(config, app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Failback
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;
      jest.advanceTimersByTime(31000);
      bm.failback();

      // handleMessage should never have been called for notifications
      expect(app.handleMessage).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  // 21. Manual Failover Does Not Interfere With Health Check Loop
  // ═══════════════════════════════════════════════

  describe("Manual Failover Does Not Interfere With Health Check Loop", () => {
    test("manually calling failover() while monitoring is active continues health checks", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      // Health monitoring is running

      const heartbeatsBefore = bm.links.primary.heartbeatsSent;

      // Manual failover
      bm.failover();
      expect(bm.activeLink).toBe("backup");
      expect(bm._shouldFailover()).toBe(false); // already on backup

      // Health checks should continue running
      jest.advanceTimersByTime(3000);
      expect(bm.links.primary.heartbeatsSent).toBeGreaterThan(heartbeatsBefore);
      expect(bm.links.backup.heartbeatsSent).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 22. EMA RTT Smoothing Accuracy
  // ═══════════════════════════════════════════════

  describe("EMA RTT Smoothing Accuracy", () => {
    test("RTT follows EMA formula: 0.2 * new + 0.8 * old", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // First heartbeat response: RTT = 100ms (first sample sets directly)
      bm.links.primary.pendingHeartbeats.set(0, Date.now() - 100);
      simulateHeartbeatResponse(bm.links.primary, 0);
      expect(bm.links.primary.health.rtt).toBe(100);

      // Second: new=200, EMA = 0.2*200 + 0.8*100 = 120
      bm.links.primary.pendingHeartbeats.set(1, Date.now() - 200);
      simulateHeartbeatResponse(bm.links.primary, 1);
      expect(bm.links.primary.health.rtt).toBeCloseTo(120, 0);

      // Third: new=300, EMA = 0.2*300 + 0.8*120 = 156
      bm.links.primary.pendingHeartbeats.set(2, Date.now() - 300);
      simulateHeartbeatResponse(bm.links.primary, 2);
      expect(bm.links.primary.health.rtt).toBeCloseTo(156, 0);

      // Fourth: new=400, EMA = 0.2*400 + 0.8*156 = 204.8
      bm.links.primary.pendingHeartbeats.set(3, Date.now() - 400);
      simulateHeartbeatResponse(bm.links.primary, 3);
      expect(bm.links.primary.health.rtt).toBeCloseTo(204.8, 0);

      // Fifth: new=500, EMA = 0.2*500 + 0.8*204.8 = 263.84
      bm.links.primary.pendingHeartbeats.set(4, Date.now() - 500);
      simulateHeartbeatResponse(bm.links.primary, 4);
      expect(bm.links.primary.health.rtt).toBeCloseTo(263.84, 0);
    });
  });

  // ═══════════════════════════════════════════════
  // 23. CircularBuffer Loss Window Boundary
  // ═══════════════════════════════════════════════

  describe("CircularBuffer Loss Window Boundary", () => {
    test("loss ratio changes as samples slide through the window", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Send 10 heartbeats and respond to all — loss should be 0
      for (let i = 0; i < 10; i++) {
        bm._checkHealth(); // Sends probes, records pending
        const seq = bm.links.primary.heartbeatSeq - 1;
        simulateHeartbeatResponse(bm.links.primary, seq);
      }

      // Run one more health check to update metrics
      bm._checkHealth();
      // Loss should be very low (all responded)
      expect(bm.links.primary.health.loss).toBeLessThanOrEqual(0.1);

      // Now send heartbeats WITHOUT responses — loss should increase
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(6000); // Ensure pending heartbeats time out
        bm._checkHealth(); // Old pending heartbeats get cleaned up as losses
      }

      // Loss should have increased significantly
      expect(bm.links.primary.health.loss).toBeGreaterThan(0);
    });
  });
});
