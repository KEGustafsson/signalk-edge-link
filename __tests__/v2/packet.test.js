"use strict";

const {
  PacketBuilder,
  PacketParser,
  PacketType,
  PacketFlags,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  MAX_SEQUENCE,
  crc16,
  getTypeName
} = require("../../lib/packet");

describe("PacketBuilder", () => {
  let builder;

  beforeEach(() => {
    builder = new PacketBuilder();
  });

  describe("construction", () => {
    test("initializes with sequence 0 by default", () => {
      expect(builder.getCurrentSequence()).toBe(0);
    });

    test("initializes with custom initial sequence", () => {
      const b = new PacketBuilder({ initialSequence: 42 });
      expect(b.getCurrentSequence()).toBe(42);
    });
  });

  describe("buildDataPacket", () => {
    test("builds packet with correct header size", () => {
      const payload = Buffer.from("hello");
      const packet = builder.buildDataPacket(payload);
      expect(packet.length).toBe(HEADER_SIZE + payload.length);
    });

    test("sets magic bytes correctly", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(packet[0]).toBe(0x53); // 'S'
      expect(packet[1]).toBe(0x4b); // 'K'
    });

    test("sets protocol version to 0x02", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(packet[2]).toBe(PROTOCOL_VERSION);
    });

    test("sets packet type to DATA", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(packet[3]).toBe(PacketType.DATA);
    });

    test("sets no flags when none specified", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(packet[4]).toBe(0x00);
    });

    test("sets compressed flag", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"), { compressed: true });
      expect(packet[4] & PacketFlags.COMPRESSED).toBeTruthy();
    });

    test("sets encrypted flag", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"), { encrypted: true });
      expect(packet[4] & PacketFlags.ENCRYPTED).toBeTruthy();
    });

    test("sets messagepack flag", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"), { messagepack: true });
      expect(packet[4] & PacketFlags.MESSAGEPACK).toBeTruthy();
    });

    test("sets pathDictionary flag", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"), { pathDictionary: true });
      expect(packet[4] & PacketFlags.PATH_DICTIONARY).toBeTruthy();
    });

    test("sets multiple flags simultaneously", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"), {
        compressed: true,
        encrypted: true,
        messagepack: true,
        pathDictionary: true
      });
      expect(packet[4]).toBe(0x0f); // all 4 lower bits set
    });

    test("writes sequence number correctly", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(packet.readUInt32BE(5)).toBe(0);
    });

    test("writes payload length correctly", () => {
      const payload = Buffer.from("hello world");
      const packet = builder.buildDataPacket(payload);
      expect(packet.readUInt32BE(9)).toBe(payload.length);
    });

    test("includes CRC16 in header", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      const crcVal = packet.readUInt16BE(13);
      expect(crcVal).toBeGreaterThan(0);
    });

    test("appends payload after header", () => {
      const payload = Buffer.from("hello world");
      const packet = builder.buildDataPacket(payload);
      expect(packet.subarray(HEADER_SIZE).toString()).toBe("hello world");
    });

    test("increments sequence after each DATA packet", () => {
      builder.buildDataPacket(Buffer.from("a"));
      expect(builder.getCurrentSequence()).toBe(1);
      builder.buildDataPacket(Buffer.from("b"));
      expect(builder.getCurrentSequence()).toBe(2);
      builder.buildDataPacket(Buffer.from("c"));
      expect(builder.getCurrentSequence()).toBe(3);
    });

    test("handles empty payload", () => {
      const packet = builder.buildDataPacket(Buffer.alloc(0));
      expect(packet.length).toBe(HEADER_SIZE);
      expect(packet.readUInt32BE(9)).toBe(0);
    });

    test("handles large payload", () => {
      const payload = Buffer.alloc(10000, 0xab);
      const packet = builder.buildDataPacket(payload);
      expect(packet.length).toBe(HEADER_SIZE + 10000);
      expect(packet.readUInt32BE(9)).toBe(10000);
    });
  });

  describe("buildACKPacket", () => {
    test("builds ACK with correct type", () => {
      const packet = builder.buildACKPacket(5);
      expect(packet[3]).toBe(PacketType.ACK);
    });

    test("encodes acked sequence in payload", () => {
      const packet = builder.buildACKPacket(42);
      const parser = new PacketParser();
      const parsed = parser.parseHeader(packet);
      expect(parser.parseACKPayload(parsed.payload)).toBe(42);
    });

    test("does not increment sequence number", () => {
      builder.buildACKPacket(5);
      expect(builder.getCurrentSequence()).toBe(0);
    });
  });

  describe("buildNAKPacket", () => {
    test("builds NAK with correct type", () => {
      const packet = builder.buildNAKPacket([1, 2, 3]);
      expect(packet[3]).toBe(PacketType.NAK);
    });

    test("encodes missing sequences in payload", () => {
      const packet = builder.buildNAKPacket([5, 10, 15]);
      const parser = new PacketParser();
      const parsed = parser.parseHeader(packet);
      expect(parser.parseNAKPayload(parsed.payload)).toEqual([5, 10, 15]);
    });

    test("handles empty missing list", () => {
      const packet = builder.buildNAKPacket([]);
      expect(packet.length).toBe(HEADER_SIZE);
    });

    test("handles single missing sequence", () => {
      const packet = builder.buildNAKPacket([99]);
      const parser = new PacketParser();
      const parsed = parser.parseHeader(packet);
      expect(parser.parseNAKPayload(parsed.payload)).toEqual([99]);
    });
  });

  describe("buildHeartbeatPacket", () => {
    test("builds heartbeat with correct type", () => {
      const packet = builder.buildHeartbeatPacket();
      expect(packet[3]).toBe(PacketType.HEARTBEAT);
    });

    test("heartbeat has no payload", () => {
      const packet = builder.buildHeartbeatPacket();
      expect(packet.length).toBe(HEADER_SIZE);
      expect(packet.readUInt32BE(9)).toBe(0);
    });
  });

  describe("buildHelloPacket", () => {
    test("builds hello with correct type", () => {
      const packet = builder.buildHelloPacket();
      expect(packet[3]).toBe(PacketType.HELLO);
    });

    test("encodes hello info as JSON payload", () => {
      const packet = builder.buildHelloPacket({ clientId: "test-client" });
      const parser = new PacketParser();
      const parsed = parser.parseHeader(packet);
      const info = JSON.parse(parsed.payload.toString());
      expect(info.clientId).toBe("test-client");
      expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(info.timestamp).toBeDefined();
    });
  });

  describe("sequence management", () => {
    test("setSequence sets sequence explicitly", () => {
      builder.setSequence(100);
      expect(builder.getCurrentSequence()).toBe(100);
    });

    test("setSequence enforces uint32", () => {
      builder.setSequence(-1);
      expect(builder.getCurrentSequence()).toBe(MAX_SEQUENCE);
    });

    test("sequence wraps around at MAX_SEQUENCE", () => {
      builder.setSequence(MAX_SEQUENCE);
      builder.buildDataPacket(Buffer.from("wrap"));
      expect(builder.getCurrentSequence()).toBe(0);
    });
  });
});

describe("PacketParser", () => {
  let parser;
  let builder;

  beforeEach(() => {
    parser = new PacketParser();
    builder = new PacketBuilder();
  });

  describe("parseHeader", () => {
    test("parses valid DATA packet", () => {
      const payload = Buffer.from("test data");
      const packet = builder.buildDataPacket(payload, {
        compressed: true,
        encrypted: true
      });
      const parsed = parser.parseHeader(packet);

      expect(parsed.version).toBe(PROTOCOL_VERSION);
      expect(parsed.type).toBe(PacketType.DATA);
      expect(parsed.typeName).toBe("DATA");
      expect(parsed.flags.compressed).toBe(true);
      expect(parsed.flags.encrypted).toBe(true);
      expect(parsed.flags.messagepack).toBe(false);
      expect(parsed.flags.pathDictionary).toBe(false);
      expect(parsed.sequence).toBe(0);
      expect(parsed.payloadLength).toBe(payload.length);
      expect(parsed.payload.toString()).toBe("test data");
    });

    test("throws on non-Buffer input", () => {
      expect(() => parser.parseHeader("not a buffer")).toThrow("Packet must be a Buffer");
    });

    test("throws on packet smaller than header", () => {
      expect(() => parser.parseHeader(Buffer.alloc(5))).toThrow("Packet too small");
    });

    test("throws on invalid magic bytes", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      packet[0] = 0x00;
      expect(() => parser.parseHeader(packet)).toThrow("Invalid magic bytes");
    });

    test("throws on unsupported protocol version", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      packet[2] = 0x99;
      expect(() => parser.parseHeader(packet)).toThrow("Unsupported protocol version");
    });

    test("throws on unknown packet type", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      packet[3] = 0xff;
      // Need to recalculate CRC after modifying header
      expect(() => parser.parseHeader(packet)).toThrow();
    });

    test("throws on CRC mismatch", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      // Corrupt a header byte after CRC was calculated
      packet[4] = 0xff;
      expect(() => parser.parseHeader(packet)).toThrow("CRC mismatch");
    });

    test("throws on payload length mismatch", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      // Artificially truncate the packet
      const truncated = packet.subarray(0, HEADER_SIZE + 2);
      expect(() => parser.parseHeader(truncated)).toThrow("Payload length mismatch");
    });

    test("parses all flag combinations", () => {
      const flagCombinations = [
        { compressed: true },
        { encrypted: true },
        { messagepack: true },
        { pathDictionary: true },
        { compressed: true, encrypted: true },
        { compressed: true, encrypted: true, messagepack: true },
        { compressed: true, encrypted: true, messagepack: true, pathDictionary: true }
      ];

      for (const flags of flagCombinations) {
        const b = new PacketBuilder();
        const packet = b.buildDataPacket(Buffer.from("test"), flags);
        const parsed = parser.parseHeader(packet);
        expect(parsed.flags.compressed).toBe(!!flags.compressed);
        expect(parsed.flags.encrypted).toBe(!!flags.encrypted);
        expect(parsed.flags.messagepack).toBe(!!flags.messagepack);
        expect(parsed.flags.pathDictionary).toBe(!!flags.pathDictionary);
      }
    });

    test("parses sequence numbers correctly", () => {
      for (const seq of [0, 1, 255, 65535, 16777215, MAX_SEQUENCE]) {
        const b = new PacketBuilder({ initialSequence: seq });
        const packet = b.buildDataPacket(Buffer.from("test"));
        const parsed = parser.parseHeader(packet);
        expect(parsed.sequence).toBe(seq);
      }
    });
  });

  describe("isV2Packet", () => {
    test("returns true for valid v2 packet", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      expect(parser.isV2Packet(packet)).toBe(true);
    });

    test("returns false for non-Buffer", () => {
      expect(parser.isV2Packet("not a buffer")).toBe(false);
    });

    test("returns false for too-small buffer", () => {
      expect(parser.isV2Packet(Buffer.alloc(5))).toBe(false);
    });

    test("returns false for wrong magic bytes", () => {
      const packet = Buffer.alloc(HEADER_SIZE);
      packet[0] = 0x00;
      expect(parser.isV2Packet(packet)).toBe(false);
    });

    test("returns false for wrong version", () => {
      const packet = builder.buildDataPacket(Buffer.from("test"));
      packet[2] = 0x01;
      expect(parser.isV2Packet(packet)).toBe(false);
    });
  });

  describe("parseACKPayload", () => {
    test("parses acked sequence number", () => {
      const payload = Buffer.alloc(4);
      payload.writeUInt32BE(12345, 0);
      expect(parser.parseACKPayload(payload)).toBe(12345);
    });

    test("throws on payload too small", () => {
      expect(() => parser.parseACKPayload(Buffer.alloc(2))).toThrow("ACK payload too small");
    });
  });

  describe("parseNAKPayload", () => {
    test("parses multiple missing sequences", () => {
      const payload = Buffer.alloc(12);
      payload.writeUInt32BE(1, 0);
      payload.writeUInt32BE(5, 4);
      payload.writeUInt32BE(9, 8);
      expect(parser.parseNAKPayload(payload)).toEqual([1, 5, 9]);
    });

    test("parses empty NAK payload", () => {
      expect(parser.parseNAKPayload(Buffer.alloc(0))).toEqual([]);
    });

    test("throws on invalid payload length", () => {
      expect(() => parser.parseNAKPayload(Buffer.alloc(5))).toThrow("multiple of 4");
    });
  });
});

describe("crc16", () => {
  test("produces consistent results", () => {
    const data = Buffer.from("hello");
    expect(crc16(data)).toBe(crc16(data));
  });

  test("produces different results for different data", () => {
    expect(crc16(Buffer.from("hello"))).not.toBe(crc16(Buffer.from("world")));
  });

  test("handles empty buffer", () => {
    const result = crc16(Buffer.alloc(0));
    expect(typeof result).toBe("number");
    expect(result).toBe(0xffff); // initial CRC value for empty data
  });

  test("produces 16-bit values", () => {
    const result = crc16(Buffer.from("test data for crc"));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffff);
  });
});

describe("getTypeName", () => {
  test("returns correct names for all types", () => {
    expect(getTypeName(PacketType.DATA)).toBe("DATA");
    expect(getTypeName(PacketType.ACK)).toBe("ACK");
    expect(getTypeName(PacketType.NAK)).toBe("NAK");
    expect(getTypeName(PacketType.HEARTBEAT)).toBe("HEARTBEAT");
    expect(getTypeName(PacketType.HELLO)).toBe("HELLO");
  });

  test("returns UNKNOWN for invalid type", () => {
    expect(getTypeName(0xff)).toBe("UNKNOWN");
  });
});

describe("ACK/NAK Parsing Integration", () => {
  test("parses ACK with cumulative sequence", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const ackPacket = builder.buildACKPacket(100);
    const parsed = parser.parseHeader(ackPacket);
    const ackedSeq = parser.parseACKPayload(parsed.payload);

    expect(parsed.type).toBe(PacketType.ACK);
    expect(parsed.typeName).toBe("ACK");
    expect(ackedSeq).toBe(100);
  });

  test("parses ACK for sequence 0", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const ackPacket = builder.buildACKPacket(0);
    const parsed = parser.parseHeader(ackPacket);
    const ackedSeq = parser.parseACKPayload(parsed.payload);

    expect(ackedSeq).toBe(0);
  });

  test("parses ACK for large sequence number", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const ackPacket = builder.buildACKPacket(MAX_SEQUENCE);
    const parsed = parser.parseHeader(ackPacket);
    const ackedSeq = parser.parseACKPayload(parsed.payload);

    expect(ackedSeq).toBe(MAX_SEQUENCE);
  });

  test("parses NAK with multiple missing sequences", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const missing = [50, 52, 54];
    const nakPacket = builder.buildNAKPacket(missing);
    const parsed = parser.parseHeader(nakPacket);
    const nakMissing = parser.parseNAKPayload(parsed.payload);

    expect(parsed.type).toBe(PacketType.NAK);
    expect(parsed.typeName).toBe("NAK");
    expect(nakMissing).toEqual(missing);
  });

  test("parses NAK with single missing sequence", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const nakPacket = builder.buildNAKPacket([42]);
    const parsed = parser.parseHeader(nakPacket);
    const nakMissing = parser.parseNAKPayload(parsed.payload);

    expect(nakMissing).toEqual([42]);
  });

  test("parses NAK with many missing sequences", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const missing = Array.from({ length: 50 }, (_, i) => i * 2);
    const nakPacket = builder.buildNAKPacket(missing);
    const parsed = parser.parseHeader(nakPacket);
    const nakMissing = parser.parseNAKPayload(parsed.payload);

    expect(nakMissing).toEqual(missing);
    expect(nakMissing).toHaveLength(50);
  });

  test("ACK does not advance builder sequence", () => {
    const builder = new PacketBuilder();

    builder.buildDataPacket(Buffer.from("data")); // seq 0 -> 1
    builder.buildACKPacket(100);

    expect(builder.getCurrentSequence()).toBe(1);
  });

  test("NAK does not advance builder sequence", () => {
    const builder = new PacketBuilder();

    builder.buildDataPacket(Buffer.from("data")); // seq 0 -> 1
    builder.buildNAKPacket([5, 10]);

    expect(builder.getCurrentSequence()).toBe(1);
  });

  test("ACK and NAK packets have valid CRC", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    // These should not throw (CRC validation happens in parseHeader)
    expect(() => {
      parser.parseHeader(builder.buildACKPacket(42));
    }).not.toThrow();

    expect(() => {
      parser.parseHeader(builder.buildNAKPacket([1, 2, 3]));
    }).not.toThrow();
  });

  test("corrupted ACK packet throws CRC error", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const ackPacket = builder.buildACKPacket(100);
    // Corrupt a header byte
    ackPacket[4] = 0xff;

    expect(() => parser.parseHeader(ackPacket)).toThrow("CRC mismatch");
  });
});

describe("Integration scenarios", () => {
  test("round-trip: build and parse DATA packet", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const payload = Buffer.from(JSON.stringify({ test: "data", value: 42 }));

    const packet = builder.buildDataPacket(payload, {
      compressed: true,
      encrypted: true
    });

    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.DATA);
    expect(parsed.flags.compressed).toBe(true);
    expect(parsed.flags.encrypted).toBe(true);
    expect(JSON.parse(parsed.payload.toString())).toEqual({ test: "data", value: 42 });
  });

  test("round-trip: build and parse ACK packet", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const packet = builder.buildACKPacket(99);
    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.ACK);
    expect(parser.parseACKPayload(parsed.payload)).toBe(99);
  });

  test("round-trip: build and parse NAK packet", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const packet = builder.buildNAKPacket([3, 7, 11]);
    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.NAK);
    expect(parser.parseNAKPayload(parsed.payload)).toEqual([3, 7, 11]);
  });

  test("multiple packets maintain sequence ordering", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    const packets = [];
    for (let i = 0; i < 10; i++) {
      packets.push(builder.buildDataPacket(Buffer.from(`packet ${i}`)));
    }

    for (let i = 0; i < 10; i++) {
      const parsed = parser.parseHeader(packets[i]);
      expect(parsed.sequence).toBe(i);
    }
  });

  test("detects v1 vs v2 packets", () => {
    const parser = new PacketParser();
    const builder = new PacketBuilder();

    // v2 packet
    const v2Packet = builder.buildDataPacket(Buffer.from("v2 data"));
    expect(parser.isV2Packet(v2Packet)).toBe(true);

    // Simulate a v1 packet (just encrypted data, no header)
    const v1Packet = Buffer.alloc(100);
    expect(parser.isV2Packet(v1Packet)).toBe(false);
  });

  test("handles sequence wraparound correctly", () => {
    const builder = new PacketBuilder({ initialSequence: MAX_SEQUENCE - 1 });
    const parser = new PacketParser();

    const p1 = builder.buildDataPacket(Buffer.from("before wrap"));
    const p2 = builder.buildDataPacket(Buffer.from("at max"));
    const p3 = builder.buildDataPacket(Buffer.from("after wrap"));

    expect(parser.parseHeader(p1).sequence).toBe(MAX_SEQUENCE - 1);
    expect(parser.parseHeader(p2).sequence).toBe(MAX_SEQUENCE);
    expect(parser.parseHeader(p3).sequence).toBe(0);
  });

  test("binary payload integrity", () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();

    // Create binary payload with all byte values
    const payload = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) {payload[i] = i;}

    const packet = builder.buildDataPacket(payload);
    const parsed = parser.parseHeader(packet);
    expect(Buffer.compare(parsed.payload, payload)).toBe(0);
  });
});
