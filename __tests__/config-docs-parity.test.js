"use strict";

const fs = require("fs");
const path = require("path");
const { validateConnectionConfig } = require("../src/connection-config");

const repoRoot = path.join(__dirname, "..");
// Enumerate the directory rather than listing files: a hardcoded list let
// samples/v2-with-bonding.json escape validation entirely (it was the only
// sample not listed, and it still used the removed protocolVersion 2).
const sampleFiles = fs
  .readdirSync(path.join(repoRoot, "samples"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => `samples/${f}`);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

describe("documented configuration schema", () => {
  test("exposes management fields", () => {
    const schema = readJson("docs/configuration-schema.json");

    expect(schema.properties.managementApiToken).toBeDefined();
    expect(schema.properties.requireManagementApiToken).toBeDefined();
  });

  test("does not reintroduce fields the runtime rejects/strips", () => {
    const schema = readJson("docs/configuration-schema.json");
    const connProps = schema.definitions.connection.properties;
    // These appeared in older documented schemas but are not accepted by the
    // runtime (udpMetaPort is not a config field; failoverThreshold/maxWindow
    // are not real bonding/congestion shapes).
    expect(connProps.udpMetaPort).toBeUndefined();
    expect(connProps.bonding.properties.failoverThreshold).toBeUndefined();
    expect(connProps.congestionControl.properties.maxWindow).toBeUndefined();
    // bonding.mode is main-backup only.
    expect(connProps.bonding.properties.mode.enum).toEqual(["main-backup"]);
  });

  test("documented schema examples are runtime-valid", () => {
    const schema = readJson("docs/configuration-schema.json");
    for (const example of schema.examples) {
      expect(Array.isArray(example.connections)).toBe(true);
      example.connections.forEach((connection, index) => {
        expect(validateConnectionConfig(connection, `connections[${index}].`)).toBeNull();
      });
    }
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
