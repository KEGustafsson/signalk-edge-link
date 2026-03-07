/* eslint-disable no-undef */
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const { saveConfigFile, loadConfigFile } = require("../lib/config-io");

describe("lib/config-io", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-io-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test("atomically saves config via tmp file rename", async () => {
    const filePath = path.join(tempDir, "config.json");
    const logger = { debug: jest.fn(), error: jest.fn() };

    const result = await saveConfigFile(filePath, { enabled: true }, logger);

    expect(result).toBe(true);
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(saved).toEqual({ enabled: true });
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(`Configuration saved to ${filePath}`);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("returns false and preserves existing config when fsync fails", async () => {
    const filePath = path.join(tempDir, "config.json");
    const logger = { debug: jest.fn(), error: jest.fn() };
    await fs.writeFile(filePath, JSON.stringify({ existing: true }), "utf-8");

    const realOpen = jest.requireActual("fs").promises.open;
    jest.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      jest.spyOn(handle, "sync").mockRejectedValueOnce(new Error("disk full"));
      return handle;
    });

    const result = await saveConfigFile(filePath, { changed: true }, logger);

    expect(result).toBe(false);
    const current = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(current).toEqual({ existing: true });
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error saving ${filePath} (fsync): disk full`)
    );
  });

  test("returns false and preserves existing config when rename fails", async () => {
    const filePath = path.join(tempDir, "config.json");
    const logger = { debug: jest.fn(), error: jest.fn() };
    await fs.writeFile(filePath, JSON.stringify({ existing: true }), "utf-8");

    const renameSpy = jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("permission denied"));

    const result = await saveConfigFile(filePath, { changed: true }, logger);

    expect(result).toBe(false);
    expect(renameSpy).toHaveBeenCalled();
    const current = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(current).toEqual({ existing: true });
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error saving ${filePath} (rename): permission denied`)
    );
  });

  test("loadConfigFile returns null on missing file", async () => {
    const filePath = path.join(tempDir, "missing.json");
    const logger = { debug: jest.fn(), error: jest.fn() };

    const loaded = await loadConfigFile(filePath, logger);

    expect(loaded).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });
});
