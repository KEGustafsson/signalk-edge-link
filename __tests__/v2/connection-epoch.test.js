"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveMonotonicEpoch } = require("../../lib/transport/reliability/connection-epoch");

describe("resolveMonotonicEpoch", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-epoch-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns ~now and persists on the first call", async () => {
    const file = path.join(dir, "replay_epoch.json");
    const before = Date.now();
    const e = await resolveMonotonicEpoch(file);
    expect(e).toBeGreaterThanOrEqual(before);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.epoch).toBe(e);
  });

  test("advances strictly on each (re)start", async () => {
    const file = path.join(dir, "replay_epoch.json");
    const e1 = await resolveMonotonicEpoch(file);
    const e2 = await resolveMonotonicEpoch(file);
    expect(e2).toBeGreaterThan(e1);
  });

  test("stays monotonic when the clock goes backwards (RTC-less reboot)", async () => {
    const file = path.join(dir, "replay_epoch.json");
    // A previously-persisted epoch far ahead of the current clock models a
    // device whose wall clock has since stepped backwards across a reboot.
    const future = Date.now() + 1_000_000_000;
    fs.writeFileSync(file, JSON.stringify({ epoch: future }));
    const e = await resolveMonotonicEpoch(file);
    expect(e).toBe(future + 1); // strictly greater than the stored value
  });

  test("falls back to Date.now() when no persistence path is given", async () => {
    const before = Date.now();
    const e = await resolveMonotonicEpoch(null);
    expect(e).toBeGreaterThanOrEqual(before);
  });

  test("ignores a corrupt store and still advances", async () => {
    const file = path.join(dir, "replay_epoch.json");
    fs.writeFileSync(file, "{ not valid json");
    const before = Date.now();
    const e = await resolveMonotonicEpoch(file);
    expect(e).toBeGreaterThanOrEqual(before);
  });
});
