"use strict";

jest.mock("fs", () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn()
  }
}));

const { promises: fsPromises } = require("fs");
const { loadConfigFile, ConfigFileLoadError } = require("../lib/config-io");

describe("loadConfigFile", () => {
  const filePath = "/tmp/config.json";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns null for missing file (ENOENT)", async () => {
    const err = new Error("missing");
    err.code = "ENOENT";
    fsPromises.readFile.mockRejectedValue(err);

    await expect(loadConfigFile(filePath)).resolves.toBeNull();
  });

  test("throws typed error for invalid JSON", async () => {
    fsPromises.readFile.mockResolvedValue("{not-valid-json");

    await expect(loadConfigFile(filePath)).rejects.toMatchObject({
      name: "ConfigFileLoadError",
      type: "invalid_json",
      filePath
    });
  });

  test("throws typed error for permission denied", async () => {
    const err = new Error("permission denied");
    err.code = "EACCES";
    fsPromises.readFile.mockRejectedValue(err);

    const promise = loadConfigFile(filePath);
    await expect(promise).rejects.toBeInstanceOf(ConfigFileLoadError);
    await expect(promise).rejects.toMatchObject({
      type: "io_error",
      filePath,
      metadata: expect.objectContaining({ code: "EACCES" })
    });
  });

  test("returns parsed JSON for valid file", async () => {
    const payload = { deltaTimer: 500 };
    fsPromises.readFile.mockResolvedValue(JSON.stringify(payload));

    await expect(loadConfigFile(filePath)).resolves.toEqual(payload);
  });
});
