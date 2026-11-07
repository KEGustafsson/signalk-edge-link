"use strict";

/**
 * Fleet sharing codec (protocol-v3-spec §15): packet types, builders, payload
 * parsers, encrypted HELLO identity, and FLEET_DATA payload round trips.
 */

const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const {
  encodeFleetIdentity,
  decodeFleetIdentity,
  fleetPathFilterFits,
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
    expect(parseFleetIdentityObject({ ...ok, maxBytesPerSec: 0.5 }).maxBytesPerSec).toBe(256);
    // Zero or negative is still a request, raised to the minimum, not ignored
    // (ignoring it would leave the session at the server's full rate).
    expect(parseFleetIdentityObject({ ...ok, maxBytesPerSec: 0 }).maxBytesPerSec).toBe(256);
    expect(parseFleetIdentityObject({ ...ok, maxBytesPerSec: -5 }).maxBytesPerSec).toBe(256);
    expect(parseFleetIdentityObject({ ...ok, maxBytesPerSec: 4096 }).maxBytesPerSec).toBe(4096);
  });
});

describe("fleet identity size", () => {
  /**
   * A near-limit allow list: as many 103-character patterns as
   * fleetPathFilterFits accepts, to test encoding with large own contexts.
   */
  function nearLimitFilter() {
    const allow = [];
    for (let i = 0; i < 32; i++) {
      const next = [...allow, `${"x".repeat(100)}.${String(i).padStart(2, "0")}`];
      if (!fleetPathFilterFits({ allow: next })) {
        break;
      }
      allow.push(next[next.length - 1]);
    }
    return { allow, deny: [] };
  }

  test("a path filter the check accepts fits with any valid own context", () => {
    const pathFilter = nearLimitFilter();
    expect(pathFilter.allow.length).toBeGreaterThan(0);
    const contexts = [
      `vessels.${"a".repeat(248)}`,
      // 2-byte UTF-8 characters, 256 bytes in all
      `vessels.${"é".repeat(124)}`,
      // escaped in JSON: 6 bytes each
      `vessels.${"\u0001".repeat(41)}`
    ];
    for (const self of contexts) {
      const field = encodeFleetIdentity(
        { self, nonce: newFleetNonce(), pathFilter, maxBytesPerSec: 10_000_000 },
        KEY
      );
      expect(decodeFleetIdentity(field, KEY).self).toBe(self);
    }
  });

  test("an own context longer than 256 bytes encoded is refused, whatever its length in characters", () => {
    const self = `vessels.${"é".repeat(200)}`; // 208 characters, 408 bytes
    expect(parseFleetIdentityObject({ v: 1, self, nonce: "0123456789abcdef" })).toBeNull();
    expect(() => encodeFleetIdentity({ self, nonce: newFleetNonce() }, KEY)).toThrow(
      /longer than 256 bytes/
    );
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

describe("fleet test vectors (protocol-v3-spec §15.11)", () => {
  // Computed independently of PacketBuilder; also listed in the spec.
  const VECTOR_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const VECTORS = {
    FLEET_ACK: "534b030b00000000000000001878fd0102030400000010867130d10c17e6d48759ea94d6ec7fe8",
    FLEET_NAK:
      "534b030c00000000000000001c2483010203040000000500000007435cf5158835af1e54650d31c06ee280",
    HELLO_ACK:
      "534b030900000000000000007c8a557b2276223a312c226163636570746564223a5b22666c6565742d7631225d2c226e6f6e6365223a2230303131323233333434353536363737222c22666c656574223a7b2273747265616d223a31363930393036302c226d61784279746573506572536563223a343039367d7d4c1b5de5f08854fbd3ac02066dafe40e",
    FLEET_DATA:
      "534b030a030000000700000024aaf701020304aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaafe8c56f292f29fe0098624eab0c6a5a8",
    FLEET_ACK_EPOCH:
      "534b030b200000000000000018df0101020304000000101854b54731d487a6b6afee248e9574dc"
  };

  test("builders produce the specified bytes", () => {
    const builder = new PacketBuilder({ secretKey: VECTOR_KEY });
    expect(builder.buildFleetAckPacket(0x01020304, 16).toString("hex")).toBe(VECTORS.FLEET_ACK);
    expect(builder.buildFleetNakPacket(0x01020304, [5, 7]).toString("hex")).toBe(VECTORS.FLEET_NAK);
    expect(
      builder
        .buildHelloAckPacket({
          v: 1,
          accepted: ["fleet-v1"],
          nonce: "0011223344556677",
          fleet: { stream: 16909060, maxBytesPerSec: 4096 }
        })
        .toString("hex")
    ).toBe(VECTORS.HELLO_ACK);
    expect(
      builder.buildFleetDataPacket(0x01020304, 7, Buffer.alloc(16, 0xaa)).toString("hex")
    ).toBe(VECTORS.FLEET_DATA);
    const bound = new PacketBuilder({
      secretKey: VECTOR_KEY,
      epochBoundAuth: true,
      connectionEpoch: 1700000000000
    });
    expect(bound.buildFleetAckPacket(0x01020304, 16).toString("hex")).toBe(VECTORS.FLEET_ACK_EPOCH);
  });

  test("the parser accepts every vector", () => {
    const parser = new PacketParser({ secretKey: VECTOR_KEY, authenticatedHeaders: false });
    for (const [name, hex] of Object.entries(VECTORS)) {
      const options = name === "FLEET_ACK_EPOCH" ? { epoch: 1700000000000 } : {};
      expect(() => parser.parseHeader(Buffer.from(hex, "hex"), options)).not.toThrow();
    }
  });
});
