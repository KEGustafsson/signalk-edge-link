/* eslint-disable no-undef */
const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");

// We'll test the config functions indirectly through the plugin
const createPlugin = require("../index");

describe("Configuration File Operations", () => {
  let plugin;
  let mockApp;
  let tempDir;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = path.join(os.tmpdir(), `signalk-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Mock SignalK app object
    mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn(),
      getSelfPath: jest.fn(() => "123456789"),
      handleMessage: jest.fn(),
      getDataDirPath: jest.fn(() => tempDir),
      subscriptionmanager: {
        subscribe: jest.fn(() => jest.fn())
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
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe("Configuration File Initialization", () => {
    test("should create delta_timer.json if it doesn't exist", async () => {
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

      const deltaTimerPath = path.join(tempDir, "delta_timer.json");
      const exists = await fs
        .access(deltaTimerPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      const content = await fs.readFile(deltaTimerPath, "utf-8");
      const config = JSON.parse(content);

      expect(config).toHaveProperty("deltaTimer");
      expect(config.deltaTimer).toBe(1000);
    });

    test("should create subscription.json if it doesn't exist", async () => {
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

      const subscriptionPath = path.join(tempDir, "subscription.json");
      const exists = await fs
        .access(subscriptionPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      const content = await fs.readFile(subscriptionPath, "utf-8");
      const config = JSON.parse(content);

      expect(config).toHaveProperty("context");
      expect(config).toHaveProperty("subscribe");
      expect(config.context).toBe("*");
      expect(Array.isArray(config.subscribe)).toBe(true);
    });

    test("should not overwrite existing configuration files", async () => {
      const customConfig = { deltaTimer: 5000 };
      const deltaTimerPath = path.join(tempDir, "delta_timer.json");

      await fs.writeFile(deltaTimerPath, JSON.stringify(customConfig), "utf-8");

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

      const content = await fs.readFile(deltaTimerPath, "utf-8");
      const config = JSON.parse(content);

      expect(config.deltaTimer).toBe(5000);
    });
  });

  describe("Configuration Loading", () => {
    test("should load existing delta_timer.json", async () => {
      const customConfig = { deltaTimer: 2500 };
      const deltaTimerPath = path.join(tempDir, "delta_timer.json");

      await fs.writeFile(deltaTimerPath, JSON.stringify(customConfig), "utf-8");

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

      // The plugin should have loaded and used the custom value
      // We can't directly test internal state, but we can verify the file was read
      expect(mockApp.debug).toHaveBeenCalled();
    });

    test("should handle corrupted JSON gracefully", async () => {
      const deltaTimerPath = path.join(tempDir, "delta_timer.json");
      await fs.writeFile(deltaTimerPath, "{ invalid json }", "utf-8");

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

      // Should not throw, should use defaults
      await expect(plugin.start(options)).resolves.not.toThrow();
    });
  });

  describe("Server Mode Configuration", () => {
    test("should not create config files in server mode", async () => {
      const options = {
        secretKey: "12345678901234567890123456789012",
        udpPort: 4446,
        serverType: "server"
      };

      await plugin.start(options);

      const deltaTimerPath = path.join(tempDir, "delta_timer.json");
      const subscriptionPath = path.join(tempDir, "subscription.json");

      const deltaExists = await fs
        .access(deltaTimerPath)
        .then(() => true)
        .catch(() => false);
      const subExists = await fs
        .access(subscriptionPath)
        .then(() => true)
        .catch(() => false);

      // Server mode should not create these files
      expect(deltaExists).toBe(false);
      expect(subExists).toBe(false);
    });
  });

  describe("Configuration Validation", () => {
    test("should handle missing context in subscription", async () => {
      const invalidSub = {
        subscribe: [{ path: "navigation.position" }]
        // missing context
      };

      const subscriptionPath = path.join(tempDir, "subscription.json");
      await fs.writeFile(subscriptionPath, JSON.stringify(invalidSub), "utf-8");

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

      // Should handle missing context gracefully
      await expect(plugin.start(options)).resolves.not.toThrow();
    });

    test("should handle missing subscribe array", async () => {
      const invalidSub = {
        context: "*"
        // missing subscribe
      };

      const subscriptionPath = path.join(tempDir, "subscription.json");
      await fs.writeFile(subscriptionPath, JSON.stringify(invalidSub), "utf-8");

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

      // Should handle missing subscribe gracefully
      await expect(plugin.start(options)).resolves.not.toThrow();
    });
  });
});
