"use strict";

/**
 * Coverage-focused tests for the v1 pipeline (packCrypt / unpackDecrypt):
 * path filter, precision, throttle, path dictionary, msgpack, oversized-packet
 * accounting, decrypt/decompress/parse error categories, delta truncation, null
 * deltas, and the socket-not-initialized error path.
 */

const crypto = require("crypto");
const createMetrics = require("../lib/metrics");
const createPipeline = require("../lib/pipeline");
const { encryptBinary } = require("../lib/crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const brotli = promisify(zlib.brotliCompress);

const SECRET = "12345678901234567890123456789012";

function makeApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn(),
    handleMessage: jest.fn()
  };
}

function makeState(optionOverrides = {}, captured = []) {
  return {
    options: { secretKey: SECRET, usePathDictionary: false, useMsgpack: false, ...optionOverrides },
    socketUdp: {
      send: jest.fn((msg, port, host, cb) => {
        captured.push(Buffer.from(msg));
        cb(null);
      })
    },
    readyToSend: true,
    isServerMode: false,
    deltas: [],
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 50,
    lastPacketTime: 0
  };
}

const navDelta = {
  context: "vessels.self",
  updates: [
    {
      source: { label: "n2k" },
      $source: "n2k.1",
      values: [
        { path: "navigation.speedOverGround", value: 5.123456 },
        { path: "navigation.position", value: { latitude: 60.17, longitude: 24.94 } }
      ]
    }
  ]
};

describe("v1 pipeline coverage", () => {
  test("packCrypt/unpackDecrypt round-trip injects the delta", async () => {
    const captured = [];
    const app = makeApp();
    const state = makeState({}, captured);
    const pipe = createPipeline(app, state, createMetrics());
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);
    expect(captured.length).toBe(1);

    const rxApp = makeApp();
    const rx = createPipeline(rxApp, makeState(), createMetrics());
    await rx.unpackDecrypt(captured[0], SECRET);
    expect(rxApp.handleMessage).toHaveBeenCalled();
  });

  test("stopped plugin (no options) is a no-op for both directions", async () => {
    const app = makeApp();
    const state = makeState();
    const pipe = createPipeline(app, state, createMetrics());
    state.options = null;
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);
    await pipe.unpackDecrypt(Buffer.from("x"), SECRET);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("plugin is stopped"));
  });

  test("pathFilter that denies all paths sends nothing", async () => {
    const captured = [];
    const state = makeState({ pathFilter: { deny: ["navigation.*"] } }, captured);
    const pipe = createPipeline(makeApp(), state, createMetrics());
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);
    expect(captured.length).toBe(0);
  });

  test("pathThrottle that drops all values sends nothing", async () => {
    const captured = [];
    const state = makeState(
      { pathThrottle: { "navigation.speedOverGround": { minIntervalMs: 999999 } } },
      captured
    );
    const pipe = createPipeline(makeApp(), state, createMetrics());
    // First send primes the throttle; a near-immediate resend is dropped.
    await pipe.packCrypt(
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1 }] }]
      },
      SECRET,
      "127.0.0.1",
      4446
    );
    captured.length = 0;
    await pipe.packCrypt(
      {
        context: "vessels.self",
        updates: [{ values: [{ path: "navigation.speedOverGround", value: 1 }] }]
      },
      SECRET,
      "127.0.0.1",
      4446
    );
    expect(captured.length).toBe(0);
  });

  test("path dictionary + msgpack + precision round-trip", async () => {
    const captured = [];
    const state = makeState(
      {
        usePathDictionary: true,
        useMsgpack: true,
        pathPrecision: { "navigation.speedOverGround": 2 }
      },
      captured
    );
    const pipe = createPipeline(makeApp(), state, createMetrics());
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);
    expect(captured.length).toBe(1);

    const rxApp = makeApp();
    const rx = createPipeline(rxApp, makeState({ useMsgpack: true }), createMetrics());
    await rx.unpackDecrypt(captured[0], SECRET);
    expect(rxApp.handleMessage).toHaveBeenCalled();
  });

  test("oversized packet increments smartBatching.oversizedPackets", async () => {
    const captured = [];
    const metricsApi = createMetrics();
    const state = makeState({}, captured);
    const pipe = createPipeline(makeApp(), state, metricsApi);
    // Incompressible random payload well above MAX_SAFE_UDP_PAYLOAD (1400).
    const big = crypto.randomBytes(4000).toString("base64");
    await pipe.packCrypt(
      { context: "vessels.self", updates: [{ values: [{ path: "x.blob", value: big }] }] },
      SECRET,
      "127.0.0.1",
      4446
    );
    expect(metricsApi.metrics.smartBatching.oversizedPackets).toBeGreaterThan(0);
  });

  test("wrong key records an encryption error", async () => {
    const captured = [];
    const state = makeState({}, captured);
    const pipe = createPipeline(makeApp(), state, createMetrics());
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);

    const rxApp = makeApp();
    const rxMetrics = createMetrics();
    const rx = createPipeline(rxApp, makeState(), rxMetrics);
    await rx.unpackDecrypt(captured[0], "99999999999999999999999999999999");
    expect(rxMetrics.metrics.errorCounts.encryption).toBeGreaterThan(0);
  });

  test("non-object payload is rejected", async () => {
    const rxApp = makeApp();
    const rxMetrics = createMetrics();
    const rx = createPipeline(rxApp, makeState(), rxMetrics);
    const compressed = await brotli(Buffer.from(JSON.stringify(42)));
    const packet = encryptBinary(compressed, SECRET);
    await rx.unpackDecrypt(packet, SECRET);
    expect(rxApp.error).toHaveBeenCalledWith(expect.stringContaining("non-object payload"));
  });

  test("too many deltas are truncated to the limit", async () => {
    const rxApp = makeApp();
    const rxMetrics = createMetrics();
    const rx = createPipeline(rxApp, makeState(), rxMetrics);
    const many = Array.from({ length: 510 }, () => ({
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 1 }] }]
    }));
    const compressed = await brotli(Buffer.from(JSON.stringify(many)));
    const packet = encryptBinary(compressed, SECRET);
    await rx.unpackDecrypt(packet, SECRET);
    expect(rxApp.error).toHaveBeenCalledWith(expect.stringContaining("truncating"));
    expect(rxMetrics.metrics.deltasReceived).toBe(500);
  });

  test("null deltas in the array are skipped", async () => {
    const rxApp = makeApp();
    const rx = createPipeline(rxApp, makeState(), createMetrics());
    const arr = [null, navDelta];
    const compressed = await brotli(Buffer.from(JSON.stringify(arr)));
    const packet = encryptBinary(compressed, SECRET);
    await rx.unpackDecrypt(packet, SECRET);
    expect(rxApp.debug).toHaveBeenCalledWith(expect.stringContaining("Skipping null delta"));
  });

  test("send with uninitialized socket records a UDP send/general error", async () => {
    const app = makeApp();
    const metricsApi = createMetrics();
    const state = makeState();
    state.socketUdp = null;
    const pipe = createPipeline(app, state, metricsApi);
    await pipe.packCrypt([navDelta], SECRET, "127.0.0.1", 4446);
    // udpSendAsync throws synchronously; packCrypt's catch records a general error.
    expect(app.error).toHaveBeenCalled();
  });
});
