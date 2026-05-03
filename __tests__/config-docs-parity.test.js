"use strict";

const fs = require("fs");
const path = require("path");
const { validateConnectionConfig } = require("../src/connection-config");

const repoRoot = path.join(__dirname, "..");
const samplesDir = path.join(repoRoot, "samples");
const sampleFiles = fs
  .readdirSync(samplesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join("samples", f));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

describe("documented configuration schema", () => {
  test("exposes management and udpMetaPort fields", () => {
    const schema = readJson("docs/configuration-schema.json");

    expect(schema.properties.managementApiToken).toBeDefined();
    expect(schema.properties.requireManagementApiToken).toBeDefined();
    expect(schema.definitions.connection.properties.udpMetaPort).toBeDefined();
  });
});

describe("sample configuration parity", () => {
  test.each(sampleFiles)("%s contains runtime-valid connections", (sampleFile) => {
    const sample = readJson(sampleFile);

    expect(Array.isArray(sample.connections)).toBe(true);
    expect(sample.connections.length).toBeGreaterThan(0);

    sample.connections.forEach((connection, index) => {
      expect(validateConnectionConfig(connection, `connections[${index}].`)).toBeNull();
    });
  });
});
