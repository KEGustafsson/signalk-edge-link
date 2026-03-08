"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createDebouncedConfigHandler } = require("../lib/config-watcher");
const { FILE_WATCH_DEBOUNCE_DELAY } = require("../lib/constants");

describe("createDebouncedConfigHandler", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "edge-link-config-watcher-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not cache hash on parse error, allowing later valid content to process", async () => {
    const configPath = path.join(tmpDir, "subscription.json");
    const processConfig = jest.fn().mockResolvedValue(undefined);
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = {
      configDebounceTimers: {},
      configContentHashes: {}
    };

    const handleChange = createDebouncedConfigHandler({
      name: "Subscription",
      getFilePath: () => configPath,
      processConfig,
      state,
      instanceId: "default",
      app
    });

    await fs.promises.writeFile(configPath, "{ invalid", "utf-8");
    handleChange();
    await new Promise((resolve) => setTimeout(resolve, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).not.toHaveBeenCalled();
    expect(state.configContentHashes.Subscription).toBeUndefined();
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining("Error handling Subscription change"));

    await fs.promises.writeFile(configPath, JSON.stringify({ context: "*", subscribe: [{ path: "*" }] }), "utf-8");
    handleChange();
    await new Promise((resolve) => setTimeout(resolve, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).toHaveBeenCalledTimes(1);
    expect(processConfig).toHaveBeenCalledWith({ context: "*", subscribe: [{ path: "*" }] });
    expect(state.configContentHashes.Subscription).toMatch(/^[a-f0-9]+$/);
  });
});
