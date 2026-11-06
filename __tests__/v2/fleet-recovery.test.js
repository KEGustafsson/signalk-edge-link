"use strict";

/**
 * Fleet sharing client recovery (protocol-v3-spec §15.3, §15.5, §15.7): loss
 * on slow links, outages that swallow the HELLO answers, replays against the
 * inbound cap, and the learned-context set that keeps fleet data off the
 * uplink across restarts.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  secretKey,
  HUB_PORT,
  HUB_ADDR,
  wait,
  makeHub,
  makeClient,
  pump,
  sog,
  lastSog,
  deliverToHub,
  deliverToClient
} = require("../helpers/fleet-harness");
const { processDelta } = require("../../src/app/connection/process-delta");
const { LearnedContexts } = require("../../src/transport/pipeline/reliable-client/fleet-learned");
const { createFleetClientRuntime } = require("../../src/transport/pipeline/reliable-client/fleet");
const { ReplayWindow } = require("../../src/transport/reliability/replay-window");
const { FLEET_MAX_INBOUND_PACKETS_PER_SEC } = require("../../src/foundation/constants");

/** The client's metrics tick (fleet maintenance runs in it). */
function captureTick(c) {
  let tick = null;
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    tick = fn;
    return realSetInterval(fn, ms);
  };
  try {
    c.client.startMetricsPublishing();
  } finally {
    global.setInterval = realSetInterval;
  }
  return tick;
}

/** Every value `c` received for `context`, in arrival order. */
function valuesFor(c, context) {
  return c.bus.received
    .filter((d) => d.context === context)
    .flatMap((d) => d.updates.flatMap((u) => u.values));
}

describe("fleet client recovery", () => {
  let hub;
  let clients;
  let realNow;
  let offset;

  beforeEach(() => {
    realNow = Date.now;
    offset = 0;
    Date.now = () => realNow() + offset;
  });

  afterEach(() => {
    Date.now = realNow;
    hub?.server.stop();
    for (const c of clients || []) {
      c.client.stopMetricsPublishing();
      c.client.stop();
    }
  });

  async function connect(aOptions = {}) {
    hub = makeHub({ enabled: true, batchIntervalMs: 100 });
    const a = makeClient("230000001", 40001, { enabled: true }, aOptions);
    const b = makeClient("230000002", 40002);
    clients = [a, b];
    hub.server.startACKTimer();
    for (const c of clients) {
      await c.client.sendHello(HUB_ADDR, HUB_PORT);
    }
    await pump(hub, clients);
    expect(a.metricsApi.metrics.fleet.state).toBe("active");
    return { a, b };
  }

  test("data resuming after an outage that lost the HELLO answers makes the state active again", async () => {
    const { a, b } = await connect();
    const tick = captureTick(a);
    offset = 61000;
    // The downlink is down: every HELLO reaches the hub, no answer comes back.
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await a.client.sendHello(HUB_ADDR, HUB_PORT);
      } else {
        tick(); // the liveness re-HELLO
        await wait(5);
      }
      await deliverToHub(hub, a);
      hub.toClients.length = 0;
    }
    tick();
    expect(a.metricsApi.metrics.fleet.state).toBe("not-offered");
    // Still not-offered a minute later: the client asks again rather than
    // waiting for the 5-minute HELLO refresh.
    a.toHub.length = 0;
    offset += 61000;
    tick();
    await wait(5);
    expect(a.toHub.length).toBeGreaterThan(0);
    a.toHub.length = 0;
    // The downlink is back and the hub's data arrives on the current stream.
    await b.client.sendDelta([sog(b.self, 4.4)], secretKey, HUB_ADDR, HUB_PORT);
    await deliverToHub(hub, b);
    await wait(250);
    await deliverToClient(hub, a);
    expect(lastSog(a, b.self)).toBe(4.4);
    expect(a.metricsApi.metrics.fleet.state).toBe("active");
    // Maintenance no longer counts the unanswered HELLOs against it.
    tick();
    expect(a.metricsApi.metrics.fleet.state).toBe("active");
  });

  test("a keepalive for the current stream is acknowledged, so a lost confirmation is repeated", async () => {
    const { a } = await connect();
    const acks = a.metricsApi.metrics.fleet.acksSent;
    // The adopt FLEET_ACK may have been lost; a later keepalive HELLO_ACK
    // for the same stream must bring another FLEET_ACK.
    a.toHub.length = 0;
    offset += 21000;
    await wait(250);
    const keepalives = hub.toClients.filter((out) => out.port === a.port);
    expect(keepalives.length).toBeGreaterThan(0);
    await deliverToClient(hub, a);
    expect(a.metricsApi.metrics.fleet.acksSent).toBeGreaterThan(acks);
    expect(a.toHub.length).toBeGreaterThan(0);
  });

  test("a FLEET_DATA lost on a 700 ms round-trip link is recovered with default NAK timing", async () => {
    const { a, b } = await connect({ reliability: {} });
    await wait(300);
    await pump(hub, clients); // join snapshots
    const lost = sog(b.self, 4.4);
    lost.updates[0].values.push({ path: "navigation.headingTrue", value: 1.25 });
    await b.client.sendDelta([lost], secretKey, HUB_ADDR, HUB_PORT);
    await deliverToHub(hub, b);
    await wait(250);
    hub.toClients.length = 0; // lost on a's downlink
    await b.client.sendDelta([sog(b.self, 4.5)], secretKey, HUB_ADDR, HUB_PORT);
    await deliverToHub(hub, b);
    await wait(250);
    await deliverToClient(hub, a); // the next packet arrives: a gap, NAK timers start
    await wait(350); // the NAKs take 350 ms to reach the hub
    await deliverToHub(hub, a);
    await wait(350); // and the retransmit 350 ms to come back
    await deliverToClient(hub, a);
    const heading = valuesFor(a, b.self).find((v) => v.path === "navigation.headingTrue");
    expect(heading?.value).toBe(1.25);
    // The retransmit carried an older speed; it must not replace 4.5.
    expect(lastSog(a, b.self)).toBe(4.5);
    expect(a.metricsApi.metrics.fleet.naksSent).toBeGreaterThan(0);
  });

  test("replayed FLEET_DATA does not use up the inbound packet cap", async () => {
    const { a, b } = await connect();
    await b.client.sendDelta([sog(b.self, 4.4)], secretKey, HUB_ADDR, HUB_PORT);
    await deliverToHub(hub, b);
    await wait(250);
    const fleetData = hub.toClients.filter((out) => out.port === a.port);
    expect(fleetData.length).toBeGreaterThan(0);
    await deliverToClient(hub, a);
    const rejectedBefore = a.metricsApi.metrics.fleet.rejectedPackets;
    // An attacker floods the client with copies of a packet it already has.
    for (let i = 0; i < FLEET_MAX_INBOUND_PACKETS_PER_SEC + 50; i++) {
      await a.client.handleControlPacket(fleetData[0].pkt, { address: HUB_ADDR, port: HUB_PORT });
    }
    expect(a.metricsApi.metrics.fleet.rejectedPackets).toBe(rejectedBefore);
    // New data in the same second is still accepted.
    await b.client.sendDelta([sog(b.self, 4.6)], secretKey, HUB_ADDR, HUB_PORT);
    await deliverToHub(hub, b);
    await wait(250);
    await deliverToClient(hub, a);
    expect(lastSog(a, b.self)).toBe(4.6);
  });

  test("a new pipeline of the same instance keeps the vessels learned by the previous one", async () => {
    const { a, b } = await connect();
    await b.client.sendDelta([sog(b.self, 4.4)], secretKey, HUB_ADDR, HUB_PORT);
    await pump(hub, clients);
    await wait(250);
    await pump(hub, clients);
    expect(a.state.fleetLearnedContexts.has(b.self)).toBe(true);
    // Socket recovery or a connection restart builds a new runtime on the
    // same instance state; the local tree still holds vessel b.
    const runtime = createFleetClientRuntime(a.state, () => {});
    expect(runtime.learnedContexts.has(b.self)).toBe(true);
    // A values snapshot replay walks the tree and feeds processDelta; the
    // loop guard drops b before anything is queued for the uplink.
    const metrics = { loopDrops: 0 };
    processDelta(
      {
        state: { readyToSend: true, fleetLearnedContexts: runtime.learnedContexts },
        metrics: { fleet: metrics },
        options: {},
        appProxy: {},
        services: {}
      },
      sog(b.self, 4.4)
    );
    expect(metrics.loopDrops).toBe(1);
  });
});

describe("learned fleet contexts", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-learned-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("forgets a context not seen for the TTL", () => {
    const learned = new LearnedContexts(null, 1000, 10);
    learned.touch("vessels.a", 0);
    learned.touch("vessels.b", 500);
    learned.prune(1200);
    expect(learned.has("vessels.a")).toBe(false);
    expect(learned.has("vessels.b")).toBe(true);
  });

  test("evicts the least recently seen context past the cap", () => {
    const learned = new LearnedContexts(null, 1e9, 2);
    learned.touch("vessels.a", 0);
    learned.touch("vessels.b", 100_000);
    learned.touch("vessels.a", 200_000); // seen again: now the most recent
    learned.touch("vessels.c", 300_000);
    expect(learned.size).toBe(2);
    expect(learned.has("vessels.b")).toBe(false);
    expect(learned.has("vessels.a")).toBe(true);
    expect(learned.has("vessels.c")).toBe(true);
  });

  test("survives a restart through the instance's data file", async () => {
    const file = path.join(dir, "fleet-learned.json");
    const first = new LearnedContexts(file, 10_000, 10);
    first.touch("vessels.a", 1000);
    first.touch("vessels.b", 2000);
    await first.save(2000, true);
    const next = new LearnedContexts(file, 10_000, 10);
    next.load(11_500); // vessels.a is now past the TTL
    expect(next.has("vessels.a")).toBe(false);
    expect(next.has("vessels.b")).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  test("saves at most once per interval unless forced, and only after a change", async () => {
    const file = path.join(dir, "fleet-learned.json");
    const learned = new LearnedContexts(file, 1e9, 10);
    learned.touch("vessels.a", 100_000);
    await learned.save(100_000);
    learned.touch("vessels.b", 200_000);
    await learned.save(101_000); // changed, but within the interval
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).contexts)).toEqual(["vessels.a"]);
    await learned.save(101_000, true);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).contexts)).toEqual([
      "vessels.a",
      "vessels.b"
    ]);
  });

  test("a missing, garbled or hand-edited file leaves the set usable", () => {
    const file = path.join(dir, "fleet-learned.json");
    const missing = new LearnedContexts(file);
    missing.load(0);
    expect(missing.size).toBe(0);
    fs.writeFileSync(file, "{not json");
    const garbled = new LearnedContexts(file);
    garbled.load(0);
    expect(garbled.size).toBe(0);
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, contexts: { "vessels.a": "x", "vessels.b": 5 } })
    );
    const edited = new LearnedContexts(file, 1e9);
    edited.load(10);
    expect(edited.has("vessels.a")).toBe(false);
    expect(edited.has("vessels.b")).toBe(true);
  });

  test("a forced save waits for a save in flight and writes what changed since", async () => {
    const file = path.join(dir, "fleet-learned.json");
    const learned = new LearnedContexts(file, 1e9, 10);
    learned.touch("vessels.a", 100_000);
    const periodic = learned.save(100_000);
    // Learned while the periodic save is writing, then the connection stops.
    learned.touch("vessels.b", 200_000);
    await learned.save(200_000, true);
    await periodic;
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).contexts)).toEqual([
      "vessels.a",
      "vessels.b"
    ]);
  });

  test("a new runtime starts from the instance's saved file", async () => {
    const file = path.join(dir, "fleet-learned.json");
    const saved = new LearnedContexts(file);
    saved.touch("vessels.other", Date.now());
    await saved.save(Date.now(), true);
    // A fresh instance state, as after a plugin restart.
    const runtime = createFleetClientRuntime(
      { options: { fleetSharing: { enabled: true } } },
      () => {},
      file
    );
    expect(runtime.learnedContexts.has("vessels.other")).toBe(true);
  });

  test("a failed write is retried at the next save", async () => {
    const file = path.join(dir, "missing-dir", "fleet-learned.json");
    const learned = new LearnedContexts(file, 1e9, 10);
    learned.touch("vessels.a", 0);
    await learned.save(0, true);
    expect(fs.existsSync(file)).toBe(false);
    fs.mkdirSync(path.dirname(file));
    await learned.save(1, true);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("ReplayWindow.wouldAccept", () => {
  test("answers like accept without recording the sequence", () => {
    const window = new ReplayWindow();
    expect(window.wouldAccept(5)).toBe(true);
    expect(window.wouldAccept(5)).toBe(true);
    expect(window.accept(5)).toBe(true);
    expect(window.wouldAccept(5)).toBe(false);
    expect(window.wouldAccept(6)).toBe(true);
    expect(window.wouldAccept(3)).toBe(true);
    window.accept(3);
    expect(window.wouldAccept(3)).toBe(false);
    window.accept(5000);
    expect(window.wouldAccept(4)).toBe(false); // older than the window
  });
});

describe("fleet value staleness bound", () => {
  const {
    dispatchFleetDeltas,
    MAX_TRACKED_VALUE_TIMES
  } = require("../../src/transport/pipeline/reliable-client/fleet-dispatch");

  test("past the bound the quietest path is forgotten, not every path", () => {
    const applied = [];
    const ctx = {
      app: { debug: () => {}, handleMessage: (_id, delta) => applied.push(delta) },
      metricsApi: { metrics: {} }
    };
    const fleet = {
      self: "vessels.me",
      pathFilter: null,
      appliedTimes: new Map(),
      learnedContexts: new LearnedContexts(null)
    };
    const delta = (context, path, at, value) => ({
      context,
      updates: [
        { $source: "gps", timestamp: new Date(at).toISOString(), values: [{ path, value }] }
      ]
    });
    dispatchFleetDeltas(ctx, fleet, [delta("vessels.busy", "navigation.speedOverGround", 5000, 2)]);
    // Fill the bound with other paths; the busy path keeps updating.
    for (let i = 0; i < MAX_TRACKED_VALUE_TIMES; i++) {
      const deltas = [delta(`vessels.t${i}`, "navigation.speedOverGround", 1000, i)];
      if (i % 1000 === 0) {
        deltas.push(delta("vessels.busy", "navigation.speedOverGround", 5000 + i, 3));
      }
      dispatchFleetDeltas(ctx, fleet, deltas);
    }
    expect(fleet.appliedTimes.size).toBe(MAX_TRACKED_VALUE_TIMES);
    // The busy path is still protected: a late retransmit of an old value is refused.
    applied.length = 0;
    dispatchFleetDeltas(ctx, fleet, [delta("vessels.busy", "navigation.speedOverGround", 4000, 1)]);
    expect(applied).toHaveLength(0);
    expect(ctx.metricsApi.metrics.fleet.staleValues).toBe(1);
  });
});

describe("fleet lifecycle", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lifecycle-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stopping the server ends its subscription, timer and state, even if an unsubscribe throws", async () => {
    const hub = makeHub({ enabled: true, batchIntervalMs: 100 });
    const a = makeClient("230000001", 40001);
    const b = makeClient("230000002", 40002);
    const clients = [a, b];
    // The fleet subscription is taken when sharing starts; make the first
    // unsubscribe it registers throw.
    const manager = hub.bus.app.subscriptionmanager;
    const subscribe = manager.subscribe;
    manager.subscribe = (sub, unsubscribes, onError, onDelta) => {
      unsubscribes.push(() => {
        throw new Error("unsubscribe failed");
      });
      subscribe(sub, unsubscribes, onError, onDelta);
    };
    try {
      hub.server.startACKTimer();
      for (const c of clients) {
        await c.client.sendHello(HUB_ADDR, HUB_PORT);
      }
      await pump(hub, clients);
      expect(hub.bus.subscribers.length).toBeGreaterThan(0);
      expect(hub.metricsApi.metrics.fleet.state).toBe("active");
      hub.server.stop();
      expect(hub.bus.subscribers).toHaveLength(0);
      expect(hub.metricsApi.metrics.fleet.state).toBe("disabled");
      hub.toClients.length = 0;
      hub.bus.app.handleMessage("local", sog(b.self, 9.9));
      await wait(250);
      expect(hub.toClients).toHaveLength(0);
    } finally {
      hub.server.stop();
      for (const c of clients) {
        c.client.stop();
      }
    }
  });

  test("stopping the client clears its ACK timer and saves what it learned", async () => {
    const instanceDir = path.join(dir, "instances", "client-40001");
    fs.mkdirSync(instanceDir, { recursive: true });
    const hub = makeHub({ enabled: true, batchIntervalMs: 100 });
    const a = makeClient("230000001", 40001, { enabled: true }, {}, { getDataDirPath: () => dir });
    const b = makeClient("230000002", 40002);
    const clients = [a, b];
    try {
      hub.server.startACKTimer();
      for (const c of clients) {
        await c.client.sendHello(HUB_ADDR, HUB_PORT);
      }
      await pump(hub, clients);
      await b.client.sendDelta([sog(b.self, 4.4)], secretKey, HUB_ADDR, HUB_PORT);
      await deliverToHub(hub, b);
      await wait(250);
      await deliverToClient(hub, a); // FLEET_DATA arrives; an ACK is now scheduled
      a.toHub.length = 0;
      a.client.stop();
      await wait(300);
      expect(a.toHub).toHaveLength(0);
      const saved = JSON.parse(
        fs.readFileSync(path.join(instanceDir, "fleet-learned.json"), "utf-8")
      );
      expect(Object.keys(saved.contexts)).toEqual([b.self]);
    } finally {
      hub.server.stop();
      for (const c of clients) {
        c.client.stop();
      }
    }
  });
});
