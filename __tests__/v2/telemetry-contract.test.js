"use strict";

/**
 * The client→server telemetry contract, checked against both real ends.
 *
 * Every value a server reports for a remote peer — RTT, jitter, packet loss,
 * retransmissions, queue depth, retransmit rate, active link — arrives as a
 * Signal K delta published by the client and matched by path on the server.
 * Nothing type-checks across that boundary: the publisher builds path strings
 * and the receiver looks them up in a Set and a table. A rename on either side
 * is a silent, total loss of telemetry, and the symptom is a dashboard reading
 * "N/A" forever rather than an error anywhere.
 *
 * That is exactly how instance-scoped publishing (`networking.edgeLink.<id>.*`,
 * used by every multi-connection/proxy deployment) went unnoticed: the paths
 * never matched, and the per-path tests all hard-coded the unscoped form, so
 * they stayed green against a broken link.
 *
 * These tests therefore derive the published paths from the real
 * MetricsPublisher rather than restating them, and assert the two ends agree.
 */

const { MetricsPublisher } = require("../../lib/transport/metrics/publisher");

/** Every metric the publisher knows how to emit, so no path is missed. */
const FULL_METRICS = {
  rtt: 42,
  jitter: 3.5,
  packetLoss: 0.01,
  retransmitRate: 0.02,
  retransmissions: 5,
  queueDepth: 2,
  sequenceNumber: 9,
  activeLink: "primary",
  compressionRatio: 80,
  // Flat field names, matching what the publisher actually reads. Nested
  // `bandwidth`/`packetsPerSecond` objects were silently ignored, so the four
  // paths below were never emitted and the "every metric" claim above was
  // false for them.
  uploadBandwidth: 1024,
  downloadBandwidth: 2048,
  packetsSentPerSec: 3,
  packetsReceivedPerSec: 4
};

function publishedPaths(pathPrefix) {
  const emitted = [];
  const app = { handleMessage: (_id, delta) => emitted.push(delta), debug: () => {} };
  new MetricsPublisher(app, { pathPrefix }).publish(FULL_METRICS);
  return emitted.flatMap((d) => d.updates.flatMap((u) => u.values));
}

/**
 * Published but deliberately NOT consumed as authoritative telemetry.
 *
 * `linkQuality` is recomputed by the receiver from the ingested inputs, so
 * accepting the client's own score would give two disagreeing sources for one
 * number. The rest are informational, and the receiver measures its own side
 * of each: it counts the bytes and packets it actually received.
 *
 * Listing them explicitly is the point: a newly published path that is neither
 * ingested nor named here fails the test, forcing the decision to be made
 * rather than defaulted.
 *
 * Stored unprefixed and joined with the prefix under test, so the exemptions
 * still apply to an instance-scoped prefix such as
 * `networking.edgeLink.boat-1`.
 */
const INTENTIONALLY_NOT_INGESTED = [
  "linkQuality",
  "sequenceNumber",
  "compressionRatio",
  "bandwidth.upload",
  "bandwidth.download",
  "packetsPerSecond.sent",
  "packetsPerSecond.received"
];

const exemptPaths = (prefix) =>
  new Set(INTENTIONALLY_NOT_INGESTED.map((name) => `${prefix}.${name}`));

// The receiver's path set is module-private, so assert the contract through
// observable behaviour instead: drive real published values into a real server
// and require each one to land in remoteNetworkQuality.
describe("telemetry survives the real publish → ingest round trip", () => {
  const zlib = require("zlib");
  const { promisify } = require("util");
  const brotliCompressAsync = promisify(zlib.brotliCompress);
  const { PacketBuilder } = require("../../lib/packet");
  const { encryptBinary } = require("../../lib/crypto");
  const createMetrics = require("../../lib/metrics");
  const { createPipeline } = require("../../lib/pipeline-factory");

  const SECRET_KEY = "12345678901234567890123456789012";

  function makeServer() {
    const app = { debug: () => {}, error: () => {}, handleMessage: () => {} };
    const state = {
      options: {
        secretKey: SECRET_KEY,
        udpPort: 12345,
        protocolVersion: 3,
        authenticatedHeaders: false,
        useMsgpack: false,
        usePathDictionary: false,
        reliability: {}
      },
      socketUdp: { send: (b, p, a, cb) => cb && cb(null) },
      instanceId: null
    };
    const metricsApi = createMetrics();
    return { pipeline: createPipeline(2, "server", app, state, metricsApi), metricsApi };
  }

  async function encrypted(payload, builder) {
    const compressed = await brotliCompressAsync(Buffer.from(JSON.stringify(payload)));
    return builder.buildDataPacket(encryptBinary(compressed, SECRET_KEY), {
      compressed: true,
      encrypted: true,
      messagepack: false,
      pathDictionary: false
    });
  }

  async function ingestWithApp(values, rinfo) {
    const dispatched = [];
    const app = {
      debug: () => {},
      error: () => {},
      handleMessage: (_id, delta) => dispatched.push(delta)
    };
    const state = {
      options: {
        secretKey: SECRET_KEY,
        udpPort: 12345,
        protocolVersion: 3,
        authenticatedHeaders: false,
        useMsgpack: false,
        usePathDictionary: false,
        reliability: {}
      },
      socketUdp: { send: (b, p, a, cb) => cb && cb(null) },
      instanceId: null
    };
    const metricsApi = createMetrics();
    const pipeline = createPipeline(2, "server", app, state, metricsApi);
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET_KEY });
    await pipeline.receivePacket(
      builder.buildHelloPacket({ clientId: "peer", instanceId: "peer" }),
      SECRET_KEY,
      rinfo
    );
    const b2 = new PacketBuilder({
      protocolVersion: 3,
      secretKey: SECRET_KEY,
      initialSequence: 700
    });
    await pipeline.receivePacket(
      await encrypted(
        [
          {
            context: "vessels.self",
            updates: [
              {
                source: { label: "signalk-edge-link-client-telemetry", type: "plugin" },
                timestamp: new Date().toISOString(),
                values
              }
            ]
          }
        ],
        b2
      ),
      SECRET_KEY,
      rinfo
    );
    return { dispatched, metrics: metricsApi.metrics };
  }

  async function ingest(values, rinfo) {
    const { pipeline, metricsApi } = makeServer();
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET_KEY });
    await pipeline.receivePacket(
      builder.buildHelloPacket({ clientId: "peer", instanceId: "peer" }),
      SECRET_KEY,
      rinfo
    );
    const b2 = new PacketBuilder({
      protocolVersion: 3,
      secretKey: SECRET_KEY,
      initialSequence: 500
    });
    const delta = [
      {
        context: "vessels.self",
        updates: [
          {
            source: { label: "signalk-edge-link-client-telemetry", type: "plugin" },
            timestamp: new Date().toISOString(),
            values
          }
        ]
      }
    ];
    await pipeline.receivePacket(await encrypted(delta, b2), SECRET_KEY, rinfo);
    return metricsApi.metrics.remoteNetworkQuality;
  }

  // Both prefixes must behave identically. The unscoped form is what a
  // single-connection client sends; the scoped form is what every proxy sends,
  // and it was silently discarded.
  for (const [label, prefix] of [
    ["single-connection (unscoped)", "networking.edgeLink"],
    ["multi-connection (instance-scoped)", "networking.edgeLink.boat-1"]
  ]) {
    test(`${label} telemetry populates every ingested field`, async () => {
      const values = publishedPaths(prefix);
      const remote = await ingest(values, {
        address: prefix.includes("boat-1") ? "10.9.0.2" : "10.9.0.1",
        port: 9500
      });

      expect(remote.lastUpdate).toBeGreaterThan(0);
      expect(remote.rtt).toBe(42);
      expect(remote.jitter).toBe(3.5);
      expect(remote.packetLoss).toBeCloseTo(0.01);
      expect(remote.retransmissions).toBe(5);
      expect(remote.queueDepth).toBe(2);
      expect(remote.retransmitRate).toBeCloseTo(0.02);
      expect(remote.activeLink).toBe("primary");
    });
  }

  test("every published path is either ingested or explicitly exempt", async () => {
    const prefix = "networking.edgeLink";
    const values = publishedPaths(prefix);
    const remote = await ingest(values, { address: "10.9.0.3", port: 9600 });

    // Fields the accumulator gained from this publish.
    const ingestedPaths = new Set(
      [
        ["rtt", remote.rtt],
        ["jitter", remote.jitter],
        ["packetLoss", remote.packetLoss],
        ["retransmissions", remote.retransmissions],
        ["queueDepth", remote.queueDepth],
        ["retransmitRate", remote.retransmitRate],
        ["activeLink", remote.activeLink]
      ]
        .filter(([, v]) => v !== undefined)
        .map(([k]) => `${prefix}.${k}`)
    );

    const exempt = exemptPaths(prefix);
    const unaccounted = values
      .map((v) => v.path)
      .filter((p) => !ingestedPaths.has(p) && !exempt.has(p));

    // A new published metric must be wired into the receiver or listed as
    // deliberately local — not silently dropped on the wire.
    expect(unaccounted).toEqual([]);
  });

  // The peer's telemetry belongs in remoteNetworkQuality, not in this node's
  // own Signal K tree. The unconsumed paths used to be forwarded there, which
  // put the peer's linkQuality on `networking.edgeLink.linkQuality` — the same
  // path this node publishes for its own link, separated only by $source.
  test("no telemetry value reaches the receiver's own Signal K tree", async () => {
    const values = publishedPaths("networking.edgeLink");
    const { dispatched, metrics } = await ingestWithApp(values, {
      address: "10.9.0.4",
      port: 9700
    });

    // The ingested figures still land — the update was consumed, not lost.
    expect(metrics.remoteNetworkQuality.rtt).toBe(42);

    const leaked = dispatched
      .flatMap((d) => (d.updates || []).flatMap((u) => u.values || []))
      .map((v) => v.path)
      .filter((p) => typeof p === "string" && p.startsWith("networking.edgeLink"));
    expect(leaked).toEqual([]);
  });
});
