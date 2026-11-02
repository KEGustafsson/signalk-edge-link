#!/usr/bin/env node
"use strict";

/**
 * Fleet sharing smoke test against real signalk-server processes.
 *
 * Starts a hub and two vessels as separate signalk-server instances with this
 * plugin linked in, feeds each vessel its own speedOverGround (with units
 * metadata) over its Signal K WebSocket, and checks over REST that:
 *
 *   - each vessel holds the other vessel's value and units,
 *   - each vessel's own value keeps its own source (no echo from the hub),
 *   - the hub holds both vessels, and fleet counters show no rejections.
 *
 * signalk-server is not a dependency of this repository. Install it anywhere
 * and pass its bin script:
 *
 *   npm install --prefix /tmp/sk signalk-server
 *   npm run build:ts
 *   node scripts/fleet-smoke.js /tmp/sk/node_modules/signalk-server/bin/signalk-server
 *
 * Exits 0 on success, 1 on any failed check. Uses HTTP ports 3100-3102 and UDP
 * port 24446; instance directories go under the OS temp directory.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const serverBin = process.argv[2];
if (!serverBin || !fs.existsSync(serverBin)) {
  console.error("usage: node scripts/fleet-smoke.js <path to signalk-server/bin/signalk-server>");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("Node 22 or later is required (global WebSocket).");
  process.exit(2);
}

const repo = path.resolve(__dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "edge-link-fleet-smoke-"));
const KEY = "Fl33tSm0keK3y-7hQ2mZ7vR4pW8nL1cY";
const HUB_UDP = 24446;
const client = (extra = {}) => ({
  name: "to-hub",
  serverType: "client",
  udpPort: HUB_UDP,
  udpAddress: "127.0.0.1",
  secretKey: KEY,
  protocolVersion: 3,
  fleetSharing: { enabled: true },
  ...extra
});
const NODES = [
  {
    name: "hub",
    http: 3100,
    mmsi: "999000999",
    connection: {
      name: "fleet-hub",
      serverType: "server",
      udpPort: HUB_UDP,
      secretKey: KEY,
      protocolVersion: 3,
      fleetSharing: { enabled: true, batchIntervalMs: 200 }
    }
  },
  { name: "vesselA", http: 3101, mmsi: "230000001", sog: 1.5, src: "gpsA", connection: client() },
  { name: "vesselB", http: 3102, mmsi: "230000002", sog: 2.5, src: "gpsB", connection: client() }
];

const children = [];
function cleanup() {
  for (const child of children) {
    try {
      process.kill(child.pid);
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

function startNode(n) {
  const dir = path.join(base, n.name);
  fs.mkdirSync(path.join(dir, "plugin-config-data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(repo, path.join(dir, "node_modules", "signalk-edge-link"));
  const write = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  write("package.json", {
    name: `sk-${n.name}`,
    version: "1.0.0",
    dependencies: { "signalk-edge-link": "*" }
  });
  write("settings.json", { interfaces: {}, port: n.http, pipedProviders: [] });
  write("baseDeltas.json", [
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "", value: { name: n.name, mmsi: n.mmsi } }] }]
    }
  ]);
  write("plugin-config-data/signalk-edge-link.json", {
    enabled: true,
    configuration: { connections: [n.connection] }
  });
  const log = fs.openSync(path.join(base, `${n.name}.log`), "a");
  children.push(
    spawn(process.execPath, [serverBin, "-c", dir], {
      env: { ...process.env, PORT: String(n.http) },
      stdio: ["ignore", log, log]
    })
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return res.json();
}
async function waitHttp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/signalk`)).ok) {
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`signalk-server on ${port} did not start; see logs in ${base}`);
}

function feed(n, seconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${n.http}/signalk/v1/stream?subscribe=none`);
    ws.onerror = () => reject(new Error(`WebSocket to ${n.name} failed`));
    ws.onopen = () => {
      let i = 0;
      const timer = setInterval(() => {
        ws.send(
          JSON.stringify({
            context: "vessels.self",
            updates: [
              {
                source: { label: n.src },
                timestamp: new Date().toISOString(),
                values: [{ path: "navigation.speedOverGround", value: n.sog }],
                ...(i === 0
                  ? { meta: [{ path: "navigation.speedOverGround", value: { units: "m/s" } }] }
                  : {})
              }
            ]
          })
        );
        if (++i >= seconds) {
          clearInterval(timer);
          ws.close();
          resolve();
        }
      }, 1000);
    };
  });
}

async function fleetMetrics(port) {
  const [conn] = await getJson(port, "/plugins/signalk-edge-link/connections");
  return (await getJson(port, `/plugins/signalk-edge-link/connections/${conn.id}/metrics`)).fleet;
}

async function main() {
  NODES.forEach(startNode);
  await Promise.all(NODES.map((n) => waitHttp(n.http)));
  await Promise.all(NODES.filter((n) => n.sog !== undefined).map((n) => feed(n, 8)));
  await sleep(3000);

  const failures = [];
  const check = (ok, message) => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${message}\n`);
    if (!ok) {
      failures.push(message);
    }
  };
  const [, a, b] = NODES;
  for (const [self, other] of [
    [a, b],
    [b, a]
  ]) {
    const vessels = await getJson(self.http, "/signalk/v1/api/vessels");
    const own = vessels[`urn:mrn:imo:mmsi:${self.mmsi}`]?.navigation?.speedOverGround;
    const theirs = vessels[`urn:mrn:imo:mmsi:${other.mmsi}`]?.navigation?.speedOverGround;
    check(theirs?.value === other.sog, `${self.name} has ${other.name}'s speed (${theirs?.value})`);
    check(
      theirs?.meta?.units === "m/s",
      `${self.name} has ${other.name}'s units (${theirs?.meta?.units})`
    );
    check(
      own?.$source?.startsWith(self.src) && own?.value === self.sog,
      `${self.name}'s own speed keeps its own source (${own?.$source})`
    );
    const fleet = await fleetMetrics(self.http);
    check(fleet?.state === "active", `${self.name} fleet state active (${fleet?.state})`);
    check(
      fleet?.contextsKnown === 1,
      `${self.name} knows exactly one fleet vessel (${fleet?.contextsKnown})`
    );
    check(
      fleet?.rejectedPackets === 0,
      `${self.name} rejected no fleet packets (${fleet?.rejectedPackets})`
    );
  }
  const hubVessels = await getJson(NODES[0].http, "/signalk/v1/api/vessels");
  check(
    [a, b].every((v) => hubVessels[`urn:mrn:imo:mmsi:${v.mmsi}`]),
    "hub holds both vessels"
  );
  const hubFleet = await fleetMetrics(NODES[0].http);
  check(hubFleet?.members === 2, `hub has two members (${hubFleet?.members})`);
  check(hubFleet?.identityConflicts === 0, "hub saw no identity conflicts");

  process.stdout.write(
    failures.length === 0
      ? "fleet smoke: OK\n"
      : `fleet smoke: ${failures.length} failed (logs: ${base})\n`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
