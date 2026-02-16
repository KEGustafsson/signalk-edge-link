"use strict";

/**
 * End-to-End Pipeline Tests
 *
 * Tests the full data pipeline under real-life conditions for both v1 and v2 protocols.
 * Exercises: serialization, path dictionary, MessagePack, compression, encryption,
 * packet building, UDP transport (simulated), sequence tracking, ACK/NAK,
 * retransmission, and Signal K message delivery.
 */

const { promisify } = require("util");
const zlib = require("node:zlib");
const msgpack = require("@msgpack/msgpack");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { encodeDelta, decodeDelta } = require("../../lib/pathDictionary");
const { PacketBuilder, PacketParser, PacketType, HEADER_SIZE } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { RetransmitQueue } = require("../../lib/retransmit-queue");
const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");
const { NetworkSimulator, createSimulatedSockets } = require("../network-simulator");
const {
  MAX_SAFE_UDP_PAYLOAD,
  BROTLI_QUALITY_HIGH
} = require("../../lib/constants");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

// ============================================================
// Test Fixtures - Realistic Signal K Data
// ============================================================

const SECRET_KEY = "12345678901234567890123456789012";
const WRONG_KEY  = "abcdefghijklmnopqrstuvwxyz123456";

/** Realistic navigation delta from a sailing vessel */
function makeNavigationDelta(lat = 60.1695, lon = 24.9354, sog = 6.2, cog = 1.47) {
  return {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "GPS", type: "NMEA2000", pgn: 129029, src: "3" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "navigation.position", value: { latitude: lat, longitude: lon } },
        { path: "navigation.speedOverGround", value: sog },
        { path: "navigation.courseOverGroundTrue", value: cog },
        { path: "navigation.headingTrue", value: 1.52 },
        { path: "navigation.magneticVariation", value: 0.12 }
      ]
    }]
  };
}

/** Realistic environment delta with wind, temperature, depth */
function makeEnvironmentDelta() {
  return {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "WeatherStation", type: "NMEA0183", sentence: "MWV" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "environment.wind.speedApparent", value: 8.7 },
        { path: "environment.wind.angleApparent", value: 0.68 },
        { path: "environment.wind.speedTrue", value: 7.2 },
        { path: "environment.wind.angleTrueWater", value: 0.52 },
        { path: "environment.water.temperature", value: 289.15 },
        { path: "environment.outside.temperature", value: 293.15 },
        { path: "environment.outside.pressure", value: 101325 },
        { path: "environment.depth.belowTransducer", value: 12.4 }
      ]
    }]
  };
}

/** Engine/propulsion delta */
function makePropulsionDelta() {
  return {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "Engine", type: "NMEA2000", pgn: 127488, src: "1" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "propulsion.main.revolutions", value: 42.5 },
        { path: "propulsion.main.temperature", value: 353.15 },
        { path: "propulsion.main.oilPressure", value: 350000 },
        { path: "propulsion.main.coolantTemperature", value: 348.15 },
        { path: "propulsion.main.fuelRate", value: 0.0012 }
      ]
    }]
  };
}

/** Electrical system delta */
function makeElectricalDelta() {
  return {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [{
      source: { label: "BMS", type: "NMEA2000", pgn: 127508, src: "5" },
      timestamp: new Date().toISOString(),
      values: [
        { path: "electrical.batteries.house.voltage", value: 12.8 },
        { path: "electrical.batteries.house.current", value: -5.2 },
        { path: "electrical.batteries.house.capacity.stateOfCharge", value: 0.87 },
        { path: "electrical.batteries.starter.voltage", value: 12.9 }
      ]
    }]
  };
}

/** Create a batch of mixed deltas simulating a real vessel data stream */
function makeRealisticBatch(count = 10) {
  const deltas = [];
  for (let i = 0; i < count; i++) {
    const lat = 60.1695 + i * 0.0001;
    const lon = 24.9354 + i * 0.0002;
    const sog = 5.5 + Math.sin(i * 0.1) * 2;
    const cog = 1.47 + i * 0.001;

    switch (i % 4) {
      case 0: deltas.push(makeNavigationDelta(lat, lon, sog, cog)); break;
      case 1: deltas.push(makeEnvironmentDelta()); break;
      case 2: deltas.push(makePropulsionDelta()); break;
      case 3: deltas.push(makeElectricalDelta()); break;
    }
  }
  return deltas;
}

// ============================================================
// V1 Pipeline Helpers
// ============================================================

async function v1Compress(data, useMsgpack = false) {
  const serialized = useMsgpack
    ? Buffer.from(msgpack.encode(data))
    : Buffer.from(JSON.stringify(data), "utf8");

  const compressed = await brotliCompressAsync(serialized, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: useMsgpack
        ? zlib.constants.BROTLI_MODE_GENERIC
        : zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_HIGH,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
    }
  });

  return { serialized, compressed };
}

async function v1Pack(data, key, useMsgpack = false) {
  const { compressed } = await v1Compress(data, useMsgpack);
  return encryptBinary(compressed, key);
}

async function v1Unpack(packet, key, useMsgpack = false) {
  const decrypted = decryptBinary(packet, key);
  const decompressed = await brotliDecompressAsync(decrypted);

  if (useMsgpack) {
    return msgpack.decode(decompressed);
  }
  return JSON.parse(decompressed.toString());
}

// ============================================================
// V2 Pipeline Helpers
// ============================================================

function createV2ClientPipeline(opts = {}) {
  const builder = new PacketBuilder();
  const parser = new PacketParser();
  const retransmitQueue = new RetransmitQueue({ maxRetransmits: opts.maxRetransmits || 3 });

  return {
    builder,
    parser,
    retransmitQueue,
    async buildPacket(data, key, flags = {}) {
      const { compressed } = await v1Compress(data, flags.messagepack);
      const encrypted = encryptBinary(compressed, key);
      const seq = builder.getCurrentSequence();
      const packet = builder.buildDataPacket(encrypted, {
        compressed: true,
        encrypted: true,
        messagepack: !!flags.messagepack,
        pathDictionary: !!flags.pathDictionary
      });
      retransmitQueue.add(seq, packet);
      return { packet, seq };
    }
  };
}

function createV2ServerPipeline(opts = {}) {
  const parser = new PacketParser();
  const builder = new PacketBuilder();
  const naks = [];
  const tracker = new SequenceTracker({
    nakTimeout: opts.nakTimeout || 50,
    onLossDetected: (missing) => naks.push(...missing)
  });

  return {
    parser,
    builder,
    tracker,
    naks,
    async receiveAndDecode(packet, key, useMsgpack = false) {
      const parsed = parser.parseHeader(packet);
      if (parsed.type !== PacketType.DATA) return { parsed, delta: null };

      const seqResult = tracker.processSequence(parsed.sequence);
      if (seqResult.duplicate) return { parsed, seqResult, delta: null, duplicate: true };

      const decrypted = decryptBinary(parsed.payload, key);
      const decompressed = await brotliDecompressAsync(decrypted);
      let content;
      if (useMsgpack || parsed.flags.messagepack) {
        try { content = msgpack.decode(decompressed); }
        catch { content = JSON.parse(decompressed.toString()); }
      } else {
        content = JSON.parse(decompressed.toString());
      }
      return { parsed, seqResult, delta: content };
    }
  };
}


// ============================================================
// TEST SUITES
// ============================================================

describe("E2E Pipeline Tests", () => {

  // ==========================================================
  // V1 Full Pipeline Round-Trips
  // ==========================================================
  describe("V1 Full Pipeline Round-Trips", () => {
    test("single navigation delta survives full pipeline", async () => {
      const delta = makeNavigationDelta();
      const packet = await v1Pack(delta, SECRET_KEY);
      const recovered = await v1Unpack(packet, SECRET_KEY);
      expect(recovered).toEqual(delta);
    });

    test("batched deltas (indexed object format) survive pipeline", async () => {
      const deltas = makeRealisticBatch(5);
      const indexed = {};
      deltas.forEach((d, i) => { indexed[i] = d; });

      const packet = await v1Pack(indexed, SECRET_KEY);
      const recovered = await v1Unpack(packet, SECRET_KEY);

      for (let i = 0; i < deltas.length; i++) {
        expect(recovered[String(i)]).toEqual(deltas[i]);
      }
    });

    test("path dictionary encoding round-trips correctly", async () => {
      const delta = makeNavigationDelta();
      const encoded = encodeDelta(delta);

      // Encoded paths should be numeric IDs
      const encodedPath = encoded.updates[0].values[0].path;
      expect(typeof encodedPath).toBe("number");

      const packet = await v1Pack(encoded, SECRET_KEY);
      const recovered = await v1Unpack(packet, SECRET_KEY);
      const decoded = decodeDelta(recovered);

      expect(decoded.updates[0].values[0].path).toBe("navigation.position");
      expect(decoded.updates[0].values[0].value.latitude).toBe(60.1695);
    });

    test("MessagePack serialization round-trips correctly", async () => {
      const delta = makeNavigationDelta();
      const packet = await v1Pack(delta, SECRET_KEY, true);
      const recovered = await v1Unpack(packet, SECRET_KEY, true);

      expect(recovered.context).toBe(delta.context);
      expect(recovered.updates[0].values[0].value.latitude).toBe(60.1695);
    });

    test("path dictionary + MessagePack combined round-trip", async () => {
      const delta = makeEnvironmentDelta();
      const encoded = encodeDelta(delta);

      const packet = await v1Pack(encoded, SECRET_KEY, true);
      const recovered = await v1Unpack(packet, SECRET_KEY, true);
      const decoded = decodeDelta(recovered);

      expect(decoded.updates[0].values[0].path).toBe("environment.wind.speedApparent");
      expect(decoded.updates[0].values[0].value).toBe(8.7);
    });

    test("wrong key fails authentication", async () => {
      const delta = makeNavigationDelta();
      const packet = await v1Pack(delta, SECRET_KEY);

      await expect(v1Unpack(packet, WRONG_KEY)).rejects.toThrow();
    });

    test("tampered packet fails authentication", async () => {
      const delta = makeNavigationDelta();
      const packet = await v1Pack(delta, SECRET_KEY);

      // Flip a bit in the encrypted payload
      packet[20] ^= 0xff;
      await expect(v1Unpack(packet, SECRET_KEY)).rejects.toThrow();
    });

    test("large batch compression ratio > 80%", async () => {
      const deltas = makeRealisticBatch(50);
      const indexed = {};
      deltas.forEach((d, i) => { indexed[i] = d; });

      const raw = Buffer.from(JSON.stringify(indexed), "utf8");
      const packet = await v1Pack(indexed, SECRET_KEY);
      const ratio = (1 - packet.length / raw.length) * 100;

      expect(ratio).toBeGreaterThan(80);
    });

    test("realistic vessel data stream: 100 deltas pipeline throughput", async () => {
      const deltas = makeRealisticBatch(100);
      const batchSize = 10;
      const batches = [];

      for (let i = 0; i < deltas.length; i += batchSize) {
        const batch = {};
        for (let j = 0; j < batchSize && i + j < deltas.length; j++) {
          batch[j] = deltas[i + j];
        }
        batches.push(batch);
      }

      const startTime = Date.now();
      let totalReceived = 0;

      for (const batch of batches) {
        const packet = await v1Pack(batch, SECRET_KEY);
        const recovered = await v1Unpack(packet, SECRET_KEY);
        totalReceived += Object.keys(recovered).length;
      }

      const elapsed = Date.now() - startTime;
      expect(totalReceived).toBe(100);
      // Pipeline should handle 100 deltas in under 2 seconds
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // ==========================================================
  // V1 Pipeline via Factory (using real pipeline module)
  // ==========================================================
  describe("V1 Pipeline via Factory", () => {
    let metricsApi, state, pipeline;
    const sentPackets = [];
    const receivedMessages = [];

    const mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn((id, msg) => receivedMessages.push(msg)),
      setPluginStatus: jest.fn()
    };

    beforeEach(() => {
      sentPackets.length = 0;
      receivedMessages.length = 0;
      mockApp.debug.mockClear();
      mockApp.error.mockClear();
      mockApp.handleMessage.mockClear();

      metricsApi = createMetrics();
      state = {
        options: { useMsgpack: false, usePathDictionary: false },
        socketUdp: {
          send: (msg, port, host, cb) => {
            sentPackets.push(Buffer.from(msg));
            if (cb) cb(null);
          }
        },
        avgBytesPerDelta: 200,
        maxDeltasPerBatch: 5,
        lastPacketTime: 0
      };
      pipeline = createPipeline(1, "client", mockApp, state, metricsApi);
    });

    test("packCrypt sends encrypted packet via UDP socket", async () => {
      const delta = makeNavigationDelta();
      await pipeline.packCrypt(delta, SECRET_KEY, "127.0.0.1", 5000);

      expect(sentPackets).toHaveLength(1);
      expect(sentPackets[0]).toBeInstanceOf(Buffer);
      expect(sentPackets[0].length).toBeGreaterThan(28); // IV(12) + AuthTag(16) + some data
      expect(metricsApi.metrics.deltasSent).toBe(1);
    });

    test("packCrypt + unpackDecrypt full round-trip via factory", async () => {
      // Real plugin sends deltas wrapped in indexed object: {0: delta, 1: delta, ...}
      const delta = makeNavigationDelta();
      const batch = { 0: delta };
      await pipeline.packCrypt(batch, SECRET_KEY, "127.0.0.1", 5000);

      // Now receive on server side
      const serverState = {
        options: { useMsgpack: false, usePathDictionary: false }
      };
      const serverMetrics = createMetrics();
      const serverPipeline = createPipeline(1, "server", mockApp, serverState, serverMetrics);

      await serverPipeline.unpackDecrypt(sentPackets[0], SECRET_KEY);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].context).toBe("vessels.urn:mrn:imo:mmsi:230035780");
      expect(receivedMessages[0].updates[0].values[0].path).toBe("navigation.position");
    });

    test("packCrypt + unpackDecrypt with path dictionary via factory", async () => {
      state.options.usePathDictionary = true;

      const delta = makeEnvironmentDelta();
      const batch = { 0: delta };
      await pipeline.packCrypt(batch, SECRET_KEY, "127.0.0.1", 5000);

      // Server side also has path dictionary enabled (decodes automatically)
      const serverState = {
        options: { useMsgpack: false, usePathDictionary: true }
      };
      const serverMetrics = createMetrics();
      const serverPipeline = createPipeline(1, "server", mockApp, serverState, serverMetrics);

      await serverPipeline.unpackDecrypt(sentPackets[0], SECRET_KEY);

      expect(receivedMessages).toHaveLength(1);
      // decodeDelta is applied in unpackDecrypt, so paths should be restored
      expect(receivedMessages[0].updates[0].values[0].path).toBe("environment.wind.speedApparent");
    });

    test("packCrypt + unpackDecrypt with MessagePack via factory", async () => {
      state.options.useMsgpack = true;

      const delta = makePropulsionDelta();
      const batch = { 0: delta };
      await pipeline.packCrypt(batch, SECRET_KEY, "127.0.0.1", 5000);

      const serverState = {
        options: { useMsgpack: true, usePathDictionary: false }
      };
      const serverMetrics = createMetrics();
      const serverPipeline = createPipeline(1, "server", mockApp, serverState, serverMetrics);

      await serverPipeline.unpackDecrypt(sentPackets[0], SECRET_KEY);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].updates[0].values[0].path).toBe("propulsion.main.revolutions");
      expect(receivedMessages[0].updates[0].values[0].value).toBe(42.5);
    });

    test("batched deltas via factory pipeline", async () => {
      const deltas = makeRealisticBatch(5);
      const batch = {};
      deltas.forEach((d, i) => { batch[i] = d; });

      await pipeline.packCrypt(batch, SECRET_KEY, "127.0.0.1", 5000);

      const serverState = { options: { useMsgpack: false, usePathDictionary: false } };
      const serverMetrics = createMetrics();
      const serverPipeline = createPipeline(1, "server", mockApp, serverState, serverMetrics);

      await serverPipeline.unpackDecrypt(sentPackets[0], SECRET_KEY);

      expect(receivedMessages).toHaveLength(5);
    });

    test("metrics track bandwidth correctly after pipeline", async () => {
      const delta = makeNavigationDelta();
      await pipeline.packCrypt(delta, SECRET_KEY, "127.0.0.1", 5000);

      expect(metricsApi.metrics.bandwidth.bytesOut).toBeGreaterThan(0);
      expect(metricsApi.metrics.bandwidth.bytesOutRaw).toBeGreaterThan(0);
      expect(metricsApi.metrics.bandwidth.packetsOut).toBe(1);
      // Compression should save significant bytes
      expect(metricsApi.metrics.bandwidth.bytesOut).toBeLessThan(metricsApi.metrics.bandwidth.bytesOutRaw);
    });
  });

  // ==========================================================
  // V2 Full Pipeline Round-Trips
  // ==========================================================
  describe("V2 Full Pipeline Round-Trips", () => {
    test("single delta through v2 packet pipeline", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const delta = makeNavigationDelta();
      const data = { 0: delta };

      const { packet, seq } = await client.buildPacket(data, SECRET_KEY);
      const { parsed, seqResult, delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);

      expect(seq).toBe(0);
      expect(parsed.type).toBe(PacketType.DATA);
      expect(parsed.flags.compressed).toBe(true);
      expect(parsed.flags.encrypted).toBe(true);
      expect(seqResult.inOrder).toBe(true);
      expect(received["0"].context).toBe("vessels.urn:mrn:imo:mmsi:230035780");
      expect(received["0"].updates[0].values[0].value.latitude).toBe(60.1695);
    });

    test("sequential deltas maintain sequence ordering", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const receivedValues = [];

      for (let i = 0; i < 10; i++) {
        const delta = { 0: makeNavigationDelta(60 + i * 0.001, 24 + i * 0.001) };
        const { packet, seq } = await client.buildPacket(delta, SECRET_KEY);
        expect(seq).toBe(i);

        const result = await server.receiveAndDecode(packet, SECRET_KEY);
        expect(result.seqResult.inOrder).toBe(true);
        receivedValues.push(result.delta["0"].updates[0].values[0].value.latitude);
      }

      // Verify all values received in order
      for (let i = 0; i < 10; i++) {
        expect(receivedValues[i]).toBeCloseTo(60 + i * 0.001, 6);
      }
      expect(server.tracker.expectedSeq).toBe(10);
    });

    test("v2 with path dictionary encoding", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const delta = makeEnvironmentDelta();
      const encoded = encodeDelta(delta);
      const data = { 0: encoded };

      const { packet } = await client.buildPacket(data, SECRET_KEY, { pathDictionary: true });
      const { parsed, delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);

      expect(parsed.flags.pathDictionary).toBe(true);

      // Decode path dictionary on server side
      const decoded = decodeDelta(received["0"]);
      expect(decoded.updates[0].values[0].path).toBe("environment.wind.speedApparent");
    });

    test("v2 with MessagePack serialization", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const delta = makePropulsionDelta();
      const data = { 0: delta };

      const { packet } = await client.buildPacket(data, SECRET_KEY, { messagepack: true });
      const { parsed, delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);

      expect(parsed.flags.messagepack).toBe(true);
      expect(received["0"].updates[0].values[0].path).toBe("propulsion.main.revolutions");
    });

    test("v2 with path dictionary + MessagePack", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const delta = makeNavigationDelta();
      const encoded = encodeDelta(delta);
      const data = { 0: encoded };

      const { packet } = await client.buildPacket(data, SECRET_KEY, {
        messagepack: true,
        pathDictionary: true
      });
      const { delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);
      const decoded = decodeDelta(received["0"]);

      expect(decoded.updates[0].values[0].path).toBe("navigation.position");
      expect(decoded.updates[0].values[0].value.latitude).toBe(60.1695);
    });

    test("v2 packet header overhead is exactly HEADER_SIZE", async () => {
      const client = createV2ClientPipeline();

      const delta = { 0: makeNavigationDelta() };
      const { compressed } = await v1Compress(delta);
      const encrypted = encryptBinary(compressed, SECRET_KEY);
      const v2Packet = client.builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });

      expect(v2Packet.length).toBe(encrypted.length + HEADER_SIZE);
    });

    test("heartbeat packet round-trip", () => {
      const client = createV2ClientPipeline();
      const parser = new PacketParser();

      const heartbeat = client.builder.buildHeartbeatPacket();
      const parsed = parser.parseHeader(heartbeat);

      expect(parsed.type).toBe(PacketType.HEARTBEAT);
      expect(parsed.payloadLength).toBe(0);
    });

    test("hello packet round-trip", () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();

      const hello = builder.buildHelloPacket({
        protocolVersion: 2,
        clientId: "vessel-230035780"
      });
      const parsed = parser.parseHeader(hello);

      expect(parsed.type).toBe(PacketType.HELLO);
      const info = JSON.parse(parsed.payload.toString());
      expect(info.clientId).toBe("vessel-230035780");
      expect(info.protocolVersion).toBe(2);
    });
  });

  // ==========================================================
  // V2 Pipeline via Factory (using real pipeline modules)
  // ==========================================================
  describe("V2 Pipeline via Factory", () => {
    let clientMetrics, clientState, clientPipeline;
    let serverMetrics, serverState, serverPipeline;
    const sentPackets = [];
    const receivedMessages = [];

    const mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn((id, msg) => receivedMessages.push(msg)),
      setPluginStatus: jest.fn()
    };

    beforeEach(() => {
      sentPackets.length = 0;
      receivedMessages.length = 0;
      mockApp.debug.mockClear();
      mockApp.error.mockClear();
      mockApp.handleMessage.mockClear();

      clientMetrics = createMetrics();
      clientState = {
        options: { useMsgpack: false, usePathDictionary: false },
        socketUdp: {
          send: (msg, port, host, cb) => {
            sentPackets.push(Buffer.from(msg));
            if (cb) cb(null);
          }
        },
        avgBytesPerDelta: 200,
        maxDeltasPerBatch: 5,
        lastPacketTime: 0
      };
      clientPipeline = createPipeline(2, "client", mockApp, clientState, clientMetrics);

      serverMetrics = createMetrics();
      serverState = {
        options: { useMsgpack: false, usePathDictionary: false },
        socketUdp: {
          send: (msg, port, host, cb) => {
            if (cb) cb(null);
          }
        }
      };
      serverPipeline = createPipeline(2, "server", mockApp, serverState, serverMetrics);
    });

    afterEach(() => {
      serverPipeline.stopACKTimer();
      serverPipeline.stopMetricsPublishing();
      clientPipeline.stopMetricsPublishing();
      clientPipeline.stopCongestionControl();
    });

    test("v2 factory pipeline: client sendDelta -> server receivePacket", async () => {
      // Real plugin wraps deltas in indexed object: {0: delta}
      const delta = makeNavigationDelta();
      const batch = { 0: delta };
      await clientPipeline.sendDelta(batch, SECRET_KEY, "127.0.0.1", 5000);

      expect(sentPackets).toHaveLength(1);

      await serverPipeline.receivePacket(sentPackets[0], SECRET_KEY, {
        address: "127.0.0.1",
        port: 6000
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].context).toBe("vessels.urn:mrn:imo:mmsi:230035780");
    });

    test("v2 factory pipeline with path dictionary", async () => {
      clientState.options.usePathDictionary = true;

      const delta = makeEnvironmentDelta();
      const batch = { 0: delta };
      await clientPipeline.sendDelta(batch, SECRET_KEY, "127.0.0.1", 5000);

      await serverPipeline.receivePacket(sentPackets[0], SECRET_KEY, {
        address: "127.0.0.1", port: 6000
      });

      // Server pipeline calls decodeDelta, paths should be restored
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].updates[0].values[0].path).toBe("environment.wind.speedApparent");
    });

    test("v2 factory pipeline with MessagePack", async () => {
      clientState.options.useMsgpack = true;

      const delta = makePropulsionDelta();
      const batch = { 0: delta };
      await clientPipeline.sendDelta(batch, SECRET_KEY, "127.0.0.1", 5000);

      // Server reads flags from packet header to determine msgpack
      await serverPipeline.receivePacket(sentPackets[0], SECRET_KEY, {
        address: "127.0.0.1", port: 6000
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].updates[0].values[0].path).toBe("propulsion.main.revolutions");
    });

    test("v2 factory: multiple sequential sends maintain sequence", async () => {
      for (let i = 0; i < 5; i++) {
        const delta = makeNavigationDelta(60 + i * 0.001, 24);
        const batch = { 0: delta };
        await clientPipeline.sendDelta(batch, SECRET_KEY, "127.0.0.1", 5000);
      }

      expect(sentPackets).toHaveLength(5);

      for (const pkt of sentPackets) {
        await serverPipeline.receivePacket(pkt, SECRET_KEY, {
          address: "127.0.0.1", port: 6000
        });
      }

      expect(receivedMessages).toHaveLength(5);
      expect(serverPipeline.getSequenceTracker().expectedSeq).toBe(5);
    });

    test("v2 factory: duplicate packet is rejected", async () => {
      const delta = makeNavigationDelta();
      const batch = { 0: delta };
      await clientPipeline.sendDelta(batch, SECRET_KEY, "127.0.0.1", 5000);

      // Deliver same packet twice
      await serverPipeline.receivePacket(sentPackets[0], SECRET_KEY, {
        address: "127.0.0.1", port: 6000
      });
      await serverPipeline.receivePacket(sentPackets[0], SECRET_KEY, {
        address: "127.0.0.1", port: 6000
      });

      // Only first should be processed
      expect(receivedMessages).toHaveLength(1);
      expect(serverMetrics.metrics.duplicatePackets).toBe(1);
    });

    test("v2 factory: metrics track correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await clientPipeline.sendDelta({ 0: makeNavigationDelta() }, SECRET_KEY, "127.0.0.1", 5000);
      }

      expect(clientMetrics.metrics.deltasSent).toBe(3);
      expect(clientMetrics.metrics.bandwidth.packetsOut).toBe(3);
      expect(clientMetrics.metrics.bandwidth.bytesOut).toBeGreaterThan(0);
      expect(clientPipeline.getRetransmitQueue().getSize()).toBe(3);
    });
  });

  // ==========================================================
  // V2 ACK/NAK Full Pipeline
  // ==========================================================
  describe("V2 ACK/NAK Full Pipeline", () => {
    test("complete ACK flow: send -> receive -> ACK -> queue cleanup", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      // Client sends 5 packets
      const packets = [];
      for (let i = 0; i < 5; i++) {
        const data = { 0: makeNavigationDelta(60 + i * 0.001, 24) };
        const result = await client.buildPacket(data, SECRET_KEY);
        packets.push(result);
      }
      expect(client.retransmitQueue.getSize()).toBe(5);

      // Server receives all 5
      for (const { packet } of packets) {
        await server.receiveAndDecode(packet, SECRET_KEY);
      }
      expect(server.tracker.expectedSeq).toBe(5);

      // Server sends ACK
      const ackPacket = server.builder.buildACKPacket(4);
      const parsedAck = client.parser.parseHeader(ackPacket);
      const ackedSeq = client.parser.parseACKPayload(parsedAck.payload);

      // Client processes ACK
      client.retransmitQueue.acknowledge(ackedSeq);
      expect(client.retransmitQueue.getSize()).toBe(0);
    });

    test("complete NAK flow: send -> loss -> NAK -> retransmit -> receive", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      // Client builds 5 packets
      const packets = [];
      for (let i = 0; i < 5; i++) {
        const data = { 0: makeNavigationDelta(60 + i * 0.001, 24) };
        packets.push(await client.buildPacket(data, SECRET_KEY));
      }

      // Server receives 0, 1, 3, 4 (packet 2 lost)
      await server.receiveAndDecode(packets[0].packet, SECRET_KEY);
      await server.receiveAndDecode(packets[1].packet, SECRET_KEY);
      await server.receiveAndDecode(packets[3].packet, SECRET_KEY);
      await server.receiveAndDecode(packets[4].packet, SECRET_KEY);

      // Server detects gap
      expect(server.tracker.expectedSeq).toBe(2); // waiting for seq 2

      // Server sends NAK for missing seq 2
      const nakPacket = server.builder.buildNAKPacket([2]);
      const parsedNak = client.parser.parseHeader(nakPacket);
      const missingSeqs = client.parser.parseNAKPayload(parsedNak.payload);
      expect(missingSeqs).toEqual([2]);

      // Client retransmits
      const retransmitted = client.retransmitQueue.retransmit(missingSeqs);
      expect(retransmitted).toHaveLength(1);
      expect(retransmitted[0].sequence).toBe(2);

      // Server receives retransmitted packet
      await server.receiveAndDecode(retransmitted[0].packet, SECRET_KEY);
      expect(server.tracker.expectedSeq).toBe(5); // all received

      // Server sends cumulative ACK
      const ackPacket = server.builder.buildACKPacket(4);
      const ackedSeq = client.parser.parseACKPayload(
        client.parser.parseHeader(ackPacket).payload
      );
      client.retransmitQueue.acknowledge(ackedSeq);
      expect(client.retransmitQueue.getSize()).toBe(0);
    });

    test("multiple gaps: NAK recovers all missing packets", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      // Client builds 10 packets
      const packets = [];
      for (let i = 0; i < 10; i++) {
        packets.push(await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY));
      }

      // Server receives 0, 1, 4, 5, 8, 9 (lost: 2, 3, 6, 7)
      const deliveryOrder = [0, 1, 4, 5, 8, 9];
      for (const idx of deliveryOrder) {
        await server.receiveAndDecode(packets[idx].packet, SECRET_KEY);
      }

      expect(server.tracker.expectedSeq).toBe(2); // waiting for 2

      // Server sends NAK for [2, 3, 6, 7]
      const missingSeqs = [2, 3, 6, 7];
      const retransmitted = client.retransmitQueue.retransmit(missingSeqs);
      expect(retransmitted).toHaveLength(4);

      // Server receives all retransmitted
      for (const { packet } of retransmitted) {
        await server.receiveAndDecode(packet, SECRET_KEY);
      }
      expect(server.tracker.expectedSeq).toBe(10);
    });

    test("NAK callback fires on gap detection after timeout", (done) => {
      const naks = [];
      const tracker = new SequenceTracker({
        nakTimeout: 30,
        onLossDetected: (missing) => naks.push(...missing)
      });

      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.processSequence(3); // gap at 2

      setTimeout(() => {
        expect(naks).toContain(2);
        tracker.reset();
        done();
      }, 80);
    });
  });

  // ==========================================================
  // V2 with Simulated Network Conditions
  // ==========================================================
  describe("V2 Under Simulated Network Conditions", () => {
    test("5% packet loss: retransmission achieves >99.9% delivery", async () => {
      const client = createV2ClientPipeline({ maxRetransmits: 5 });
      const server = createV2ServerPipeline({ nakTimeout: 0 });
      const sim = new NetworkSimulator({ packetLoss: 0.05 });

      const numPackets = 200;
      const receivedSet = new Set();

      // Build all packets
      const allPackets = [];
      for (let i = 0; i < numPackets; i++) {
        allPackets.push(await client.buildPacket(
          { 0: makeNavigationDelta(60 + i * 0.0001, 24) }, SECRET_KEY
        ));
      }

      // Send through lossy network
      for (const { packet, seq } of allPackets) {
        sim.send(packet, (pkt) => {
          try {
            const parsed = server.parser.parseHeader(pkt);
            server.tracker.processSequence(parsed.sequence);
            receivedSet.add(parsed.sequence);
          } catch { /* corrupted packet */ }
        });
      }

      // Identify missing and retransmit (up to 3 rounds)
      for (let round = 0; round < 3; round++) {
        const missing = [];
        for (let i = 0; i < numPackets; i++) {
          if (!receivedSet.has(i)) missing.push(i);
        }
        if (missing.length === 0) break;

        const retransmitted = client.retransmitQueue.retransmit(missing);
        for (const { packet } of retransmitted) {
          sim.send(packet, (pkt) => {
            try {
              const parsed = server.parser.parseHeader(pkt);
              receivedSet.add(parsed.sequence);
            } catch { /* corrupted packet */ }
          });
        }
      }

      const deliveryRate = receivedSet.size / numPackets;
      expect(deliveryRate).toBeGreaterThan(0.999);
      sim.destroy();
    });

    test("20% packet loss: recovery with multiple retransmit rounds", async () => {
      const client = createV2ClientPipeline({ maxRetransmits: 5 });
      const server = createV2ServerPipeline({ nakTimeout: 0 });
      const sim = new NetworkSimulator({ packetLoss: 0.20 });

      const numPackets = 100;
      const receivedSet = new Set();

      const allPackets = [];
      for (let i = 0; i < numPackets; i++) {
        allPackets.push(await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY));
      }

      // Initial send
      for (const { packet } of allPackets) {
        sim.send(packet, (pkt) => {
          try {
            const parsed = server.parser.parseHeader(pkt);
            receivedSet.add(parsed.sequence);
          } catch { /* skip */ }
        });
      }

      // Multiple retransmission rounds
      for (let round = 0; round < 5; round++) {
        const missing = [];
        for (let i = 0; i < numPackets; i++) {
          if (!receivedSet.has(i)) missing.push(i);
        }
        if (missing.length === 0) break;

        const retransmitted = client.retransmitQueue.retransmit(missing);
        for (const { packet } of retransmitted) {
          sim.send(packet, (pkt) => {
            try {
              const parsed = server.parser.parseHeader(pkt);
              receivedSet.add(parsed.sequence);
            } catch { /* skip */ }
          });
        }
      }

      const deliveryRate = receivedSet.size / numPackets;
      expect(deliveryRate).toBeGreaterThan(0.98);
      sim.destroy();
    });

    test("burst loss (Gilbert-Elliott model): recovery after burst", async () => {
      const client = createV2ClientPipeline({ maxRetransmits: 5 });
      const server = createV2ServerPipeline({ nakTimeout: 0 });
      const sim = new NetworkSimulator({
        burstLoss: { burstLength: 5, burstRate: 0.1 }
      });

      const numPackets = 100;
      const receivedSet = new Set();

      const allPackets = [];
      for (let i = 0; i < numPackets; i++) {
        allPackets.push(await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY));
      }

      for (const { packet } of allPackets) {
        sim.send(packet, (pkt) => {
          try {
            const parsed = server.parser.parseHeader(pkt);
            receivedSet.add(parsed.sequence);
          } catch { /* skip */ }
        });
      }

      // Retransmit rounds
      for (let round = 0; round < 4; round++) {
        const missing = [];
        for (let i = 0; i < numPackets; i++) {
          if (!receivedSet.has(i)) missing.push(i);
        }
        if (missing.length === 0) break;

        const retransmitted = client.retransmitQueue.retransmit(missing);
        for (const { packet } of retransmitted) {
          sim.send(packet, (pkt) => {
            try {
              const parsed = server.parser.parseHeader(pkt);
              receivedSet.add(parsed.sequence);
            } catch { /* skip */ }
          });
        }
      }

      const deliveryRate = receivedSet.size / numPackets;
      expect(deliveryRate).toBeGreaterThan(0.95);
      sim.destroy();
    });

    test("link flapping: packet loss during down periods", async () => {
      const client = createV2ClientPipeline({ maxRetransmits: 3 });
      const sim = new NetworkSimulator({ packetLoss: 0 });

      const receivedSet = new Set();
      const parser = new PacketParser();

      const allPackets = [];
      for (let i = 0; i < 20; i++) {
        allPackets.push(await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY));
      }

      // Send first 10 with link up
      for (let i = 0; i < 10; i++) {
        sim.send(allPackets[i].packet, (pkt) => {
          const p = parser.parseHeader(pkt);
          receivedSet.add(p.sequence);
        });
      }

      // Link goes down
      sim.setLinkDown(true);
      for (let i = 10; i < 15; i++) {
        sim.send(allPackets[i].packet, (pkt) => {
          const p = parser.parseHeader(pkt);
          receivedSet.add(p.sequence);
        });
      }

      // Link comes back up
      sim.setLinkDown(false);
      for (let i = 15; i < 20; i++) {
        sim.send(allPackets[i].packet, (pkt) => {
          const p = parser.parseHeader(pkt);
          receivedSet.add(p.sequence);
        });
      }

      // Packets 10-14 should have been lost
      expect(receivedSet.size).toBe(15);
      for (let i = 10; i < 15; i++) {
        expect(receivedSet.has(i)).toBe(false);
      }

      // Retransmit lost packets (link is up now)
      const missing = [];
      for (let i = 0; i < 20; i++) {
        if (!receivedSet.has(i)) missing.push(i);
      }

      const retransmitted = client.retransmitQueue.retransmit(missing);
      for (const { packet } of retransmitted) {
        sim.send(packet, (pkt) => {
          const p = parser.parseHeader(pkt);
          receivedSet.add(p.sequence);
        });
      }

      expect(receivedSet.size).toBe(20);
      sim.destroy();
    });

    test("simulated socket pair: full v2 client-server exchange", (done) => {
      const c2s = new NetworkSimulator({ packetLoss: 0 });
      const s2c = new NetworkSimulator({ packetLoss: 0 });
      const { clientSocket, serverSocket } = createSimulatedSockets(c2s, s2c);

      const builder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();
      const receivedDeltas = [];

      // Server listens for data
      serverSocket.on("message", async (msg) => {
        try {
          const parsed = parser.parseHeader(msg);
          if (parsed.type !== PacketType.DATA) return;

          tracker.processSequence(parsed.sequence);

          const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
          const decompressed = await brotliDecompressAsync(decrypted);
          const content = JSON.parse(decompressed.toString());
          receivedDeltas.push(content);

          // Send ACK back
          const ack = new PacketBuilder().buildACKPacket(parsed.sequence);
          serverSocket.send(ack, 5555, "127.0.0.1");
        } catch (err) {
          // ignore parse errors
        }
      });

      // Client sends delta
      (async () => {
        const delta = { 0: makeNavigationDelta() };
        const { compressed } = await v1Compress(delta);
        const encrypted = encryptBinary(compressed, SECRET_KEY);
        const packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });

        clientSocket.send(packet, 5000, "127.0.0.1");

        // Wait for processing
        setTimeout(() => {
          expect(receivedDeltas).toHaveLength(1);
          expect(receivedDeltas[0]["0"].context).toBe("vessels.urn:mrn:imo:mmsi:230035780");
          expect(tracker.expectedSeq).toBe(1);
          c2s.destroy();
          s2c.destroy();
          tracker.reset();
          done();
        }, 50);
      })();
    });
  });

  // ==========================================================
  // Cross-Version Compatibility
  // ==========================================================
  describe("Cross-Version Data Integrity", () => {
    test("same delta produces identical content via v1 and v2 pipelines", async () => {
      const delta = makeNavigationDelta();
      const data = { 0: delta };

      // V1 path
      const v1Packet = await v1Pack(data, SECRET_KEY);
      const v1Recovered = await v1Unpack(v1Packet, SECRET_KEY);

      // V2 path
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();
      const { packet: v2Packet } = await client.buildPacket(data, SECRET_KEY);
      const { delta: v2Recovered } = await server.receiveAndDecode(v2Packet, SECRET_KEY);

      // Data content should be identical
      expect(v2Recovered).toEqual(v1Recovered);
    });

    test("v2 adds only header overhead vs v1", async () => {
      const delta = { 0: makeNavigationDelta() };
      const { compressed } = await v1Compress(delta);
      const encrypted = encryptBinary(compressed, SECRET_KEY);

      const v1Size = encrypted.length;

      const builder = new PacketBuilder();
      const v2Packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
      const v2Size = v2Packet.length;

      // V2 overhead should be exactly HEADER_SIZE (15 bytes)
      expect(v2Size - v1Size).toBe(HEADER_SIZE);
    });

    test("isV2Packet correctly distinguishes v1 and v2 packets", async () => {
      const parser = new PacketParser();
      const delta = { 0: makeNavigationDelta() };

      // V1 packet (raw encrypted data)
      const v1Packet = await v1Pack(delta, SECRET_KEY);
      expect(parser.isV2Packet(v1Packet)).toBe(false);

      // V2 packet
      const client = createV2ClientPipeline();
      const { packet: v2Packet } = await client.buildPacket(delta, SECRET_KEY);
      expect(parser.isV2Packet(v2Packet)).toBe(true);
    });

    test("path dictionary encoding is consistent across v1 and v2", async () => {
      const delta = makeEnvironmentDelta();
      const encoded = encodeDelta(delta);
      const data = { 0: encoded };

      // V1
      const v1Packet = await v1Pack(data, SECRET_KEY);
      const v1Recovered = await v1Unpack(v1Packet, SECRET_KEY);
      const v1Decoded = decodeDelta(v1Recovered["0"]);

      // V2
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();
      const { packet } = await client.buildPacket(data, SECRET_KEY, { pathDictionary: true });
      const { delta: v2Recovered } = await server.receiveAndDecode(packet, SECRET_KEY);
      const v2Decoded = decodeDelta(v2Recovered["0"]);

      expect(v1Decoded.updates[0].values[0].path).toBe(v2Decoded.updates[0].values[0].path);
      expect(v1Decoded.updates[0].values[0].value).toBe(v2Decoded.updates[0].values[0].value);
    });

    test("MessagePack encoding is consistent across v1 and v2", async () => {
      const delta = makePropulsionDelta();
      const data = { 0: delta };

      // V1 with msgpack
      const v1Packet = await v1Pack(data, SECRET_KEY, true);
      const v1Recovered = await v1Unpack(v1Packet, SECRET_KEY, true);

      // V2 with msgpack
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();
      const { packet } = await client.buildPacket(data, SECRET_KEY, { messagepack: true });
      const { delta: v2Recovered } = await server.receiveAndDecode(packet, SECRET_KEY);

      expect(v2Recovered["0"].updates[0].values[0].value)
        .toBe(v1Recovered["0"].updates[0].values[0].value);
    });
  });

  // ==========================================================
  // Real-World Scenario Tests
  // ==========================================================
  describe("Real-World Scenarios", () => {
    test("scenario: vessel sailing - continuous position updates", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      // Simulate 60 seconds of 1Hz updates
      const receivedPositions = [];

      for (let second = 0; second < 60; second++) {
        const lat = 60.1695 + second * 0.00005;
        const lon = 24.9354 + second * 0.00008;
        const sog = 6.0 + Math.sin(second * 0.1) * 0.5;
        const cog = 1.47 + second * 0.001;

        const data = { 0: makeNavigationDelta(lat, lon, sog, cog) };
        const { packet } = await client.buildPacket(data, SECRET_KEY);
        const { delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);

        receivedPositions.push({
          lat: received["0"].updates[0].values[0].value.latitude,
          lon: received["0"].updates[0].values[0].value.longitude
        });
      }

      expect(receivedPositions).toHaveLength(60);
      expect(server.tracker.expectedSeq).toBe(60);

      // Verify position progression
      for (let i = 1; i < receivedPositions.length; i++) {
        expect(receivedPositions[i].lat).toBeGreaterThan(receivedPositions[i - 1].lat);
      }
    });

    test("scenario: mixed sensor data batch (nav + env + engine + electrical)", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const batch = makeRealisticBatch(20);
      const indexed = {};
      batch.forEach((d, i) => { indexed[i] = d; });

      const { packet } = await client.buildPacket(indexed, SECRET_KEY);
      const { delta: received } = await server.receiveAndDecode(packet, SECRET_KEY);

      // All 20 deltas should arrive intact
      expect(Object.keys(received)).toHaveLength(20);

      // Verify diverse path types
      const paths = new Set();
      for (const key of Object.keys(received)) {
        const delta = received[key];
        for (const update of delta.updates) {
          for (const v of update.values) {
            paths.add(v.path.split(".")[0]);
          }
        }
      }
      // Should contain navigation, environment, propulsion, electrical
      expect(paths.has("navigation")).toBe(true);
      expect(paths.has("environment")).toBe(true);
      expect(paths.has("propulsion")).toBe(true);
      expect(paths.has("electrical")).toBe(true);
    });

    test("scenario: high-frequency updates under packet loss with retransmission", async () => {
      const client = createV2ClientPipeline({ maxRetransmits: 5 });
      const sim = new NetworkSimulator({ packetLoss: 0.10 });
      const parser = new PacketParser();
      const receivedSet = new Set();

      // 5Hz updates for 10 seconds = 50 packets
      const numPackets = 50;
      const allPackets = [];
      for (let i = 0; i < numPackets; i++) {
        const data = { 0: makeNavigationDelta(60 + i * 0.00001, 24) };
        allPackets.push(await client.buildPacket(data, SECRET_KEY));
      }

      // Initial send through lossy network
      for (const { packet } of allPackets) {
        sim.send(packet, (pkt) => {
          try {
            const p = parser.parseHeader(pkt);
            receivedSet.add(p.sequence);
          } catch { /* skip */ }
        });
      }

      // Retransmit rounds
      for (let round = 0; round < 4; round++) {
        const missing = [];
        for (let i = 0; i < numPackets; i++) {
          if (!receivedSet.has(i)) missing.push(i);
        }
        if (missing.length === 0) break;

        const retransmitted = client.retransmitQueue.retransmit(missing);
        for (const { packet } of retransmitted) {
          sim.send(packet, (pkt) => {
            try {
              const p = parser.parseHeader(pkt);
              receivedSet.add(p.sequence);
            } catch { /* skip */ }
          });
        }
      }

      expect(receivedSet.size / numPackets).toBeGreaterThan(0.98);
      sim.destroy();
    });

    test("scenario: packet stays under MTU with realistic data", async () => {
      const deltas = makeRealisticBatch(3);
      const indexed = {};
      deltas.forEach((d, i) => { indexed[i] = d; });

      const { compressed } = await v1Compress(indexed);
      const encrypted = encryptBinary(compressed, SECRET_KEY);

      // V1 packet size
      expect(encrypted.length).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);

      // V2 packet size
      const builder = new PacketBuilder();
      const v2Packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });
      expect(v2Packet.length).toBeLessThan(MAX_SAFE_UDP_PAYLOAD);
    });

    test("scenario: compression ratio with path dictionary vs without", async () => {
      const deltas = makeRealisticBatch(10);
      const indexed = {};
      deltas.forEach((d, i) => { indexed[i] = d; });

      // Without path dictionary
      const { compressed: withoutPD } = await v1Compress(indexed);
      const rawSize = Buffer.from(JSON.stringify(indexed), "utf8").length;

      // With path dictionary
      const encodedDeltas = {};
      deltas.forEach((d, i) => { encodedDeltas[i] = encodeDelta(d); });
      const { compressed: withPD } = await v1Compress(encodedDeltas);

      // Path dictionary should produce same or better compression
      expect(withPD.length).toBeLessThanOrEqual(withoutPD.length + 50); // allow small variance

      // Both should compress significantly
      const ratioWithout = (1 - withoutPD.length / rawSize) * 100;
      const ratioWith = (1 - withPD.length / rawSize) * 100;
      expect(ratioWithout).toBeGreaterThan(70);
      expect(ratioWith).toBeGreaterThan(70);
    });

    test("scenario: compression ratio with MessagePack vs JSON", async () => {
      const deltas = makeRealisticBatch(10);
      const indexed = {};
      deltas.forEach((d, i) => { indexed[i] = d; });

      // JSON
      const { compressed: jsonCompressed, serialized: jsonSerialized } = await v1Compress(indexed, false);
      // MessagePack
      const { compressed: msgpackCompressed, serialized: msgpackSerialized } = await v1Compress(indexed, true);

      // MessagePack serialized should be smaller than JSON
      expect(msgpackSerialized.length).toBeLessThan(jsonSerialized.length);

      // After Brotli compression, difference should be smaller but both should compress well
      const jsonRatio = (1 - jsonCompressed.length / jsonSerialized.length) * 100;
      const msgpackRatio = (1 - msgpackCompressed.length / msgpackSerialized.length) * 100;
      expect(jsonRatio).toBeGreaterThan(50);
      expect(msgpackRatio).toBeGreaterThan(30);
    });

    test("scenario: unicode and special characters in vessel data", async () => {
      const delta = {
        context: "vessels.urn:mrn:imo:mmsi:230035780",
        updates: [{
          source: { label: "AIS" },
          timestamp: new Date().toISOString(),
          values: [
            { path: "navigation.destination.commonName", value: "Mariehamn (Åland)" },
            { path: "name", value: "M/V Nörd Sjöfarare" },
            { path: "communication.callsignVhf", value: "OH1234" }
          ]
        }]
      };

      // V1 round-trip
      const v1Packet = await v1Pack(delta, SECRET_KEY);
      const v1Recovered = await v1Unpack(v1Packet, SECRET_KEY);
      expect(v1Recovered.updates[0].values[0].value).toBe("Mariehamn (Åland)");
      expect(v1Recovered.updates[0].values[1].value).toBe("M/V Nörd Sjöfarare");

      // V2 round-trip
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();
      const { packet } = await client.buildPacket({ 0: delta }, SECRET_KEY);
      const { delta: v2Recovered } = await server.receiveAndDecode(packet, SECRET_KEY);
      expect(v2Recovered["0"].updates[0].values[0].value).toBe("Mariehamn (Åland)");
    });

    test("scenario: empty and null values in delta", async () => {
      const delta = {
        context: "vessels.urn:mrn:imo:mmsi:230035780",
        updates: [{
          source: { label: "test" },
          timestamp: new Date().toISOString(),
          values: [
            { path: "navigation.speedOverGround", value: 0 },
            { path: "navigation.courseOverGroundTrue", value: null },
            { path: "navigation.state", value: "" }
          ]
        }]
      };

      const packet = await v1Pack(delta, SECRET_KEY);
      const recovered = await v1Unpack(packet, SECRET_KEY);

      expect(recovered.updates[0].values[0].value).toBe(0);
      expect(recovered.updates[0].values[1].value).toBeNull();
      expect(recovered.updates[0].values[2].value).toBe("");
    });

    test("scenario: large GNSS satellite data (GSV-like)", async () => {
      const satellites = Array.from({ length: 32 }, (_, i) => ({
        id: i + 1,
        elevation: Math.random() * 90,
        azimuth: Math.random() * 360,
        snr: Math.random() * 50
      }));

      const delta = {
        context: "vessels.urn:mrn:imo:mmsi:230035780",
        updates: [{
          source: { label: "GPS", sentence: "GSV" },
          timestamp: new Date().toISOString(),
          values: [
            { path: "navigation.gnss.satellites", value: 32 },
            { path: "navigation.gnss.satellitesInView", value: satellites }
          ]
        }]
      };

      const packet = await v1Pack(delta, SECRET_KEY);
      const recovered = await v1Unpack(packet, SECRET_KEY);

      expect(recovered.updates[0].values[0].value).toBe(32);
      expect(recovered.updates[0].values[1].value).toHaveLength(32);
    });
  });

  // ==========================================================
  // Pipeline Performance
  // ==========================================================
  describe("Pipeline Performance", () => {
    test("v1 pipeline latency < 10ms per delta", async () => {
      const delta = makeNavigationDelta();
      const iterations = 50;
      const times = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        const packet = await v1Pack(delta, SECRET_KEY);
        await v1Unpack(packet, SECRET_KEY);
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avg).toBeLessThan(10);
    });

    test("v2 pipeline latency < 15ms per delta (includes header processing)", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();
      const iterations = 50;
      const times = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        const data = { 0: makeNavigationDelta() };
        const { packet } = await client.buildPacket(data, SECRET_KEY);
        await server.receiveAndDecode(packet, SECRET_KEY);
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avg).toBeLessThan(15);
    });

    test("v2 packet building overhead is minimal", async () => {
      const builder = new PacketBuilder();
      const iterations = 10000;

      const payload = Buffer.alloc(100, 0x42);
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        builder.buildDataPacket(payload, { compressed: true, encrypted: true });
      }

      const elapsed = Date.now() - start;
      // 10000 packets should build in < 500ms
      expect(elapsed).toBeLessThan(500);
    });

    test("sequence tracker handles 10000 sequences without memory leak", () => {
      const tracker = new SequenceTracker({ maxOutOfOrder: 100 });

      for (let i = 0; i < 10000; i++) {
        tracker.processSequence(i);
      }

      expect(tracker.expectedSeq).toBe(10000);
      // receivedSeqs should be bounded by maxOutOfOrder cleanup
      expect(tracker.receivedSeqs.size).toBeLessThan(200);
      tracker.reset();
    });

    test("retransmit queue bounded memory with eviction", () => {
      const queue = new RetransmitQueue({ maxSize: 100, maxRetransmits: 3 });
      const builder = new PacketBuilder();

      for (let i = 0; i < 200; i++) {
        queue.add(i, builder.buildDataPacket(Buffer.from(`data ${i}`)));
      }

      // Queue should never exceed maxSize
      expect(queue.getSize()).toBe(100);
      // Should have the most recent 100 packets
      expect(queue.get(100)).toBeDefined();
      expect(queue.get(199)).toBeDefined();
    });
  });

  // ==========================================================
  // Error Handling
  // ==========================================================
  describe("Error Handling", () => {
    test("v1: corrupted encrypted packet is rejected", async () => {
      const delta = makeNavigationDelta();
      const packet = await v1Pack(delta, SECRET_KEY);

      // Corrupt the payload
      const corrupted = Buffer.from(packet);
      corrupted[15] ^= 0xff;
      corrupted[16] ^= 0xff;

      await expect(v1Unpack(corrupted, SECRET_KEY)).rejects.toThrow();
    });

    test("v2: corrupted CRC is detected", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const { packet } = await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY);

      // Corrupt the CRC bytes (bytes 13-14 in header)
      const corrupted = Buffer.from(packet);
      corrupted[13] ^= 0xff;

      expect(() => server.parser.parseHeader(corrupted)).toThrow(/CRC/);
    });

    test("v2: wrong key fails on server side", async () => {
      const client = createV2ClientPipeline();
      const server = createV2ServerPipeline();

      const { packet } = await client.buildPacket({ 0: makeNavigationDelta() }, SECRET_KEY);

      // Server tries to decode with wrong key
      await expect(async () => {
        const parsed = server.parser.parseHeader(packet);
        decryptBinary(parsed.payload, WRONG_KEY);
      }).rejects.toThrow();
    });

    test("v2: truncated packet is rejected", () => {
      const parser = new PacketParser();
      const truncated = Buffer.alloc(10); // Less than HEADER_SIZE

      expect(() => parser.parseHeader(truncated)).toThrow(/too small/);
    });

    test("v2: non-v2 data is rejected by isV2Packet", () => {
      const parser = new PacketParser();
      const randomData = Buffer.from("this is not a v2 packet at all!");

      expect(parser.isV2Packet(randomData)).toBe(false);
    });

    test("v1: empty data handling", async () => {
      expect(() => encryptBinary(Buffer.alloc(0), SECRET_KEY)).toThrow();
    });

    test("v2: server pipeline gracefully handles non-v2 packet", async () => {
      const serverMetrics = createMetrics();
      const serverState = {
        options: { useMsgpack: false, usePathDictionary: false },
        socketUdp: { send: (msg, port, host, cb) => { if (cb) cb(null); } }
      };
      const receivedMessages = [];
      const mockApp = {
        debug: jest.fn(),
        error: jest.fn(),
        handleMessage: jest.fn((id, msg) => receivedMessages.push(msg)),
        setPluginStatus: jest.fn()
      };

      const serverPipeline = createPipeline(2, "server", mockApp, serverState, serverMetrics);

      // Send a non-v2 packet (raw encrypted v1 data)
      const v1Packet = await v1Pack({ 0: makeNavigationDelta() }, SECRET_KEY);
      await serverPipeline.receivePacket(v1Packet, SECRET_KEY, {
        address: "127.0.0.1", port: 6000
      });

      // Should be silently ignored, no crash
      expect(receivedMessages).toHaveLength(0);
      serverPipeline.stopACKTimer();
    });
  });
});
