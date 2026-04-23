"use strict";

const { PacketBuilder, PacketParser, PacketType, getTypeName } = require("../../lib/packet");

describe("PacketBuilder.buildMetadataPacket", () => {
  let builder;

  beforeEach(() => {
    builder = new PacketBuilder();
  });

  test("emits packet type 0x06 METADATA", () => {
    const packet = builder.buildMetadataPacket(Buffer.from("meta-payload"));
    expect(packet[3]).toBe(PacketType.METADATA);
    expect(PacketType.METADATA).toBe(0x06);
  });

  test("advances sequence so subsequent DATA/META use distinct seqs", () => {
    builder.buildMetadataPacket(Buffer.from("a"));
    const dataPacket = builder.buildDataPacket(Buffer.from("b"));
    expect(dataPacket.readUInt32BE(5)).toBe(1);
  });

  test("round-trips through PacketParser with all flags", () => {
    const payload = Buffer.from("round-trip");
    const packet = builder.buildMetadataPacket(payload, {
      compressed: true,
      encrypted: true,
      messagepack: true,
      pathDictionary: true
    });
    const parser = new PacketParser();
    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.METADATA);
    expect(parsed.typeName).toBe("METADATA");
    expect(parsed.flags).toEqual({
      compressed: true,
      encrypted: true,
      messagepack: true,
      pathDictionary: true
    });
    // METADATA payloads are treated like DATA (no CRC trailer, no auth tag) so
    // the entire payload survives the round trip byte-for-byte.
    expect(parsed.payload.toString()).toBe("round-trip");
  });
});

describe("PacketBuilder.buildMetaRequestPacket", () => {
  test("emits packet type 0x07 META_REQUEST with empty payload (v2)", () => {
    const builder = new PacketBuilder();
    const packet = builder.buildMetaRequestPacket();
    expect(packet[3]).toBe(PacketType.META_REQUEST);
    expect(PacketType.META_REQUEST).toBe(0x07);
  });

  test("parses back cleanly on v2", () => {
    const builder = new PacketBuilder();
    const packet = builder.buildMetaRequestPacket();
    const parser = new PacketParser();
    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.META_REQUEST);
    expect(parsed.payload.length).toBe(0);
  });

  test("round-trips under v3 authenticated control", () => {
    const secretKey = "12345678901234567890123456789012"; // 32-char ASCII
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey });
    const parser = new PacketParser({ secretKey });
    const packet = builder.buildMetaRequestPacket();
    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.META_REQUEST);
    expect(parsed.payload.length).toBe(0);
  });
});

describe("getTypeName", () => {
  test("labels METADATA and META_REQUEST", () => {
    expect(getTypeName(PacketType.METADATA)).toBe("METADATA");
    expect(getTypeName(PacketType.META_REQUEST)).toBe("META_REQUEST");
  });
});
