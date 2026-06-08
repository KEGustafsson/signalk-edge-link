"use strict";

/**
 * Old ↔ new wire-interop harness (rewrite plan doc 06 §6.1.3, doc 07 phase 0).
 *
 * Goal of the FINAL harness: run the OLD compiled build and the NEW build
 * against each other over a real loopback `dgram` socket and assert that
 * data / control / metadata / source-snapshot frames cross the wire intact in
 * both directions, for v1 (legacy JSON) and v3 (authenticated binary).
 *
 * Phase 0 ships the SKELETON: the loopback transport and a pluggable
 * "sender build" / "receiver build" seam are real and exercised here with the
 * current build on both ends (a self-interop smoke that proves the rig works).
 * As the rewrite lands new modules under the layered tree, swap one side's
 * factory for the new build — the assertions stay identical, which is the
 * whole point of an interop gate.
 *
 * The remaining cross-build / v1 cases are tracked as `test.todo` until the
 * corresponding phases produce a second build to interop against.
 */

const dgram = require("dgram");

// Loaded through the lib→src moduleNameMapper, i.e. the current SOURCE build.
// When a second (old compiled) build exists, expose it here as `oldBuild` and
// parameterize the matrix below over { sender, receiver } ∈ {old,new}².
const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { encryptBinary, decryptBinary } = require("../../lib/crypto");

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

  // ── Cross-build matrix — enabled as later phases produce a 2nd build ───────
  // (doc 06 §6.6 acceptance: old↔new interop passes for v1 and v3.)
  test.todo("v3: old build → new build (DATA, control, metadata, source snapshot)");
  test.todo("v3: new build → old build (DATA, control, metadata, source snapshot)");
  test.todo("v1: old build ↔ new build (legacy JSON pipeline)");
});
