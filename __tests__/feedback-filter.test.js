"use strict";

jest.mock("ping-monitor", () => {
  const { EventEmitter } = require("events");

  class MockMonitor extends EventEmitter {
    constructor() {
      super();
      MockMonitor.instances.push(this);
    }

    stop() {}
  }

  MockMonitor.instances = [];
  return MockMonitor;
});

const createPlugin = require("../index");
const Monitor = require("ping-monitor");

describe("Outbound feedback filtering", () => {
  let plugin;
  let mockApp;

  const clientOptions = {
    secretKey: "12345678901234567890123456789012",
    udpPort: 4446,
    serverType: "client",
    udpAddress: "127.0.0.1",
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1,
    helloMessageSender: 60
  };

  beforeEach(() => {
    Monitor.instances.length = 0;

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
          mockApp._deltaCallback = deltaCallback;
          return jest.fn();
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  async function startClientAndEnableSending() {
    await plugin.start(clientOptions);
    const deadline = Date.now() + 2000;
    while (typeof mockApp._deltaCallback !== "function" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const monitor = Monitor.instances[0];
    expect(monitor).toBeDefined();
    monitor.emit("up", { time: 10 });
  }

  test("drops deltas sourced from this plugin", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [{
        source: { label: "signalk-edge-link" },
        values: [{ path: "networking.edgeLink.linkQuality", value: 99 }]
      }]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).not.toHaveBeenCalled();
  });

  test("allows non-edge-link deltas through", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [{
        source: { label: "other-plugin" },
        values: [{ path: "navigation.speedOverGround", value: 5.1 }]
      }]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("drops networking.modem.rtt even without source metadata", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [{
        values: [{ path: "networking.modem.rtt", value: 0.012 }]
      }]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).not.toHaveBeenCalled();
  });

  test("drops notifications.signalk-edge-link.* even without source metadata", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [{
        values: [{
          path: "notifications.signalk-edge-link.packetLoss",
          value: { state: "alert", message: "test", method: ["visual"] }
        }]
      }]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).not.toHaveBeenCalled();
  });
});
