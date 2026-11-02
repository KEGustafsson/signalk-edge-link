"use strict";

/**
 * fleetSharing configuration (protocol-v3-spec §15): runtime validation,
 * sanitization and schema exposure in both modes.
 */

const { validateConnectionConfig, sanitizeConnectionConfig } = require("../src/connection-config");
const {
  buildConnectionItemSchema,
  buildWebappConnectionSchema
} = require("../src/shared/connection-schema");
const { resolveFleetConfig } = require("../src/transport/fleet/common");

const KEY = "12345678901234567890123456789012";

function server(fleetSharing, extra = {}) {
  return {
    serverType: "server",
    udpPort: 4446,
    secretKey: KEY,
    protocolVersion: 3,
    fleetSharing,
    ...extra
  };
}

function client(fleetSharing, extra = {}) {
  return {
    serverType: "client",
    udpPort: 4446,
    udpAddress: "hub.example.net",
    secretKey: KEY,
    protocolVersion: 3,
    fleetSharing,
    ...extra
  };
}

describe("fleetSharing validation", () => {
  test("accepts the documented server and client shapes", () => {
    expect(
      validateConnectionConfig(
        server({
          enabled: true,
          scope: "all",
          includeServerVessel: true,
          pathFilter: { allow: ["navigation.*"], deny: [] },
          maxBytesPerSec: 4096,
          batchIntervalMs: 500
        })
      )
    ).toBeNull();
    expect(
      validateConnectionConfig(
        client({ enabled: true, pathFilter: { deny: ["design.*"] }, maxBytesPerSec: 1024 })
      )
    ).toBeNull();
  });

  test.each([
    [server("yes"), /fleetSharing must be an object/],
    [server({ enabled: "true" }), /fleetSharing.enabled must be a boolean/],
    [server({ scope: "everyone" }), /scope must be 'fleet' or 'all'/],
    [server({ includeServerVessel: 1 }), /includeServerVessel must be a boolean/],
    [server({ maxBytesPerSec: 10 }), /maxBytesPerSec must be an integer between 256 and 1048576/],
    [server({ batchIntervalMs: 50 }), /batchIntervalMs must be an integer between 100 and 10000/],
    [server({ pathFilter: { allow: [""] } }), /pathFilter.allow\[0\] must be a non-empty string/],
    [server({ pathFilter: { only: [] } }), /pathFilter.only is not a supported property/],
    [server({ bogus: true }), /fleetSharing.bogus is not a supported property/],
    [client({ scope: "all" }), /fleetSharing.scope is only supported in server mode/],
    [client({ batchIntervalMs: 500 }), /batchIntervalMs is only supported in server mode/],
    [server({ enabled: true }, { protocolVersion: 1 }), /fleetSharing requires protocolVersion 3/],
    [
      server({ enabled: true }, { protocolVersion: "basic" }),
      /fleetSharing requires protocolVersion 3/
    ],
    [
      client({ enabled: true }, { bonding: { enabled: true } }),
      /fleetSharing is not supported together with bonding/
    ]
  ])("rejects %j", (conn, message) => {
    expect(validateConnectionConfig(conn)).toMatch(message);
  });

  test("disabled fleet sharing is accepted on v1 and with bonding", () => {
    expect(validateConnectionConfig(server({ enabled: false }, { protocolVersion: 1 }))).toBeNull();
  });

  test("sanitize keeps fleetSharing", () => {
    expect(sanitizeConnectionConfig(server({ enabled: true })).fleetSharing).toEqual({
      enabled: true
    });
  });
});

describe("fleetSharing schema", () => {
  test("server and client branches expose mode-appropriate fields", () => {
    const item = buildConnectionItemSchema();
    const [serverBranch, clientBranch] = item.dependencies.serverType.oneOf;
    expect(Object.keys(serverBranch.properties.fleetSharing.properties)).toEqual(
      expect.arrayContaining(["enabled", "scope", "includeServerVessel", "batchIntervalMs"])
    );
    expect(clientBranch.properties.fleetSharing.properties.scope).toBeUndefined();
    expect(clientBranch.properties.fleetSharing.properties.batchIntervalMs).toBeUndefined();
  });

  test("UI schema offers fleetSharing on reliable connections only", () => {
    expect(buildWebappConnectionSchema(false, 3).properties.fleetSharing).toBeDefined();
    expect(buildWebappConnectionSchema(true, 3).properties.fleetSharing).toBeDefined();
    expect(buildWebappConnectionSchema(true, 1).properties.fleetSharing).toBeUndefined();
  });
});

describe("plugin schema JSON safety", () => {
  test("contains no object referenced twice (signalk plugin schema check)", () => {
    const seen = new WeakSet();
    const repeated = [];
    const walk = (node, path) => {
      if (node === null || typeof node !== "object") {
        return;
      }
      if (seen.has(node)) {
        repeated.push(path);
        return;
      }
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        walk(value, `${path}.${key}`);
      }
    };
    walk(buildConnectionItemSchema(), "item");
    expect(repeated).toEqual([]);
  });
});

describe("resolveFleetConfig", () => {
  test("applies defaults and clamps out-of-range values", () => {
    expect(resolveFleetConfig({ enabled: true })).toEqual({
      scope: "fleet",
      includeServerVessel: false,
      pathFilter: null,
      maxBytesPerSec: 8192,
      batchIntervalMs: 1000
    });
    const clamped = resolveFleetConfig({
      maxBytesPerSec: 1,
      batchIntervalMs: 999999,
      scope: "all"
    });
    expect(clamped.maxBytesPerSec).toBe(256);
    expect(clamped.batchIntervalMs).toBe(10000);
    expect(clamped.scope).toBe("all");
  });
});
