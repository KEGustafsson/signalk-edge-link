"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createDebouncedConfigHandler,
  createWatcherWithRecovery,
  migrateLegacyConfigFiles,
  initializePersistentStorage
} = require("../lib/config-watcher");
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
    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining("Error handling Subscription change")
    );

    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ context: "*", subscribe: [{ path: "*" }] }),
      "utf-8"
    );
    handleChange();
    await new Promise((resolve) => setTimeout(resolve, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).toHaveBeenCalledTimes(1);
    expect(processConfig).toHaveBeenCalledWith({ context: "*", subscribe: [{ path: "*" }] });
    expect(state.configContentHashes.Subscription).toMatch(/^[a-f0-9]+$/);
  });

  test("skips processing when content hash is unchanged on repeated events", async () => {
    const configPath = path.join(tmpDir, "subscription.json");
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ context: "*", subscribe: [{ path: "*" }] }),
      "utf-8"
    );
    const processConfig = jest.fn().mockResolvedValue(undefined);
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = { configDebounceTimers: {}, configContentHashes: {} };

    const handleChange = createDebouncedConfigHandler({
      name: "Subscription",
      getFilePath: () => configPath,
      processConfig,
      state,
      instanceId: "default",
      app
    });

    handleChange();
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));
    expect(processConfig).toHaveBeenCalledTimes(1);

    handleChange();
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).toHaveBeenCalledTimes(1);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
  });

  test("uses readFallback when the file is missing", async () => {
    const missingPath = path.join(tmpDir, "missing.json");
    const fallback = { deltaTimer: 1000 };
    const processConfig = jest.fn().mockResolvedValue(undefined);
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = { configDebounceTimers: {}, configContentHashes: {} };

    const handleChange = createDebouncedConfigHandler({
      name: "DeltaTimer",
      getFilePath: () => missingPath,
      processConfig,
      state,
      instanceId: "default",
      app,
      readFallback: fallback
    });

    handleChange();
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).toHaveBeenCalledWith(fallback);
    expect(app.error).not.toHaveBeenCalled();
  });

  test("does not invoke processConfig once state.stopped is set during debounce", async () => {
    const configPath = path.join(tmpDir, "delta_timer.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ deltaTimer: 500 }), "utf-8");
    const processConfig = jest.fn().mockResolvedValue(undefined);
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = { configDebounceTimers: {}, configContentHashes: {}, stopped: false };

    const handleChange = createDebouncedConfigHandler({
      name: "DeltaTimer",
      getFilePath: () => configPath,
      processConfig,
      state,
      instanceId: "default",
      app
    });

    handleChange();
    state.stopped = true;
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).not.toHaveBeenCalled();
  });

  test("skips hash update when stopped between processConfig and cache write", async () => {
    const configPath = path.join(tmpDir, "late-stop.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ a: 1 }), "utf-8");
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = { configDebounceTimers: {}, configContentHashes: {}, stopped: false };

    const processConfig = jest.fn(async () => {
      state.stopped = true;
    });

    const handleChange = createDebouncedConfigHandler({
      name: "Late",
      getFilePath: () => configPath,
      processConfig,
      state,
      instanceId: "default",
      app
    });

    handleChange();
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(processConfig).toHaveBeenCalledTimes(1);
    expect(state.configContentHashes.Late).toBeUndefined();
  });

  test("suppresses error logging when stopped before the rejection is surfaced", async () => {
    const configPath = path.join(tmpDir, "err.json");
    const app = { debug: jest.fn(), error: jest.fn() };
    const state = { configDebounceTimers: {}, configContentHashes: {}, stopped: false };

    const handleChange = createDebouncedConfigHandler({
      name: "Err",
      getFilePath: () => configPath,
      processConfig: jest.fn().mockResolvedValue(undefined),
      state,
      instanceId: "default",
      app
    });

    handleChange();
    state.stopped = true;
    await new Promise((r) => setTimeout(r, FILE_WATCH_DEBOUNCE_DELAY + 50));

    expect(app.error).not.toHaveBeenCalled();
  });
});

describe("createWatcherWithRecovery", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "edge-link-watcher-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns a no-op handle when filePath is null", () => {
    const handle = createWatcherWithRecovery({
      filePath: null,
      onChange: jest.fn(),
      name: "Missing",
      instanceId: "default",
      app: { debug: jest.fn(), error: jest.fn() },
      state: {}
    });

    expect(handle.watcher).toBeNull();
    expect(() => handle.close()).not.toThrow();
  });

  test("creates a live watcher when the file exists", async () => {
    const file = path.join(tmpDir, "watch.json");
    await fs.promises.writeFile(file, "{}", "utf-8");
    const handle = createWatcherWithRecovery({
      filePath: file,
      onChange: jest.fn(),
      name: "Watch",
      instanceId: "default",
      app: { debug: jest.fn(), error: jest.fn() },
      state: {}
    });

    expect(handle.watcher).not.toBeNull();
    handle.close();
    expect(handle.watcher).toBeNull();
  });
});

describe("migrateLegacyConfigFiles", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "edge-link-migrate-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("is a no-op for non-default instance ids", async () => {
    const app = { debug: jest.fn(), error: jest.fn() };
    await migrateLegacyConfigFiles({
      instanceId: "secondary",
      dataDir: tmpDir,
      instanceDir: path.join(tmpDir, "instances/secondary"),
      app
    });
    expect(app.debug).not.toHaveBeenCalled();
    expect(app.error).not.toHaveBeenCalled();
  });

  test("moves legacy root files into instance directory exactly once", async () => {
    const instanceDir = path.join(tmpDir, "instances", "default");
    await fs.promises.mkdir(instanceDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(tmpDir, "delta_timer.json"),
      JSON.stringify({ deltaTimer: 1234 }),
      "utf-8"
    );

    const app = { debug: jest.fn(), error: jest.fn() };
    await migrateLegacyConfigFiles({
      instanceId: "default",
      dataDir: tmpDir,
      instanceDir,
      app
    });

    const migrated = await fs.promises.readFile(
      path.join(instanceDir, "delta_timer.json"),
      "utf-8"
    );
    expect(JSON.parse(migrated)).toEqual({ deltaTimer: 1234 });
    expect(app.error).not.toHaveBeenCalled();

    await migrateLegacyConfigFiles({
      instanceId: "default",
      dataDir: tmpDir,
      instanceDir,
      app
    });

    expect(app.error).not.toHaveBeenCalled();
  });
});

describe("initializePersistentStorage", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "edge-link-init-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates instance dir and default config files", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      getDataDirPath: () => tmpDir
    };
    const state = {
      deltaTimerFile: null,
      subscriptionFile: null,
      sentenceFilterFile: null,
      excludedSentences: []
    };

    await initializePersistentStorage({ instanceId: "default", app, state });

    expect(
      state.deltaTimerFile.endsWith(path.join("instances", "default", "delta_timer.json"))
    ).toBe(true);
    expect(
      state.subscriptionFile.endsWith(path.join("instances", "default", "subscription.json"))
    ).toBe(true);
    expect(
      state.sentenceFilterFile.endsWith(path.join("instances", "default", "sentence_filter.json"))
    ).toBe(true);

    const dt = JSON.parse(await fs.promises.readFile(state.deltaTimerFile, "utf-8"));
    expect(dt).toHaveProperty("deltaTimer");
    // On first run the default sentence_filter.json is written but
    // excludedSentences is only populated when an existing file is found.
    expect(state.excludedSentences).toEqual([]);
  });

  test("loads excludedSentences from an existing sentence_filter.json", async () => {
    const instanceDir = path.join(tmpDir, "instances", "custom");
    await fs.promises.mkdir(instanceDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(instanceDir, "sentence_filter.json"),
      JSON.stringify({ excludedSentences: ["GSV", "GLL"] }),
      "utf-8"
    );

    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      getDataDirPath: () => tmpDir
    };
    const state = {
      deltaTimerFile: null,
      subscriptionFile: null,
      sentenceFilterFile: null,
      excludedSentences: []
    };

    await initializePersistentStorage({ instanceId: "custom", app, state });

    expect(state.excludedSentences).toEqual(["GSV", "GLL"]);
  });
});
