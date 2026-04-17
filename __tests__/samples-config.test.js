"use strict";

const fs = require("node:fs");
const path = require("node:path");

function validateConnection(conn) {
  expect(["server", "client"]).toContain(conn.serverType);
  expect(typeof conn.udpPort).toBe("number");
  expect(conn.udpPort).toBeGreaterThanOrEqual(1024);
  expect(conn.udpPort).toBeLessThanOrEqual(65535);
  expect(typeof conn.secretKey).toBe("string");
  expect(conn.secretKey.length).toBe(32);
  if (conn.protocolVersion !== undefined) {
    expect([1, 2, 3]).toContain(conn.protocolVersion);
  }
}

describe("sample configurations", () => {
  const samplesDir = path.join(__dirname, "..", "samples");

  test("all sample config files parse and include at least one connection", () => {
    const files = fs.readdirSync(samplesDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const file of files) {
      const payload = JSON.parse(fs.readFileSync(path.join(samplesDir, file), "utf8"));
      expect(Array.isArray(payload.connections)).toBe(true);
      expect(payload.connections.length).toBeGreaterThan(0);
      payload.connections.forEach(validateConnection);
    }
  });
});
