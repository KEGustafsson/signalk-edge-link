"use strict";

const zlib = require("node:zlib");
const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const { PacketBuilder } = require("../../lib/packet");
const { encryptBinary } = require("../../lib/crypto");

function makeMetricsApi() {
  const metrics = {
    startTime: Date.now(),
    deltasReceived: 0,
    malformedPackets: 0,
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

function buildMetaPacket(envelope, key) {
  const builder = new PacketBuilder();
  const json = Buffer.from(JSON.stringify(envelope));
  const compressed = zlib.brotliCompressSync(json);
  const encrypted = encryptBinary(compressed, key);
  return builder.buildMetadataPacket(encrypted, {
    compressed: true,
    encrypted: true
  });
}

describe("pipeline-v2-server METADATA handling", () => {
  const secretKey = "12345678901234567890123456789012";

  function makeHarness() {
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
    return { app, state, metricsApi, pipeline };
  }

  test("decrypts and forwards a snapshot envelope as deltas with updates[].meta[]", async () => {
    const { app, pipeline, metricsApi } = makeHarness();
    const envelope = {
      v: 1,
      kind: "snapshot",
      seq: 7,
      idx: 0,
      total: 1,
      entries: [
        {
          context: "vessels.self",
          path: "navigation.speedOverGround",
          meta: { units: "m/s", description: "Speed over ground" }
        },
        {
          context: "vessels.self",
          path: "environment.wind.speedApparent",
          meta: { units: "m/s" }
        }
      ]
    };
    const packet = buildMetaPacket(envelope, secretKey);
    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 13000 });

    expect(app.handleMessage).toHaveBeenCalledTimes(2);
    const firstDelta = app.handleMessage.mock.calls[0][1];
    expect(firstDelta.context).toBe("vessels.self");
    expect(firstDelta.updates[0].meta[0].path).toBe("navigation.speedOverGround");
    expect(firstDelta.updates[0].meta[0].value).toEqual({
      units: "m/s",
      description: "Speed over ground"
    });
    expect(metricsApi.metrics.bandwidth.metaPacketsIn).toBe(1);
  });

  test("ignores envelopes with no entries", async () => {
    const { app, pipeline } = makeHarness();
    const packet = buildMetaPacket(
      { v: 1, kind: "diff", seq: 0, idx: 0, total: 1, entries: [] },
      secretKey
    );
    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 13001 });
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("ignores non-object envelopes", async () => {
    const { app, pipeline } = makeHarness();
    const packet = buildMetaPacket(["not", "an", "envelope"], secretKey);
    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 13002 });
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("skips malformed entries but forwards good ones", async () => {
    const { app, pipeline } = makeHarness();
    const envelope = {
      v: 1,
      kind: "snapshot",
      seq: 1,
      idx: 0,
      total: 1,
      entries: [
        { context: "vessels.self", path: "a", meta: { units: "m" } },
        { context: "vessels.self" }, // missing path & meta
        null,
        { path: "b" } // missing meta
      ]
    };
    const packet = buildMetaPacket(envelope, secretKey);
    await pipeline.receivePacket(packet, secretKey, { address: "127.0.0.1", port: 13003 });
    expect(app.handleMessage).toHaveBeenCalledTimes(1);
  });
});

describe("pipeline-v2-server META_REQUEST emission", () => {
  const { PacketParser, PacketType } = require("../../lib/packet");
  const secretKey = "12345678901234567890123456789012";

  function makeHarness() {
    const sent = [];
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn()
    };
    const state = {
      options: { reliability: { nakTimeout: 10 } },
      socketUdp: {
        send: jest.fn((pkt, port, addr, cb) => {
          sent.push({ pkt, port, addr });
          if (cb) {
            cb(null);
          }
        })
      },
      instanceId: "test"
    };
    const metricsApi = makeMetricsApi();
    const pipeline = createPipelineV2Server(app, state, metricsApi);
    return { app, state, metricsApi, pipeline, sent };
  }

  function buildHelloPacket() {
    const builder = new PacketBuilder({ protocolVersion: 2 });
    return builder.buildHelloPacket({ protocolVersion: 2, clientId: "c1" });
  }

  test("emits exactly one META_REQUEST per session when a HELLO arrives", async () => {
    const { pipeline, sent } = makeHarness();
    const rinfo = { address: "127.0.0.1", port: 14100 };
    await pipeline.receivePacket(buildHelloPacket(), secretKey, rinfo);
    await pipeline.receivePacket(buildHelloPacket(), secretKey, rinfo);

    // One of the sends is the META_REQUEST back to the client (there may be
    // others such as ACKs for later DATA packets — for HELLO only, only the
    // META_REQUEST is expected).
    const parser = new PacketParser();
    const metaRequests = sent
      .map((s) => parser.parseHeader(s.pkt))
      .filter((p) => p.type === PacketType.META_REQUEST);
    expect(metaRequests).toHaveLength(1);
    const reqSend = sent.find((s) => parser.parseHeader(s.pkt).type === PacketType.META_REQUEST);
    expect(reqSend.addr).toBe(rinfo.address);
    expect(reqSend.port).toBe(rinfo.port);
  });

  test("does not re-emit META_REQUEST on repeated HELLOs from the same session", async () => {
    const { pipeline, sent } = makeHarness();
    const rinfo = { address: "127.0.0.1", port: 14101 };
    for (let i = 0; i < 5; i++) {
      await pipeline.receivePacket(buildHelloPacket(), secretKey, rinfo);
    }
    const parser = new PacketParser();
    const metaRequests = sent
      .map((s) => parser.parseHeader(s.pkt))
      .filter((p) => p.type === PacketType.META_REQUEST);
    expect(metaRequests).toHaveLength(1);
  });
});
