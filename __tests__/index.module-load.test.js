"use strict";

/**
 * Regression test for the lazy connection-config import in plugin.start():
 * a module-load failure must resolve start() (signalk-server does not await
 * it), keep the loader detail in the server log, and surface only a generic
 * status message.
 */

jest.mock("ping-monitor", () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    stop: jest.fn()
  }))
);

jest.mock(
  "@msgpack/msgpack",
  () => ({
    encode: jest.fn((v) => Buffer.from(JSON.stringify(v))),
    decode: jest.fn((b) => JSON.parse(b.toString()))
  }),
  { virtual: true }
);

const mockConnectionConfig = {
  failLoad: false,
  message: "Cannot find module '/srv/signalk/node_modules/broken-dep'"
};
jest.mock("../src/connection-config", () => {
  if (mockConnectionConfig.failLoad) {
    throw new Error(mockConnectionConfig.message);
  }
  return jest.requireActual("../src/connection-config");
});

const createPlugin = require("../src/index");

test("a connection-config load failure resolves start() with a generic status", async () => {
  const mockApp = {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setPluginError: jest.fn(),
    getSelfPath: jest.fn(() => "vessel"),
    getDataDirPath: jest.fn(() => __dirname + "/temp"),
    handleMessage: jest.fn(),
    subscriptionmanager: { subscribe: jest.fn() },
    reportOutputMessages: jest.fn()
  };
  const plugin = createPlugin(mockApp);

  // plugin.start() requires connection-config lazily; resetting the module
  // registry forces that require through the throwing factory even though the
  // module loaded fine while the plugin itself was being required.
  mockConnectionConfig.failLoad = true;
  jest.resetModules();

  await expect(plugin.start({})).resolves.toBeUndefined();
  expect(mockApp.error).toHaveBeenCalledWith(expect.stringContaining(mockConnectionConfig.message));
  expect(mockApp.setPluginError).toHaveBeenCalledWith("Module load failed — see server log");
});
