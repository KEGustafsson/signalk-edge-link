"use strict";

/**
 * Shared, deterministic golden-vector builder for the frozen wire/codec
 * conformance suite (rewrite plan doc 06 §6.1, doc 03).
 *
 * This module contains NO I/O and NO randomness. It is invoked from two
 * places with the SAME logic so the two can never drift:
 *
 *   - `generate-vectors.js` injects the COMPILED modules (`lib/**`) to emit
 *     the committed `vectors/golden.json`.
 *   - `conformance.test.js` injects the SOURCE modules (`src/**`, via ts-jest)
 *     and asserts the source reproduces the committed vectors byte-for-byte.
 *
 * Because both paths run identical code over identical fixed inputs, a green
 * conformance test proves: source === frozen golden === compiled lib.
 *
 * Crypto AEAD ciphertext is deliberately NOT built here: `encryptBinary`
 * uses a fresh random IV per call, so its output cannot be reproduced.
 * Frozen ciphertext lives in `vectors/crypto-decrypt.json` (generated once)
 * and is only ever DECRYPTED by the test.
 *
 * @param {object} mods injected module set
 * @param {object} mods.crypto         crypto module
 * @param {object} mods.packet         packet module (PacketBuilder, crc16, ...)
 * @param {object} mods.compactDelta   compact-delta module
 * @param {object} mods.valueDedup     value-dedup module
 * @param {object} mods.pathDict       pathDictionary module
 * @param {object} mods.metadata       metadata module
 * @returns {object} JSON-serializable vector object
 */
module.exports = function buildVectors(mods) {
  const { crypto, packet, compactDelta, valueDedup, pathDict, metadata } = mods;
  const b64 = (buf) => Buffer.from(buf).toString("base64");

  // Fixed 64-hex key (decodes raw to 32 bytes, no ASCII-stretch ambiguity).
  const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  // ── 1. CRC16-CCITT (poly 0x1021, init 0xFFFF) ────────────────────────────
  const crc16Inputs = ["", "SK", "Hello, World!", "signalk-edge-link"];
  const crc16 = crc16Inputs.map((s) => ({
    inputUtf8: s,
    crc: packet.crc16(Buffer.from(s, "utf8"))
  }));

  // ── 2. v3 control packets (HMAC-authenticated, fully deterministic) ───────
  // A fresh builder => sequence counter 0, so the bytes are reproducible.
  const mkBuilder = () => new packet.PacketBuilder({ protocolVersion: 3, secretKey: KEY_HEX });
  const controlPackets = {
    ack: b64(mkBuilder().buildACKPacket(1)),
    ackWithWindow: b64(mkBuilder().buildACKPacket(0x01020304, { receiveWindow: 200 })),
    nak: b64(mkBuilder().buildNAKPacket([5, 6, 9])),
    heartbeat: b64(mkBuilder().buildHeartbeatPacket()),
    metaRequest: b64(mkBuilder().buildMetaRequestPacket()),
    fullStatusRequest: b64(mkBuilder().buildFullStatusRequestPacket())
  };

  // ── 3. Control-packet HMAC auth tags (deterministic) ─────────────────────
  const authTags = [
    {
      header: "00112233445566778899aabbcc",
      payload: "",
      tag: b64(
        crypto.createControlPacketAuthTag(
          Buffer.from("00112233445566778899aabbcc", "hex"),
          Buffer.alloc(0),
          KEY_HEX
        )
      )
    },
    {
      header: "534b03020000000001000000040000",
      payload: "deadbeef",
      tag: b64(
        crypto.createControlPacketAuthTag(
          Buffer.from("534b03020000000001000000040000", "hex"),
          Buffer.from("deadbeef", "hex"),
          KEY_HEX
        )
      )
    }
  ];

  // ── 4. Compact-delta encoding (round-trips exactly) ──────────────────────
  const sampleDelta = {
    context: "vessels.urn:mrn:imo:mmsi:230000000",
    updates: [
      {
        source: { label: "GPS1", type: "NMEA0183" },
        $source: "GPS1.RMC",
        timestamp: "2026-06-07T09:00:00.000Z",
        values: [
          { path: "navigation.speedOverGround", value: 3.21 },
          { path: "navigation.courseOverGroundTrue", value: 1.5708 }
        ]
      }
    ]
  };
  const compactDeltaVector = {
    input: sampleDelta,
    encoded: compactDelta.encodeCompactDelta(sampleDelta)
  };

  // ── 5. Value dedup ({$$:"dup"} sentinel substitution) ────────────────────
  const dedupInput = [
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 3.21 }] }]
    },
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 3.21 }] }]
    },
    {
      context: "vessels.self",
      updates: [{ values: [{ path: "navigation.speedOverGround", value: 4.0 }] }]
    }
  ];
  const dedupState = valueDedup.createValueDedupState();
  const dedupEncoded = valueDedup.dedupDeltaArray(dedupInput, dedupState);
  const valueDedupVector = {
    input: dedupInput,
    encoded: dedupEncoded
  };

  // ── 6. Path dictionary encoding ──────────────────────────────────────────
  const dictPaths = [
    "navigation.position",
    "navigation.speedOverGround",
    "navigation.courseOverGroundTrue",
    "environment.wind.speedApparent",
    "electrical.batteries.0.voltage",
    "this.path.is.not.in.the.dictionary"
  ];
  const pathDictionary = {
    size: pathDict.getDictionarySize(),
    encoded: dictPaths.map((p) => ({ path: p, id: pathDict.encodePath(p) }))
  };

  // ── 7. Metadata envelope ─────────────────────────────────────────────────
  const metaEntries = [
    {
      path: "navigation.speedOverGround",
      meta: { units: "m/s", description: "Vessel speed over ground" }
    },
    { path: "environment.depth.belowTransducer", meta: { units: "m" } }
  ];
  const metaEnvelope = metadata.buildMetaEnvelope(metaEntries, "snapshot", 7, 0, 1);
  // Freeze the diff variant too so the metadata envelope `kind` surface is pinned.
  const metaEnvelopeDiff = metadata.buildMetaEnvelope(metaEntries, "diff", 8, 1, 2);

  // ── 8. DATA / METADATA packet wire format across flag combinations ────────
  // The builder wraps a PROVIDED payload (it does not encrypt), so with a fixed
  // payload buffer the entire packet (header + flags + CRC + payload + optional
  // authenticated-header tag) is byte-reproducible. This freezes the header /
  // flag / CRC / type surface independent of the (non-deterministic) AEAD layer.
  const fixedPayload = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const flagCombos = [
    ["plain", {}],
    ["compressed", { compressed: true }],
    ["encrypted", { encrypted: true }],
    ["messagepack", { messagepack: true }],
    ["pathDictionary", { pathDictionary: true }],
    ["compressedEncrypted", { compressed: true, encrypted: true }],
    ["all", { compressed: true, encrypted: true, messagepack: true, pathDictionary: true }]
  ];
  const dataPackets = {};
  const metadataPackets = {};
  for (const [name, flags] of flagCombos) {
    dataPackets[name] = b64(mkBuilder().buildDataPacket(fixedPayload, flags));
    metadataPackets[name] = b64(mkBuilder().buildMetadataPacket(fixedPayload, flags));
  }
  // Authenticated-header variants: the trailing HMAC tag covers header[0..13)
  // plus the payload, so it is deterministic for a fixed payload + key.
  const mkAuthBuilder = () =>
    new packet.PacketBuilder({
      protocolVersion: 3,
      secretKey: KEY_HEX,
      authenticatedHeaders: true
    });
  const dataPacketsAuthHeader = {
    encrypted: b64(mkAuthBuilder().buildDataPacket(fixedPayload, { encrypted: true })),
    all: b64(
      mkAuthBuilder().buildDataPacket(fixedPayload, {
        compressed: true,
        encrypted: true,
        messagepack: true,
        pathDictionary: true
      })
    )
  };
  const metadataPacketsAuthHeader = {
    encrypted: b64(mkAuthBuilder().buildMetadataPacket(fixedPayload, { encrypted: true }))
  };

  // ── 9. Source-snapshot envelope (application-level wire shape) ────────────
  // Mirrors the `{ v, kind: "sources", seq, idx, total, sources }` envelope the
  // client emits inside a METADATA payload. Frozen as JSON so its shape cannot
  // drift unnoticed; a METADATA packet is also frozen wrapping a fixed-byte
  // serialization of it to pin the carrier framing.
  const sourceSnapshotEnvelope = {
    v: 1,
    kind: "sources",
    seq: 3,
    idx: 0,
    total: 1,
    sources: {
      "sensor.gps": { label: "sensor.gps", type: "NMEA0183" },
      "n2k.1": { label: "n2k", type: "NMEA2000" }
    }
  };
  const sourceSnapshotPacket = b64(
    mkBuilder().buildMetadataPacket(Buffer.from(JSON.stringify(sourceSnapshotEnvelope), "utf8"), {
      compressed: false,
      encrypted: false
    })
  );

  return {
    schema: 1,
    description:
      "Frozen wire/codec conformance vectors. Generated by " +
      "__conformance__/generate-vectors.js. Do not hand-edit. See doc 03/06.",
    keyHex: KEY_HEX,
    crc16,
    controlPackets,
    authTags,
    compactDelta: compactDeltaVector,
    valueDedup: valueDedupVector,
    pathDictionary,
    metaEnvelope,
    metaEnvelopeDiff,
    dataPackets,
    metadataPackets,
    dataPacketsAuthHeader,
    metadataPacketsAuthHeader,
    sourceSnapshotEnvelope,
    sourceSnapshotPacket
  };
};
