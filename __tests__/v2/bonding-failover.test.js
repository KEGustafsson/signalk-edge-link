"use strict";

const { BondingManager, LinkStatus } = require("../../lib/bonding");
const {
  BONDING_RTT_THRESHOLD,
  BONDING_LOSS_THRESHOLD,
  BONDING_FAILBACK_DELAY,
  BONDING_FAILBACK_RTT_HYSTERESIS,
  BONDING_FAILBACK_LOSS_HYSTERESIS
} = require("../../lib/constants");

// Mock dgram with proper event emitter behavior
jest.mock("dgram", () => {
  const createMockSocket = () => {
    const listeners = {};
    return {
      send: jest.fn((msg, port, address, cb) => { if (cb) cb(null); }),
      bind: jest.fn((opts, cb) => { if (cb) cb(null); }),
      close: jest.fn(),
      on: jest.fn((event, handler) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
      }),
      emit: (event, ...args) => {
        if (listeners[event]) {
          listeners[event].forEach(h => h(...args));
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
    failover: {
      rttThreshold: 500,
      lossThreshold: 0.10,
      healthCheckInterval: 1000,
      failbackDelay: 30000,
      heartbeatTimeout: 5000,
      ...overrides
    }
  };
}

describe("Bonding Failover Scenarios", () => {
  let bm;
  let app;

  beforeEach(() => {
    jest.useFakeTimers();
    app = createMockApp();
  });

  afterEach(() => {
    if (bm && bm._initialized) bm.stop();
    jest.useRealTimers();
  });

  // ═══════════════════════════════════════════════
  // Complete Failover Scenarios (using _shouldFailover directly)
  // ═══════════════════════════════════════════════

  describe("Primary Link Failure Scenario", () => {
    test("detects primary failure and switches to backup via _checkHealth", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Primary goes down
      bm.links.primary.health.status = LinkStatus.DOWN;

      // Health check triggers failover
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
      expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);
    });

    test("failover on primary DOWN detected by _shouldFailover", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.status = LinkStatus.DOWN;

      expect(bm._shouldFailover()).toBe(true);
    });
  });

  describe("RTT Degradation Scenario", () => {
    test("does not failover when RTT is below threshold", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.rtt = 200;
      expect(bm._shouldFailover()).toBe(false);

      bm.links.primary.health.rtt = 400;
      expect(bm._shouldFailover()).toBe(false);
    });

    test("fails over when RTT exceeds threshold", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.rtt = 550; // Above 500ms threshold
      expect(bm._shouldFailover()).toBe(true);
    });

    test("stays on backup even if primary RTT drops slightly below threshold (hysteresis)", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Trigger failover
      bm.links.primary.health.rtt = 600;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary RTT improves but not below hysteresis (500 * 0.8 = 400)
      bm.links.primary.health.rtt = 450;
      bm.links.primary.health.loss = 0;
      bm.links.primary.health.status = LinkStatus.STANDBY;
      jest.advanceTimersByTime(31000);

      expect(bm._shouldFailback()).toBe(false);
      expect(bm.activeLink).toBe("backup"); // Hysteresis prevents premature failback
    });
  });

  describe("Packet Loss Scenario", () => {
    test("fails over when loss exceeds threshold", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.loss = 0.15; // 15% > 10% threshold
      expect(bm._shouldFailover()).toBe(true);
    });

    test("does not failover when loss equals threshold exactly", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.loss = 0.10; // Exactly at threshold (not strictly greater)
      expect(bm._shouldFailover()).toBe(false);
    });

    test("failover on loss with good RTT", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.rtt = 50; // Excellent RTT
      bm.links.primary.health.loss = 0.20; // But terrible loss
      expect(bm._shouldFailover()).toBe(true);
    });
  });

  describe("Failback After Recovery", () => {
    test("fails back after delay when primary recovers", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Step 1: Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Step 2: Primary recovers
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 100;
      bm.links.primary.health.loss = 0.01;

      // Step 3: Wait for failback delay then check decision directly
      // (avoid _checkHealth which remeasures health from heartbeat counters)
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(bm.activeLink).toBe("primary");
    });

    test("does not failback prematurely", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Primary recovers immediately
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // Only 5 seconds - should still be on backup
      jest.advanceTimersByTime(5000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });

    test("does not failback if primary has high RTT after recovery", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.rtt = 600;
      bm._checkHealth();

      // Primary recovers but RTT is still above hysteresis
      bm.links.primary.health.rtt = 420; // > 400 (500 * 0.8)
      bm.links.primary.health.loss = 0;
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });

    test("does not failback if primary has high loss after recovery", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.loss = 0.15;
      bm._checkHealth();

      // Primary recovers but loss still above hysteresis
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0.06; // > 0.05 (0.10 * 0.5)
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup");
    });
  });

  describe("Oscillation Prevention", () => {
    test("failback delay prevents rapid switching", async () => {
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

      // Multiple health checks within delay
      for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(1000);
        bm._checkHealth();
      }

      // Still on backup (20s < 30s delay)
      expect(bm.activeLink).toBe("backup");
    });

    test("hysteresis prevents failback when metrics are borderline", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.rtt = 600;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Primary "recovers" but metrics are borderline
      bm.links.primary.health.rtt = 410; // Below 500 but above 400 (hysteresis)
      bm.links.primary.health.loss = 0.06; // Below 0.10 but above 0.05 (hysteresis)
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      bm._checkHealth();

      expect(bm.activeLink).toBe("backup"); // Hysteresis prevents
    });
  });

  describe("Both Links Degraded", () => {
    test("stays on primary when backup is also down", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      bm.links.primary.health.rtt = 600;
      bm.links.backup.health.status = LinkStatus.DOWN;

      // Cannot failover if backup is down
      expect(bm._shouldFailover()).toBe(false);
    });

    test("stays on backup when primary is down and backup degraded", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover to backup
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");

      // Backup gets degraded, but primary still down
      bm.links.backup.health.rtt = 800;
      bm._checkHealth();
      expect(bm.activeLink).toBe("backup");
    });
  });

  describe("Rapid Link Flapping", () => {
    test("handles rapid primary up/down without crash", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      for (let i = 0; i < 10; i++) {
        bm.links.primary.health.status = LinkStatus.DOWN;
        bm._checkHealth();
        bm.links.primary.health.status = LinkStatus.ACTIVE;
        bm.links.primary.health.rtt = 50;
        bm.links.primary.health.loss = 0;
      }

      // Should be on backup after first flap (failback delay prevents going back)
      expect(bm.activeLink).toBe("backup");
    });
  });

  // ═══════════════════════════════════════════════
  // Custom Threshold Scenarios
  // ═══════════════════════════════════════════════

  describe("Custom Thresholds", () => {
    test("respects custom RTT threshold", async () => {
      bm = new BondingManager(createDefaultConfig({ rttThreshold: 1000 }), app);
      await bm.initialize();

      bm.links.primary.health.rtt = 600;
      expect(bm._shouldFailover()).toBe(false); // Below custom threshold

      bm.links.primary.health.rtt = 1100;
      expect(bm._shouldFailover()).toBe(true); // Above custom threshold
    });

    test("respects custom loss threshold", async () => {
      bm = new BondingManager(createDefaultConfig({ lossThreshold: 0.05 }), app);
      await bm.initialize();

      bm.links.primary.health.loss = 0.06;
      expect(bm._shouldFailover()).toBe(true);
    });

    test("respects custom failback delay", async () => {
      bm = new BondingManager(createDefaultConfig({ failbackDelay: 60000 }), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      // Primary recovers
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 50;
      bm.links.primary.health.loss = 0;

      // 30s is not enough with 60s delay
      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(false);
      expect(bm.activeLink).toBe("backup");

      // 60s should be enough
      jest.advanceTimersByTime(30000);
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();
      expect(bm.activeLink).toBe("primary");
    });
  });

  // ═══════════════════════════════════════════════
  // Signal K Notification Scenarios
  // ═══════════════════════════════════════════════

  describe("Signal K Notifications", () => {
    test("emits notification on automatic failover", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();

      expect(app.handleMessage).toHaveBeenCalledWith(
        "vessels.self",
        expect.objectContaining({
          updates: expect.arrayContaining([
            expect.objectContaining({
              values: expect.arrayContaining([
                expect.objectContaining({
                  path: "notifications.signalk-edge-link.linkFailover",
                  value: expect.objectContaining({
                    state: "alert",
                    message: "Link switched: primary to backup",
                    method: ["visual", "sound"]
                  })
                })
              ])
            })
          ])
        })
      );
    });

    test("emits notification on automatic failback", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Failover
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm._checkHealth();
      app.handleMessage.mockClear();

      // Recover and failback
      bm.links.primary.health.status = LinkStatus.STANDBY;
      bm.links.primary.health.rtt = 100;
      bm.links.primary.health.loss = 0.01;
      jest.advanceTimersByTime(31000);

      // Directly call failback to trigger notification
      expect(bm._shouldFailback()).toBe(true);
      bm.failback();

      expect(app.handleMessage).toHaveBeenCalledWith(
        "vessels.self",
        expect.objectContaining({
          updates: expect.arrayContaining([
            expect.objectContaining({
              values: expect.arrayContaining([
                expect.objectContaining({
                  path: "notifications.signalk-edge-link.linkFailover",
                  value: expect.objectContaining({
                    message: "Link switched: backup to primary"
                  })
                })
              ])
            })
          ])
        })
      );
    });

    test("handles notification emit errors gracefully", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      app.handleMessage.mockImplementation(() => {
        throw new Error("SignalK not ready");
      });

      // Should not throw
      expect(() => {
        bm.links.primary.health.status = LinkStatus.DOWN;
        bm._checkHealth();
      }).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════
  // End-to-end Health Check Cycle
  // ═══════════════════════════════════════════════

  describe("End-to-end Health Check", () => {
    test("health check sends probes and evaluates metrics", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      // Run a few health check cycles
      jest.advanceTimersByTime(3000);

      // Heartbeats should have been sent
      expect(bm.links.primary.heartbeatsSent).toBe(3);
      expect(bm.links.backup.heartbeatsSent).toBe(3);
    });

    test("health check cleans up old pending heartbeats", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();
      bm.stopHealthMonitoring();

      // Add old pending heartbeat
      bm.links.primary.pendingHeartbeats.set(99, Date.now() - 10000); // 10s ago

      // Run health check manually
      bm._checkHealth();

      // Old heartbeat should be cleaned up (> 5000ms timeout)
      expect(bm.links.primary.pendingHeartbeats.has(99)).toBe(false);
    });

    test("multiple health checks without responses increase loss", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      // Run health checks without any heartbeat responses
      jest.advanceTimersByTime(3000);

      // Primary should have sent 3 heartbeats but received none
      expect(bm.links.primary.heartbeatsSent).toBe(3);
      expect(bm.links.primary.heartbeatResponses).toBe(0);
      expect(bm.links.primary.health.loss).toBe(1); // 100% loss
    });

    test("link marked DOWN after heartbeat timeout with no responses", async () => {
      bm = new BondingManager(createDefaultConfig(), app);
      await bm.initialize();

      // Advance past heartbeat timeout (5000ms) with enough heartbeats sent
      jest.advanceTimersByTime(6000);

      // With 6 heartbeats sent and 0 responses, after timeout the link should be DOWN
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);
    });
  });

  // ═══════════════════════════════════════════════
  // Constants Validation
  // ═══════════════════════════════════════════════

  describe("Constants", () => {
    test("RTT threshold is 500ms", () => {
      expect(BONDING_RTT_THRESHOLD).toBe(500);
    });

    test("loss threshold is 10%", () => {
      expect(BONDING_LOSS_THRESHOLD).toBe(0.10);
    });

    test("failback delay is 30 seconds", () => {
      expect(BONDING_FAILBACK_DELAY).toBe(30000);
    });

    test("failback RTT hysteresis is 0.8", () => {
      expect(BONDING_FAILBACK_RTT_HYSTERESIS).toBe(0.8);
    });

    test("failback loss hysteresis is 0.5", () => {
      expect(BONDING_FAILBACK_LOSS_HYSTERESIS).toBe(0.5);
    });
  });
});
