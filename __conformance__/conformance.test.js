"use strict";

/**
 * Frozen wire/codec conformance gate (rewrite plan doc 03 + doc 06 §6.1).
 *
 * Asserts that the CURRENT SOURCE (`src/**`, loaded through ts-jest via the
 * `lib/** → src/**` moduleNameMapper) reproduces the committed golden vectors
 * byte-for-byte, and can still decrypt the frozen AEAD blobs.
 *
 * This is the executable definition of "correct" that the rewrite targets:
 * every phase must keep it green. A diff here means the wire changed and
 * requires a separately-reviewed protocol decision — not a refactor.
 *
 * Regenerate the deterministic vectors after an intentional, reviewed change
 * with `npm run conformance:generate`.
 */

const buildVectors = require("./build-vectors");
const golden = require("./vectors/golden.json");
const cryptoDecrypt = require("./vectors/crypto-decrypt.json");

// Loaded via the lib→src moduleNameMapper, so these are the SOURCE modules.
const cryptoMod = require("../lib/crypto");
const packetMod = require("../lib/packet");
const compactDeltaMod = require("../lib/compact-delta");
const valueDedupMod = require("../lib/value-dedup");
const pathDictMod = require("../lib/pathDictionary");
const metadataMod = require("../lib/metadata");

const srcMods = {
  crypto: cryptoMod,
  packet: packetMod,
  compactDelta: compactDeltaMod,
  valueDedup: valueDedupMod,
  pathDict: pathDictMod,
  metadata: metadataMod
};

describe("Conformance: frozen wire/codec golden vectors", () => {
  test("source reproduces the full golden vector set byte-for-byte", () => {
    const produced = buildVectors(srcMods);
    // JSON round-trip normalizes (e.g. undefined-stripping) so the comparison
    // matches exactly what the committed file holds.
    expect(JSON.parse(JSON.stringify(produced))).toEqual(golden);
  });

  describe("CRC16-CCITT", () => {
    test.each(golden.crc16)("crc16(%j) is frozen", ({ inputUtf8, crc }) => {
      expect(packetMod.crc16(Buffer.from(inputUtf8, "utf8"))).toBe(crc);
    });
  });

  describe("v3 DATA/METADATA packets across flag combinations", () => {
    const parser = new packetMod.PacketParser();
    const FIXED = "00112233445566778899aabbccddeeff";

    test.each(Object.keys(golden.dataPackets))("DATA[%s] parses with the expected type", (name) => {
      const buf = Buffer.from(golden.dataPackets[name], "base64");
      const parsed = parser.parseHeader(buf);
      expect(parsed.type).toBe(packetMod.PacketType.DATA);
      expect(parsed.payload.toString("hex")).toBe(FIXED);
    });

    test.each(Object.keys(golden.metadataPackets))(
      "METADATA[%s] parses with the expected type",
      (name) => {
        const buf = Buffer.from(golden.metadataPackets[name], "base64");
        const parsed = parser.parseHeader(buf);
        expect(parsed.type).toBe(packetMod.PacketType.METADATA);
        expect(parsed.payload.toString("hex")).toBe(FIXED);
      }
    );

    test("flag bits are reflected in the parsed flags", () => {
      const parsed = parser.parseHeader(Buffer.from(golden.dataPackets.all, "base64"));
      expect(parsed.flags.compressed).toBe(true);
      expect(parsed.flags.encrypted).toBe(true);
      expect(parsed.flags.messagepack).toBe(true);
      expect(parsed.flags.pathDictionary).toBe(true);
    });

    test("authenticated-header DATA verifies its trailing HMAC tag", () => {
      const authParser = new packetMod.PacketParser({
        secretKey: golden.keyHex,
        authenticatedHeaders: true
      });
      const buf = Buffer.from(golden.dataPacketsAuthHeader.encrypted, "base64");
      const parsed = authParser.parseHeader(buf, { secretKey: golden.keyHex });
      expect(parsed.type).toBe(packetMod.PacketType.DATA);
      expect(parsed.flags.authenticatedHeader).toBe(true);
      expect(parsed.payload.toString("hex")).toBe(FIXED);
    });

    test("authenticated-header METADATA verifies its trailing HMAC tag", () => {
      const authParser = new packetMod.PacketParser({
        secretKey: golden.keyHex,
        authenticatedHeaders: true
      });
      const buf = Buffer.from(golden.metadataPacketsAuthHeader.encrypted, "base64");
      const parsed = authParser.parseHeader(buf, { secretKey: golden.keyHex });
      expect(parsed.type).toBe(packetMod.PacketType.METADATA);
      expect(parsed.flags.authenticatedHeader).toBe(true);
      expect(parsed.payload.toString("hex")).toBe(FIXED);
    });

    test("source-snapshot METADATA carries the frozen sources envelope", () => {
      const buf = Buffer.from(golden.sourceSnapshotPacket, "base64");
      const parsed = parser.parseHeader(buf);
      expect(parsed.type).toBe(packetMod.PacketType.METADATA);
      const env = JSON.parse(parsed.payload.toString("utf8"));
      expect(env.kind).toBe("sources");
      expect(env).toEqual(golden.sourceSnapshotEnvelope);
    });
  });

  describe("v3 control packets round-trip through the parser", () => {
    const parser = new packetMod.PacketParser();
    const KEY = golden.keyHex;

    test("ACK carries its acked sequence", () => {
      const buf = Buffer.from(golden.controlPackets.ack, "base64");
      const parsed = parser.parseHeader(buf, { secretKey: KEY });
      expect(parsed.type).toBe(packetMod.PacketType.ACK);
      expect(parser.parseACKPayload(parsed.payload)).toBe(1);
    });

    test("ACK-with-window carries sequence and receive window", () => {
      const buf = Buffer.from(golden.controlPackets.ackWithWindow, "base64");
      const parsed = parser.parseHeader(buf, { secretKey: KEY });
      const full = parser.parseACKPayloadFull(parsed.payload);
      expect(full.sequence).toBe(0x01020304);
      expect(full.receiveWindow).toBe(200);
    });

    test("NAK carries its missing-sequence list", () => {
      const buf = Buffer.from(golden.controlPackets.nak, "base64");
      const parsed = parser.parseHeader(buf, { secretKey: KEY });
      expect(parser.parseNAKPayload(parsed.payload)).toEqual([5, 6, 9]);
    });

    test.each([
      ["heartbeat", "HEARTBEAT"],
      ["metaRequest", "META_REQUEST"],
      ["fullStatusRequest", "FULL_STATUS_REQUEST"]
    ])("%s parses as type %s", (key, typeName) => {
      const buf = Buffer.from(golden.controlPackets[key], "base64");
      const parsed = parser.parseHeader(buf, { secretKey: KEY });
      expect(parsed.type).toBe(packetMod.PacketType[typeName]);
    });

    test("a tampered control packet fails HMAC verification", () => {
      const buf = Buffer.from(golden.controlPackets.heartbeat, "base64");
      const tampered = Buffer.from(buf);
      tampered[tampered.length - 1] ^= 0xff; // corrupt the auth tag
      expect(() => parser.parseHeader(tampered, { secretKey: KEY })).toThrow();
    });
  });

  describe("frozen AEAD ciphertext still decrypts to the known plaintext", () => {
    test.each(cryptoDecrypt.cases)("$name", (c) => {
      const out = cryptoMod.decryptBinary(Buffer.from(c.ciphertextB64, "base64"), c.key, c.options);
      expect(out.toString("utf8")).toBe(c.plaintextUtf8);
    });

    test("stretched vs raw ASCII keys are NOT interchangeable", () => {
      const stretched = cryptoDecrypt.cases.find((c) => c.name === "ascii-key-stretched");
      expect(() =>
        cryptoMod.decryptBinary(Buffer.from(stretched.ciphertextB64, "base64"), stretched.key, {})
      ).toThrow();
    });
  });

  describe("codec round-trips", () => {
    test("compact-delta decodes back to the source delta", () => {
      const { input, encoded } = golden.compactDelta;
      expect(compactDeltaMod.encodeCompactDelta(input)).toEqual(encoded);
      expect(compactDeltaMod.decodeCompactDelta(encoded)).toEqual(input);
    });

    test("value-dedup expands sentinels back to the original values", () => {
      const { input, encoded } = golden.valueDedup;
      const undedupState = valueDedupMod.createValueDedupState();
      const restored = valueDedupMod.undedupDeltaArray(encoded, undedupState);
      expect(restored).toEqual(input);
    });

    test("path-dictionary ids decode back to their paths", () => {
      for (const { path, id } of golden.pathDictionary.encoded) {
        expect(pathDictMod.encodePath(path)).toEqual(id);
        if (typeof id === "number") {
          expect(pathDictMod.decodePath(id)).toBe(path);
        }
      }
    });
  });
});
