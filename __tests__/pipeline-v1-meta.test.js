"use strict";

const zlib = require("node:zlib");
const createPipeline = require("../lib/pipeline");
const { encryptBinary } = require("../lib/crypto");

function makeMetricsApi() {
  const metrics = {
    startTime: Date.now(),
    deltasSent: 0,
    deltasReceived: 0,
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
    },
    smartBatching: {
      avgBytesPerDelta: 0,
      maxDeltasPerBatch: 0,
      oversizedPackets: 0,
      earlySends: 0,
      timerSends: 0
    }
  };
  return {
    metrics,
    recordError: jest.fn(),
    trackPathStats: jest.fn(),
    updateBandwidthRates: jest.fn()
  };
}

function makeEncryptedMeta(envelope, secretKey, { withMagic = true, useMsgpack = false } = {}) {
  const serialized = useMsgpack
    ? Buffer.from(require("@msgpack/msgpack").encode(envelope))
    : Buffer.from(JSON.stringify(envelope));
  const plaintext = withMagic
    ? Buffer.concat([Buffer.from("SKM1", "ascii"), serialized])
    : serialized;
  const compressed = zlib.brotliCompressSync(plaintext);
  return encryptBinary(compressed, secretKey);
}

describe("v1 pipeline.unpackDecryptMeta", () => {
  const secretKey = "12345678901234567890123456789012";

  function makeHarness() {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: {
        secretKey,
        udpPort: 5000,
        udpMetaPort: 5001,
        serverType: "server",
        useMsgpack: false,
        usePathDictionary: false,
        stretchAsciiKey: false
      },
      socketUdp: null
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipeline(app, state, metricsApi);
    return { app, state, metricsApi, pipeline };
  }

  test("decrypts a SKM1-prefixed payload and dispatches deltas with updates[].meta[]", async () => {
    const { app, pipeline, metricsApi } = makeHarness();
    const envelope = {
      v: 1,
      kind: "snapshot",
      seq: 0,
      idx: 0,
      total: 1,
      entries: [
        { context: "vessels.self", path: "navigation.speedOverGround", meta: { units: "m/s" } },
        { context: "vessels.self", path: "environment.wind.speed", meta: { units: "m/s" } }
      ]
    };
    const packet = makeEncryptedMeta(envelope, secretKey);
    await pipeline.unpackDecryptMeta(packet, secretKey);

    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    const first = app.handleMessage.mock.calls[0][1];
    expect(first.context).toBe("vessels.self");
    expect(first.updates[0].meta[0]).toEqual({
      path: "navigation.speedOverGround",
      value: { units: "m/s" }
    });
    expect(metricsApi.metrics.bandwidth.metaPacketsIn).toBe(1);
  });

  test("drops payloads that lack the SKM1 magic", async () => {
    const { app, pipeline } = makeHarness();
    const envelope = {
      v: 1,
      kind: "snapshot",
      seq: 0,
      idx: 0,
      total: 1,
      entries: [{ context: "vessels.self", path: "a", meta: { units: "m" } }]
    };
    const packet = makeEncryptedMeta(envelope, secretKey, { withMagic: false });
    await pipeline.unpackDecryptMeta(packet, secretKey);
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("skips malformed entries but forwards good ones", async () => {
    const { app, pipeline } = makeHarness();
    const envelope = {
      v: 1,
      kind: "diff",
      seq: 1,
      idx: 0,
      total: 1,
      entries: [
        { context: "vessels.self", path: "a", meta: { units: "m" } },
        null,
        { context: "vessels.self" },
        { path: "b" }
      ]
    };
    const packet = makeEncryptedMeta(envelope, secretKey);
    await pipeline.unpackDecryptMeta(packet, secretKey);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });

  test("supports MessagePack-serialized envelopes when useMsgpack is true", async () => {
    const { app, state, pipeline } = makeHarness();
    state.options.useMsgpack = true;
    const envelope = {
      v: 1,
      kind: "snapshot",
      seq: 0,
      idx: 0,
      total: 1,
      entries: [{ context: "vessels.self", path: "a", meta: { units: "m" } }]
    };
    const packet = makeEncryptedMeta(envelope, secretKey, { useMsgpack: true });
    await pipeline.unpackDecryptMeta(packet, secretKey);
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });

  test("no-ops when the plugin is stopped (state.options = null)", async () => {
    const { app, state, pipeline } = makeHarness();
    state.options = null;
    const packet = Buffer.from([1, 2, 3]);
    await pipeline.unpackDecryptMeta(packet, secretKey);
    expect(app.handleMessage).not.toHaveBeenCalled();
  });
});

describe("v1 pipeline.packCryptMeta ↔ unpackDecryptMeta round-trip", () => {
  const secretKey = "12345678901234567890123456789012";

  test("a sent meta payload round-trips back to the same entries on the receiver", async () => {
    // Sender harness
    const senderSent = [];
    const senderApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const senderState = {
      options: {
        secretKey,
        udpPort: 6000,
        udpMetaPort: 6001,
        serverType: "client",
        useMsgpack: false,
        usePathDictionary: false,
        stretchAsciiKey: false
      },
      socketUdp: {
        send: jest.fn((pkt, port, addr, cb) => {
          senderSent.push({ pkt: Buffer.from(pkt), port, addr });
          if (cb) {
            cb(null);
          }
        })
      },
      metaConfig: { enabled: true, intervalSec: 300, maxPathsPerPacket: 500 },
      avgBytesPerDelta: 100,
      maxDeltasPerBatch: 10
    };
    const senderPipeline = createPipeline(senderApp, senderState, makeMetricsApi());

    const entries = [
      {
        context: "vessels.self",
        path: "navigation.speedOverGround",
        meta: { units: "m/s", description: "Speed over ground" }
      }
    ];
    await senderPipeline.packCryptMeta(entries, "snapshot", secretKey, "127.0.0.1", 6001);
    expect(senderSent).toHaveLength(1);
    expect(senderSent[0].port).toBe(6001);

    // Receiver harness decodes what the sender wrote
    const receiverApp = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
    const receiverState = {
      options: {
        secretKey,
        udpPort: 6000,
        udpMetaPort: 6001,
        serverType: "server",
        useMsgpack: false,
        usePathDictionary: false,
        stretchAsciiKey: false
      },
      socketUdp: null
    };
    const receiverPipeline = createPipeline(receiverApp, receiverState, makeMetricsApi());
    await receiverPipeline.unpackDecryptMeta(senderSent[0].pkt, secretKey);

    expect(receiverApp.handleMessage).toHaveBeenCalledTimes(1);
    const delta = receiverApp.handleMessage.mock.calls[0][1];
    expect(delta.context).toBe("vessels.self");
    expect(delta.updates[0].meta[0]).toEqual({
      path: "navigation.speedOverGround",
      value: { units: "m/s", description: "Speed over ground" }
    });
  });
});
