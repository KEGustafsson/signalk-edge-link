"use strict";

/** L1 codec — packet construction. */

import {
  MAGIC,
  HEADER_SIZE,
  PacketType,
  PacketFlags,
  MAX_SEQUENCE,
  normalizeProtocolVersion,
  usesAuthenticatedControl,
  crc16
} from "./constants";
import { createControlPacketAuthTag, CONTROL_AUTH_TAG_LENGTH } from "../crypto";

// --- PacketBuilder ---

/**
 * Builds v2 protocol packets with headers
 */
export class PacketBuilder {
  _sequence: number;
  _metaSequence: number;
  _protocolVersion: number;
  _secretKey: string | null;
  _stretchAsciiKey: boolean;

  /**
   * @param {Object} [config]
   * @param {number} [config.initialSequence=0] - Starting sequence number
   * @param {boolean} [config.stretchAsciiKey=false] - When true, 32-char
   *   ASCII keys are stretched via PBKDF2 before use. Both ends must agree.
   */
  constructor(
    config: {
      initialSequence?: number;
      protocolVersion?: number;
      secretKey?: string;
      stretchAsciiKey?: boolean;
    } = {}
  ) {
    this._sequence = config.initialSequence ?? 0;
    // METADATA lives in its own sequence space. DATA sequencing drives the
    // cumulative ACK/NAK protocol on the server; mixing METADATA into it
    // would create apparent gaps (receivers don't track METADATA sequences)
    // and trigger spurious NAKs / retransmit churn for real data traffic.
    this._metaSequence = 0;
    this._protocolVersion = normalizeProtocolVersion(config.protocolVersion);
    this._secretKey = config.secretKey || null;
    this._stretchAsciiKey = !!config.stretchAsciiKey;
  }

  /**
   * Build a DATA packet
   * @param {Buffer} payload - Payload data
   * @param {Object} [flags] - Packet flags
   * @param {boolean} [flags.compressed=false]
   * @param {boolean} [flags.encrypted=false]
   * @param {boolean} [flags.messagepack=false]
   * @param {boolean} [flags.pathDictionary=false]
   * @returns {Buffer} Complete packet with header and payload
   */
  buildDataPacket(
    payload: Buffer,
    flags: {
      compressed?: boolean;
      encrypted?: boolean;
      messagepack?: boolean;
      pathDictionary?: boolean;
    } = {}
  ): Buffer {
    const packet = this._buildPacket(PacketType.DATA, payload, flags);
    this._advanceSequence();
    return packet;
  }

  /**
   * Build a METADATA packet. Shares the flag set and the build/encrypt
   * pipeline with buildDataPacket but uses packet type 0x06 and its own
   * sequence space so that METADATA never steals DATA sequence numbers.
   *
   * METADATA is not ACKed/NAKed on the wire — recovery is handled by the
   * application-level periodic snapshot and by META_REQUEST (0x07). The
   * separate sequence counter exists purely so a receiver can detect
   * duplicate or reordered METADATA packets within a single snapshot burst.
   */
  buildMetadataPacket(
    payload: Buffer,
    flags: {
      compressed?: boolean;
      encrypted?: boolean;
      messagepack?: boolean;
      pathDictionary?: boolean;
    } = {}
  ): Buffer {
    const packet = this._buildPacket(PacketType.METADATA, payload, flags, {
      sequence: this._metaSequence
    });
    this._metaSequence = (this._metaSequence + 1) >>> 0;
    return packet;
  }

  /**
   * Build a META_REQUEST control packet (receiver → client).
   * Payload is empty; control-packet authentication/CRC is applied by
   * _buildPacket the same way as ACK/NAK.
   */
  buildMetaRequestPacket(options: { secretKey?: string; protocolVersion?: number } = {}): Buffer {
    return this._buildPacket(PacketType.META_REQUEST, Buffer.alloc(0), {}, options);
  }

  /**
   * Build a FULL_STATUS_REQUEST control packet (server → client).
   * Payload is empty. Instructs the client to replay its full values snapshot
   * so the server can rebuild state after a restart.
   */
  buildFullStatusRequestPacket(
    options: { secretKey?: string; protocolVersion?: number } = {}
  ): Buffer {
    return this._buildPacket(PacketType.FULL_STATUS_REQUEST, Buffer.alloc(0), {}, options);
  }

  /**
   * Build an ACK packet
   * @param {number} ackedSequence - Sequence number being acknowledged
   * @param {Object} [options]
   * @param {number} [options.receiveWindow] - Receiver's available buffer capacity (packets)
   * @returns {Buffer} ACK packet
   */
  buildACKPacket(
    ackedSequence: number,
    options: { receiveWindow?: number; secretKey?: string; protocolVersion?: number } = {}
  ): Buffer {
    const hasWindow = options.receiveWindow !== undefined;
    const payload = Buffer.alloc(hasWindow ? 8 : 4);
    payload.writeUInt32BE(ackedSequence >>> 0, 0);
    if (hasWindow) {
      payload.writeUInt32BE(options.receiveWindow! >>> 0, 4);
    }
    return this._buildPacket(PacketType.ACK, payload, {}, options);
  }

  /**
   * Build a NAK packet
   * @param {number[]} missingSequences - Array of missing sequence numbers
   * @returns {Buffer} NAK packet
   */
  buildNAKPacket(
    missingSequences: number[],
    options: { secretKey?: string; protocolVersion?: number } = {}
  ): Buffer {
    const payload = Buffer.alloc(missingSequences.length * 4);
    for (let i = 0; i < missingSequences.length; i++) {
      payload.writeUInt32BE(missingSequences[i] >>> 0, i * 4);
    }
    return this._buildPacket(PacketType.NAK, payload, {}, options);
  }

  /**
   * Build a HEARTBEAT packet
   * @returns {Buffer} Heartbeat packet (no payload)
   */
  buildHeartbeatPacket(options: { secretKey?: string; protocolVersion?: number } = {}): Buffer {
    return this._buildPacket(PacketType.HEARTBEAT, Buffer.alloc(0), {}, options);
  }

  /**
   * Build a HELLO packet
   * @param {Object} info - Hello information
   * @param {number} [info.protocolVersion] - Protocol version
   * @param {string} [info.clientId] - Client identifier
   * @param {string} [info.instanceId] - Plugin instance identifier (used by the
   *   server to namespace source-registry attribution; falls back to clientId
   *   when omitted)
   * @param {string[]} [info.capabilities] - Supported capabilities
   * @returns {Buffer} Hello packet
   */
  buildHelloPacket(
    info: {
      protocolVersion?: number;
      clientId?: string;
      instanceId?: string;
      capabilities?: string[];
    } = {},
    options: { secretKey?: string; protocolVersion?: number } = {}
  ): Buffer {
    const protocolVersion = normalizeProtocolVersion(
      options.protocolVersion ?? info.protocolVersion ?? this._protocolVersion
    );
    const payload: Record<string, unknown> = {
      protocolVersion,
      clientId: info.clientId || "",
      timestamp: Date.now(),
      capabilities:
        info.capabilities ||
        (usesAuthenticatedControl(protocolVersion)
          ? ["compression", "encryption", "reliability", "authenticated-control"]
          : ["compression", "encryption", "reliability"])
    };
    if (info.instanceId) {
      payload.instanceId = info.instanceId;
    }
    return this._buildPacket(PacketType.HELLO, Buffer.from(JSON.stringify(payload)), {}, options);
  }

  /**
   * Get current sequence number
   * @returns {number}
   */
  getCurrentSequence(): number {
    return this._sequence;
  }

  /**
   * Manually set the sequence number (for testing/retransmission)
   * @param {number} seq
   */
  setSequence(seq: number): void {
    this._sequence = seq >>> 0; // ensure uint32
  }

  /**
   * Build a packet with header
   * @private
   * @param {number} type - Packet type
   * @param {Buffer} payload - Payload data
   * @param {Object} flags - Flag options
   * @returns {Buffer} Complete packet
   */
  _buildPacket(
    type: number,
    payload: Buffer | string,
    flags: {
      compressed?: boolean;
      encrypted?: boolean;
      messagepack?: boolean;
      pathDictionary?: boolean;
    },
    options: {
      secretKey?: string | null;
      protocolVersion?: number;
      /** Explicit sequence number to write into the header. Defaults to
       *  `this._sequence` for DATA/ACK/NAK/HEARTBEAT/HELLO. METADATA passes
       *  `this._metaSequence` so it draws from its own sequence space
       *  without mutating the DATA counter. */
      sequence?: number;
    } = {}
  ): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
    const protocolVersion = normalizeProtocolVersion(
      options.protocolVersion ?? this._protocolVersion
    );
    const sequence = (options.sequence ?? this._sequence) >>> 0;

    // Magic bytes
    header[0] = MAGIC[0];
    header[1] = MAGIC[1];

    // Version
    header[2] = protocolVersion;

    // Type
    header[3] = type;

    // Flags
    let flagByte = 0;
    if (flags.compressed) {
      flagByte |= PacketFlags.COMPRESSED;
    }
    if (flags.encrypted) {
      flagByte |= PacketFlags.ENCRYPTED;
    }
    if (flags.messagepack) {
      flagByte |= PacketFlags.MESSAGEPACK;
    }
    if (flags.pathDictionary) {
      flagByte |= PacketFlags.PATH_DICTIONARY;
    }
    header[4] = flagByte;

    // Sequence number (uint32 big-endian) — DATA uses this._sequence, METADATA
    // uses this._metaSequence, control packets inherit this._sequence.
    header.writeUInt32BE(sequence, 5);

    let finalPayload = payloadBuffer;

    // DATA and METADATA packets are authenticated by AES-256-GCM (their payload
    // is already an AEAD ciphertext). v2 control packets use a trailing CRC for
    // corruption detection; v3 control packets use an HMAC tag so
    // ACK/NAK/HEARTBEAT/HELLO/META_REQUEST cannot be forged off-path.
    if (type !== PacketType.DATA && type !== PacketType.METADATA) {
      if (usesAuthenticatedControl(protocolVersion)) {
        const secretKey = options.secretKey || this._secretKey;
        if (!secretKey) {
          throw new Error("Protocol v3 control packets require a secretKey");
        }
        // Write the final payload length (payload + auth tag) into header bytes
        // 9-12 BEFORE computing the HMAC, since the tag is authenticated over
        // header.subarray(0, 13). The later writeUInt32BE(finalPayload.length, 9)
        // re-writes the same value, so this is not a dead write — removing it
        // would change the bytes the HMAC covers and break the wire format.
        header.writeUInt32BE(payloadBuffer.length + CONTROL_AUTH_TAG_LENGTH, 9);
        const authTag = createControlPacketAuthTag(
          header.subarray(0, 13),
          payloadBuffer,
          secretKey,
          { stretchAsciiKey: this._stretchAsciiKey }
        );
        finalPayload = Buffer.concat([payloadBuffer, authTag]);
      } else if (payloadBuffer.length > 0) {
        const payloadCrc = Buffer.alloc(2);
        payloadCrc.writeUInt16BE(crc16(payloadBuffer), 0);
        finalPayload = Buffer.concat([payloadBuffer, payloadCrc]);
      }
    }

    // Payload length (uint32 big-endian)
    header.writeUInt32BE(finalPayload.length, 9);

    // CRC16 over header bytes 0..12 (everything except the CRC field itself)
    const crcValue = crc16(header.subarray(0, 13));
    header.writeUInt16BE(crcValue, 13);

    return Buffer.concat([header, finalPayload]);
  }

  /**
   * Advance sequence number with wraparound
   * @private
   */
  _advanceSequence(): void {
    this._sequence = (this._sequence + 1) >>> 0;
  }
}
