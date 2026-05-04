"use strict";

/**
 * Tests for array schema backward compatibility and the plugin coordinator.
 *
 * Verifies:
 * - slugify produces correct identifiers
 * - Legacy flat config is wrapped into connections[0] correctly
 * - Array config with multiple connections parses correctly
 * - Duplicate server port detection works
 * - Instance ID collision disambiguation works
 */

jest.mock(
  "ping-monitor",
  () =>
    jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      stop: jest.fn()
    })),
  { virtual: true }
);

const { slugify } = require("../lib/instance");
const {
  buildConnectionItemSchema,
  buildWebappConnectionSchema
} = require("../src/shared/connection-schema");

describe("shared connection schema", () => {
  function expectUdpMetaPortProperty(properties) {
    expect(properties.udpMetaPort).toMatchObject({
      type: "integer",
      title: "v1 Metadata UDP Port",
      minimum: 1024,
      maximum: 65535
    });
  }

  test("backend item schema exposes optional udpMetaPort", () => {
    const schema = buildConnectionItemSchema();

    expectUdpMetaPortProperty(schema.properties);
    expect(schema.required).not.toContain("udpMetaPort");
  });

  test("webapp connection schema exposes optional udpMetaPort", () => {
    const schema = buildWebappConnectionSchema(true, 1);

    expectUdpMetaPortProperty(schema.properties);
    expect(schema.required).not.toContain("udpMetaPort");
  });
});

// ── slugify ───────────────────────────────────────────────────────────────

describe("slugify (re-tested from schema perspective)", () => {
  const cases = [
    ["Shore Server", "shore-server"],
    ["sat-client", "sat-client"],
    ["My Connection #1", "my-connection-1"],
    ["  Spaces  ", "spaces"],
    ["LTE/4G Link", "lte-4g-link"],
    ["server", "server"],
    ["CLIENT", "client"]
  ];

  test.each(cases)("slugify(%s) === %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

// ── Instance ID collision disambiguation ──────────────────────────────────

describe("generateInstanceId collision disambiguation", () => {
  // Replicate the logic from index.js so we can unit-test it without
  // importing the full plugin.
  function generateInstanceId(name, usedIds) {
    const base = slugify(name || "connection");
    if (!usedIds.has(base)) {
      return base;
    }
    let n = 1;
    while (usedIds.has(`${base}-${n}`)) {
      n++;
    }
    return `${base}-${n}`;
  }

  test("first use of a name returns the plain slug", () => {
    const used = new Set();
    expect(generateInstanceId("shore-server", used)).toBe("shore-server");
  });

  test("second use of the same name gets -1 suffix", () => {
    const used = new Set(["shore-server"]);
    expect(generateInstanceId("shore-server", used)).toBe("shore-server-1");
  });

  test("third use increments to -2", () => {
    const used = new Set(["shore-server", "shore-server-1"]);
    expect(generateInstanceId("shore-server", used)).toBe("shore-server-2");
  });

  test("undefined name falls back to 'connection'", () => {
    const used = new Set();
    expect(generateInstanceId(undefined, used)).toBe("connection");
  });
});

// ── Legacy flat config wrapping ───────────────────────────────────────────

describe("legacy flat config detection", () => {
  function parseConnectionList(options) {
    if (Array.isArray(options.connections) && options.connections.length > 0) {
      return options.connections;
    } else if (options.serverType) {
      return [{ ...options, name: options.name || "default" }];
    }
    return null;
  }

  test("flat config with serverType=server is wrapped in array", () => {
    const opts = {
      serverType: "server",
      udpPort: 4446,
      secretKey: "a".repeat(32)
    };
    const list = parseConnectionList(opts);
    expect(list).toHaveLength(1);
    expect(list[0].serverType).toBe("server");
    expect(list[0].name).toBe("default");
  });

  test("flat config with serverType=client is wrapped in array", () => {
    const opts = {
      serverType: "client",
      udpPort: 4446,
      secretKey: "a".repeat(32),
      udpAddress: "192.168.1.1"
    };
    const list = parseConnectionList(opts);
    expect(list).toHaveLength(1);
    expect(list[0].udpAddress).toBe("192.168.1.1");
  });

  test("connections array is returned as-is", () => {
    const opts = {
      connections: [
        { name: "server1", serverType: "server", udpPort: 4446, secretKey: "a".repeat(32) },
        { name: "client1", serverType: "client", udpPort: 4447, secretKey: "b".repeat(32) }
      ]
    };
    const list = parseConnectionList(opts);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("server1");
    expect(list[1].name).toBe("client1");
  });

  test("options without serverType or connections returns null", () => {
    const list = parseConnectionList({});
    expect(list).toBeNull();
  });
});

// ── Duplicate port detection ──────────────────────────────────────────────

describe("duplicate server port detection", () => {
  function findDuplicatePorts(connectionList) {
    const serverPorts = connectionList
      .filter((c) => c.serverType === "server" || c.serverType === true)
      .map((c) => c.udpPort);
    return serverPorts.filter((p, i) => serverPorts.indexOf(p) !== i);
  }

  test("no duplicates when ports are unique", () => {
    const conns = [
      { serverType: "server", udpPort: 4446 },
      { serverType: "server", udpPort: 4447 }
    ];
    expect(findDuplicatePorts(conns)).toHaveLength(0);
  });

  test("detects duplicate server ports", () => {
    const conns = [
      { serverType: "server", udpPort: 4446 },
      { serverType: "server", udpPort: 4446 }
    ];
    expect(findDuplicatePorts(conns)).toContain(4446);
  });

  test("clients on same port as server are not flagged", () => {
    const conns = [
      { serverType: "server", udpPort: 4446 },
      { serverType: "client", udpPort: 4446 }
    ];
    expect(findDuplicatePorts(conns)).toHaveLength(0);
  });

  test("serverType=true is treated as server for port check", () => {
    const conns = [
      { serverType: true, udpPort: 4446 },
      { serverType: true, udpPort: 4446 }
    ];
    expect(findDuplicatePorts(conns)).toContain(4446);
  });
});
