"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { main, createRequestJson } = require("../bin/edge-link-cli.ts");

describe("edge-link-cli", () => {
  test("help command resolves successfully", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  test("unknown command rejects", async () => {
    await expect(main(["nope"])).rejects.toThrow("Unknown command: nope");
  });

  test("migrate-config rejects when input file is missing", async () => {
    await expect(main(["migrate-config"])).rejects.toThrow("migrate-config requires <input.json>");
  });

  test("migrate-config converts legacy payload", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edge-link-cli-test-"));
    const inPath = path.join(tmpDir, "input.json");
    const outPath = path.join(tmpDir, "output.json");

    await fs.writeFile(
      inPath,
      JSON.stringify({
        serverType: "client",
        udpPort: 4446,
        secretKey: "12345678901234567890123456789012",
        udpAddress: "127.0.0.1",
        testAddress: "8.8.8.8",
        testPort: 53
      }),
      "utf8"
    );

    await expect(main(["migrate-config", inPath, outPath])).resolves.toBe(0);

    const migrated = JSON.parse(await fs.readFile(outPath, "utf8"));
    expect(migrated).toEqual({
      connections: [
        {
          name: "default",
          serverType: "client",
          udpPort: 4446,
          secretKey: "12345678901234567890123456789012",
          udpAddress: "127.0.0.1",
          testAddress: "8.8.8.8",
          testPort: 53,
          protocolVersion: 1
        }
      ]
    });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("instances list uses API request helper", async () => {
    const requestJson = jest.fn(() => [{ id: "alpha" }]);
    await expect(main(["instances", "list"], { requestJson })).resolves.toBe(0);
    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances",
      { token: null }
    );
  });

  test("instances list supports state/limit/page query options", async () => {
    const requestJson = jest.fn(() => []);

    await expect(
      main(["instances", "list", "--state=running", "--limit=5", "--page=2"], { requestJson })
    ).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances?state=running&limit=5&page=2",
      { token: null }
    );
  });

  test("instances list rejects invalid --limit", async () => {
    const requestJson = jest.fn(() => []);

    await expect(main(["instances", "list", "--limit=0"], { requestJson })).rejects.toThrow(
      "--limit must be a positive integer"
    );

    expect(requestJson).not.toHaveBeenCalled();
  });

  test("instances list rejects invalid --page", async () => {
    const requestJson = jest.fn(() => []);

    await expect(main(["instances", "list", "--page=abc"], { requestJson })).rejects.toThrow(
      "--page must be a positive integer"
    );

    expect(requestJson).not.toHaveBeenCalled();
  });

  test("instances list table mode supports paginated envelope responses", async () => {
    const requestJson = jest.fn(() => ({
      items: [
        {
          id: "alpha",
          name: "Alpha",
          state: "running",
          protocolVersion: 2,
          currentLink: "primary",
          metrics: { deltasSent: 7 }
        }
      ],
      pagination: { page: 2, totalPages: 4, total: 17, limit: 5 }
    }));
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(["instances", "list", "--limit=5", "--page=2", "--format=table"], { requestJson })
    ).resolves.toBe(0);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alpha"));
    expect(spy).toHaveBeenCalledWith("page 2/4 (total 17)");
    spy.mockRestore();
  });

  test("instances list supports table output", async () => {
    const requestJson = jest.fn(() => [
      {
        id: "alpha",
        name: "Alpha",
        state: "running",
        protocolVersion: 2,
        currentLink: "primary",
        metrics: { deltasSent: 7 }
      }
    ]);
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(main(["instances", "list", "--format=table"], { requestJson })).resolves.toBe(0);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("id"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alpha"));
    spy.mockRestore();
  });

  test("bonding status supports table output", async () => {
    const requestJson = jest.fn(() => ({
      instances: [{ id: "alpha", enabled: true, state: { activeLink: "primary", switchCount: 1 } }]
    }));
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(main(["bonding", "status", "--format", "table"], { requestJson })).resolves.toBe(
      0
    );

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("activeLink"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alpha"));
    spy.mockRestore();
  });

  test("rejects unsupported output format", async () => {
    const requestJson = jest.fn(() => []);
    await expect(main(["instances", "list", "--format=xml"], { requestJson })).rejects.toThrow(
      "--format must be 'json' or 'table'"
    );
  });

  test("forwards --token to request headers through requestJson options", async () => {
    const requestJson = jest.fn(() => [{ id: "alpha" }]);

    await expect(main(["instances", "list", "--token=abc123"], { requestJson })).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances",
      { token: "abc123" }
    );
  });

  test("uses SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN for CLI calls when --token is omitted", async () => {
    const original = process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN;
    process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN = "env-cli-token";

    try {
      const requestJson = jest.fn(() => ({ instances: [] }));
      await expect(main(["bonding", "status"], { requestJson })).resolves.toBe(0);
      expect(requestJson).toHaveBeenCalledWith(
        "http://localhost:3000/plugins/signalk-edge-link",
        "/bonding",
        { token: "env-cli-token" }
      );
    } finally {
      if (original === undefined) {
        delete process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN;
      } else {
        process.env.SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN = original;
      }
    }
  });

  test("instances show requires id", async () => {
    const requestJson = jest.fn();
    await expect(main(["instances", "show"], { requestJson })).rejects.toThrow(
      "instances show requires <id>"
    );
  });

  test("instances create reads config and POSTS payload", async () => {
    const requestJson = jest.fn(() => ({ ok: true }));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edge-link-cli-create-"));
    const configPath = path.join(tmpDir, "new-instance.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: "dock",
        serverType: "server",
        udpPort: 4450,
        secretKey: "12345678901234567890123456789012"
      }),
      "utf8"
    );

    await expect(
      main(["instances", "create", "--config", configPath], { requestJson })
    ).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances",
      {
        method: "POST",
        token: null,
        body: {
          name: "dock",
          serverType: "server",
          udpPort: 4450,
          secretKey: "12345678901234567890123456789012"
        }
      }
    );

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("instances update sends PUT with JSON patch", async () => {
    const requestJson = jest.fn(() => ({ ok: true }));

    await expect(
      main(["instances", "update", "alpha", "--patch", '{"udpAddress":"10.0.0.2"}'], {
        requestJson
      })
    ).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances/alpha",
      {
        method: "PUT",
        token: null,
        body: { udpAddress: "10.0.0.2" }
      }
    );
  });

  test("instances delete sends DELETE", async () => {
    const requestJson = jest.fn(() => ({ deleted: true }));
    await expect(main(["instances", "delete", "alpha"], { requestJson })).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/instances/alpha",
      { method: "DELETE", token: null }
    );
  });

  test("bonding status uses API request helper", async () => {
    const requestJson = jest.fn(() => ({ instances: [] }));
    await expect(
      main(["bonding", "status", "--baseUrl=http://example.test/plugins/signalk-edge-link"], {
        requestJson
      })
    ).resolves.toBe(0);
    expect(requestJson).toHaveBeenCalledWith(
      "http://example.test/plugins/signalk-edge-link",
      "/bonding",
      { token: null }
    );
  });

  test("status command uses API request helper", async () => {
    const requestJson = jest.fn(() => ({ totalInstances: 1, instances: [] }));
    await expect(
      main(["status", "--baseUrl=http://example.test/plugins/signalk-edge-link"], { requestJson })
    ).resolves.toBe(0);
    expect(requestJson).toHaveBeenCalledWith(
      "http://example.test/plugins/signalk-edge-link",
      "/status",
      { token: null }
    );
  });

  test("status command supports table output", async () => {
    const requestJson = jest.fn(() => ({
      instances: [{ id: "alpha", name: "Alpha", healthy: true, status: "running", lastError: null }]
    }));
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(main(["status", "--format", "table"], { requestJson })).resolves.toBe(0);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("healthy"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alpha"));
    spy.mockRestore();
  });

  test("bonding update sends POST with JSON patch", async () => {
    const requestJson = jest.fn(() => ({ updated: true }));
    await expect(
      main(["bonding", "update", "--patch", '{"failoverThreshold":300}'], { requestJson })
    ).resolves.toBe(0);

    expect(requestJson).toHaveBeenCalledWith(
      "http://localhost:3000/plugins/signalk-edge-link",
      "/bonding",
      {
        method: "POST",
        token: null,
        body: { failoverThreshold: 300 }
      }
    );
  });

  test("createRequestJson sends both custom token and bearer auth headers", async () => {
    const originalRequest = http.request;

    try {
      http.request = (url, options, callback) => {
        expect(options.headers["x-edge-link-token"]).toBe("secret-token");
        expect(options.headers.authorization).toBe("Bearer secret-token");

        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        });

        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        return req;
      };

      const requestJson = createRequestJson();
      await expect(
        requestJson("http://localhost:3000/plugins/signalk-edge-link", "/status", {
          token: "secret-token"
        })
      ).resolves.toEqual({ ok: true });
    } finally {
      http.request = originalRequest;
    }
  });

  test("help output includes table format for instances show", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["help"])).resolves.toBe(0);
    const output = spy.mock.calls[0] && spy.mock.calls[0][0] ? String(spy.mock.calls[0][0]) : "";
    expect(output).toContain(
      "instances show <id> [--baseUrl=<url>] [--token=<token>] [--format=json|table]"
    );
    expect(output).toContain(
      "instances list [--baseUrl=<url>] [--token=<token>] [--state=<value>] [--limit=<n>] [--page=<n>] [--format=json|table]"
    );
    expect(output).toContain(
      "edge-link-cli status [--baseUrl=<url>] [--token=<token>] [--format=json|table]"
    );
    spy.mockRestore();
  });
});
