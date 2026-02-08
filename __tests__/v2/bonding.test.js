"use strict";

const { BondingManager, LinkStatus, BondingMode } = require("../../lib/bonding");
const {
  BONDING_HEALTH_CHECK_INTERVAL,
  BONDING_RTT_THRESHOLD,
  BONDING_LOSS_THRESHOLD,
  BONDING_FAILBACK_DELAY,
  BONDING_HEARTBEAT_TIMEOUT,
  BONDING_FAILBACK_RTT_HYSTERESIS,
  BONDING_FAILBACK_LOSS_HYSTERESIS,
  BONDING_HEALTH_WINDOW_SIZE,
  BONDING_RTT_EMA_ALPHA
} = require("../../lib/constants");

// Mock dgram with proper event emitter behavior
jest.mock("dgram", () => {
  const createMockSocket = () => {
    const listeners = {};
    const socket = {
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
    return socket;
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

function createDefaultConfig() {
  return {
    mode: "main-backup",
    primary: {
      address: "10.0.0.1",
      port: 4446,
      interface: null
    },
    backup: {
      address: "10.0.1.1",
      port: 4447,
      interface: null
    },
    failover: {
      rttThreshold: 500,
      lossThreshold: 0.10,
      healthCheckInterval: 1000,
      failbackDelay: 30000,
      heartbeatTimeout: 5000
    }
  };
}

describe("BondingManager", () => {
  let bm;
  let app;
  let config;

  beforeEach(() => {
    jest.useFakeTimers();
    app = createMockApp();
    config = createDefaultConfig();
    bm = new BondingManager(config, app);
  });

  afterEach(() => {
    if (bm && bm._initialized) {
      bm.stop();
    }
    jest.useRealTimers();
  });

  // ═══════════════════════════════════════════════
  // Construction
  // ═══════════════════════════════════════════════

  describe("Construction", () => {
    test("initializes with default config values", () => {
      const defaultBm = new BondingManager({
        primary: { address: "1.2.3.4", port: 4446 },
        backup: { address: "5.6.7.8", port: 4447 }
      }, app);

      expect(defaultBm.mode).toBe("main-backup");
      expect(defaultBm.activeLink).toBe("primary");
      expect(defaultBm.failoverThresholds.rttThreshold).toBe(BONDING_RTT_THRESHOLD);
      expect(defaultBm.failoverThresholds.lossThreshold).toBe(BONDING_LOSS_THRESHOLD);
      expect(defaultBm.failoverThresholds.healthCheckInterval).toBe(BONDING_HEALTH_CHECK_INTERVAL);
      expect(defaultBm.failoverThresholds.failbackDelay).toBe(BONDING_FAILBACK_DELAY);
      expect(defaultBm.failoverThresholds.heartbeatTimeout).toBe(BONDING_HEARTBEAT_TIMEOUT);
    });

    test("respects custom config values", () => {
      expect(bm.config).toBe(config);
      expect(bm.failoverThresholds.rttThreshold).toBe(500);
      expect(bm.failoverThresholds.lossThreshold).toBe(0.10);
      expect(bm.failoverThresholds.healthCheckInterval).toBe(1000);
      expect(bm.failoverThresholds.failbackDelay).toBe(30000);
      expect(bm.failoverThresholds.heartbeatTimeout).toBe(5000);
    });

    test("stores primary link configuration", () => {
      expect(bm.links.primary.address).toBe("10.0.0.1");
      expect(bm.links.primary.port).toBe(4446);
      expect(bm.links.primary.interface).toBeNull();
    });

    test("stores backup link configuration", () => {
      expect(bm.links.backup.address).toBe("10.0.1.1");
      expect(bm.links.backup.port).toBe(4447);
      expect(bm.links.backup.interface).toBeNull();
    });

    test("starts with primary as active link", () => {
      expect(bm.activeLink).toBe("primary");
    });

    test("initializes link health as unknown before init", () => {
      expect(bm.links.primary.health.status).toBe(LinkStatus.UNKNOWN);
      expect(bm.links.backup.health.status).toBe(LinkStatus.UNKNOWN);
    });

    test("initializes counters to zero", () => {
      expect(bm.links.primary.heartbeatSeq).toBe(0);
      expect(bm.links.primary.heartbeatResponses).toBe(0);
      expect(bm.links.primary.heartbeatsSent).toBe(0);
      expect(bm.links.backup.heartbeatSeq).toBe(0);
      expect(bm.links.backup.heartbeatResponses).toBe(0);
      expect(bm.links.backup.heartbeatsSent).toBe(0);
    });

    test("initializes with no metrics publisher", () => {
      expect(bm.metricsPublisher).toBeNull();
    });

    test("is not initialized before calling initialize()", () => {
      expect(bm._initialized).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════

  describe("Initialization", () => {
    test("creates UDP sockets for both links", async () => {
      await bm.initialize();

      expect(bm.links.primary.socket).toBeTruthy();
      expect(bm.links.backup.socket).toBeTruthy();
    });

    test("sets primary to active after init", async () => {
      await bm.initialize();

      expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
    });

    test("sets backup to standby after init", async () => {
      await bm.initialize();

      expect(bm.links.backup.health.status).toBe(LinkStatus.STANDBY);
    });

    test("starts health monitoring after init", async () => {
      await bm.initialize();

      expect(bm.healthCheckTimer).toBeTruthy();
    });

    test("marks as initialized", async () => {
      await bm.initialize();

      expect(bm._initialized).toBe(true);
    });

    test("is idempotent - calling initialize twice has no effect", async () => {
      await bm.initialize();
      const firstSocket = bm.links.primary.socket;

      await bm.initialize();
      expect(bm.links.primary.socket).toBe(firstSocket);
    });

    test("registers message handlers on sockets", async () => {
      await bm.initialize();

      // Verify handler was registered by testing behavior:
      // Simulate heartbeat response on primary socket
      const probe = Buffer.alloc(12);
      probe.write("HBPROBE", 0, 7, "ascii");
      probe.writeUInt32BE(0, 7);
      bm.links.primary.pendingHeartbeats.set(0, Date.now());
      bm.links.primary.socket.emit("message", probe, {});
      expect(bm.links.primary.heartbeatResponses).toBe(1);
    });

    test("registers error handlers on sockets", async () => {
      await bm.initialize();

      // Verify error handler by testing behavior:
      // Triggering error should mark link as DOWN
      bm.links.primary.socket.emit("error", new Error("test error"));
      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);

      bm.links.backup.socket.emit("error", new Error("test error"));
      expect(bm.links.backup.health.status).toBe(LinkStatus.DOWN);
    });
  });

  // ═══════════════════════════════════════════════
  // Link Status Enum
  // ═══════════════════════════════════════════════

  describe("LinkStatus enum", () => {
    test("has UNKNOWN value", () => {
      expect(LinkStatus.UNKNOWN).toBe("unknown");
    });

    test("has ACTIVE value", () => {
      expect(LinkStatus.ACTIVE).toBe("active");
    });

    test("has STANDBY value", () => {
      expect(LinkStatus.STANDBY).toBe("standby");
    });

    test("has DOWN value", () => {
      expect(LinkStatus.DOWN).toBe("down");
    });

    test("is frozen", () => {
      expect(Object.isFrozen(LinkStatus)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // BondingMode enum
  // ═══════════════════════════════════════════════

  describe("BondingMode enum", () => {
    test("has MAIN_BACKUP value", () => {
      expect(BondingMode.MAIN_BACKUP).toBe("main-backup");
    });

    test("is frozen", () => {
      expect(Object.isFrozen(BondingMode)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // Active Socket & Address
  // ═══════════════════════════════════════════════

  describe("Active Socket & Address", () => {
    test("getActiveSocket returns primary socket by default", async () => {
      await bm.initialize();
      expect(bm.getActiveSocket()).toBe(bm.links.primary.socket);
    });

    test("getActiveAddress returns primary address by default", async () => {
      await bm.initialize();
      const addr = bm.getActiveAddress();
      expect(addr.address).toBe("10.0.0.1");
      expect(addr.port).toBe(4446);
    });

    test("getActiveLinkName returns 'primary' by default", () => {
      expect(bm.getActiveLinkName()).toBe("primary");
    });

    test("getActiveSocket returns backup socket after failover", async () => {
      await bm.initialize();
      bm.failover();
      expect(bm.getActiveSocket()).toBe(bm.links.backup.socket);
    });

    test("getActiveAddress returns backup address after failover", async () => {
      await bm.initialize();
      bm.failover();
      const addr = bm.getActiveAddress();
      expect(addr.address).toBe("10.0.1.1");
      expect(addr.port).toBe(4447);
    });

    test("getActiveLinkName returns 'backup' after failover", async () => {
      await bm.initialize();
      bm.failover();
      expect(bm.getActiveLinkName()).toBe("backup");
    });
  });

  // ═══════════════════════════════════════════════
  // Failover
  // ═══════════════════════════════════════════════

  describe("Failover", () => {
    test("switches active link to backup", async () => {
      await bm.initialize();
      bm.failover();

      expect(bm.activeLink).toBe("backup");
    });

    test("sets backup status to active", async () => {
      await bm.initialize();
      bm.failover();

      expect(bm.links.backup.health.status).toBe(LinkStatus.ACTIVE);
    });

    test("sets primary status to standby", async () => {
      await bm.initialize();
      bm.failover();

      expect(bm.links.primary.health.status).toBe(LinkStatus.STANDBY);
    });

    test("preserves DOWN status on primary if it was down", async () => {
      await bm.initialize();
      bm.links.primary.health.status = LinkStatus.DOWN;
      bm.failover();

      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);
    });

    test("records failover timestamp", async () => {
      await bm.initialize();
      const before = Date.now();
      bm.failover();

      expect(bm.lastFailoverTime).toBeGreaterThanOrEqual(before);
    });

    test("emits Signal K notification", async () => {
      await bm.initialize();
      bm.failover();

      expect(app.handleMessage).toHaveBeenCalledWith("vessels.self", expect.objectContaining({
        updates: expect.arrayContaining([
          expect.objectContaining({
            values: expect.arrayContaining([
              expect.objectContaining({
                path: "notifications.signalk-edge-link.linkFailover",
                value: expect.objectContaining({
                  state: "alert",
                  message: "Link switched: primary to backup"
                })
              })
            ])
          })
        ])
      }));
    });

    test("logs error message", async () => {
      await bm.initialize();
      bm.failover();

      expect(app.error).toHaveBeenCalledWith("[FAILOVER] Switching from primary to backup link");
    });

    test("is idempotent - calling failover when already on backup does nothing", async () => {
      await bm.initialize();
      bm.failover();
      const time = bm.lastFailoverTime;
      jest.advanceTimersByTime(100);
      bm.failover();

      expect(bm.lastFailoverTime).toBe(time);
    });

    test("calls onFailover callback", async () => {
      await bm.initialize();
      const callback = jest.fn();
      bm.onFailover(callback);
      bm.failover();

      expect(callback).toHaveBeenCalledWith("primary", "backup");
    });
  });

  // ═══════════════════════════════════════════════
  // Failback
  // ═══════════════════════════════════════════════

  describe("Failback", () => {
    test("switches active link back to primary", async () => {
      await bm.initialize();
      bm.failover();
      bm.failback();

      expect(bm.activeLink).toBe("primary");
    });

    test("sets primary status to active", async () => {
      await bm.initialize();
      bm.failover();
      bm.failback();

      expect(bm.links.primary.health.status).toBe(LinkStatus.ACTIVE);
    });

    test("sets backup status to standby", async () => {
      await bm.initialize();
      bm.failover();
      bm.failback();

      expect(bm.links.backup.health.status).toBe(LinkStatus.STANDBY);
    });

    test("emits Signal K notification for failback", async () => {
      await bm.initialize();
      bm.failover();
      app.handleMessage.mockClear();
      bm.failback();

      expect(app.handleMessage).toHaveBeenCalledWith("vessels.self", expect.objectContaining({
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
      }));
    });

    test("is idempotent - calling failback when already on primary does nothing", async () => {
      await bm.initialize();
      app.handleMessage.mockClear();
      bm.failback();
      // Should not emit any failover notification
      expect(app.handleMessage).not.toHaveBeenCalled();
    });

    test("calls onFailback callback", async () => {
      await bm.initialize();
      const callback = jest.fn();
      bm.onFailback(callback);
      bm.failover();
      bm.failback();

      expect(callback).toHaveBeenCalledWith("backup", "primary");
    });
  });

  // ═══════════════════════════════════════════════
  // Force Failover
  // ═══════════════════════════════════════════════

  describe("forceFailover", () => {
    test("toggles from primary to backup", async () => {
      await bm.initialize();
      bm.forceFailover();
      expect(bm.activeLink).toBe("backup");
    });

    test("toggles from backup to primary", async () => {
      await bm.initialize();
      bm.failover();
      bm.forceFailover();
      expect(bm.activeLink).toBe("primary");
    });
  });

  // ═══════════════════════════════════════════════
  // shouldFailover logic (unit tests - call directly)
  // ═══════════════════════════════════════════════

  describe("Failover Decision Logic (_shouldFailover)", () => {
    test("does not failover when on backup already", async () => {
      await bm.initialize();
      bm.activeLink = "backup";
      expect(bm._shouldFailover()).toBe(false);
    });

    test("does not failover when backup is down", async () => {
      await bm.initialize();
      bm.links.backup.health.status = LinkStatus.DOWN;
      bm.links.primary.health.rtt = 600;
      expect(bm._shouldFailover()).toBe(false);
    });

    test("triggers failover when primary is down", async () => {
      await bm.initialize();
      bm.links.primary.health.status = LinkStatus.DOWN;
      expect(bm._shouldFailover()).toBe(true);
    });

    test("triggers failover when RTT exceeds threshold", async () => {
      await bm.initialize();
      bm.links.primary.health.rtt = 600;
      expect(bm._shouldFailover()).toBe(true);
    });

    test("does not trigger failover when RTT is within threshold", async () => {
      await bm.initialize();
      bm.links.primary.health.rtt = 400;
      expect(bm._shouldFailover()).toBe(false);
    });

    test("triggers failover when loss exceeds threshold", async () => {
      await bm.initialize();
      bm.links.primary.health.loss = 0.15;
      expect(bm._shouldFailover()).toBe(true);
    });

    test("does not trigger failover when loss is within threshold", async () => {
      await bm.initialize();
      bm.links.primary.health.loss = 0.05;
      expect(bm._shouldFailover()).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  // shouldFailback logic (unit tests - stop monitoring, call directly)
  // ═══════════════════════════════════════════════

  describe("Failback Decision Logic (_shouldFailback)", () => {
    test("does not failback when on primary", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      expect(bm._shouldFailback()).toBe(false);
    });

    test("does not failback within delay period", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      bm.links.primary.health.rtt = 100;
      bm.links.primary.health.loss = 0.01;
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(10000); // only 10s, delay is 30s
      expect(bm._shouldFailback()).toBe(false);
    });

    test("fails back after delay when primary is healthy", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      bm.links.primary.health.rtt = 100;
      bm.links.primary.health.loss = 0.01;
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000); // past 30s delay
      expect(bm._shouldFailback()).toBe(true);
    });

    test("does not failback if primary is still down", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      bm.links.primary.health.status = LinkStatus.DOWN;

      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(false);
    });

    test("requires RTT below hysteresis threshold", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      // RTT just below failover threshold but above hysteresis
      bm.links.primary.health.rtt = 450; // > 500 * 0.8 = 400
      bm.links.primary.health.loss = 0.01;
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(false);
    });

    test("requires loss below hysteresis threshold", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      bm.links.primary.health.rtt = 100;
      bm.links.primary.health.loss = 0.06; // > 0.10 * 0.5 = 0.05
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(false);
    });

    test("fails back when both RTT and loss are within hysteresis", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      bm.failover();
      bm.links.primary.health.rtt = 350; // < 500 * 0.8 = 400
      bm.links.primary.health.loss = 0.04; // < 0.10 * 0.5 = 0.05
      bm.links.primary.health.status = LinkStatus.STANDBY;

      jest.advanceTimersByTime(31000);
      expect(bm._shouldFailback()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // Quality Calculation
  // ═══════════════════════════════════════════════

  describe("Quality Calculation (_calculateQuality)", () => {
    test("returns 100 for perfect metrics", () => {
      const quality = bm._calculateQuality({ rtt: 0, loss: 0 });
      expect(quality).toBe(100);
    });

    test("returns 0 for worst-case metrics", () => {
      const quality = bm._calculateQuality({ rtt: 1000, loss: 1 });
      expect(quality).toBe(0);
    });

    test("decreases with higher RTT", () => {
      const q1 = bm._calculateQuality({ rtt: 100, loss: 0 });
      const q2 = bm._calculateQuality({ rtt: 500, loss: 0 });
      expect(q2).toBeLessThan(q1);
    });

    test("decreases with higher loss", () => {
      const q1 = bm._calculateQuality({ rtt: 100, loss: 0 });
      const q2 = bm._calculateQuality({ rtt: 100, loss: 0.5 });
      expect(q2).toBeLessThan(q1);
    });

    test("loss impacts quality more than RTT (60% vs 40% weight)", () => {
      // 50% loss, 0 RTT
      const qLoss = bm._calculateQuality({ rtt: 0, loss: 0.5 });
      // 0 loss, 500ms RTT (50% of 1000ms max)
      const qRtt = bm._calculateQuality({ rtt: 500, loss: 0 });
      // Loss of 0.5 should have more impact
      expect(qLoss).toBeLessThan(qRtt);
    });

    test("returns integer value", () => {
      const quality = bm._calculateQuality({ rtt: 123, loss: 0.045 });
      expect(Number.isInteger(quality)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // Heartbeat Response Handling
  // ═══════════════════════════════════════════════

  describe("Heartbeat Response Handling", () => {
    test("updates RTT from heartbeat response", async () => {
      await bm.initialize();
      const link = bm.links.primary;

      // Simulate sending a heartbeat
      link.pendingHeartbeats.set(0, Date.now() - 50); // sent 50ms ago

      // Simulate response
      const response = Buffer.alloc(12);
      response.write("HBPROBE", 0, 7, "ascii");
      response.writeUInt32BE(0, 7);

      bm._handleHeartbeatResponse("primary", response);

      expect(link.health.rtt).toBeGreaterThan(0);
      expect(link.heartbeatResponses).toBe(1);
    });

    test("tracks RTT samples in window", async () => {
      await bm.initialize();
      const link = bm.links.primary;

      for (let i = 0; i < 5; i++) {
        link.pendingHeartbeats.set(i, Date.now() - (50 + i * 10));
        const response = Buffer.alloc(12);
        response.write("HBPROBE", 0, 7, "ascii");
        response.writeUInt32BE(i, 7);
        bm._handleHeartbeatResponse("primary", response);
      }

      expect(link.rttSamples.length).toBe(5);
    });

    test("limits RTT samples to window size", async () => {
      await bm.initialize();
      const link = bm.links.primary;

      for (let i = 0; i < BONDING_HEALTH_WINDOW_SIZE + 5; i++) {
        link.pendingHeartbeats.set(i, Date.now() - 50);
        const response = Buffer.alloc(12);
        response.write("HBPROBE", 0, 7, "ascii");
        response.writeUInt32BE(i, 7);
        bm._handleHeartbeatResponse("primary", response);
      }

      expect(link.rttSamples.length).toBe(BONDING_HEALTH_WINDOW_SIZE);
    });

    test("recovers link from DOWN status on heartbeat response", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      link.health.status = LinkStatus.DOWN;

      link.pendingHeartbeats.set(0, Date.now() - 50);
      const response = Buffer.alloc(12);
      response.write("HBPROBE", 0, 7, "ascii");
      response.writeUInt32BE(0, 7);

      bm._handleHeartbeatResponse("primary", response);

      expect(link.health.status).toBe(LinkStatus.ACTIVE);
    });

    test("ignores non-heartbeat messages", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      const initialResponses = link.heartbeatResponses;

      const randomMsg = Buffer.from("not a heartbeat");
      bm._handleHeartbeatResponse("primary", randomMsg);

      expect(link.heartbeatResponses).toBe(initialResponses);
    });

    test("forwards non-heartbeat messages via onControlPacket", async () => {
      await bm.initialize();
      const controlHandler = jest.fn();
      bm.onControlPacket(controlHandler);

      const controlMsg = Buffer.from("CONTROL_PKT");
      bm._handleHeartbeatResponse("primary", controlMsg);

      expect(controlHandler).toHaveBeenCalledWith("primary", controlMsg);
    });

    test("ignores heartbeat response with unknown sequence", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      const initialResponses = link.heartbeatResponses;

      const response = Buffer.alloc(12);
      response.write("HBPROBE", 0, 7, "ascii");
      response.writeUInt32BE(999, 7); // unknown seq

      bm._handleHeartbeatResponse("primary", response);

      expect(link.heartbeatResponses).toBe(initialResponses);
    });
  });

  // ═══════════════════════════════════════════════
  // Health Metrics Update
  // ═══════════════════════════════════════════════

  describe("Health Metrics (_updateLinkMetrics)", () => {
    test("calculates loss ratio from heartbeat stats", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      link.heartbeatsSent = 100;
      link.heartbeatResponses = 90;

      bm._updateLinkMetrics("primary", link);

      expect(link.health.loss).toBeCloseTo(0.1, 2);
    });

    test("loss is 0 when all heartbeats received", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      link.heartbeatsSent = 50;
      link.heartbeatResponses = 50;

      bm._updateLinkMetrics("primary", link);

      expect(link.health.loss).toBe(0);
    });

    test("loss is clamped to [0, 1]", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      link.heartbeatsSent = 10;
      link.heartbeatResponses = 15; // more responses than sent (defensive)

      bm._updateLinkMetrics("primary", link);

      expect(link.health.loss).toBeGreaterThanOrEqual(0);
      expect(link.health.loss).toBeLessThanOrEqual(1);
    });

    test("updates quality score", async () => {
      await bm.initialize();
      const link = bm.links.primary;
      link.heartbeatsSent = 100;
      link.heartbeatResponses = 80;
      link.health.rtt = 200;

      bm._updateLinkMetrics("primary", link);

      expect(link.health.quality).toBeGreaterThan(0);
      expect(link.health.quality).toBeLessThanOrEqual(100);
    });
  });

  // ═══════════════════════════════════════════════
  // Health Monitoring
  // ═══════════════════════════════════════════════

  describe("Health Monitoring", () => {
    test("starts interval timer", async () => {
      await bm.initialize();
      expect(bm.healthCheckTimer).toBeTruthy();
    });

    test("stopHealthMonitoring clears the timer", async () => {
      await bm.initialize();
      bm.stopHealthMonitoring();
      expect(bm.healthCheckTimer).toBeNull();
    });

    test("startHealthMonitoring is idempotent", async () => {
      await bm.initialize();
      const firstTimer = bm.healthCheckTimer;
      bm.startHealthMonitoring();
      expect(bm.healthCheckTimer).toBe(firstTimer);
    });

    test("increments heartbeatsSent on health check tick", async () => {
      await bm.initialize();

      jest.advanceTimersByTime(1000);

      // Each health check sends a heartbeat probe
      expect(bm.links.primary.heartbeatsSent).toBe(1);
      expect(bm.links.backup.heartbeatsSent).toBe(1);
    });

    test("sends heartbeat probes via socket.send", async () => {
      await bm.initialize();

      jest.advanceTimersByTime(1000);

      // Verify heartbeat probes were sent by checking counters
      expect(bm.links.primary.heartbeatsSent).toBeGreaterThanOrEqual(1);
      expect(bm.links.backup.heartbeatsSent).toBeGreaterThanOrEqual(1);
      // Also verify pending heartbeats were tracked
      expect(bm.links.primary.pendingHeartbeats.size).toBeGreaterThan(0);
      expect(bm.links.backup.pendingHeartbeats.size).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // State & Diagnostics
  // ═══════════════════════════════════════════════

  describe("State & Diagnostics", () => {
    test("getState returns complete bonding state", async () => {
      await bm.initialize();
      const state = bm.getState();

      expect(state.enabled).toBe(true);
      expect(state.mode).toBe("main-backup");
      expect(state.activeLink).toBe("primary");
      expect(state.lastFailoverTime).toBe(0);
      expect(state.failoverThresholds).toBeDefined();
      expect(state.links).toBeDefined();
      expect(state.links.primary).toBeDefined();
      expect(state.links.backup).toBeDefined();
    });

    test("getLinkHealth returns per-link health data", async () => {
      await bm.initialize();
      const health = bm.getLinkHealth();

      expect(health.primary.address).toBe("10.0.0.1");
      expect(health.primary.port).toBe(4446);
      expect(health.primary.status).toBe(LinkStatus.ACTIVE);
      expect(health.primary.rtt).toBeDefined();
      expect(health.primary.loss).toBeDefined();
      expect(health.primary.quality).toBeDefined();
      expect(health.primary.heartbeatsSent).toBeDefined();
      expect(health.primary.heartbeatResponses).toBeDefined();

      expect(health.backup.status).toBe(LinkStatus.STANDBY);
    });

    test("getState reflects failover", async () => {
      await bm.initialize();
      bm.failover();
      const state = bm.getState();

      expect(state.activeLink).toBe("backup");
      expect(state.lastFailoverTime).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // Metrics Publisher Integration
  // ═══════════════════════════════════════════════

  describe("Metrics Publisher Integration", () => {
    test("setMetricsPublisher stores the publisher", () => {
      const mockPublisher = { publishLinkMetrics: jest.fn() };
      bm.setMetricsPublisher(mockPublisher);
      expect(bm.metricsPublisher).toBe(mockPublisher);
    });

    test("publishes per-link metrics during health check", async () => {
      const mockPublisher = { publishLinkMetrics: jest.fn() };
      bm.setMetricsPublisher(mockPublisher);
      await bm.initialize();

      jest.advanceTimersByTime(1000);

      expect(mockPublisher.publishLinkMetrics).toHaveBeenCalledWith(
        "primary",
        expect.objectContaining({
          status: expect.any(String),
          rtt: expect.any(Number)
        })
      );
      expect(mockPublisher.publishLinkMetrics).toHaveBeenCalledWith(
        "backup",
        expect.objectContaining({
          status: expect.any(String),
          rtt: expect.any(Number)
        })
      );
    });
  });

  // ═══════════════════════════════════════════════
  // Cleanup / Stop
  // ═══════════════════════════════════════════════

  describe("Cleanup", () => {
    test("stop clears health check timer", async () => {
      await bm.initialize();
      bm.stop();
      expect(bm.healthCheckTimer).toBeNull();
    });

    test("stop closes sockets", async () => {
      await bm.initialize();
      // Sockets exist before stop
      expect(bm.links.primary.socket).not.toBeNull();
      expect(bm.links.backup.socket).not.toBeNull();

      // stop() should call close and then nullify
      bm.stop();
      expect(bm.links.primary.socket).toBeNull();
      expect(bm.links.backup.socket).toBeNull();
    });

    test("stop nullifies socket references", async () => {
      await bm.initialize();
      bm.stop();

      expect(bm.links.primary.socket).toBeNull();
      expect(bm.links.backup.socket).toBeNull();
    });

    test("stop clears pending heartbeats", async () => {
      await bm.initialize();
      bm.links.primary.pendingHeartbeats.set(0, Date.now());
      bm.links.backup.pendingHeartbeats.set(0, Date.now());
      bm.stop();

      expect(bm.links.primary.pendingHeartbeats.size).toBe(0);
      expect(bm.links.backup.pendingHeartbeats.size).toBe(0);
    });

    test("stop clears RTT samples", async () => {
      await bm.initialize();
      bm.links.primary.rttSamples = [1, 2, 3];
      bm.stop();

      expect(bm.links.primary.rttSamples.length).toBe(0);
    });

    test("stop marks as uninitialized", async () => {
      await bm.initialize();
      bm.stop();

      expect(bm._initialized).toBe(false);
    });

    test("stop is safe to call multiple times", async () => {
      await bm.initialize();
      bm.stop();
      expect(() => bm.stop()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════
  // Interface Binding
  // ═══════════════════════════════════════════════

  describe("Interface Binding", () => {
    test("stores interface config in link definition", () => {
      config.primary.interface = "192.168.1.100";
      bm = new BondingManager(config, app);

      expect(bm.links.primary.interface).toBe("192.168.1.100");
      expect(bm.links.backup.interface).toBeNull();
    });

    test("interface defaults to null when not configured", () => {
      expect(bm.links.primary.interface).toBeNull();
      expect(bm.links.backup.interface).toBeNull();
    });

    test("initializes without interface binding when null", async () => {
      await bm.initialize();

      // Should initialize successfully without binding
      expect(bm._initialized).toBe(true);
      expect(bm.links.primary.socket).not.toBeNull();
      expect(bm.links.backup.socket).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════
  // Socket Error Handling
  // ═══════════════════════════════════════════════

  describe("Socket Error Handling", () => {
    test("marks link as DOWN on socket error", async () => {
      await bm.initialize();
      const socket = bm.links.primary.socket;

      // Trigger error handler via the mock's emit
      socket.emit("error", new Error("Network unreachable"));

      expect(bm.links.primary.health.status).toBe(LinkStatus.DOWN);
    });

    test("logs socket error", async () => {
      await bm.initialize();
      const socket = bm.links.primary.socket;

      socket.emit("error", new Error("Network unreachable"));

      expect(app.debug).toHaveBeenCalledWith(
        expect.stringContaining("primary socket error")
      );
    });
  });

  // ═══════════════════════════════════════════════
  // Event Callbacks
  // ═══════════════════════════════════════════════

  describe("Event Callbacks", () => {
    test("onControlPacket callback is called for non-heartbeat messages", async () => {
      await bm.initialize();
      const handler = jest.fn();
      bm.onControlPacket(handler);

      const msg = Buffer.from("SK_DATA_PKT");
      bm._handleHeartbeatResponse("primary", msg);

      expect(handler).toHaveBeenCalledWith("primary", msg);
    });

    test("onFailover callback receives correct link names", async () => {
      await bm.initialize();
      const handler = jest.fn();
      bm.onFailover(handler);

      bm.failover();

      expect(handler).toHaveBeenCalledWith("primary", "backup");
    });

    test("onFailback callback receives correct link names", async () => {
      await bm.initialize();
      const handler = jest.fn();
      bm.onFailback(handler);

      bm.failover();
      bm.failback();

      expect(handler).toHaveBeenCalledWith("backup", "primary");
    });
  });
});
