"use strict";

const zlib = require("node:zlib");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");
const { createSourceRegistry } = require("../../lib/source-replication");

function makeMetricsApi() {
  const metrics = {
    startTime: Date.now(),
    deltasSent: 0,
    deltasReceived: 0,
    udpSendErrors: 0,
    udpRetries: 0,
    compressionErrors: 0,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    duplicatePackets: 0,
    dataPacketsReceived: 0,
    acksSent: 0,
    naksSent: 0,
    packetLoss: 0,
    bandwidth: {
      packetsOut: 0,
      packetsIn: 0,
      bytesOut: 0,
      bytesIn: 0,
      bytesOutRaw: 0,
      bytesInRaw: 0,
      rateOut: 0,
      rateIn: 0,
      compressionRatio: 1,
      history: { toArray: () => [] }
    }
  };

  return {
    metrics,
    recordError: jest.fn(),
    trackPathStats: jest.fn(),
    updateBandwidthRates: jest.fn()
  };
}

function buildDataPacket(sequence, payloadObj, key, protocolVersion = 2) {
  const builder = new PacketBuilder({ initialSequence: sequence, protocolVersion });
  const json = Buffer.from(JSON.stringify([payloadObj]));
  const compressed = zlib.brotliCompressSync(json);
  const encrypted = encryptBinary(compressed, key);
  return builder.buildDataPacket(encrypted, {
    compressed: true,
    encrypted: true
  });
}

function buildMetadataPacket(envelope, key, protocolVersion = 2) {
  const builder = new PacketBuilder({ protocolVersion });
  const json = Buffer.from(JSON.stringify(envelope));
  const compressed = zlib.brotliCompressSync(json);
  const encrypted = encryptBinary(compressed, key);
  return builder.buildMetadataPacket(encrypted, {
    compressed: true,
    encrypted: true
  });
}

describe("pipeline-v2-server", () => {
  const secretKey = "12345678901234567890123456789012";

  test("processes valid DATA packets and forwards decoded deltas", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();

    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const packet = buildDataPacket(
      0,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 4.2 }] }]
      },
      secretKey
    );

    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12000 });

    expect(app.handleMessage).toHaveBeenCalledTimes(1);
    expect(metricsApi.metrics.deltasReceived).toBe(1);
    expect(metricsApi.metrics.dataPacketsReceived).toBe(1);
  });

  test("replicates mixed source metadata into server registry", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const packet = buildDataPacket(
      1,
      {
        context: "vessels.self",
        updates: [
          {
            timestamp: "2026-04-27T00:00:00.000Z",
            source: { label: "ws.dev77.stream", type: "ws", sentence: "MWV" },
            values: [{ path: "environment.wind.speedApparent", value: 5.3 }]
          },
          {
            timestamp: "2026-04-27T00:00:01.000Z",
            $source: "n2k.204.5",
            source: { label: "N2K depth", type: "NMEA2000", pgn: 128267 },
            values: [{ path: "environment.depth.belowTransducer", value: 7.1 }]
          }
        ]
      },
      secretKey
    );

    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12005 });
    const snapshot = state.sourceRegistry.snapshot();
    expect(snapshot.size).toBe(2);
    expect(snapshot.legacy.byLabel["ws.dev77.stream"]).toBeDefined();
    expect(snapshot.legacy.bySourceRef["n2k.204.5"]).toBeDefined();
  });

  test("replicates source fields from DATA packets without requiring METADATA packets", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const packet = buildDataPacket(
      2,
      {
        context: "vessels.self",
        updates: [
          {
            source: { label: "raw-client-source", type: "NMEA0183", sentence: "RMC" },
            values: [{ path: "navigation.courseOverGroundTrue", value: 1.23 }]
          }
        ]
      },
      secretKey
    );

    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12006 });

    const snapshot = state.sourceRegistry.snapshot();
    expect(snapshot.size).toBe(1);
    expect(snapshot.sources[0].raw.source).toEqual({
      label: "raw-client-source",
      type: "NMEA0183",
      sentence: "RMC"
    });
  });

  test("HELLO sends exactly one META_REQUEST per client session", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const send = jest.fn((_pkt, _port, _addr, cb) => cb && cb(null));
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);
    const builder = new PacketBuilder({ protocolVersion: 2 });
    const parser = new PacketParser();
    const hello = builder.buildHelloPacket({
      clientId: "edge-a",
      capabilities: ["compression", "encryption", "reliability"]
    });
    const rinfo = { address: "127.0.0.1", port: 12008 };

    await pipeline.receivePacket(hello, secretKey, rinfo);
    await Promise.resolve();
    await Promise.resolve();
    await pipeline.receivePacket(hello, secretKey, rinfo);
    await Promise.resolve();
    await Promise.resolve();

    const metaRequests = send.mock.calls
      .map((call) => call[0])
      .filter((packet) => parser.parseHeader(packet).type === PacketType.META_REQUEST);

    expect(metaRequests).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.any(Buffer), 12008, "127.0.0.1", expect.any(Function));
  });

  test("rejects malformed source snapshot envelopes without mutating source tree", async () => {
    const root = {
      sources: {
        existing: { label: "existing", type: "test" }
      }
    };
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      signalk: { retrieve: jest.fn(() => root) }
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);
    const malformedSources = buildMetadataPacket(
      {
        v: 1,
        kind: "sources",
        seq: 0,
        idx: 0,
        total: 1,
        sources: ["not", "a", "source", "tree"]
      },
      secretKey
    );

    await pipeline.receivePacket(malformedSources, secretKey, {
      address: "127.0.0.1",
      port: 12009
    });

    expect(root.sources).toEqual({
      existing: { label: "existing", type: "test" }
    });
    expect(app.handleMessage).not.toHaveBeenCalled();
    expect(metricsApi.metrics.malformedPackets).toBe(1);
  });

  test("dispatches remote updates under their original source labels", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test",
      sourceRegistry: createSourceRegistry(app)
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const packet = buildDataPacket(
      3,
      {
        context: "vessels.self",
        updates: [
          {
            $source: "signalk-edge-link.HC",
            source: { label: "Arabella Compass", type: "NMEA0183", talker: "HC", sentence: "HDM" },
            values: [{ path: "navigation.headingMagnetic", value: 1.23 }]
          },
          {
            $source: "signalk-edge-link.AI",
            source: { label: "Arabella AIS", type: "NMEA0183", talker: "AI", sentence: "VDM" },
            values: [{ path: "navigation.position", value: { latitude: 60, longitude: 25 } }]
          }
        ]
      },
      secretKey
    );

    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12007 });

    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    expect(app.handleMessage.mock.calls.map((call) => call[0])).toEqual([
      "Arabella Compass",
      "Arabella AIS"
    ]);
    expect(app.handleMessage.mock.calls[0][1].updates).toHaveLength(1);
    expect(app.handleMessage.mock.calls[1][1].updates).toHaveLength(1);
    expect(app.handleMessage.mock.calls[0][1].updates[0].$source).toBeUndefined();
    expect(app.handleMessage.mock.calls[1][1].updates[0].$source).toBeUndefined();
  });

  test("marks duplicate DATA packets", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test"
    };
    const metricsApi = makeMetricsApi();

    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const packet = buildDataPacket(
      7,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.courseOverGroundTrue", value: 1.1 }] }]
      },
      secretKey
    );

    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12001 });
    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 12001 });

    expect(metricsApi.metrics.deltasReceived).toBe(1);
    expect(metricsApi.metrics.duplicatePackets).toBe(1);
  });

  test("schedules and sends NAK for detected missing sequences", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const send = jest.fn((_pkt, _port, _addr, cb) => cb && cb(null));
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: { send },
      instanceId: "test"
    };
    const metricsApi = makeMetricsApi();

    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const seq10 = buildDataPacket(
      10,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingTrue", value: 1.2 }] }]
      },
      secretKey
    );
    const seq12 = buildDataPacket(
      12,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingMagnetic", value: 1.3 }] }]
      },
      secretKey
    );

    await pipeline.receivePacket(seq10, secretKey, { address: "127.0.0.1", port: 12002 });
    await pipeline.receivePacket(seq12, secretKey, { address: "127.0.0.1", port: 12002 });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const parser = new PacketParser();
    const nakPackets = send.mock.calls
      .map((c) => c[0])
      .filter((pkt) => {
        try {
          return parser.parseHeader(pkt).type === PacketType.NAK;
        } catch (_e) {
          return false;
        }
      });

    expect(nakPackets.length).toBeGreaterThan(0);
    expect(metricsApi.metrics.naksSent).toBeGreaterThan(0);
  });

  test("signs v3 NAK packets so clients can authenticate them", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const send = jest.fn((_pkt, _port, _addr, cb) => cb && cb(null));
    const state = {
      options: {
        protocolVersion: 3,
        secretKey,
        reliability: { nakTimeout: 10 }
      },
      socketUdp: { send },
      instanceId: "test"
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const seq10 = buildDataPacket(
      10,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingTrue", value: 1.2 }] }]
      },
      secretKey,
      3
    );
    const seq12 = buildDataPacket(
      12,
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.headingMagnetic", value: 1.3 }] }]
      },
      secretKey,
      3
    );

    await pipeline.receivePacket(seq10, secretKey, { address: "127.0.0.1", port: 12002 });
    await pipeline.receivePacket(seq12, secretKey, { address: "127.0.0.1", port: 12002 });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const parser = new PacketParser({ secretKey });
    const nakPacket = send.mock.calls
      .map((c) => c[0])
      .find((pkt) => {
        try {
          return parser.parseHeader(pkt).type === PacketType.NAK;
        } catch (_e) {
          return false;
        }
      });

    expect(nakPacket).toBeDefined();
    expect(parser.parseNAKPayload(parser.parseHeader(nakPacket).payload)).toEqual([11]);
  });

  test("rejects forged v3 heartbeat packets", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: {
        protocolVersion: 3,
        secretKey,
        reliability: { nakTimeout: 10 }
      },
      socketUdp: { send: jest.fn((_pkt, _port, _addr, cb) => cb && cb(null)) },
      instanceId: "test"
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);

    const forgedHeartbeat = new PacketBuilder({
      protocolVersion: 3,
      secretKey: "6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536"
    }).buildHeartbeatPacket();

    await pipeline.receivePacket(forgedHeartbeat, secretKey, { address: "127.0.0.1", port: 12003 });

    expect(app.error).toHaveBeenCalledWith(
      "v2 authentication failed: packet tampered or wrong key"
    );
  });
});
