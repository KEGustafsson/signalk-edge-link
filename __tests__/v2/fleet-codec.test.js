"use strict";

/**
 * Fleet sharing codec (protocol-v3-spec §15): packet types, builders, payload
 * parsers, encrypted HELLO identity, and FLEET_DATA payload round trips.
 */

const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const {
  encodeFleetIdentity,
  decodeFleetIdentity,
  newFleetNonce,
  parseFleetIdentityObject
} = require("../../src/codec/fleet-identity");
const { encodeFleetPayload, decodeFleetPayload } = require("../../src/codec/fleet-payload");

const KEY = "12345678901234567890123456789012";
const OTHER_KEY = "abcdefghijklmnopqrstuvwxyz012345";
const SELF = "vessels.urn:mrn:imo:mmsi:230123456";

describe("fleet packet types", () => {
  test("type values are fixed by the spec", () => {
    expect(PacketType.HELLO_ACK).toBe(0x09);
    expect(PacketType.FLEET_DATA).toBe(0x0a);
    expect(PacketType.FLEET_ACK).toBe(0x0b);
    expect(PacketType.FLEET_NAK).toBe(0x0c);
  });

  test("HELLO_ACK round-trips its JSON and is HMAC-authenticated", () => {
    const builder = new PacketBuilder({ secretKey: KEY });
    const parser = new PacketParser({ secretKey: KEY });
    const info = { v: 1, accepted: ["fleet-v1"], nonce: "0011223344556677" };
    const parsed = parser.parseHeader(builder.buildHelloAckPacket(info));
    expect(parsed.typeName).toBe("HELLO_ACK");
    expect(JSON.parse(parsed.payload.toString())).toEqual(info);

    const wrong = new PacketParser({ secretKey: OTHER_KEY });
    expect(() => wrong.parseHeader(builder.buildHelloAckPacket(info))).toThrow();
  });

  test("FLEET_DATA uses its own sequence and leaves the DATA sequence alone", () => {
    const builder = new PacketBuilder({ secretKey: KEY, authenticatedHeaders: false });
    const parser = new PacketParser({ secretKey: KEY, authenticatedHeaders: false });
    const before = builder.getCurrentSequence();
    const packet = builder.buildFleetDataPacket(0xdeadbeef, 7, Buffer.from("ciphertext!"), {
      messagepack: true
    });
    expect(builder.getCurrentSequence()).toBe(before);

    const parsed = parser.parseHeader(packet);
    expect(parsed.type).toBe(PacketType.FLEET_DATA);
    expect(parsed.sequence).toBe(7);
    expect(parsed.flags.messagepack).toBe(true);
    expect(parsed.flags.encrypted).toBe(true);
    const { stream, encrypted } = parser.parseFleetDataPayload(parsed.payload);
    expect(stream).toBe(0xdeadbeef);
    expect(encrypted.toString()).toBe("ciphertext!");
  });

  test("FLEET_DATA is HMAC-tagged even with authenticatedHeaders off", () => {
    const builder = new PacketBuilder({ secretKey: KEY, authenticatedHeaders: false });
    const parser = new PacketParser({ secretKey: KEY, authenticatedHeaders: false });
    const packet = builder.buildFleetDataPacket(1, 0, Buffer.from("abcdef"));
    // Flip one ciphertext byte: the HMAC must catch it before AES-GCM runs.
    packet[15 + 4] ^= 0xff;
    expect(() => parser.parseHeader(packet)).toThrow(/authentication/i);
  });

  test("FLEET_ACK and FLEET_NAK round-trip; ACK ignores trailing bytes", () => {
    const builder = new PacketBuilder({ secretKey: KEY });
    const parser = new PacketParser({ secretKey: KEY });

    const ack = parser.parseHeader(builder.buildFleetAckPacket(42, 1000));
    expect(parser.parseFleetAckPayload(ack.payload)).toEqual({ stream: 42, sequence: 1000 });
    expect(
      parser.parseFleetAckPayload(Buffer.concat([ack.payload, Buffer.from([1, 2, 3, 4])]))
    ).toEqual({ stream: 42, sequence: 1000 });

    const nak = parser.parseHeader(builder.buildFleetNakPacket(42, [3, 5, 9]));
    expect(parser.parseFleetNakPayload(nak.payload)).toEqual({ stream: 42, missing: [3, 5, 9] });
    expect(() => parser.parseFleetNakPayload(Buffer.alloc(6))).toThrow();
  });

  test("epoch-bound fleet packets verify only against the bound epoch", () => {
    const builder = new PacketBuilder({
      secretKey: KEY,
      epochBoundAuth: true,
      connectionEpoch: 77
    });
    const parser = new PacketParser({ secretKey: KEY, epochBoundAuth: true });
    const packet = builder.buildFleetDataPacket(5, 1, Buffer.from("xyz"));
    expect(parser.parseHeader(packet, { epoch: 77 }).sequence).toBe(1);
    expect(() => parser.parseHeader(packet, { epoch: 78 })).toThrow();
  });

  test("HELLO without a fleet field is byte-identical in its JSON keys", () => {
    const builder = new PacketBuilder({ secretKey: KEY });
    const parser = new PacketParser({ secretKey: KEY });
    const plain = JSON.parse(
      parser.parseHeader(builder.buildHelloPacket({ clientId: "c" })).payload.toString()
    );
    expect(Object.keys(plain).sort()).toEqual(
      ["capabilities", "clientId", "protocolVersion", "timestamp"].sort()
    );
    const withFleet = JSON.parse(
      parser
        .parseHeader(builder.buildHelloPacket({ clientId: "c", fleet: "AAAA" }))
        .payload.toString()
    );
    expect(withFleet.fleet).toBe("AAAA");
  });
});

describe("encrypted fleet identity", () => {
  test("round-trips and hides the vessel context on the wire", () => {
    const nonce = newFleetNonce();
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    const field = encodeFleetIdentity(
      {
        self: SELF,
        nonce,
        pathFilter: { allow: ["navigation.*"], deny: [] },
        maxBytesPerSec: 4096
      },
      KEY
    );
    expect(field).not.toContain("230123456");
    expect(Buffer.from(field, "base64").toString("latin1")).not.toContain("230123456");
    expect(decodeFleetIdentity(field, KEY)).toEqual({
      self: SELF,
      nonce,
      pathFilter: { allow: ["navigation.*"], deny: [] },
      maxBytesPerSec: 4096
    });
  });

  test("rejects a wrong key, tampering, oversize and garbage", () => {
    const field = encodeFleetIdentity({ self: SELF, nonce: newFleetNonce() }, KEY);
    expect(decodeFleetIdentity(field, OTHER_KEY)).toBeNull();
    const raw = Buffer.from(field, "base64");
    raw[raw.length - 1] ^= 1;
    expect(decodeFleetIdentity(raw.toString("base64"), KEY)).toBeNull();
    expect(decodeFleetIdentity("x".repeat(5000), KEY)).toBeNull();
    expect(decodeFleetIdentity(123, KEY)).toBeNull();
    expect(decodeFleetIdentity("not base64 at all", KEY)).toBeNull();
  });

  test("validates the decrypted object", () => {
    const ok = { v: 1, self: SELF, nonce: "0123456789abcdef" };
    expect(parseFleetIdentityObject(ok)).toEqual({ self: SELF, nonce: "0123456789abcdef" });
    expect(parseFleetIdentityObject({ ...ok, v: 2 })).toBeNull();
    expect(parseFleetIdentityObject({ ...ok, self: "vessels.self" })).toBeNull();
    expect(parseFleetIdentityObject({ ...ok, self: "aircraft.x" })).toBeNull();
    expect(parseFleetIdentityObject({ ...ok, nonce: "short" })).toBeNull();
    const capped = parseFleetIdentityObject({
      ...ok,
      pathFilter: { allow: Array.from({ length: 100 }, (_, i) => `p${i}.*`) }
    });
    expect(capped.pathFilter.allow).toHaveLength(32);
  });
});

describe("FLEET_DATA payload", () => {
  const deltas = [
    {
      context: SELF,
      updates: [
        {
          $source: "n2k.115",
          timestamp: "2026-11-02T10:00:00.000Z",
          values: [{ path: "navigation.speedOverGround", value: 3.5 }]
        }
      ]
    }
  ];

  for (const variant of [
    { name: "json", useMsgpack: false, usePathDictionary: false },
    { name: "msgpack", useMsgpack: true, usePathDictionary: false },
    { name: "path dictionary", useMsgpack: false, usePathDictionary: true },
    { name: "msgpack + path dictionary", useMsgpack: true, usePathDictionary: true }
  ]) {
    test(`round-trips with ${variant.name}`, async () => {
      const encrypted = await encodeFleetPayload(deltas, { secretKey: KEY, ...variant });
      const out = await decodeFleetPayload(
        encrypted,
        { messagepack: variant.useMsgpack, pathDictionary: variant.usePathDictionary },
        { secretKey: KEY }
      );
      expect(out).toMatchObject(deltas);
    });
  }

  test("fails authentication with the wrong key", async () => {
    const encrypted = await encodeFleetPayload(deltas, { secretKey: KEY });
    await expect(
      decodeFleetPayload(
        encrypted,
        { messagepack: false, pathDictionary: false },
        { secretKey: OTHER_KEY }
      )
    ).rejects.toThrow();
  });
});

describe("fleet wire layout matches protocol-v3-spec §15", () => {
  const HEADER = 15;
  const TAG = 16;

  test("FLEET_DATA: header, stream id, ciphertext, HMAC tag", () => {
    const builder = new PacketBuilder({ secretKey: KEY, authenticatedHeaders: false });
    const ciphertext = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const packet = builder.buildFleetDataPacket(0x01020304, 0x0a0b0c0d, ciphertext, {
      messagepack: true,
      pathDictionary: true
    });
    expect(packet.subarray(0, 2).toString("ascii")).toBe("SK");
    expect(packet[2]).toBe(0x03);
    expect(packet[3]).toBe(0x0a);
    // COMPRESSED | ENCRYPTED | MESSAGEPACK | PATH_DICTIONARY, no header-auth flag
    expect(packet[4]).toBe(0x0f);
    expect(packet.readUInt32BE(5)).toBe(0x0a0b0c0d);
    expect(packet.readUInt32BE(9)).toBe(4 + ciphertext.length + TAG);
    expect(packet.readUInt32BE(HEADER)).toBe(0x01020304);
    expect(packet.subarray(HEADER + 4, HEADER + 4 + ciphertext.length)).toEqual(ciphertext);
    expect(packet.length).toBe(HEADER + 4 + ciphertext.length + TAG);
  });

  test("FLEET_ACK and FLEET_NAK payloads", () => {
    const builder = new PacketBuilder({ secretKey: KEY });
    const ack = builder.buildFleetAckPacket(0x11223344, 0x55667788);
    expect(ack[3]).toBe(0x0b);
    expect(ack.readUInt32BE(9)).toBe(8 + TAG);
    expect(ack.readUInt32BE(HEADER)).toBe(0x11223344);
    expect(ack.readUInt32BE(HEADER + 4)).toBe(0x55667788);

    const nak = builder.buildFleetNakPacket(7, [1, 2]);
    expect(nak[3]).toBe(0x0c);
    expect(nak.readUInt32BE(9)).toBe(4 + 8 + TAG);
    expect([
      nak.readUInt32BE(HEADER),
      nak.readUInt32BE(HEADER + 4),
      nak.readUInt32BE(HEADER + 8)
    ]).toEqual([7, 1, 2]);
  });

  test("HELLO_ACK carries JSON then the tag", () => {
    const builder = new PacketBuilder({ secretKey: KEY });
    const body = { v: 1, accepted: [] };
    const packet = builder.buildHelloAckPacket(body);
    const json = Buffer.from(JSON.stringify(body));
    expect(packet[3]).toBe(0x09);
    expect(packet.readUInt32BE(9)).toBe(json.length + TAG);
    expect(packet.subarray(HEADER, HEADER + json.length)).toEqual(json);
  });
});
