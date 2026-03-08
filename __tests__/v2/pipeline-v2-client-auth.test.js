const createMetrics = require("../../lib/metrics");
const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { PacketBuilder } = require("../../lib/packet");

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn()
  };
}

function makeState(overrides = {}) {
  return {
    instanceId: "client-auth-test",
    deltaTimerTime: 100,
    options: {
      protocolVersion: 3,
      secretKey: "12345678901234567890123456789012",
      reliability: {}
    },
    socketUdp: {
      send: jest.fn((_message, _port, _host, cb) => cb(null))
    },
    ...overrides
  };
}

describe("pipeline-v2-client authenticated control packets", () => {
  test("accepts signed ACK packets and clears the retransmit queue", async () => {
    const app = makeApp();
    const state = makeState();
    const metricsApi = createMetrics();
    const pipeline = createPipelineV2Client(app, state, metricsApi);

    const dataBuilder = new PacketBuilder({ protocolVersion: 3, secretKey: state.options.secretKey, initialSequence: 12 });
    const dataPacket = dataBuilder.buildDataPacket(Buffer.from("payload"));
    pipeline.getRetransmitQueue().add(12, dataPacket);

    const ackPacket = new PacketBuilder({ protocolVersion: 3, secretKey: state.options.secretKey })
      .buildACKPacket(12);

    await pipeline.handleControlPacket(ackPacket, { address: "127.0.0.1", port: 4446 });

    expect(pipeline.getRetransmitQueue().getSize()).toBe(0);
    expect(metricsApi.metrics.malformedPackets || 0).toBe(0);
  });

  test("rejects forged NAK packets without retransmitting data", async () => {
    const app = makeApp();
    const state = makeState();
    const metricsApi = createMetrics();
    const pipeline = createPipelineV2Client(app, state, metricsApi);

    const dataBuilder = new PacketBuilder({ protocolVersion: 3, secretKey: state.options.secretKey, initialSequence: 21 });
    const dataPacket = dataBuilder.buildDataPacket(Buffer.from("payload"));
    pipeline.getRetransmitQueue().add(21, dataPacket);

    const forgedNak = new PacketBuilder({ protocolVersion: 3, secretKey: "abcdefghijklmnopqrstuvwxyz123456" })
      .buildNAKPacket([21]);

    await pipeline.handleControlPacket(forgedNak, { address: "127.0.0.1", port: 4446 });

    expect(state.socketUdp.send).not.toHaveBeenCalled();
    expect(pipeline.getRetransmitQueue().getSize()).toBe(1);
    expect(metricsApi.metrics.malformedPackets).toBe(1);
  });
});
