"use strict";

/**
 * Old ↔ new wire-interop harness (rewrite plan doc 06 §6.1.3, doc 07 phase 0).
 *
 * Goal of the FINAL harness: run the OLD compiled build and the NEW build
 * against each other over a real loopback `dgram` socket and assert that
 * data / control / metadata / source-snapshot frames cross the wire intact in
 * both directions, for v1 (legacy JSON) and v3 (authenticated binary).
 *
 * The loopback transport and a pluggable "sender build" / "receiver build" seam
 * are real and exercised on the current build (a self-interop smoke that proves
 * the rig works). The cross-build matrix uses the committed FROZEN conformance
 * vectors as the concrete "old build": old→new asserts the current build parses
 * the frozen wire bytes; new→old asserts the current build reproduces them
 * byte-for-byte (so an old parser that emitted them accepts new output). v1
 * interop is covered through the frozen AES-GCM ciphertext fixtures (the v1
 * envelope) plus a round-trip property test.
 */

const dgram = require("dgram");

// Loaded through the lib→src moduleNameMapper, i.e. the current SOURCE build.
// When a second (old compiled) build exists, expose it here as `oldBuild` and
// parameterize the matrix below over { sender, receiver } ∈ {old,new}².
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");

// The committed FROZEN conformance vectors are the concrete stand-in for the
// "old build": they are the byte-exact wire output of a previous release (the
// crypto fixtures bake in a random IV from when they were generated, and the
// packet vectors are pinned bytes). Old→new = the current build must PARSE
// those bytes; new→old = the current build must REPRODUCE those bytes (so an
// old parser that emitted them would accept what the new build emits).
const golden = require("../../__conformance__/vectors/golden.json");
const cryptoFixtures = require("../../__conformance__/vectors/crypto-decrypt.json");

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXED_PAYLOAD = Buffer.from("00112233445566778899aabbccddeeff", "hex");

/**
 * Bind a loopback UDP socket and resolve once it is listening.
 * @returns {Promise<{socket: import('dgram').Socket, port: number}>}
 */
function bindLoopback() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve({ socket, port: socket.address().port }));
  });
}

/**
 * Send one datagram from `sender` to 127.0.0.1:port and resolve with the bytes
 * the receiver observes. The core seam of the interop rig.
 */
function roundTripDatagram(sender, receiver, receiverPort, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("interop datagram timed out")), 2000);
    receiver.once("message", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    sender.send(payload, receiverPort, "127.0.0.1", (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

describe("Interop harness skeleton (loopback dgram)", () => {
  let alice;
  let bob;

  beforeAll(async () => {
    alice = await bindLoopback();
    bob = await bindLoopback();
  });

  afterAll(() => {
    if (alice) {
      alice.socket.close();
    }
    if (bob) {
      bob.socket.close();
    }
  });

  test("v3 DATA frame survives the loopback round-trip (self-interop smoke)", async () => {
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: KEY });
    const plaintext = Buffer.from(
      JSON.stringify({ updates: [{ values: [{ path: "x", value: 1 }] }] })
    );
    const ciphertext = encryptBinary(plaintext, KEY);
    const packet = builder.buildDataPacket(ciphertext, { encrypted: true });

    const received = await roundTripDatagram(alice.socket, bob.socket, bob.port, packet);

    const parser = new PacketParser();
    const parsed = parser.parseHeader(received, { secretKey: KEY });
    expect(parsed.type).toBe(PacketType.DATA);
    expect(parsed.flags.encrypted).toBe(true);
    expect(decryptBinary(parsed.payload, KEY).equals(plaintext)).toBe(true);
  });

  test("v3 control (ACK) frame survives the loopback round-trip", async () => {
    const builder = new PacketBuilder({ protocolVersion: 3, secretKey: KEY });
    const packet = builder.buildACKPacket(42, { receiveWindow: 16 });

    const received = await roundTripDatagram(bob.socket, alice.socket, alice.port, packet);

    const parser = new PacketParser();
    const parsed = parser.parseHeader(received, { secretKey: KEY });
    expect(parsed.type).toBe(PacketType.ACK);
    expect(parser.parseACKPayloadFull(parsed.payload)).toEqual({ sequence: 42, receiveWindow: 16 });
  });

  // ── Cross-build matrix — old build == frozen conformance vectors ───────────
  // (doc 06 §6.6 acceptance: old↔new interop passes for v1 and v3.)

  test("v3: old build → new build — frozen DATA/control/metadata frames parse over loopback", async () => {
    const parser = new PacketParser({ secretKey: golden.keyHex });
    const frames = [
      [golden.dataPackets.all, PacketType.DATA],
      [golden.dataPackets.plain, PacketType.DATA],
      [golden.controlPackets.ack, PacketType.ACK],
      [golden.controlPackets.nak, PacketType.NAK],
      [golden.metadataPackets.plain, PacketType.METADATA],
      [golden.sourceSnapshotPacket, PacketType.METADATA]
    ];
    for (const [b64, type] of frames) {
      const bytes = Buffer.from(b64, "base64");
      const received = await roundTripDatagram(alice.socket, bob.socket, bob.port, bytes);
      const parsed = parser.parseHeader(received, { secretKey: golden.keyHex });
      expect(parsed.type).toBe(type);
    }
    // The source-snapshot envelope must still decode to the frozen shape.
    const snapParsed = parser.parseHeader(Buffer.from(golden.sourceSnapshotPacket, "base64"), {
      secretKey: golden.keyHex
    });
    expect(JSON.parse(snapParsed.payload.toString("utf8"))).toEqual(golden.sourceSnapshotEnvelope);
  });

  test("v3: new build → old build — current builder reproduces the frozen wire bytes", () => {
    const mk = () => new PacketBuilder({ protocolVersion: 3, secretKey: golden.keyHex });
    // Byte-identical to the frozen (old) fixtures ⇒ an old parser accepts new output.
    expect(mk().buildDataPacket(FIXED_PAYLOAD, {}).toString("base64")).toBe(
      golden.dataPackets.plain
    );
    expect(
      mk()
        .buildDataPacket(FIXED_PAYLOAD, {
          compressed: true,
          encrypted: true,
          messagepack: true,
          pathDictionary: true
        })
        .toString("base64")
    ).toBe(golden.dataPackets.all);
    expect(mk().buildMetadataPacket(FIXED_PAYLOAD, {}).toString("base64")).toBe(
      golden.metadataPackets.plain
    );
    expect(mk().buildACKPacket(1).toString("base64")).toBe(golden.controlPackets.ack);
    expect(mk().buildNAKPacket([5, 6, 9]).toString("base64")).toBe(golden.controlPackets.nak);
  });

  test("v1: old build → new build — frozen AES-GCM blobs decrypt to known plaintext over loopback", async () => {
    // v1's wire envelope is the AES-256-GCM layer (no packet framing). The
    // frozen ciphertext blobs were produced by an earlier build; the current
    // build must still decrypt them to the exact known plaintext.
    for (const c of cryptoFixtures.cases) {
      const blob = Buffer.from(c.ciphertextB64, "base64");
      const received = await roundTripDatagram(bob.socket, alice.socket, alice.port, blob);
      const plaintext = decryptBinary(received, c.key, c.options || {});
      expect(plaintext.toString("utf8")).toBe(c.plaintextUtf8);
    }
  });

  test("v1: new build → old build — current build's AES-GCM output decrypts back (round-trip)", async () => {
    // The v1 envelope has a random IV, so it isn't byte-frozen; instead assert
    // the round-trip property an old peer relies on: new-build ciphertext is
    // decryptable to the original plaintext after crossing the wire.
    const plaintext = Buffer.from("v1 interop payload ⚓");
    const blob = encryptBinary(plaintext, KEY);
    const received = await roundTripDatagram(alice.socket, bob.socket, bob.port, blob);
    expect(decryptBinary(received, KEY).equals(plaintext)).toBe(true);
  });
});
