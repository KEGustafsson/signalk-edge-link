"use strict";

const zlib = require("node:zlib");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server.ts");
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet.ts");
const { encryptBinary } = require("../../lib/crypto.ts");

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
      instanceId: "test"
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
      secretKey: "abcdefghijklmnopqrstuvwxyz123456"
    }).buildHeartbeatPacket();

    await pipeline.receivePacket(forgedHeartbeat, secretKey, { address: "127.0.0.1", port: 12003 });

    expect(app.error).toHaveBeenCalledWith(
      "v2 authentication failed: packet tampered or wrong key"
    );
  });
});
