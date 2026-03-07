"use strict";

const fs = require("node:fs");
const path = require("node:path");

const schema = require("../schemas/config.schema.json");

function validateConnection(conn) {
  expect(["server", "client"]).toContain(conn.serverType);
  expect(typeof conn.udpPort).toBe("number");
  expect(conn.udpPort).toBeGreaterThanOrEqual(1024);
  expect(conn.udpPort).toBeLessThanOrEqual(65535);
  expect(typeof conn.secretKey).toBe("string");
  expect(conn.secretKey.length).toBe(32);
  if (conn.protocolVersion !== undefined) {
    expect([1, 2]).toContain(conn.protocolVersion);
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

  test("documentation schema remains aligned with runtime schema core constraints", () => {
    const docSchema = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "docs", "configuration-schema.json"), "utf8")
    );

    expect(docSchema.required).toContain("connections");
    expect(docSchema.properties.connections.type).toBe("array");

    const runtimeConnection = schema.definitions.connection.properties;
    const docConnection = docSchema.definitions.connection.properties;

    expect(docConnection.serverType.enum).toEqual(runtimeConnection.serverType.enum);
    expect(docConnection.udpPort.minimum).toBe(runtimeConnection.udpPort.minimum);
    expect(docConnection.udpPort.maximum).toBe(runtimeConnection.udpPort.maximum);
    expect(docConnection.secretKey.minLength).toBe(runtimeConnection.secretKey.minLength);
    expect(docConnection.secretKey.maxLength).toBe(runtimeConnection.secretKey.maxLength);

    expect(docSchema.properties.managementApiToken.minLength).toBe(
      schema.properties.managementApiToken.minLength
    );
    expect(docSchema.properties.managementApiToken.maxLength).toBe(
      schema.properties.managementApiToken.maxLength
    );
  });
});
