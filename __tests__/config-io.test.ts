// @ts-nocheck
"use strict";

const fs = require("fs").promises;
const os = require("os");
const path = require("path");

const { loadConfigFile, saveConfigFile } = require("../lib/config-io.ts");

describe("config-io", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-io-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("saveConfigFile writes atomically via temp file and keeps return contract", async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    const filePath = path.join(tempDir, "settings.json");

    const saved = await saveConfigFile(filePath, { enabled: true }, logger);

    expect(saved).toBe(true);
    const persisted = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(persisted).toEqual({ enabled: true });
    await expect(fs.access(path.join(tempDir, ".settings.json.tmp"))).rejects.toBeTruthy();
    expect(logger.debug).toHaveBeenCalledWith(`Configuration saved to ${filePath}`);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("loadConfigFile logs parse errors as error and returns null", async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    const filePath = path.join(tempDir, "bad.json");
    await fs.writeFile(filePath, "{not valid json", "utf-8");

    const loaded = await loadConfigFile(filePath, logger);

    expect(loaded).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error parsing JSON in ${filePath}`)
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("loadConfigFile logs ENOENT as debug and returns null", async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    const filePath = path.join(tempDir, "missing.json");

    const loaded = await loadConfigFile(filePath, logger);

    expect(loaded).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(`Config file not found ${filePath}`);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
