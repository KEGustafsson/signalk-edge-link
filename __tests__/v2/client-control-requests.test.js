"use strict";

/**
 * Client-side handling of server-initiated control requests.
 *
 * `invokeRequestHandler` — reached only from the META_REQUEST and
 * FULL_STATUS_REQUEST branches — had no coverage: the server's *emission* of
 * these packets was well tested, but no test ever built one and fed it to a
 * client pipeline. Breaking the PacketType comparison would leave every
 * downstream vessel showing stale data after a server restart, with the suite
 * green.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { PacketBuilder } = require("../../lib/packet");
const createMetrics = require("../../lib/metrics");

const SECRET = "12345678901234567890123456789012";
const WRONG_SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const PEER = { address: "127.0.0.1", port: 4446 };

function makeClient() {
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId: "client-1",
    options: {
      secretKey: SECRET,
      udpAddress: PEER.address,
      udpPort: PEER.port,
      protocolVersion: 3,
      stretchAsciiKey: false
    },
    socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const pipeline = createPipelineV2Client(app, state, createMetrics());
  return { app, state, pipeline };
}

function builder() {
  return new PacketBuilder({ protocolVersion: 3, secretKey: SECRET });
}

describe("client control-request dispatch", () => {
  test("a META_REQUEST packet invokes the registered handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setMetaRequestHandler(handler);

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a FULL_STATUS_REQUEST packet invokes the registered handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setFullStatusRequestHandler(handler);

    const packet = builder().buildFullStatusRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a request signed with the wrong key does not invoke the handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setFullStatusRequestHandler(handler);

    const forged = new PacketBuilder({
      protocolVersion: 3,
      secretKey: WRONG_SECRET
    }).buildFullStatusRequestPacket({ secretKey: WRONG_SECRET });
    await pipeline.handleControlPacket(forged, PEER);

    expect(handler).not.toHaveBeenCalled();
  });

  test("a request from an unexpected source address is ignored", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setMetaRequestHandler(handler);

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, { address: "203.0.113.9", port: 4446 });

    expect(handler).not.toHaveBeenCalled();
  });

  test("a throwing handler does not surface as a parse error", async () => {
    const { app, pipeline } = makeClient();
    pipeline.setMetaRequestHandler(() => {
      throw new Error("handler blew up");
    });

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await expect(pipeline.handleControlPacket(packet, PEER)).resolves.toBeUndefined();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("handler error"));
  });

  test("a rejecting async handler is caught", async () => {
    const { app, pipeline } = makeClient();
    pipeline.setFullStatusRequestHandler(() => Promise.reject(new Error("async boom")));

    const packet = builder().buildFullStatusRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);
    await Promise.resolve();
    await Promise.resolve();

    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("handler rejected"));
  });

  test("no registered handler is a no-op, not a crash", async () => {
    const { pipeline } = makeClient();
    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await expect(pipeline.handleControlPacket(packet, PEER)).resolves.toBeUndefined();
  });
});
