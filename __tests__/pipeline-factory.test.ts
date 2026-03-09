// @ts-nocheck
"use strict";

const { createPipeline } = require("../lib/pipeline-factory.ts");
const createMetrics = require("../lib/metrics.ts");

describe("pipeline-factory", () => {
  let metricsApi;
  let state;
  let mockApp;

  beforeEach(() => {
    metricsApi = createMetrics();
    state = {
      options: {
        secretKey: "12345678901234567890123456789012",
        usePathDictionary: false,
        useMsgpack: false
      }
    };

    mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn()
    };
  });

  test("version 1 uses v1 pipeline", () => {
    const pipeline = createPipeline(1, "client", mockApp, state, metricsApi);
    expect(pipeline.packCrypt).toBeDefined();
    expect(pipeline.unpackDecrypt).toBeDefined();
  });

  test("version 3 client uses reliable pipeline methods", () => {
    const pipeline = createPipeline(3, "client", mockApp, state, metricsApi);
    expect(pipeline.sendDelta).toBeDefined();
    expect(pipeline.getPacketBuilder).toBeDefined();
  });

  test("version 3 server uses reliable pipeline methods", () => {
    const pipeline = createPipeline(3, "server", mockApp, state, metricsApi);
    expect(pipeline.receivePacket).toBeDefined();
    expect(pipeline.getSequenceTracker).toBeDefined();
  });

  test("unsupported version throws descriptive error", () => {
    expect(() => createPipeline(0, "client", mockApp, state, metricsApi)).toThrow(
      "Unsupported pipeline version: 0 (supported versions: 1, 2, 3)"
    );
  });
});
