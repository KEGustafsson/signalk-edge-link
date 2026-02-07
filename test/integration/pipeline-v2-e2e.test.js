"use strict";

const zlib = require("zlib");
const { promisify } = require("util");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");
const { PacketBuilder, PacketParser, PacketType, HEADER_SIZE } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");
const { createPipeline } = require("../../lib/pipeline-factory");
const createMetrics = require("../../lib/metrics");

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const SECRET_KEY = "12345678901234567890123456789012";

describe("V2 Pipeline End-to-End", () => {
  describe("Pipeline Factory", () => {
    let metricsApi;
    let state;
    const mockApp = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn()
    };

    beforeEach(() => {
      metricsApi = createMetrics();
      state = { options: { useMsgpack: false, usePathDictionary: false } };
    });

    test("creates v1 pipeline by default", () => {
      const pipeline = createPipeline(1, "client", mockApp, state, metricsApi);
      expect(pipeline.packCrypt).toBeDefined();
      expect(pipeline.unpackDecrypt).toBeDefined();
    });

    test("creates v2 client pipeline", () => {
      const pipeline = createPipeline(2, "client", mockApp, state, metricsApi);
      expect(pipeline.sendDelta).toBeDefined();
      expect(pipeline.getPacketBuilder).toBeDefined();
    });

    test("creates v2 server pipeline", () => {
      const pipeline = createPipeline(2, "server", mockApp, state, metricsApi);
      expect(pipeline.receivePacket).toBeDefined();
      expect(pipeline.getSequenceTracker).toBeDefined();
      expect(pipeline.getMetrics).toBeDefined();
    });
  });

  describe("V2 Packet Round-Trip (manual pipeline)", () => {
    test("transmits delta through v2 protocol: build → parse → verify", async () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();

      const testDelta = {
        updates: [{
          source: { label: "test" },
          timestamp: new Date().toISOString(),
          values: [
            { path: "navigation.position.latitude", value: 60.1 },
            { path: "navigation.position.longitude", value: 24.9 }
          ]
        }]
      };

      // Client side: serialize → compress → encrypt → packet build
      const serialized = Buffer.from(JSON.stringify({ 0: testDelta }), "utf8");
      const compressed = await brotliCompressAsync(serialized, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: serialized.length
        }
      });
      const encrypted = encryptBinary(compressed, SECRET_KEY);
      const packet = builder.buildDataPacket(encrypted, {
        compressed: true,
        encrypted: true
      });

      // Server side: packet parse → sequence track → decrypt → decompress
      const parsed = parser.parseHeader(packet);
      const seqResult = tracker.processSequence(parsed.sequence);

      expect(parsed.type).toBe(PacketType.DATA);
      expect(parsed.flags.compressed).toBe(true);
      expect(parsed.flags.encrypted).toBe(true);
      expect(seqResult.inOrder).toBe(true);
      expect(seqResult.duplicate).toBe(false);

      const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
      const decompressed = await brotliDecompressAsync(decrypted);
      const received = JSON.parse(decompressed.toString());

      expect(received["0"]).toEqual(testDelta);
      expect(received["0"].updates[0].values).toHaveLength(2);
      expect(received["0"].updates[0].values[0].path).toBe("navigation.position.latitude");
      tracker.reset();
    });

    test("handles multiple sequential packets correctly", async () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();

      const receivedValues = [];

      for (let i = 0; i < 5; i++) {
        const delta = {
          updates: [{
            source: { label: "test" },
            timestamp: new Date().toISOString(),
            values: [{ path: "test.value", value: i }]
          }]
        };

        // Client: serialize → compress → encrypt → packet build
        const serialized = Buffer.from(JSON.stringify({ 0: delta }), "utf8");
        const compressed = await brotliCompressAsync(serialized);
        const encrypted = encryptBinary(compressed, SECRET_KEY);
        const packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });

        // Server: parse → track → decrypt → decompress
        const parsed = parser.parseHeader(packet);
        const seqResult = tracker.processSequence(parsed.sequence);

        expect(seqResult.inOrder).toBe(true);
        expect(parsed.sequence).toBe(i);

        const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
        const decompressed = await brotliDecompressAsync(decrypted);
        const received = JSON.parse(decompressed.toString());
        receivedValues.push(received["0"].updates[0].values[0].value);
      }

      expect(receivedValues).toEqual([0, 1, 2, 3, 4]);
      expect(tracker.expectedSeq).toBe(5);
      tracker.reset();
    });

    test("detects packet loss in v2 stream", async () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();

      // Build 5 packets
      const packets = [];
      for (let i = 0; i < 5; i++) {
        builder.setSequence(i);
        const serialized = Buffer.from(JSON.stringify({ value: i }), "utf8");
        const compressed = await brotliCompressAsync(serialized);
        const encrypted = encryptBinary(compressed, SECRET_KEY);
        packets.push(builder.buildDataPacket(encrypted, { compressed: true, encrypted: true }));
      }

      // Deliver packets 0, 1, 3, 4 (skip 2)
      const deliveryOrder = [0, 1, 3, 4];
      let missingDetected = [];

      for (const idx of deliveryOrder) {
        const parsed = parser.parseHeader(packets[idx]);
        const seqResult = tracker.processSequence(parsed.sequence);
        if (seqResult.missing.length > 0) {
          missingDetected.push(...seqResult.missing);
        }
      }

      expect(missingDetected).toContain(2);
      tracker.reset();
    });

    test("detects duplicate packets in v2 stream", async () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();

      const serialized = Buffer.from(JSON.stringify({ value: "test" }), "utf8");
      const compressed = await brotliCompressAsync(serialized);
      const encrypted = encryptBinary(compressed, SECRET_KEY);
      const packet = builder.buildDataPacket(encrypted, { compressed: true, encrypted: true });

      // Parse same packet twice
      const parsed1 = parser.parseHeader(packet);
      const result1 = tracker.processSequence(parsed1.sequence);
      expect(result1.duplicate).toBe(false);

      const parsed2 = parser.parseHeader(packet);
      const result2 = tracker.processSequence(parsed2.sequence);
      expect(result2.duplicate).toBe(true);
      tracker.reset();
    });
  });

  describe("V2 Packet Overhead", () => {
    test("v2 header adds exactly HEADER_SIZE bytes", async () => {
      const builder = new PacketBuilder();

      const serialized = Buffer.from(JSON.stringify({ test: "data" }), "utf8");
      const compressed = await brotliCompressAsync(serialized);
      const encrypted = encryptBinary(compressed, SECRET_KEY);

      const v2Packet = builder.buildDataPacket(encrypted, {
        compressed: true,
        encrypted: true
      });

      expect(v2Packet.length).toBe(encrypted.length + HEADER_SIZE);
    });
  });

  describe("V2 Packet Type Handling", () => {
    test("heartbeat packets are recognized", () => {
      const builder = new PacketBuilder();
      const parser = new PacketParser();

      const heartbeat = builder.buildHeartbeatPacket();
      const parsed = parser.parseHeader(heartbeat);

      expect(parsed.type).toBe(PacketType.HEARTBEAT);
      expect(parsed.payloadLength).toBe(0);
    });

    test("ACK/NAK round-trip for loss recovery", () => {
      const clientBuilder = new PacketBuilder();
      const serverBuilder = new PacketBuilder();
      const parser = new PacketParser();
      const tracker = new SequenceTracker();

      // Client sends seq 0, 1, 3 (missing 2)
      for (const seq of [0, 1, 3]) {
        clientBuilder.setSequence(seq);
        const packet = clientBuilder.buildDataPacket(Buffer.from(`data-${seq}`));
        const parsed = parser.parseHeader(packet);
        const result = tracker.processSequence(parsed.sequence);

        if (result.missing.length > 0) {
          // Server sends NAK
          const nakPacket = serverBuilder.buildNAKPacket(result.missing);
          const parsedNak = parser.parseHeader(nakPacket);

          expect(parsedNak.type).toBe(PacketType.NAK);
          const missingSeqs = parser.parseNAKPayload(parsedNak.payload);
          expect(missingSeqs).toContain(2);
        }
      }

      // Client retransmits seq 2
      clientBuilder.setSequence(2);
      const retransmit = clientBuilder.buildDataPacket(Buffer.from("data-2"));
      const parsedRetransmit = parser.parseHeader(retransmit);
      const retransmitResult = tracker.processSequence(parsedRetransmit.sequence);

      expect(retransmitResult.inOrder).toBe(true);
      expect(tracker.expectedSeq).toBe(4);

      // Server sends ACK for cumulative seq
      const ackPacket = serverBuilder.buildACKPacket(tracker.expectedSeq - 1);
      const parsedAck = parser.parseHeader(ackPacket);
      expect(parser.parseACKPayload(parsedAck.payload)).toBe(3);
      tracker.reset();
    });

    test("isV2Packet distinguishes v2 from v1 packets", () => {
      const parser = new PacketParser();
      const builder = new PacketBuilder();

      // v2 packet
      const v2 = builder.buildDataPacket(Buffer.from("v2"));
      expect(parser.isV2Packet(v2)).toBe(true);

      // Simulated v1 packet (just raw encrypted data, no header)
      const v1 = encryptBinary(Buffer.from("v1 raw data"), SECRET_KEY);
      expect(parser.isV2Packet(v1)).toBe(false);
    });
  });
});
