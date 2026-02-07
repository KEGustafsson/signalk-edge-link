/* eslint-disable no-undef */
/**
 * Integration test: Input → Backend → Frontend pipe
 *
 * Tests the full data flow through the modular architecture:
 *   1. Client packCrypt (serialize → compress → encrypt → UDP send)
 *   2. Server unpackDecrypt (decrypt → decompress → parse → handleMessage)
 *   3. Metrics tracking across both sides
 *   4. Frontend /metrics API serves correct data for the webapp
 *   5. Path dictionary encode/decode round-trip through the pipeline
 *   6. Source fixing (null source → empty object) through decodeDelta
 */

const createMetrics = require("../lib/metrics");
const createPipeline = require("../lib/pipeline");
const createRoutes = require("../lib/routes");
const {
  SMART_BATCH_INITIAL_ESTIMATE,
  calculateMaxDeltasPerBatch
} = require("../lib/constants");

describe("Integration: Input → Backend → Frontend Pipe", () => {
  let mockApp;
  let state;
  let metricsApi;
  let pipeline;
  let routesApi;
  let capturedPackets;

  // Realistic test deltas
  const navigationDelta = {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "N2K", type: "NMEA2000", pgn: 129029, src: "3" },
      timestamp: "2024-06-15T12:00:00.000Z",
      $source: "n2k-gateway.3",
      values: [
        { path: "navigation.position", value: { latitude: 60.1699, longitude: 24.9384 } },
        { path: "navigation.speedOverGround", value: 5.14 },
        { path: "navigation.courseOverGroundTrue", value: 1.5708 }
      ]
    }]
  };

  const environmentDelta = {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "Weather", type: "signalk" },
      timestamp: "2024-06-15T12:00:01.000Z",
      $source: "weather-station",
      values: [
        { path: "environment.wind.speedApparent", value: 8.5 },
        { path: "environment.wind.angleApparent", value: 0.785 },
        { path: "environment.outside.temperature", value: 293.15 }
      ]
    }]
  };

  beforeEach(() => {
    capturedPackets = [];

    mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn(),
      handleMessage: jest.fn(),
      readPluginOptions: jest.fn(() => ({ configuration: {} })),
      savePluginOptions: jest.fn()
    };

    state = {
      options: {
        secretKey: "12345678901234567890123456789012",
        usePathDictionary: false,
        useMsgpack: false
      },
      socketUdp: {
        send: jest.fn((msg, port, host, cb) => {
          capturedPackets.push(Buffer.from(msg));
          cb(null);
        })
      },
      readyToSend: true,
      isServerMode: false,
      deltas: [],
      timer: false,
      avgBytesPerDelta: SMART_BATCH_INITIAL_ESTIMATE,
      maxDeltasPerBatch: calculateMaxDeltasPerBatch(SMART_BATCH_INITIAL_ESTIMATE),
      lastPacketTime: 0,
      deltaTimerFile: "/tmp/test_dt.json",
      subscriptionFile: "/tmp/test_sub.json",
      sentenceFilterFile: "/tmp/test_sf.json"
    };

    metricsApi = createMetrics();
    pipeline = createPipeline(mockApp, state, metricsApi);
    routesApi = createRoutes(mockApp, state, metricsApi, { schema: {} });
  });

  // ── 1. Client → Server Pipeline ──

  describe("Client → Server Pipeline (JSON)", () => {
    test("single delta: pack on client, unpack on server, deliver to handleMessage", async () => {
      // CLIENT: pack and send
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      expect(capturedPackets).toHaveLength(1);
      const packet = capturedPackets[0];
      expect(packet).toBeInstanceOf(Buffer);
      expect(packet.length).toBeGreaterThan(0);

      // SERVER: receive and unpack
      await pipeline.unpackDecrypt(packet, state.options.secretKey);

      // Verify delta delivered to SignalK
      expect(mockApp.handleMessage).toHaveBeenCalledTimes(1);
      const delivered = mockApp.handleMessage.mock.calls[0][1];

      expect(delivered.context).toBe("vessels.urn:mrn:imo:mmsi:230035780");
      expect(delivered.updates[0].values[0].path).toBe("navigation.position");
      expect(delivered.updates[0].values[0].value).toEqual({ latitude: 60.1699, longitude: 24.9384 });
      expect(delivered.updates[0].values[1].path).toBe("navigation.speedOverGround");
      expect(delivered.updates[0].values[1].value).toBe(5.14);
      expect(delivered.updates[0].timestamp).toBe("2024-06-15T12:00:00.000Z");
      expect(delivered.updates[0].$source).toBe("n2k-gateway.3");
    });

    test("multiple deltas batch: all delivered in order", async () => {
      const batch = [navigationDelta, environmentDelta];

      await pipeline.packCrypt(batch, state.options.secretKey, "10.0.0.1", 4446);
      expect(capturedPackets).toHaveLength(1);

      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      // Both deltas should be delivered
      expect(mockApp.handleMessage).toHaveBeenCalledTimes(2);

      const first = mockApp.handleMessage.mock.calls[0][1];
      const second = mockApp.handleMessage.mock.calls[1][1];

      expect(first.updates[0].values[0].path).toBe("navigation.position");
      expect(second.updates[0].values[0].path).toBe("environment.wind.speedApparent");
    });

    test("source is preserved through the pipeline", async () => {
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const delivered = mockApp.handleMessage.mock.calls[0][1];
      expect(delivered.updates[0].source).toBeDefined();
      expect(delivered.updates[0].source).not.toBeNull();
    });

    test("null source is fixed to empty object by decodeDelta", async () => {
      const deltaWithNullSource = {
        context: "vessels.self",
        updates: [{
          source: null,
          timestamp: "2024-01-01T00:00:00Z",
          values: [{ path: "navigation.position", value: { latitude: 60.0, longitude: 25.0 } }]
        }]
      };

      await pipeline.packCrypt([deltaWithNullSource], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const delivered = mockApp.handleMessage.mock.calls[0][1];
      // decodeDelta applies source ?? {}, so null becomes {}
      expect(delivered.updates[0].source).toEqual({});
    });
  });

  // ── 2. Path Dictionary Integration ──

  describe("Path Dictionary through Pipeline", () => {
    test("paths encoded on client, decoded on server, original paths restored", async () => {
      state.options.usePathDictionary = true;

      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      expect(capturedPackets).toHaveLength(1);

      // Packet should be smaller than without dictionary (numeric IDs vs string paths)
      const withDict = capturedPackets[0].length;

      capturedPackets = [];
      state.options.usePathDictionary = false;
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      const withoutDict = capturedPackets[0].length;

      // Path dictionary should produce smaller packets for known paths
      expect(withDict).toBeLessThanOrEqual(withoutDict);

      // Now verify decode: pack with dictionary, unpack, paths restored
      capturedPackets = [];
      state.options.usePathDictionary = true;
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const delivered = mockApp.handleMessage.mock.calls[0][1];
      expect(delivered.updates[0].values[0].path).toBe("navigation.position");
      expect(delivered.updates[0].values[1].path).toBe("navigation.speedOverGround");
      expect(delivered.updates[0].values[2].path).toBe("navigation.courseOverGroundTrue");
    });

    test("unknown paths pass through unchanged with dictionary enabled", async () => {
      state.options.usePathDictionary = true;

      const deltaWithCustomPath = {
        context: "vessels.self",
        updates: [{
          source: {},
          timestamp: "2024-01-01T00:00:00Z",
          values: [{ path: "custom.sensor.reading", value: 42 }]
        }]
      };

      await pipeline.packCrypt([deltaWithCustomPath], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const delivered = mockApp.handleMessage.mock.calls[0][1];
      expect(delivered.updates[0].values[0].path).toBe("custom.sensor.reading");
      expect(delivered.updates[0].values[0].value).toBe(42);
    });
  });

  // ── 3. MessagePack Integration ──

  describe("MessagePack through Pipeline", () => {
    test("deltas round-trip through msgpack serialization", async () => {
      state.options.useMsgpack = true;

      await pipeline.packCrypt([navigationDelta, environmentDelta], state.options.secretKey, "10.0.0.1", 4446);
      expect(capturedPackets).toHaveLength(1);

      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      expect(mockApp.handleMessage).toHaveBeenCalledTimes(2);
      const nav = mockApp.handleMessage.mock.calls[0][1];
      expect(nav.updates[0].values[0].path).toBe("navigation.position");
      expect(nav.updates[0].values[0].value.latitude).toBe(60.1699);
    });
  });

  // ── 4. Metrics Tracking ──

  describe("Metrics across Pipeline", () => {
    test("client metrics: deltasSent, bandwidth, smart batching updated after packCrypt", async () => {
      const { metrics } = metricsApi;

      expect(metrics.deltasSent).toBe(0);
      expect(metrics.bandwidth.bytesOut).toBe(0);
      expect(metrics.bandwidth.packetsOut).toBe(0);

      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      expect(metrics.deltasSent).toBe(1);
      expect(metrics.bandwidth.bytesOut).toBeGreaterThan(0);
      expect(metrics.bandwidth.bytesOutRaw).toBeGreaterThan(0);
      expect(metrics.bandwidth.packetsOut).toBe(1);
      expect(metrics.bandwidth.bytesOut).toBeLessThan(metrics.bandwidth.bytesOutRaw); // compression effective
    });

    test("server metrics: deltasReceived, bandwidth updated after unpackDecrypt", async () => {
      const { metrics } = metricsApi;

      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      expect(metrics.deltasReceived).toBe(1);
      expect(metrics.bandwidth.bytesIn).toBeGreaterThan(0);
      expect(metrics.bandwidth.bytesInRaw).toBeGreaterThan(0);
      expect(metrics.bandwidth.packetsIn).toBe(1);
    });

    test("smart batching model updates after sends", async () => {
      const { metrics } = metricsApi;

      expect(metrics.smartBatching.avgBytesPerDelta).toBe(SMART_BATCH_INITIAL_ESTIMATE);

      // Send several batches to let the model converge
      for (let i = 0; i < 5; i++) {
        capturedPackets = [];
        await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      }

      expect(metrics.deltasSent).toBe(5);
      // Model should have updated from initial estimate
      expect(metrics.smartBatching.avgBytesPerDelta).not.toBe(SMART_BATCH_INITIAL_ESTIMATE);
      expect(metrics.smartBatching.maxDeltasPerBatch).toBeGreaterThan(0);
    });

    test("path stats track update frequency per path", async () => {
      const { metrics } = metricsApi;

      await pipeline.packCrypt([navigationDelta, environmentDelta], state.options.secretKey, "10.0.0.1", 4446);

      // Path stats should have entries for the paths in the deltas
      expect(metrics.pathStats.size).toBeGreaterThan(0);
      expect(metrics.pathStats.has("navigation.position")).toBe(true);
      expect(metrics.pathStats.has("environment.wind.speedApparent")).toBe(true);

      const navStats = metrics.pathStats.get("navigation.position");
      expect(navStats.count).toBeGreaterThan(0);
      expect(navStats.bytes).toBeGreaterThan(0);
    });

    test("error metrics track decryption failures", async () => {
      const { metrics } = metricsApi;

      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      // Try to decrypt with wrong key
      const wrongKey = "wrong_key_90123456789012345678901";
      await pipeline.unpackDecrypt(capturedPackets[0], wrongKey);

      // Error should be tracked
      expect(metrics.lastError).toBeTruthy();
      expect(metrics.lastErrorTime).toBeGreaterThan(0);
      expect(mockApp.error).toHaveBeenCalled();
    });
  });

  // ── 5. Frontend API (Metrics Route) ──

  describe("Frontend /metrics API", () => {
    let metricsHandler;

    beforeEach(() => {
      // Register routes and capture the /metrics handler
      const mockRouter = {
        get: jest.fn((path, ...handlers) => {
          if (path === "/metrics") {
            metricsHandler = handlers;
          }
        }),
        post: jest.fn()
      };

      routesApi.registerWithRouter(mockRouter);
    });

    /**
     * Helper: run Express middleware chain and return response
     */
    function callRoute(handlers, req) {
      return new Promise((resolve) => {
        const res = {
          json: jest.fn((data) => resolve(data)),
          status: jest.fn().mockReturnThis()
        };

        // Run middlewares, then handler
        let i = 0;
        const next = () => {
          i++;
          if (i < handlers.length) {
            handlers[i](req, res, next);
          }
        };
        handlers[0](req, res, next);
      });
    }

    test("serves metrics response with correct structure for webapp", async () => {
      // Simulate some pipeline activity first
      await pipeline.packCrypt([navigationDelta, environmentDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const metricsData = await callRoute(metricsHandler, req);

      // Verify top-level structure (what the webapp expects)
      expect(metricsData).toHaveProperty("uptime");
      expect(metricsData).toHaveProperty("mode");
      expect(metricsData).toHaveProperty("stats");
      expect(metricsData).toHaveProperty("status");
      expect(metricsData).toHaveProperty("bandwidth");
      expect(metricsData).toHaveProperty("pathStats");
      expect(metricsData).toHaveProperty("pathCategories");
      expect(metricsData).toHaveProperty("lastError");
    });

    test("uptime is properly formatted", async () => {
      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.uptime).toHaveProperty("milliseconds");
      expect(data.uptime).toHaveProperty("seconds");
      expect(data.uptime).toHaveProperty("formatted");
      expect(data.uptime.formatted).toMatch(/\d+h \d+m \d+s/);
    });

    test("stats reflect pipeline activity", async () => {
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], state.options.secretKey);

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.stats.deltasSent).toBe(1);
      expect(data.stats.deltasReceived).toBe(1);
      expect(data.stats.udpSendErrors).toBe(0);
      expect(data.stats.compressionErrors).toBe(0);
      expect(data.stats.encryptionErrors).toBe(0);
    });

    test("bandwidth data includes formatted values for webapp display", async () => {
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.bandwidth.bytesOut).toBeGreaterThan(0);
      expect(data.bandwidth.bytesOutRaw).toBeGreaterThan(0);
      expect(data.bandwidth.bytesOutFormatted).toMatch(/\d+(\.\d+)?\s+[BKMG]/);
      expect(data.bandwidth.rateOutFormatted).toContain("/s");
      expect(data.bandwidth.avgPacketSizeFormatted).toBeDefined();
      expect(data.bandwidth.packetsOut).toBe(1);
      expect(typeof data.bandwidth.compressionRatio).toBe("number");
      expect(data.bandwidth.history).toBeInstanceOf(Array);
    });

    test("pathStats include percentage and per-minute rate for webapp table", async () => {
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.pathStats.length).toBeGreaterThan(0);
      const pathEntry = data.pathStats[0];
      expect(pathEntry).toHaveProperty("path");
      expect(pathEntry).toHaveProperty("count");
      expect(pathEntry).toHaveProperty("bytes");
      expect(pathEntry).toHaveProperty("bytesFormatted");
      expect(pathEntry).toHaveProperty("updatesPerMinute");
      expect(pathEntry).toHaveProperty("percentage");
    });

    test("smartBatching shown in client mode, null in server mode", async () => {
      state.isServerMode = false;
      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      let data = await callRoute(metricsHandler, req);

      expect(data.mode).toBe("client");
      expect(data.smartBatching).not.toBeNull();
      expect(data.smartBatching).toHaveProperty("earlySends");
      expect(data.smartBatching).toHaveProperty("timerSends");
      expect(data.smartBatching).toHaveProperty("avgBytesPerDelta");
      expect(data.smartBatching).toHaveProperty("maxDeltasPerBatch");

      state.isServerMode = true;
      data = await callRoute(metricsHandler, req);

      expect(data.mode).toBe("server");
      expect(data.smartBatching).toBeNull();
    });

    test("status shows readyToSend and deltasBuffered", async () => {
      state.readyToSend = true;
      state.deltas = [{ fake: 1 }, { fake: 2 }];

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.status.readyToSend).toBe(true);
      expect(data.status.deltasBuffered).toBe(2);
    });

    test("lastError is null when no errors", async () => {
      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.lastError).toBeNull();
    });

    test("lastError populated after decryption failure", async () => {
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      await pipeline.unpackDecrypt(capturedPackets[0], "wrong_key_90123456789012345678901");

      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await callRoute(metricsHandler, req);

      expect(data.lastError).not.toBeNull();
      expect(data.lastError.message).toBeTruthy();
      expect(data.lastError.timestamp).toBeGreaterThan(0);
      expect(typeof data.lastError.timeAgo).toBe("number");
    });
  });

  // ── 6. Full Plugin Integration ──

  describe("Full Plugin: start → pipeline → metrics → route", () => {
    const createPlugin = require("../index");
    const path = require("path");
    const os = require("os");
    const { promises: fs } = require("fs");
    let fullPlugin;
    let fullMockApp;
    let tempDir;

    beforeEach(async () => {
      tempDir = path.join(os.tmpdir(), `signalk-integ-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });

      fullMockApp = {
        debug: jest.fn(),
        error: jest.fn(),
        setPluginStatus: jest.fn(),
        setProviderStatus: jest.fn(),
        getSelfPath: jest.fn(() => "230035780"),
        handleMessage: jest.fn(),
        getDataDirPath: jest.fn(() => tempDir),
        subscriptionmanager: {
          subscribe: jest.fn()
        },
        reportOutputMessages: jest.fn(),
        readPluginOptions: jest.fn(() => ({ configuration: {} })),
        savePluginOptions: jest.fn()
      };

      fullPlugin = createPlugin(fullMockApp);
    });

    afterEach(async () => {
      if (fullPlugin && fullPlugin.stop) {
        fullPlugin.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });

    test("plugin starts, routes register, metrics endpoint responds", async () => {
      // Register routes before start (like SignalK does)
      let metricsHandler;
      const mockRouter = {
        get: jest.fn((routePath, ...handlers) => {
          if (routePath === "/metrics") {
            metricsHandler = handlers;
          }
        }),
        post: jest.fn()
      };
      fullPlugin.registerWithRouter(mockRouter);

      // Start in server mode
      await fullPlugin.start({
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      });

      // Call the metrics endpoint
      const req = { ip: "127.0.0.1", connection: { remoteAddress: "127.0.0.1" } };
      const data = await new Promise((resolve) => {
        const res = {
          json: jest.fn((d) => resolve(d)),
          status: jest.fn().mockReturnThis()
        };
        let i = 0;
        const next = () => { i++; if (i < metricsHandler.length) metricsHandler[i](req, res, next); };
        metricsHandler[0](req, res, next);
      });

      expect(data.mode).toBe("server");
      expect(data.uptime.seconds).toBeGreaterThanOrEqual(0);
      expect(data.stats.deltasReceived).toBe(0);
      expect(data.bandwidth).toBeDefined();
    });

    test("client mode initializes config files and registers watchers", async () => {
      await fullPlugin.start({
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "client",
        udpAddress: "127.0.0.1",
        testAddress: "127.0.0.1",
        testPort: 80,
        pingIntervalTime: 1,
        helloMessageSender: 60
      });

      // Config files should be created
      const dtExists = await fs.access(path.join(tempDir, "delta_timer.json")).then(() => true).catch(() => false);
      const subExists = await fs.access(path.join(tempDir, "subscription.json")).then(() => true).catch(() => false);
      const sfExists = await fs.access(path.join(tempDir, "sentence_filter.json")).then(() => true).catch(() => false);

      expect(dtExists).toBe(true);
      expect(subExists).toBe(true);
      expect(sfExists).toBe(true);

      // Verify default values
      const dtContent = JSON.parse(await fs.readFile(path.join(tempDir, "delta_timer.json"), "utf-8"));
      expect(dtContent.deltaTimer).toBe(1000);

      const sfContent = JSON.parse(await fs.readFile(path.join(tempDir, "sentence_filter.json"), "utf-8"));
      expect(sfContent.excludedSentences).toEqual(["GSV"]);
    });
  });

  // ── 7. Pipeline Guard Rails ──

  describe("Pipeline Safety", () => {
    test("packCrypt ignores calls after plugin stop (options = null)", async () => {
      state.options = null;

      await pipeline.packCrypt([navigationDelta], "key12345678901234567890123456", "10.0.0.1", 4446);

      expect(capturedPackets).toHaveLength(0);
      expect(mockApp.debug).toHaveBeenCalledWith(expect.stringContaining("plugin is stopped"));
    });

    test("unpackDecrypt ignores calls after plugin stop (options = null)", async () => {
      // First create a valid packet
      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);
      const packet = capturedPackets[0];

      // Stop the plugin
      state.options = null;

      await pipeline.unpackDecrypt(packet, "12345678901234567890123456789012");

      expect(mockApp.handleMessage).not.toHaveBeenCalled();
      expect(mockApp.debug).toHaveBeenCalledWith(expect.stringContaining("plugin is stopped"));
    });

    test("lastPacketTime is updated after successful send", async () => {
      expect(state.lastPacketTime).toBe(0);

      await pipeline.packCrypt([navigationDelta], state.options.secretKey, "10.0.0.1", 4446);

      expect(state.lastPacketTime).toBeGreaterThan(0);
    });
  });

  // ── 8. Compression Effectiveness ──

  describe("Compression through Pipeline", () => {
    test("compressed packet is smaller than raw JSON", async () => {
      const { metrics } = metricsApi;

      await pipeline.packCrypt([navigationDelta, environmentDelta], state.options.secretKey, "10.0.0.1", 4446);

      // Compressed+encrypted bytes should be less than raw bytes
      expect(metrics.bandwidth.bytesOut).toBeLessThan(metrics.bandwidth.bytesOutRaw);

      // Compression ratio should be positive
      const ratio = 1 - metrics.bandwidth.bytesOut / metrics.bandwidth.bytesOutRaw;
      expect(ratio).toBeGreaterThan(0);
    });

    test("large batch demonstrates significant compression savings", async () => {
      const largeBatch = Array(20).fill(null).map((_, i) => ({
        context: "vessels.urn:mrn:imo:mmsi:230035780",
        updates: [{
          source: { label: "N2K" },
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          values: [
            { path: "navigation.position", value: { latitude: 60.1 + i * 0.001, longitude: 24.9 + i * 0.001 } },
            { path: "navigation.speedOverGround", value: 5.0 + i * 0.1 }
          ]
        }]
      }));

      const { metrics } = metricsApi;
      await pipeline.packCrypt(largeBatch, state.options.secretKey, "10.0.0.1", 4446);

      const savingsPercent = Math.round((1 - metrics.bandwidth.bytesOut / metrics.bandwidth.bytesOutRaw) * 100);
      expect(savingsPercent).toBeGreaterThan(30); // Expect >30% savings on repetitive data
    });
  });
});
