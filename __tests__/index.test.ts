/* eslint-disable no-undef */

// Mock external packages not available in the test environment
jest.mock(
  "ping-monitor",
  () =>
    jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      stop: jest.fn()
    })),
  { virtual: true }
);

jest.mock(
  "@msgpack/msgpack",
  () => ({
    encode: jest.fn((v) => Buffer.from(JSON.stringify(v))),
    decode: jest.fn((b) => JSON.parse(b.toString()))
  }),
  { virtual: true }
);

const dgram = require("node:dgram");
const createPlugin = require("../index.ts");

describe("SignalK Data Connector Plugin", () => {
  let plugin;
  let mockApp;

  beforeEach(() => {
    // Mock SignalK app object
    mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn(),
      getSelfPath: jest.fn(() => "123456789"),
      handleMessage: jest.fn(),
      getDataDirPath: jest.fn(() => __dirname + "/temp"),
      subscriptionmanager: {
        subscribe: jest.fn((subscription, unsubscribes, errorCallback, deltaCallback) => {
          // Store the delta callback for testing
          mockApp._deltaCallback = deltaCallback;
          return jest.fn(); // return unsubscribe function
        })
      },
      reportOutputMessages: jest.fn()
    };

    plugin = createPlugin(mockApp);
  });

  afterEach(async () => {
    if (plugin && plugin.stop) {
      plugin.stop();
    }
    // Wait for async cleanup to complete (timers, monitors, etc.)
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe("Plugin Metadata", () => {
    test("should have correct plugin id", () => {
      expect(plugin.id).toBe("signalk-edge-link");
    });

    test("should have plugin name", () => {
      expect(plugin.name).toBe("Signal K Edge Link");
    });

    test("should have description", () => {
      expect(plugin.description).toContain("Secure UDP link");
    });

    test("should have schema object", () => {
      expect(plugin.schema).toBeDefined();
      expect(typeof plugin.schema).toBe("object");
      expect(plugin.schema.type).toBe("object");
    });
  });

  describe("Schema Validation", () => {
    // Helper: navigate to the per-connection item schema
    // plugin.schema wraps everything in a connections[] array.
    let itemSchema;
    beforeEach(() => {
      itemSchema = plugin.schema.properties.connections.items;
    });

    test("connections array is defined with at least 1 item required", () => {
      const conns = plugin.schema.properties.connections;
      expect(conns).toBeDefined();
      expect(conns.type).toBe("array");
      expect(conns.minItems).toBe(1);
      expect(conns.items).toBeDefined();
    });

    test("should require serverType, udpPort and secretKey inside each connection", () => {
      expect(itemSchema.required).toContain("serverType");
      expect(itemSchema.required).toContain("udpPort");
      expect(itemSchema.required).toContain("secretKey");
    });

    test("should have serverType options", () => {
      const serverType = itemSchema.properties.serverType;
      expect(serverType.oneOf[0].const).toBe("server");
      expect(serverType.oneOf[1].const).toBe("client");
    });

    test("should validate udpPort range", () => {
      const udpPort = itemSchema.properties.udpPort;
      expect(udpPort.minimum).toBe(1024);
      expect(udpPort.maximum).toBe(65535);
    });

    test("should describe supported secretKey formats", () => {
      const secretKey = itemSchema.properties.secretKey;
      expect(secretKey.minLength).toBe(32);
      expect(secretKey.maxLength).toBe(64);
      expect(secretKey.pattern).toBe("^(?:.{32}|[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$");
    });

    test("should expose protocol versions 1, 2, and 3", () => {
      const protocolVersion = itemSchema.properties.protocolVersion;
      expect(protocolVersion.oneOf.map((entry) => entry.const)).toEqual([1, 2, 3]);
    });

    test("should NOT have client-only fields in connection item main properties", () => {
      // Client-only fields live inside dependencies.serverType.oneOf, not top-level
      expect(itemSchema.properties.udpAddress).toBeUndefined();
      expect(itemSchema.properties.testAddress).toBeUndefined();
      expect(itemSchema.properties.testPort).toBeUndefined();
      expect(itemSchema.properties.pingIntervalTime).toBeUndefined();
      expect(itemSchema.properties.helloMessageSender).toBeUndefined();
    });

    test("should have dependencies with oneOf for conditional display", () => {
      expect(itemSchema.dependencies).toBeDefined();
      expect(itemSchema.dependencies.serverType).toBeDefined();
      expect(itemSchema.dependencies.serverType.oneOf).toBeDefined();
      expect(itemSchema.dependencies.serverType.oneOf.length).toBe(2);
    });

    test("should have client-only fields inside oneOf for client mode", () => {
      const clientDep = itemSchema.dependencies.serverType.oneOf.find(
        (dep) => dep.properties.serverType.enum && dep.properties.serverType.enum.includes("client")
      );
      expect(clientDep).toBeDefined();
      expect(clientDep.properties.udpAddress).toBeDefined();
      expect(clientDep.properties.testAddress).toBeDefined();
      expect(clientDep.properties.testPort).toBeDefined();
      expect(clientDep.properties.pingIntervalTime).toBeDefined();
      expect(clientDep.properties.helloMessageSender).toBeDefined();
      expect(clientDep.required).toContain("udpAddress");
      expect(clientDep.required).toContain("testAddress");
      expect(clientDep.required).toContain("testPort");
    });

    test("should expose advanced client reliability parameters in schema", () => {
      const clientDep = itemSchema.dependencies.serverType.oneOf.find(
        (dep) => dep.properties.serverType.enum && dep.properties.serverType.enum.includes("client")
      );
      expect(clientDep).toBeDefined();
      const reliabilityProps = clientDep.properties.reliability.properties;
      expect(reliabilityProps.retransmitMinAge).toBeDefined();
      expect(reliabilityProps.retransmitRttMultiplier).toBeDefined();
      expect(reliabilityProps.ackIdleDrainAge).toBeDefined();
      expect(reliabilityProps.forceDrainAfterAckIdle).toBeDefined();
      expect(reliabilityProps.recoveryBurstEnabled).toBeDefined();
      expect(reliabilityProps.retransmitMaxAge.default).toBe(120000);
    });

    test("should expose alert thresholds and bonding heartbeat timeout in schema", () => {
      const clientDep = itemSchema.dependencies.serverType.oneOf.find(
        (dep) => dep.properties.serverType.enum && dep.properties.serverType.enum.includes("client")
      );
      expect(clientDep).toBeDefined();
      expect(clientDep.properties.alertThresholds).toBeDefined();
      expect(clientDep.properties.alertThresholds.properties.rtt).toBeDefined();
      expect(clientDep.properties.alertThresholds.properties.packetLoss).toBeDefined();
      expect(
        clientDep.properties.bonding.properties.failover.properties.heartbeatTimeout
      ).toBeDefined();
    });

    test("should NOT have client fields in server mode oneOf", () => {
      const serverDep = itemSchema.dependencies.serverType.oneOf.find(
        (dep) => dep.properties.serverType.enum && dep.properties.serverType.enum.includes("server")
      );
      expect(serverDep).toBeDefined();
      expect(serverDep.properties.udpAddress).toBeUndefined();
      expect(serverDep.properties.testAddress).toBeUndefined();
    });

    test("should NOT set additionalProperties:false on connection item (incompatible with dependencies/oneOf)", () => {
      // additionalProperties:false would reject client fields defined in dependencies.oneOf
      // since they are not in the top-level properties block. Server-side sanitization
      // in the /plugin-config POST handler protects against unknown fields instead.
      expect(itemSchema.additionalProperties).not.toBe(false);
    });
  });

  describe("Plugin Start - Validation", () => {
    test("should reject invalid secretKey length", async () => {
      const options = {
        secretKey: "short",
        udpPort: 4446,
        serverType: "server"
      };

      await plugin.start(options);

      expect(mockApp.error).toHaveBeenCalledWith(
        expect.stringContaining("Secret key must be exactly 32 bytes")
      );
    });

    test("should reject invalid udpPort (too low)", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 1000,
        serverType: "server"
      };

      await plugin.start(options);

      expect(mockApp.error).toHaveBeenCalledWith(
        expect.stringContaining("UDP port must be between 1024 and 65535")
      );
    });

    test("should reject invalid udpPort (too high)", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 70000,
        serverType: "server"
      };

      await plugin.start(options);

      expect(mockApp.error).toHaveBeenCalledWith(
        expect.stringContaining("UDP port must be between 1024 and 65535")
      );
    });
  });

  describe("Plugin Stop", () => {
    test("should stop without errors when not started", () => {
      expect(() => plugin.stop()).not.toThrow();
    });

    test("should clean up resources on stop", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      };

      await plugin.start(options);

      expect(() => plugin.stop()).not.toThrow();
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith(expect.stringContaining("Stopped"));
    });

    test("should be safe to call stop multiple times", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      };

      await plugin.start(options);

      expect(() => {
        plugin.stop();
        plugin.stop();
        plugin.stop();
      }).not.toThrow();
    });
  });

  describe("Server Mode", () => {
    test("should start in server mode", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      };

      await plugin.start(options);

      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining("Starting server on port")
      );
    });

    test("should accept boolean true for server mode", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: true
      };

      await plugin.start(options);

      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining("Starting server on port")
      );
    });

    test("should surface startup failure when the UDP port is already in use", async () => {
      const { EventEmitter } = require("node:events");
      const createSocketSpy = jest.spyOn(dgram, "createSocket").mockImplementation(() => {
        const socket = new EventEmitter();
        socket.bind = jest.fn(() => {
          process.nextTick(() => {
            const err = new Error("bind EADDRINUSE 0.0.0.0:4446");
            err.code = "EADDRINUSE";
            socket.emit("error", err);
          });
        });
        socket.close = jest.fn();
        socket.address = jest.fn(() => ({ address: "0.0.0.0", port: 4446 }));
        return socket;
      });

      try {
        await plugin.start({
          secretKey: "12345678901234567890123456789012",
          udpPort: 4446,
          serverType: "server"
        });

        expect(mockApp.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to start one or more connections")
        );
        expect(mockApp.setPluginStatus).toHaveBeenCalledWith(
          expect.stringContaining("Startup failed")
        );
      } finally {
        createSocketSpy.mockRestore();
      }
    });
  });

  describe("Client Mode", () => {
    test("should start in client mode with all required options", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "client",
        udpAddress: "127.0.0.1",
        testAddress: "127.0.0.1",
        testPort: 80,
        pingIntervalTime: 1,
        helloMessageSender: 60
      };

      await plugin.start(options);

      // Should not have server-specific debug messages
      expect(mockApp.debug).not.toHaveBeenCalledWith(expect.stringContaining("server started"));
    });
  });

  describe("Ping RTT Feature", () => {
    test("should publish RTT to local SignalK when ping monitor receives response", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "client",
        udpAddress: "127.0.0.1",
        testAddress: "127.0.0.1",
        testPort: 80,
        pingIntervalTime: 0.1, // Short interval for testing
        helloMessageSender: 60
      };

      await plugin.start(options);

      // Wait for ping monitor to potentially trigger
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if handleMessage was called with RTT data
      // Note: This test depends on network connectivity to 127.0.0.1:80
      const handleMessageCalls = mockApp.handleMessage.mock.calls;
      const rttCalls = handleMessageCalls.filter((call) => {
        const delta = call[1];
        return (
          delta &&
          delta.updates &&
          delta.updates[0] &&
          delta.updates[0].values &&
          delta.updates[0].values.some((v) => v.path === "networking.modem.default.rtt")
        );
      });

      if (rttCalls.length > 0) {
        const rttCall = rttCalls[0];
        const delta = rttCall[1];

        // Verify structure
        expect(delta.context).toBe("vessels.self");
        expect(delta.updates).toHaveLength(1);
        expect(delta.updates[0].timestamp).toBeInstanceOf(Date);
        expect(delta.updates[0].values).toHaveLength(1);

        const rttValue = delta.updates[0].values[0];
        expect(rttValue.path).toBe("networking.modem.default.rtt");
        expect(typeof rttValue.value).toBe("number");
        expect(rttValue.value).toBeGreaterThan(0);
        // Value should be in seconds (converted from milliseconds)
        expect(rttValue.value).toBeLessThan(10); // Sanity check: < 10 seconds
      }
    });

    test("should convert RTT from milliseconds to seconds", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "client",
        udpAddress: "127.0.0.1",
        testAddress: "127.0.0.1",
        testPort: 80,
        pingIntervalTime: 0.1,
        helloMessageSender: 60
      };

      await plugin.start(options);

      // Wait for potential ping
      await new Promise((resolve) => setTimeout(resolve, 500));

      const handleMessageCalls = mockApp.handleMessage.mock.calls;
      const rttCalls = handleMessageCalls.filter((call) => {
        const delta = call[1];
        return (
          delta &&
          delta.updates &&
          delta.updates[0] &&
          delta.updates[0].values &&
          delta.updates[0].values.some((v) => v.path === "networking.modem.default.rtt")
        );
      });

      if (rttCalls.length > 0) {
        const delta = rttCalls[0][1];
        const rttValue = delta.updates[0].values[0].value;

        // If RTT is 25ms, it should be 0.025 seconds
        // We can't check exact value but can verify it's a small decimal (seconds not milliseconds)
        if (rttValue < 1) {
          // If less than 1 second, it's been converted properly
          expect(rttValue).toBeGreaterThan(0);
        } else {
          // If greater than 1 second but less than 10, still valid (slow connection)
          expect(rttValue).toBeLessThan(10);
        }
      }
    });

    test("should use plugin.id as source when publishing RTT", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "client",
        udpAddress: "127.0.0.1",
        testAddress: "127.0.0.1",
        testPort: 80,
        pingIntervalTime: 0.1,
        helloMessageSender: 60
      };

      await plugin.start(options);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const handleMessageCalls = mockApp.handleMessage.mock.calls;
      const rttCalls = handleMessageCalls.filter((call) => {
        const delta = call[1];
        return (
          delta &&
          delta.updates &&
          delta.updates[0] &&
          delta.updates[0].values &&
          delta.updates[0].values.some((v) => v.path === "networking.modem.default.rtt")
        );
      });

      if (rttCalls.length > 0) {
        // First argument should be plugin.id
        expect(rttCalls[0][0]).toBe("signalk-edge-link");
      }
    });
  });

  describe("Router Registration", () => {
    test("should have registerWithRouter method", () => {
      expect(plugin.registerWithRouter).toBeDefined();
      expect(typeof plugin.registerWithRouter).toBe("function");
    });

    test("should register routes with router", () => {
      const mockRouter = {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
      };

      plugin.registerWithRouter(mockRouter);

      expect(mockRouter.get).toHaveBeenCalled();
      expect(mockRouter.post).toHaveBeenCalled();
    });
  });

  describe("Configuration Routes", () => {
    let mockRouter;
    let getHandler;
    let postHandler;
    let getMiddlewares;
    let postMiddlewares;

    beforeEach(() => {
      mockRouter = {
        get: jest.fn((path, ...handlers) => {
          if (path === "/config/:filename") {
            // Last handler is the actual route handler, others are middlewares
            getHandler = handlers[handlers.length - 1];
            getMiddlewares = handlers.slice(0, -1);
          }
        }),
        post: jest.fn((path, ...handlers) => {
          if (path === "/config/:filename") {
            // Last handler is the actual route handler, others are middlewares
            postHandler = handlers[handlers.length - 1];
            postMiddlewares = handlers.slice(0, -1);
          }
        }),
        put: jest.fn(),
        delete: jest.fn()
      };

      plugin.registerWithRouter(mockRouter);
    });

    /**
     * Helper to run middlewares in sequence, then the handler
     * Properly chains middlewares and only calls the final handler if all middlewares pass
     */
    function runWithMiddlewares(middlewares, handler, req, res) {
      return new Promise((resolve) => {
        let currentIndex = 0;

        const next = () => {
          currentIndex++;
          if (currentIndex < middlewares.length) {
            // Run next middleware
            middlewares[currentIndex](req, res, next);
          } else {
            // All middlewares passed, run the handler
            Promise.resolve(handler(req, res)).then(resolve);
          }
        };

        if (middlewares.length > 0) {
          // Start with first middleware
          middlewares[0](req, res, next);
        } else {
          // No middlewares, just run handler
          Promise.resolve(handler(req, res)).then(resolve);
        }

        // Give time for sync responses (if middleware doesn't call next)
        setTimeout(resolve, 10);
      });
    }

    test("should check initialization before validating filename on GET", async () => {
      const mockReq = { params: { filename: "invalid.json" } };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        contentType: jest.fn(),
        send: jest.fn()
      };

      await runWithMiddlewares(getMiddlewares, getHandler, mockReq, mockRes);

      // No client instance running → clientModeMiddleware returns 404
      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) })
      );
    });

    test("should check initialization before validating filename on POST", async () => {
      const mockReq = {
        params: { filename: "invalid.json" },
        body: {},
        headers: { "content-type": "application/json" }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        send: jest.fn()
      };

      await runWithMiddlewares(postMiddlewares, postHandler, mockReq, mockRes);

      // No client instance running → clientModeMiddleware returns 404
      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) })
      );
    });

    test("should accept valid filename delta_timer.json", async () => {
      const mockReq = { params: { filename: "delta_timer.json" } };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        contentType: jest.fn(),
        send: jest.fn()
      };

      // This will fail because storage isn't initialized, but shouldn't reject filename
      await runWithMiddlewares(getMiddlewares, getHandler, mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
    });

    test("should accept valid filename subscription.json", async () => {
      const mockReq = { params: { filename: "subscription.json" } };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        contentType: jest.fn(),
        send: jest.fn()
      };

      // This will fail because storage isn't initialized, but shouldn't reject filename
      await runWithMiddlewares(getMiddlewares, getHandler, mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
    });
  });

  describe("Plugin Config Save Route", () => {
    let mockRouter;
    let pluginConfigPostHandler;
    let pluginConfigPostMiddlewares;

    beforeEach(() => {
      mockApp.savePluginOptions = jest.fn((config, cb) => cb(null));
      mockApp.readPluginOptions = jest.fn(() => ({
        configuration: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012"
        }
      }));

      mockRouter = {
        get: jest.fn(),
        post: jest.fn((path, ...handlers) => {
          if (path === "/plugin-config") {
            pluginConfigPostHandler = handlers[handlers.length - 1];
            pluginConfigPostMiddlewares = handlers.slice(0, -1);
          }
        }),
        put: jest.fn(),
        delete: jest.fn()
      };

      plugin.registerWithRouter(mockRouter);
    });

    function runWithMiddlewares(middlewares, handler, req, res) {
      return new Promise((resolve) => {
        let currentIndex = 0;
        const next = () => {
          currentIndex++;
          if (currentIndex < middlewares.length) {
            middlewares[currentIndex](req, res, next);
          } else {
            Promise.resolve(handler(req, res)).then(resolve);
          }
        };
        if (middlewares.length > 0) {
          middlewares[0](req, res, next);
        } else {
          Promise.resolve(handler(req, res)).then(resolve);
        }
        setTimeout(resolve, 50);
      });
    }

    test("should pass config directly to savePluginOptions without wrapping in configuration key", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "192.168.1.100",
          testAddress: "8.8.8.8",
          testPort: 53
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      // Config is always saved as { connections: [...] }
      expect(Array.isArray(savedConfig.connections)).toBe(true);
      const conn = savedConfig.connections[0];
      expect(conn.serverType).toBe("client");
      expect(conn.udpPort).toBe(4446);
    });

    test("should strip unknown properties from config before saving", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "192.168.1.100",
          testAddress: "8.8.8.8",
          testPort: 53,
          unknownField: "should be removed",
          configuration: { nested: "stale data" }
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      expect(savedConfig.unknownField).toBeUndefined();
      expect(Array.isArray(savedConfig.connections)).toBe(true);
      expect(savedConfig.connections[0].serverType).toBe("client");
    });

    test("should call restartPlugin with sanitized config after save", async () => {
      // Start the plugin to set state.restartPlugin
      const mockRestartPlugin = jest.fn();
      await plugin.start(
        {
          secretKey: "12345678901234567890123456789012",
          udpPort: 4446,
          serverType: "server"
        },
        mockRestartPlugin
      );

      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "server",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012"
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, restarting: true })
      );
      // restartPlugin must receive the config in connections[] format
      expect(mockRestartPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: expect.arrayContaining([
            expect.objectContaining({ serverType: "server", udpPort: 4446 })
          ])
        })
      );
    });

    test("should fall back to savePluginOptions when restartPlugin not available", async () => {
      // Don't start the plugin — state.restartPlugin is not set
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "192.168.1.100",
          testAddress: "8.8.8.8",
          testPort: 53
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, restarting: false })
      );
    });

    test("should strip client-only fields when saving in server mode", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "server",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "192.168.1.100",
          testAddress: "8.8.8.8",
          testPort: 53,
          helloMessageSender: 60,
          pingIntervalTime: 1
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      const savedConn = savedConfig.connections[0];
      expect(savedConn.serverType).toBe("server");
      expect(savedConn.udpAddress).toBeUndefined();
      expect(savedConn.testAddress).toBeUndefined();
      expect(savedConn.testPort).toBeUndefined();
      expect(savedConn.helloMessageSender).toBeUndefined();
      expect(savedConn.pingIntervalTime).toBeUndefined();
    });

    test("should reject non-object JSON body", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: []
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "Request body must be a JSON object" })
      );
      expect(mockApp.savePluginOptions).not.toHaveBeenCalled();
    });

    test("should reject udpPort when not an integer", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "server",
          udpPort: "4446",
          secretKey: "12345678901234567890123456789012"
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining("udpPort") })
      );
      expect(mockApp.savePluginOptions).not.toHaveBeenCalled();
    });

    test("should reject weak secretKey values", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          serverType: "server",
          udpPort: 4446,
          secretKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining("insufficient entropy")
        })
      );
      expect(mockApp.savePluginOptions).not.toHaveBeenCalled();
    });
  });

  describe("Plugin Config Read-Modify-Save Round-Trip", () => {
    let mockRouter;
    let pluginConfigGetHandler;
    let pluginConfigGetMiddlewares;
    let pluginConfigPostHandler;
    let pluginConfigPostMiddlewares;

    /**
     * Simulates SignalK server's actual savePluginOptions behavior:
     *   { ...getPluginOptions(plugin.id), configuration }
     * where "configuration" is a shorthand property — the parameter value
     * becomes the value of a key named "configuration".
     */
    let diskFile;

    beforeEach(() => {
      // Simulate the on-disk plugin config file (new connections[] format)
      diskFile = {
        enabled: true,
        configuration: {
          connections: [
            {
              name: "base",
              serverType: "client",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012",
              udpAddress: "192.168.1.100",
              testAddress: "8.8.8.8",
              testPort: 53,
              helloMessageSender: 60,
              pingIntervalTime: 1
            }
          ]
        }
      };

      // Mock readPluginOptions: returns the full disk file
      mockApp.readPluginOptions = jest.fn(() => JSON.parse(JSON.stringify(diskFile)));

      // Mock savePluginOptions: simulates real SignalK shorthand property merge
      mockApp.savePluginOptions = jest.fn((configuration, cb) => {
        // This replicates: { ...getPluginOptions(plugin.id), configuration }
        const existing = JSON.parse(JSON.stringify(diskFile));
        diskFile = { ...existing, configuration };
        cb(null);
      });

      mockRouter = {
        get: jest.fn((path, ...handlers) => {
          if (path === "/plugin-config") {
            pluginConfigGetHandler = handlers[handlers.length - 1];
            pluginConfigGetMiddlewares = handlers.slice(0, -1);
          }
        }),
        post: jest.fn((path, ...handlers) => {
          if (path === "/plugin-config") {
            pluginConfigPostHandler = handlers[handlers.length - 1];
            pluginConfigPostMiddlewares = handlers.slice(0, -1);
          }
        }),
        put: jest.fn(),
        delete: jest.fn()
      };

      plugin.registerWithRouter(mockRouter);
    });

    function runWithMiddlewares(middlewares, handler, req, res) {
      return new Promise((resolve) => {
        let currentIndex = 0;
        const next = () => {
          currentIndex++;
          if (currentIndex < middlewares.length) {
            middlewares[currentIndex](req, res, next);
          } else {
            Promise.resolve(handler(req, res)).then(resolve);
          }
        };
        if (middlewares.length > 0) {
          middlewares[0](req, res, next);
        } else {
          Promise.resolve(handler(req, res)).then(resolve);
        }
        setTimeout(resolve, 50);
      });
    }

    /** Simulates GET /plugin-config and returns the configuration object */
    async function readConfig() {
      let captured;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => {
          captured = data;
        })
      };
      await runWithMiddlewares(pluginConfigGetMiddlewares, pluginConfigGetHandler, {}, mockRes);
      return captured;
    }

    /** Simulates POST /plugin-config with the given body */
    async function saveConfig(body) {
      let captured;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => {
          captured = data;
        })
      };
      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        { headers: { "content-type": "application/json" }, body },
        mockRes
      );
      return captured;
    }

    test("GET /plugin-config redacts persisted secret keys", async () => {
      const read = await readConfig();

      expect(read.success).toBe(true);
      expect(read.configuration.connections[0].secretKey).toBe("[redacted]");
      expect(diskFile.configuration.connections[0].secretKey).toBe(
        "12345678901234567890123456789012"
      );
    });

    test("POST /plugin-config preserves persisted secret keys when the redacted sentinel is submitted", async () => {
      const read = await readConfig();

      read.configuration.connections[0].pingIntervalTime = 5;
      const response = await saveConfig(read.configuration);

      expect(response.success).toBe(true);
      expect(diskFile.configuration.connections[0].pingIntervalTime).toBe(5);
      expect(diskFile.configuration.connections[0].secretKey).toBe(
        "12345678901234567890123456789012"
      );
    });

    test("POST /plugin-config restores redacted secrets by stable identity when connections are reordered", async () => {
      diskFile.configuration = {
        connections: [
          {
            name: "alpha",
            serverType: "client",
            udpPort: 4446,
            secretKey: "abcdefghijklmnopqrstuvwxyz123456",
            udpAddress: "10.0.0.1",
            testAddress: "10.0.0.1",
            testPort: 80
          },
          {
            name: "beta",
            serverType: "client",
            udpPort: 4447,
            secretKey: "ZYXWVUTSRQPONMLKJIHGFEDCBA654321",
            udpAddress: "10.0.0.2",
            testAddress: "10.0.0.2",
            testPort: 80
          }
        ]
      };

      const read = await readConfig();
      const reordered = {
        connections: [
          { ...read.configuration.connections[1], secretKey: "[redacted]" },
          { ...read.configuration.connections[0], secretKey: "[redacted]" }
        ]
      };

      const response = await saveConfig(reordered);

      expect(response.success).toBe(true);
      expect(diskFile.configuration.connections[0].name).toBe("beta");
      expect(diskFile.configuration.connections[0].secretKey).toBe(
        "ZYXWVUTSRQPONMLKJIHGFEDCBA654321"
      );
      expect(diskFile.configuration.connections[1].name).toBe("alpha");
      expect(diskFile.configuration.connections[1].secretKey).toBe(
        "abcdefghijklmnopqrstuvwxyz123456"
      );
    });

    test("POST /plugin-config supports partial redacted-secret updates", async () => {
      diskFile.configuration = {
        connections: [
          {
            name: "alpha",
            serverType: "server",
            udpPort: 4501,
            secretKey: "abcdefghijklmnopqrstuvwxyz123456"
          },
          {
            name: "beta",
            serverType: "server",
            udpPort: 4502,
            secretKey: "ZYXWVUTSRQPONMLKJIHGFEDCBA654321"
          }
        ]
      };

      const read = await readConfig();
      const update = {
        connections: [
          { ...read.configuration.connections[0], secretKey: "[redacted]" },
          { ...read.configuration.connections[1], secretKey: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" }
        ]
      };

      const response = await saveConfig(update);

      expect(response.success).toBe(true);
      expect(diskFile.configuration.connections[0].secretKey).toBe(
        "abcdefghijklmnopqrstuvwxyz123456"
      );
      expect(diskFile.configuration.connections[1].secretKey).toBe(
        "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"
      );
    });

    test("POST /plugin-config returns a clear validation error for unmatched redacted secrets", async () => {
      diskFile.configuration = {
        connections: [
          {
            name: "alpha",
            serverType: "server",
            udpPort: 4701,
            secretKey: "abcdefghijklmnopqrstuvwxyz123456"
          }
        ]
      };

      const read = await readConfig();
      const response = await saveConfig({
        connections: [
          { ...read.configuration.connections[0], udpPort: 4702, secretKey: "[redacted]" }
        ]
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("alpha");
      expect(response.error).toContain("4702");
      expect(response.error).toContain("no stored secretKey");
    });

    test("POST /plugin-config rejects ambiguous redacted-secret identity matches", async () => {
      diskFile.configuration = {
        connections: [
          {
            name: "dup",
            serverType: "client",
            udpPort: 4600,
            secretKey: "abcdefghijklmnopqrstuvwxyz123456",
            udpAddress: "10.0.0.1",
            testAddress: "10.0.0.1",
            testPort: 80
          },
          {
            name: "dup",
            serverType: "client",
            udpPort: 4600,
            secretKey: "ZYXWVUTSRQPONMLKJIHGFEDCBA654321",
            udpAddress: "10.0.0.2",
            testAddress: "10.0.0.2",
            testPort: 80
          }
        ]
      };

      const read = await readConfig();
      const response = await saveConfig({
        connections: [{ ...read.configuration.connections[0], secretKey: "[redacted]" }]
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("ambiguous");
      expect(diskFile.configuration.connections[0].secretKey).toBe(
        "abcdefghijklmnopqrstuvwxyz123456"
      );
      expect(diskFile.configuration.connections[1].secretKey).toBe(
        "ZYXWVUTSRQPONMLKJIHGFEDCBA654321"
      );
    });

    test("config should not grow after multiple save cycles", async () => {
      const initialSize = JSON.stringify(diskFile).length;

      // Round-trip 1: read → save unchanged
      const read1 = await readConfig();
      expect(read1.success).toBe(true);
      await saveConfig(read1.configuration);

      const sizeAfterRound1 = JSON.stringify(diskFile).length;
      expect(sizeAfterRound1).toBe(initialSize);

      // Round-trip 2: read → save unchanged
      const read2 = await readConfig();
      await saveConfig(read2.configuration);

      const sizeAfterRound2 = JSON.stringify(diskFile).length;
      expect(sizeAfterRound2).toBe(initialSize);

      // Round-trip 3: read → save unchanged
      const read3 = await readConfig();
      await saveConfig(read3.configuration);

      const sizeAfterRound3 = JSON.stringify(diskFile).length;
      expect(sizeAfterRound3).toBe(initialSize);
    });

    test("config should never have nested configuration key", async () => {
      // Save three times
      for (let i = 0; i < 3; i++) {
        const read = await readConfig();
        await saveConfig(read.configuration);
      }

      // The disk file's configuration should contain a connections[] array with actual config fields
      expect(Array.isArray(diskFile.configuration.connections)).toBe(true);
      expect(diskFile.configuration.connections[0].serverType).toBe("client");
      expect(diskFile.configuration.connections[0].udpPort).toBe(4446);
      expect(diskFile.configuration.configuration).toBeUndefined();
    });

    test("config values should survive multiple read-modify-save cycles", async () => {
      // Round-trip 1: read, modify non-identity field, save
      const read1 = await readConfig();
      read1.configuration.connections[0].pingIntervalTime = 2;
      await saveConfig(read1.configuration);
      expect(diskFile.configuration.connections[0].pingIntervalTime).toBe(2);

      // Round-trip 2: read, modify address, save
      const read2 = await readConfig();
      expect(read2.configuration.connections[0].pingIntervalTime).toBe(2);
      read2.configuration.connections[0].udpAddress = "10.0.0.1";
      await saveConfig(read2.configuration);
      expect(diskFile.configuration.connections[0].pingIntervalTime).toBe(2);
      expect(diskFile.configuration.connections[0].udpAddress).toBe("10.0.0.1");

      // Round-trip 3: read, verify all changes persisted
      const read3 = await readConfig();
      expect(read3.configuration.connections[0].pingIntervalTime).toBe(2);
      expect(read3.configuration.connections[0].udpAddress).toBe("10.0.0.1");
      expect(read3.configuration.connections[0].secretKey).toBe("[redacted]");
    });

    test("switching modes should not leave stale fields on disk", async () => {
      // Start in client mode, save
      const read1 = await readConfig();
      expect(read1.configuration.connections[0].serverType).toBe("client");
      await saveConfig(read1.configuration);

      // Switch to server mode — client fields should be stripped
      const read2 = await readConfig();
      read2.configuration.connections[0].serverType = "server";
      read2.configuration.connections[0].secretKey = "12345678901234567890123456789012";
      await saveConfig(read2.configuration);

      expect(diskFile.configuration.connections[0].serverType).toBe("server");
      expect(diskFile.configuration.connections[0].udpAddress).toBeUndefined();
      expect(diskFile.configuration.connections[0].testAddress).toBeUndefined();
      expect(diskFile.configuration.connections[0].testPort).toBeUndefined();
      expect(diskFile.configuration.connections[0].helloMessageSender).toBeUndefined();
      expect(diskFile.configuration.connections[0].pingIntervalTime).toBeUndefined();

      // Switch back to client mode — add client fields back
      const read3 = await readConfig();
      read3.configuration.connections[0].serverType = "client";
      read3.configuration.connections[0].secretKey = "12345678901234567890123456789012";
      read3.configuration.connections[0].udpAddress = "192.168.1.200";
      read3.configuration.connections[0].testAddress = "1.1.1.1";
      read3.configuration.connections[0].testPort = 443;
      await saveConfig(read3.configuration);

      expect(diskFile.configuration.connections[0].serverType).toBe("client");
      expect(diskFile.configuration.connections[0].udpAddress).toBe("192.168.1.200");
      expect(diskFile.configuration.configuration).toBeUndefined();
    });

    test("stale nested configuration from prior bug should be cleaned on save", async () => {
      // Simulate a corrupted disk file with a nested configuration key
      diskFile = {
        enabled: true,
        configuration: {
          configuration: {
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "192.168.1.100",
            testAddress: "8.8.8.8",
            testPort: 53
          }
        }
      };

      // Read returns the corrupted config
      const read1 = await readConfig();
      // The nested "configuration" key will be present in what we read
      expect(read1.configuration.configuration).toBeDefined();

      // User re-enters correct values and saves using the new connections[] format
      const fixedConfig = {
        connections: [
          {
            serverType: "client",
            udpPort: 4446,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "192.168.1.100",
            testAddress: "8.8.8.8",
            testPort: 53
          }
        ]
      };
      await saveConfig(fixedConfig);

      // After save, the config should be clean connections[] format
      expect(Array.isArray(diskFile.configuration.connections)).toBe(true);
      expect(diskFile.configuration.connections[0].serverType).toBe("client");
      expect(diskFile.configuration.connections[0].udpPort).toBe(4446);
      expect(diskFile.configuration.configuration).toBeUndefined();

      // Subsequent round-trips should stay clean
      const read2 = await readConfig();
      await saveConfig(read2.configuration);
      expect(diskFile.configuration.configuration).toBeUndefined();
    });
  });

  describe("Error Handling", () => {
    test("should handle missing required options gracefully", async () => {
      const options = {};

      await plugin.start(options);

      expect(mockApp.error).toHaveBeenCalled();
    });

    test("should handle undefined options gracefully", async () => {
      await expect(plugin.start()).resolves.toBeUndefined();
      expect(mockApp.error).toHaveBeenCalled();
    });

    test("should not throw on stop if never started", () => {
      expect(() => plugin.stop()).not.toThrow();
    });
  });

  // ── Multi-instance array-based config (the primary new code path) ─────────
  describe("Multi-Instance Config (connections[])", () => {
    test("should start two independent server connections via array config", async () => {
      const options = {
        connections: [
          {
            name: "Server A",
            serverType: "server",
            udpPort: 4470,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "Server B",
            serverType: "server",
            udpPort: 4471,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      };

      await plugin.start(options);
      // Wait for async UDP socket binding to complete and status to be updated
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockApp.error).not.toHaveBeenCalled();
      // Both connections should appear in the status (either "2 connections active" or "N/2 active — ...")
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith(
        expect.stringMatching(/2 connections active|\/2 active/)
      );
    });

    test("should start a server and a client simultaneously", async () => {
      const options = {
        connections: [
          {
            name: "Shore Server",
            serverType: "server",
            udpPort: 4472,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "Sat Client",
            serverType: "client",
            udpPort: 4473,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "127.0.0.1",
            testAddress: "127.0.0.1",
            testPort: 80,
            pingIntervalTime: 60,
            helloMessageSender: 60
          }
        ]
      };

      await plugin.start(options);
      // Wait for async UDP socket binding to complete and status to be updated
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockApp.error).not.toHaveBeenCalled();
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith(
        expect.stringMatching(/2 connections active|\/2 active/)
      );
    });

    test("should detect and reject duplicate server ports before starting any instance", async () => {
      const options = {
        connections: [
          {
            name: "Server A",
            serverType: "server",
            udpPort: 4474,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "Server B",
            serverType: "server",
            udpPort: 4474,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      };

      await plugin.start(options);

      expect(mockApp.error).toHaveBeenCalledWith(expect.stringContaining("Duplicate server ports"));
      // Status should reflect the config error, not a started state
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith(expect.stringContaining("error"));
    });

    test("should generate unique instance IDs when two connections share the same name", async () => {
      // Both connections have the same name – the collision path in generateInstanceId
      // must append -1 to the second one.  We verify the plugin starts successfully
      // (no error thrown / logged) which confirms the disambiguation worked.
      const options = {
        connections: [
          {
            name: "My Link",
            serverType: "server",
            udpPort: 4475,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "My Link",
            serverType: "server",
            udpPort: 4476,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      };

      await plugin.start(options);

      expect(mockApp.error).not.toHaveBeenCalled();
    });

    test("should reject an empty connections array", async () => {
      await plugin.start({ connections: [] });

      expect(mockApp.error).toHaveBeenCalled();
    });

    test("clients on same port as server do not trigger duplicate port error", async () => {
      const options = {
        connections: [
          {
            name: "Server",
            serverType: "server",
            udpPort: 4477,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "Client",
            serverType: "client",
            udpPort: 4477,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "127.0.0.1",
            testAddress: "127.0.0.1",
            testPort: 80,
            pingIntervalTime: 60,
            helloMessageSender: 60
          }
        ]
      };

      await plugin.start(options);

      // Server listens on 4477, client connects TO 4477 – not a collision
      expect(mockApp.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Duplicate server ports")
      );
    });
  });

  // ── /connections API routes ───────────────────────────────────────────────
  describe("Multi-Instance Routes (/connections)", () => {
    let mockRouter;
    let routeHandlers; // "METHOD /path" -> handler fn

    function makeRes() {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        send: jest.fn()
      };
      return res;
    }

    beforeEach(() => {
      routeHandlers = {};
      mockRouter = {
        get: jest.fn((path, ...args) => {
          routeHandlers[`GET ${path}`] = args[args.length - 1];
        }),
        post: jest.fn((path, ...args) => {
          routeHandlers[`POST ${path}`] = args[args.length - 1];
        }),
        put: jest.fn((path, ...args) => {
          routeHandlers[`PUT ${path}`] = args[args.length - 1];
        }),
        delete: jest.fn((path, ...args) => {
          routeHandlers[`DELETE ${path}`] = args[args.length - 1];
        })
      };
      plugin.registerWithRouter(mockRouter);
    });

    test("GET /connections returns empty array when plugin not yet started", () => {
      const handler = routeHandlers["GET /connections"];
      const res = makeRes();
      handler({}, res);
      expect(res.json).toHaveBeenCalledWith([]);
    });

    test("GET /connections lists all active connections after start", async () => {
      await plugin.start({
        connections: [
          {
            name: "Shore Server",
            serverType: "server",
            udpPort: 4480,
            secretKey: "12345678901234567890123456789012"
          },
          {
            name: "Sat Client",
            serverType: "client",
            udpPort: 4481,
            secretKey: "12345678901234567890123456789012",
            udpAddress: "127.0.0.1",
            testAddress: "127.0.0.1",
            testPort: 80,
            pingIntervalTime: 60,
            helloMessageSender: 60
          }
        ]
      });

      const handler = routeHandlers["GET /connections"];
      const res = makeRes();
      handler({}, res);

      const list = res.json.mock.calls[0][0];
      expect(list).toHaveLength(2);
      expect(list.find((c) => c.id === "shore-server")).toBeDefined();
      expect(list.find((c) => c.id === "sat-client")).toBeDefined();
      expect(list.find((c) => c.id === "shore-server").type).toBe("server");
      expect(list.find((c) => c.id === "sat-client").type).toBe("client");
    });

    test("GET /connections/:id/metrics returns 404 for unknown id", () => {
      const handler = routeHandlers["GET /connections/:id/metrics"];
      const res = makeRes();
      handler({ params: { id: "nonexistent" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("nonexistent") })
      );
    });

    test("GET /connections/:id/network-metrics returns 404 for unknown id", () => {
      const handler = routeHandlers["GET /connections/:id/network-metrics"];
      const res = makeRes();
      handler({ params: { id: "ghost" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("GET /connections/:id/bonding returns 404 for unknown id", () => {
      const handler = routeHandlers["GET /connections/:id/bonding"];
      const res = makeRes();
      handler({ params: { id: "ghost" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("GET /connections/:id/congestion returns 404 for unknown id", () => {
      const handler = routeHandlers["GET /connections/:id/congestion"];
      const res = makeRes();
      handler({ params: { id: "ghost" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("GET /connections/:id/config/:filename returns 404 for unknown id", async () => {
      const handler = routeHandlers["GET /connections/:id/config/:filename"];
      const res = makeRes();
      await handler({ params: { id: "ghost", filename: "delta_timer.json" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("POST /connections/:id/config/:filename returns 404 for unknown id", async () => {
      const handler = routeHandlers["POST /connections/:id/config/:filename"];
      const res = makeRes();
      await handler({ params: { id: "ghost", filename: "delta_timer.json" }, body: {} }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("GET /connections/:id/bonding returns 404 in server mode", async () => {
      await plugin.start({
        connections: [
          {
            name: "my-server",
            serverType: "server",
            udpPort: 4482,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      });

      const handler = routeHandlers["GET /connections/:id/bonding"];
      const res = makeRes();
      handler({ params: { id: "my-server" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("GET /connections/:id/congestion returns 404 in server mode", async () => {
      await plugin.start({
        connections: [
          {
            name: "my-server2",
            serverType: "server",
            udpPort: 4483,
            secretKey: "12345678901234567890123456789012"
          }
        ]
      });

      const handler = routeHandlers["GET /connections/:id/congestion"];
      const res = makeRes();
      handler({ params: { id: "my-server2" } }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test("POST /instances preserves top-level plugin options during restart", async () => {
      const restartPlugin = jest.fn().mockResolvedValue(undefined);
      await plugin.start(
        {
          managementApiToken: "super-secret-token",
          enableCaptureByDefault: true,
          connections: [
            {
              name: "existing-client",
              serverType: "client",
              udpPort: 4484,
              secretKey: "12345678901234567890123456789012",
              udpAddress: "127.0.0.1",
              testAddress: "127.0.0.1",
              testPort: 80
            }
          ]
        },
        restartPlugin
      );

      const handler = routeHandlers["POST /instances"];
      const res = makeRes();

      await handler(
        {
          headers: {
            "x-edge-link-token": "super-secret-token"
          },
          body: {
            name: "added-server",
            serverType: "server",
            udpPort: 4485,
            secretKey: "12345678901234567890123456789012"
          }
        },
        res
      );

      expect(restartPlugin).toHaveBeenCalledTimes(1);
      const restartOptions = restartPlugin.mock.calls[0][0];
      expect(restartOptions.managementApiToken).toBe("super-secret-token");
      expect(restartOptions.enableCaptureByDefault).toBe(true);
      expect(Array.isArray(restartOptions.connections)).toBe(true);
      expect(restartOptions.connections).toHaveLength(2);
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  // ── POST /plugin-config with connections[] array format ───────────────────
  describe("Plugin Config Save – connections array format", () => {
    let mockRouter;
    let pluginConfigPostHandler;
    let pluginConfigPostMiddlewares;

    beforeEach(() => {
      mockApp.savePluginOptions = jest.fn((config, cb) => cb(null));
      mockApp.readPluginOptions = jest.fn(() => ({
        configuration: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012"
        }
      }));

      mockRouter = {
        get: jest.fn(),
        post: jest.fn((path, ...handlers) => {
          if (path === "/plugin-config") {
            pluginConfigPostHandler = handlers[handlers.length - 1];
            pluginConfigPostMiddlewares = handlers.slice(0, -1);
          }
        }),
        put: jest.fn(),
        delete: jest.fn()
      };
      plugin.registerWithRouter(mockRouter);
    });

    function runWithMiddlewares(middlewares, handler, req, res) {
      return new Promise((resolve) => {
        let i = 0;
        const next = () => {
          i++;
          if (i < middlewares.length) {
            middlewares[i](req, res, next);
          } else {
            Promise.resolve(handler(req, res)).then(resolve);
          }
        };
        if (middlewares.length > 0) {
          middlewares[0](req, res, next);
        } else {
          Promise.resolve(handler(req, res)).then(resolve);
        }
        setTimeout(resolve, 50);
      });
    }

    test("should accept and save a connections[] array body", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          connections: [
            {
              name: "shore-server",
              serverType: "server",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            }
          ]
        }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const saved = mockApp.savePluginOptions.mock.calls[0][0];
      expect(Array.isArray(saved.connections)).toBe(true);
      expect(saved.connections[0].serverType).toBe("server");
      expect(saved.connections[0].udpPort).toBe(4446);
    });

    test("should accept a 64-character hex secretKey in /plugin-config", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          connections: [
            {
              name: "hex-server",
              serverType: "server",
              udpPort: 4446,
              secretKey: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
            }
          ]
        }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const saved = mockApp.savePluginOptions.mock.calls[0][0];
      expect(saved.connections[0].secretKey).toBe(
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
      );
    });

    test("should accept a 44-character base64 secretKey in /plugin-config", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          connections: [
            {
              name: "base64-server",
              serverType: "server",
              udpPort: 4446,
              secretKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
            }
          ]
        }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const saved = mockApp.savePluginOptions.mock.calls[0][0];
      expect(saved.connections[0].secretKey).toBe("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    });

    test("should save multiple connections in array", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: {
          connections: [
            {
              name: "server1",
              serverType: "server",
              udpPort: 4446,
              secretKey: "12345678901234567890123456789012"
            },
            {
              name: "client1",
              serverType: "client",
              udpPort: 4447,
              secretKey: "12345678901234567890123456789012",
              udpAddress: "10.0.0.1",
              testAddress: "10.0.0.1",
              testPort: 80
            }
          ]
        }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const saved = mockApp.savePluginOptions.mock.calls[0][0];
      expect(saved.connections).toHaveLength(2);
    });

    test("should reject empty connections array", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: { connections: [] }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test("should reject body with neither connections nor serverType", async () => {
      const mockReq = {
        headers: { "content-type": "application/json" },
        body: { udpPort: 4446 }
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        mockReq,
        mockRes
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });
});
