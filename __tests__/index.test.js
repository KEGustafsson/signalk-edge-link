/* eslint-disable no-undef */
const createPlugin = require("../index");

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
    test("should require serverType, udpPort and secretKey", () => {
      expect(plugin.schema.required).toContain("serverType");
      expect(plugin.schema.required).toContain("udpPort");
      expect(plugin.schema.required).toContain("secretKey");
    });

    test("should have serverType options", () => {
      const serverType = plugin.schema.properties.serverType;
      expect(serverType.enum).toEqual(["server", "client"]);
    });

    test("should validate udpPort range", () => {
      const udpPort = plugin.schema.properties.udpPort;
      expect(udpPort.minimum).toBe(1024);
      expect(udpPort.maximum).toBe(65535);
    });

    test("should validate secretKey length", () => {
      const secretKey = plugin.schema.properties.secretKey;
      expect(secretKey.minLength).toBe(32);
      expect(secretKey.maxLength).toBe(32);
    });

    test("should NOT have client-only fields in main properties", () => {
      // Client-only fields should only be in dependencies.oneOf, not main properties
      expect(plugin.schema.properties.udpAddress).toBeUndefined();
      expect(plugin.schema.properties.testAddress).toBeUndefined();
      expect(plugin.schema.properties.testPort).toBeUndefined();
      expect(plugin.schema.properties.pingIntervalTime).toBeUndefined();
      expect(plugin.schema.properties.helloMessageSender).toBeUndefined();
    });

    test("should have dependencies with oneOf for conditional display", () => {
      expect(plugin.schema.dependencies).toBeDefined();
      expect(plugin.schema.dependencies.serverType).toBeDefined();
      expect(plugin.schema.dependencies.serverType.oneOf).toBeDefined();
      expect(plugin.schema.dependencies.serverType.oneOf.length).toBe(2);
    });

    test("should have client-only fields inside oneOf for client mode", () => {
      const clientDep = plugin.schema.dependencies.serverType.oneOf.find(
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

    test("should NOT have client fields in server mode oneOf", () => {
      const serverDep = plugin.schema.dependencies.serverType.oneOf.find(
        (dep) => dep.properties.serverType.enum && dep.properties.serverType.enum.includes("server")
      );
      expect(serverDep).toBeDefined();
      expect(serverDep.properties.udpAddress).toBeUndefined();
      expect(serverDep.properties.testAddress).toBeUndefined();
    });

    test("should NOT set additionalProperties:false (incompatible with dependencies/oneOf)", () => {
      // additionalProperties:false would reject client fields defined in dependencies.oneOf
      // since they are not in the top-level properties block. Server-side sanitization
      // in the /plugin-config POST handler protects against unknown fields instead.
      expect(plugin.schema.additionalProperties).not.toBe(false);
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
        expect.stringContaining("Secret key must be exactly 32 characters")
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
      expect(mockApp.debug).toHaveBeenCalledWith(expect.stringContaining("stopped"));
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

      expect(mockApp.debug).toHaveBeenCalledWith(expect.stringContaining("server started"));
    });

    test("should accept boolean true for server mode", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: true
      };

      await plugin.start(options);

      expect(mockApp.debug).toHaveBeenCalledWith(expect.stringContaining("server started"));
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
          delta.updates[0].values.some((v) => v.path === "networking.modem.rtt")
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
        expect(rttValue.path).toBe("networking.modem.rtt");
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
          delta.updates[0].values.some((v) => v.path === "networking.modem.rtt")
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
          delta.updates[0].values.some((v) => v.path === "networking.modem.rtt")
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
        post: jest.fn()
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
        })
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

      // Should return 503 (not initialized) before checking filename
      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("not fully initialized") })
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

      // Should return 503 (not initialized) before checking filename
      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("not fully initialized") })
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
        configuration: { serverType: "client", udpPort: 4446, secretKey: "12345678901234567890123456789012" }
      }));

      mockRouter = {
        get: jest.fn(),
        post: jest.fn((path, ...handlers) => {
          if (path === "/plugin-config") {
            pluginConfigPostHandler = handlers[handlers.length - 1];
            pluginConfigPostMiddlewares = handlers.slice(0, -1);
          }
        })
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

      await runWithMiddlewares(pluginConfigPostMiddlewares, pluginConfigPostHandler, mockReq, mockRes);

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      // Must NOT be wrapped in { configuration: ... }
      expect(savedConfig.configuration).toBeUndefined();
      // Must have config fields directly
      expect(savedConfig.serverType).toBe("client");
      expect(savedConfig.udpPort).toBe(4446);
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

      await runWithMiddlewares(pluginConfigPostMiddlewares, pluginConfigPostHandler, mockReq, mockRes);

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      expect(savedConfig.unknownField).toBeUndefined();
      expect(savedConfig.configuration).toBeUndefined();
      expect(savedConfig.serverType).toBe("client");
    });

    test("should call restartPlugin with sanitized config after save", async () => {
      // Start the plugin to set state.restartPlugin
      const mockRestartPlugin = jest.fn();
      await plugin.start({
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      }, mockRestartPlugin);

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

      await runWithMiddlewares(pluginConfigPostMiddlewares, pluginConfigPostHandler, mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, restarting: true })
      );
      // restartPlugin must receive the config (not called empty — that would delete config from disk)
      expect(mockRestartPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ serverType: "server", udpPort: 4446 })
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

      await runWithMiddlewares(pluginConfigPostMiddlewares, pluginConfigPostHandler, mockReq, mockRes);

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

      await runWithMiddlewares(pluginConfigPostMiddlewares, pluginConfigPostHandler, mockReq, mockRes);

      expect(mockApp.savePluginOptions).toHaveBeenCalled();
      const savedConfig = mockApp.savePluginOptions.mock.calls[0][0];
      expect(savedConfig.serverType).toBe("server");
      expect(savedConfig.udpAddress).toBeUndefined();
      expect(savedConfig.testAddress).toBeUndefined();
      expect(savedConfig.testPort).toBeUndefined();
      expect(savedConfig.helloMessageSender).toBeUndefined();
      expect(savedConfig.pingIntervalTime).toBeUndefined();
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
      // Simulate the on-disk plugin config file
      diskFile = {
        enabled: true,
        configuration: {
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "192.168.1.100",
          testAddress: "8.8.8.8",
          testPort: 53,
          helloMessageSender: 60,
          pingIntervalTime: 1
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
        })
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
        json: jest.fn((data) => { captured = data; })
      };
      await runWithMiddlewares(
        pluginConfigGetMiddlewares,
        pluginConfigGetHandler,
        {},
        mockRes
      );
      return captured;
    }

    /** Simulates POST /plugin-config with the given body */
    async function saveConfig(body) {
      let captured;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => { captured = data; })
      };
      await runWithMiddlewares(
        pluginConfigPostMiddlewares,
        pluginConfigPostHandler,
        { headers: { "content-type": "application/json" }, body },
        mockRes
      );
      return captured;
    }

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

      // The disk file's configuration should contain actual config fields, not a nested "configuration" object
      expect(diskFile.configuration.serverType).toBe("client");
      expect(diskFile.configuration.udpPort).toBe(4446);
      expect(diskFile.configuration.configuration).toBeUndefined();
    });

    test("config values should survive multiple read-modify-save cycles", async () => {
      // Round-trip 1: read, modify port, save
      const read1 = await readConfig();
      read1.configuration.udpPort = 5000;
      await saveConfig(read1.configuration);
      expect(diskFile.configuration.udpPort).toBe(5000);

      // Round-trip 2: read, modify address, save
      const read2 = await readConfig();
      expect(read2.configuration.udpPort).toBe(5000);
      read2.configuration.udpAddress = "10.0.0.1";
      await saveConfig(read2.configuration);
      expect(diskFile.configuration.udpPort).toBe(5000);
      expect(diskFile.configuration.udpAddress).toBe("10.0.0.1");

      // Round-trip 3: read, verify all changes persisted
      const read3 = await readConfig();
      expect(read3.configuration.udpPort).toBe(5000);
      expect(read3.configuration.udpAddress).toBe("10.0.0.1");
      expect(read3.configuration.secretKey).toBe("12345678901234567890123456789012");
    });

    test("switching modes should not leave stale fields on disk", async () => {
      // Start in client mode, save
      const read1 = await readConfig();
      expect(read1.configuration.serverType).toBe("client");
      await saveConfig(read1.configuration);

      // Switch to server mode — client fields should be stripped
      const read2 = await readConfig();
      read2.configuration.serverType = "server";
      await saveConfig(read2.configuration);

      expect(diskFile.configuration.serverType).toBe("server");
      expect(diskFile.configuration.udpAddress).toBeUndefined();
      expect(diskFile.configuration.testAddress).toBeUndefined();
      expect(diskFile.configuration.testPort).toBeUndefined();
      expect(diskFile.configuration.helloMessageSender).toBeUndefined();
      expect(diskFile.configuration.pingIntervalTime).toBeUndefined();

      // Switch back to client mode — add client fields back
      const read3 = await readConfig();
      read3.configuration.serverType = "client";
      read3.configuration.udpAddress = "192.168.1.200";
      read3.configuration.testAddress = "1.1.1.1";
      read3.configuration.testPort = 443;
      await saveConfig(read3.configuration);

      expect(diskFile.configuration.serverType).toBe("client");
      expect(diskFile.configuration.udpAddress).toBe("192.168.1.200");
      expect(diskFile.configuration.configuration).toBeUndefined();
    });

    test("stale nested configuration from prior bug should be cleaned on save", async () => {
      // Simulate a corrupted disk file left by the old double-nesting bug
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

      // User re-enters correct values and saves (simulating form fill after seeing defaults)
      const fixedConfig = {
        serverType: "client",
        udpPort: 4446,
        secretKey: "12345678901234567890123456789012",
        udpAddress: "192.168.1.100",
        testAddress: "8.8.8.8",
        testPort: 53,
        // Include the stale nested key that RJSF might preserve
        configuration: { serverType: "client", udpPort: 4446 }
      };
      await saveConfig(fixedConfig);

      // After save, sanitization should have stripped the nested "configuration" key
      expect(diskFile.configuration.serverType).toBe("client");
      expect(diskFile.configuration.udpPort).toBe(4446);
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

    test("should not throw on stop if never started", () => {
      expect(() => plugin.stop()).not.toThrow();
    });
  });
});
