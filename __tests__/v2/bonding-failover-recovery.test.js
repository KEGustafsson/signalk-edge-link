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
});
