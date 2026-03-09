// @ts-nocheck
"use strict";

const net = require("net");
const createPlugin = require("../index.ts");

describe("Outbound delta forwarding", () => {
  let plugin;
  let mockApp;
  let probeServer;
  let probePort;

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

  beforeEach(async () => {
    probeServer = net.createServer();
    await new Promise((resolve, reject) => {
      probeServer.once("error", reject);
      probeServer.listen(0, "127.0.0.1", () => {
        probeServer.removeListener("error", reject);
        resolve();
      });
    });
    const addr = probeServer.address();
    probePort = addr && typeof addr === "object" ? addr.port : 80;

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
    if (probeServer) {
      await new Promise((resolve) => probeServer.close(() => resolve()));
      probeServer = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  async function waitForReadyToSend() {
    const probeDelta = {
      context: "vessels.self",
      updates: [
        {
          source: { label: "probe" },
          values: [{ path: "navigation.speedOverGround", value: 1.1 }]
        }
      ]
    };

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      mockApp.reportOutputMessages.mockClear();
      mockApp._deltaCallback(probeDelta);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (mockApp.reportOutputMessages.mock.calls.length > 0) {
        mockApp.reportOutputMessages.mockClear();
        return;
      }
    }
    throw new Error("Timed out waiting for client readiness");
  }

  async function startClientAndEnableSending() {
    await plugin.start({
      ...clientOptions,
      testPort: probePort,
      pingIntervalTime: 0.001
    });
    const deadline = Date.now() + 2000;
    while (typeof mockApp._deltaCallback !== "function" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await waitForReadyToSend();
  }

  test("forwards deltas sourced from this plugin", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          source: { label: "signalk-edge-link" },
          values: [{ path: "networking.edgeLink.linkQuality", value: 99 }]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("allows non-edge-link deltas through", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          source: { label: "other-plugin" },
          values: [{ path: "navigation.speedOverGround", value: 5.1 }]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("forwards networking.modem.rtt without source metadata", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          values: [{ path: "networking.modem.rtt", value: 0.012 }]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("forwards instance-namespaced networking.modem.<instanceId>.rtt path", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          values: [{ path: "networking.modem.default.rtt", value: 0.015 }]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("forwards own instance notifications.signalk-edge-link.<instanceId>.*", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "notifications.signalk-edge-link.default.packetLoss",
              value: { state: "alert", message: "test", method: ["visual"] }
            }
          ]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalledTimes(1);
  });

  test("allows other instance notifications to pass through", async () => {
    await startClientAndEnableSending();
    expect(typeof mockApp._deltaCallback).toBe("function");

    mockApp.reportOutputMessages.mockClear();

    mockApp._deltaCallback({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "notifications.signalk-edge-link.other-instance.packetLoss",
              value: { state: "alert", message: "test", method: ["visual"] }
            }
          ]
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApp.reportOutputMessages).toHaveBeenCalled();
  });
});
