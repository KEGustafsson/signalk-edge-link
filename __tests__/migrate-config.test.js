"use strict";

const { migrateConfig } = require("../scripts/migrate-config");

describe("migrate-config", () => {
  test("keeps modern connections config unchanged", () => {
    const input = {
      connections: [
        {
          name: "alpha",
          serverType: "server",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          protocolVersion: 2
        }
      ],
      monitoringEnabled: true
    };

    expect(migrateConfig(input)).toEqual(input);
  });

  test("migrates legacy flat config into single connections entry", () => {
    const legacy = {
      name: "legacy",
      serverType: "client",
      udpPort: 4447,
      secretKey: "12345678901234567890123456789012",
      useMsgpack: true,
      usePathDictionary: false,
      protocolVersion: 2,
      monitoringEnabled: true
    };

    expect(migrateConfig(legacy)).toEqual({
      monitoringEnabled: true,
      connections: [
        {
          name: "legacy",
          serverType: "client",
          udpPort: 4447,
          secretKey: "12345678901234567890123456789012",
          useMsgpack: true,
          usePathDictionary: false,
          protocolVersion: 2
        }
      ]
    });
  });

  test("keeps non-connection configs unchanged", () => {
    expect(migrateConfig({ someOtherSetting: true })).toEqual({
      someOtherSetting: true
    });
  });

  test("does not inject optional flags when absent in legacy config", () => {
    expect(migrateConfig({
      serverType: "server",
      udpPort: 4446,
      secretKey: "12345678901234567890123456789012"
    })).toEqual({
      connections: [
        {
          name: "default",
          serverType: "server",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          protocolVersion: 1
        }
      ]
    });
  });


  test("throws when legacy config has partial connection fields", () => {
    expect(() => migrateConfig({ serverType: "client", udpPort: 4446 }))
      .toThrow("Legacy config must include secretKey as a 32-character string");
  });

  test("throws when legacy udpPort is out of range", () => {
    expect(() => migrateConfig({
      serverType: "server",
      udpPort: 80,
      secretKey: "12345678901234567890123456789012"
    })).toThrow("Legacy config must include udpPort as an integer between 1024 and 65535");
  });

  test("throws for non-object payload", () => {
    expect(() => migrateConfig(null)).toThrow("Expected plugin config object");
    expect(() => migrateConfig([])).toThrow("Expected plugin config object");
  });
});
