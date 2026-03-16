"use strict";

/**
 * Signal K Edge Link v2.0 - Packet Capture & Inspector
 *
 * Provides:
 * - Packet capture with .pcap export (libpcap format)
 * - Live packet inspector via WebSocket
 *
 * @module lib/packet-capture
 */

import { HEADER_SIZE, getTypeName } from "./packet";
import { PACKET_CAPTURE_MAX_PACKETS, PACKET_INSPECTOR_MAX_CLIENTS } from "./constants";

// ── PCAP Format Constants ──

// pcap global header (24 bytes)
const PCAP_MAGIC = 0xa1b2c3d4;
const PCAP_VERSION_MAJOR = 2;
const PCAP_VERSION_MINOR = 4;
const PCAP_THISZONE = 0;
const PCAP_SIGFIGS = 0;
const PCAP_SNAPLEN = 65535;
const PCAP_LINKTYPE_USER0 = 147; // User-defined (DLT_USER0) - for custom protocols

// ── Packet Capture ──

/**
 * Captures packets in a circular buffer and exports to pcap format.
 * Uses DLT_USER0 (user-defined) link type since these are
 * application-level protocol packets, not raw network frames.
 */
class PacketCapture {
  maxPackets: number;
  enabled: boolean;
  packets: Array<{
    timestamp: number;
    data: Buffer;
    direction: string;
    address: string;
    port: number;
    length: number;
  }>;
  stats: {
    captured: number;
    dropped: number;
  };

  /**
   * @param {Object} [config]
   * @param {number} [config.maxPackets] - Max packets in buffer
   * @param {boolean} [config.enabled] - Whether capture is active
   */
  constructor(config: { maxPackets?: number; enabled?: boolean } = {}) {
    this.maxPackets = config.maxPackets || PACKET_CAPTURE_MAX_PACKETS;
    this.enabled = config.enabled || false;
    this.packets = [];
    this.stats = {
      captured: 0,
      dropped: 0
    };
  }

  /**
   * Capture a packet
   * @param {Buffer} data - Raw packet data
   * @param {string} direction - "send" or "recv"
   * @param {Object} [meta] - Optional metadata {address, port}
   */
  capture(data: Buffer, direction: string, meta: { address?: string; port?: number } = {}): void {
    if (!this.enabled) {
      return;
    }

    const entry = {
      timestamp: Date.now(),
      data: Buffer.from(data), // Copy to prevent mutation
      direction,
      address: meta.address || "",
      port: meta.port || 0,
      length: data.length
    };

    this.packets.push(entry);
    this.stats.captured++;

    // Trim to max
    if (this.packets.length > this.maxPackets) {
      const overage = this.packets.length - this.maxPackets;
      this.packets.splice(0, overage);
      this.stats.dropped += overage;
    }
  }

  /**
   * Export captured packets to pcap format
   * @returns {Buffer} pcap file data
   */
  exportPcap(): Buffer {
    // Global header (24 bytes)
    const globalHeader = Buffer.alloc(24);
    globalHeader.writeUInt32LE(PCAP_MAGIC, 0);
    globalHeader.writeUInt16LE(PCAP_VERSION_MAJOR, 4);
    globalHeader.writeUInt16LE(PCAP_VERSION_MINOR, 6);
    globalHeader.writeInt32LE(PCAP_THISZONE, 8);
    globalHeader.writeUInt32LE(PCAP_SIGFIGS, 12);
    globalHeader.writeUInt32LE(PCAP_SNAPLEN, 16);
    globalHeader.writeUInt32LE(PCAP_LINKTYPE_USER0, 20);

    // Packet records
    const records: Buffer[] = [];
    let totalSize = 24;

    for (const pkt of this.packets) {
      // Add direction marker (1 byte: 0=send, 1=recv) as prefix
      const dirByte = Buffer.alloc(1);
      dirByte[0] = pkt.direction === "recv" ? 1 : 0;
      const packetData = Buffer.concat([dirByte, pkt.data]);

      // Per-packet header (16 bytes)
      const recordHeader = Buffer.alloc(16);
      const tsSec = Math.floor(pkt.timestamp / 1000);
      const tsUsec = (pkt.timestamp % 1000) * 1000;

      recordHeader.writeUInt32LE(tsSec, 0);
      recordHeader.writeUInt32LE(tsUsec, 4);
      recordHeader.writeUInt32LE(packetData.length, 8); // captured length
      recordHeader.writeUInt32LE(packetData.length, 12); // original length

      records.push(recordHeader, packetData);
      totalSize += 16 + packetData.length;
    }

    return Buffer.concat([globalHeader, ...records], totalSize);
  }

  /**
   * Get capture statistics
   * @returns {Object}
   */
  getStats(): {
    enabled: boolean;
    captured: number;
    dropped: number;
    buffered: number;
    maxPackets: number;
  } {
    return {
      enabled: this.enabled,
      captured: this.stats.captured,
      dropped: this.stats.dropped,
      buffered: this.packets.length,
      maxPackets: this.maxPackets
    };
  }

  /**
   * Start capturing
   */
  start(): void {
    this.enabled = true;
  }

  /**
   * Stop capturing
   */
  stop(): void {
    this.enabled = false;
  }

  /**
   * Clear capture buffer
   */
  clear(): void {
    this.packets = [];
    this.stats = { captured: 0, dropped: 0 };
  }

  /**
   * Reset (stop + clear)
   */
  reset(): void {
    this.stop();
    this.clear();
  }
}

// ── Packet Inspector ──

/**
 * Live packet inspector that streams packet summaries to connected clients.
 * Designed to work with WebSocket connections for real-time monitoring.
 */
/** WebSocket readyState value for an open connection (matches WebSocket.OPEN = 1). */
const WS_READY_STATE_OPEN = 1;

interface WsClient {
  readyState: number;
  send(data: string): void;
  on(event: string, handler: () => void): void;
  removeAllListeners(event: string): void;
  close(): void;
}

class PacketInspector {
  maxClients: number;
  clients: Set<WsClient>;
  enabled: boolean;
  stats: {
    packetsInspected: number;
    clientsConnected: number;
  };

  /**
   * @param {Object} [config]
   * @param {number} [config.maxClients] - Max concurrent inspector clients
   */
  constructor(config: { maxClients?: number } = {}) {
    this.maxClients = config.maxClients || PACKET_INSPECTOR_MAX_CLIENTS;
    this.clients = new Set();
    this.enabled = false;
    this.stats = {
      packetsInspected: 0,
      clientsConnected: 0
    };
  }

  /**
   * Register a WebSocket client for live inspection
   * @param {Object} ws - WebSocket connection
   * @returns {boolean} Whether the client was accepted
   */
  addClient(ws: WsClient): boolean {
    if (this.clients.size >= this.maxClients) {
      return false;
    }

    this.clients.add(ws);
    this.stats.clientsConnected = this.clients.size;
    this.enabled = this.clients.size > 0;

    // Handle disconnect
    ws.on("close", () => {
      this.clients.delete(ws);
      this.stats.clientsConnected = this.clients.size;
      this.enabled = this.clients.size > 0;
    });

    ws.on("error", () => {
      this.clients.delete(ws);
      this.stats.clientsConnected = this.clients.size;
      this.enabled = this.clients.size > 0;
    });

    return true;
  }

  /**
   * Inspect a packet and broadcast summary to all connected clients
   * @param {Buffer} data - Raw packet data
   * @param {string} direction - "send" or "recv"
   * @param {Object} [meta] - Optional metadata {address, port}
   */
  inspect(data: Buffer, direction: string, meta: { address?: string; port?: number } = {}): void {
    if (!this.enabled || this.clients.size === 0) {
      return;
    }

    this.stats.packetsInspected++;

    const summary = this._buildSummary(data, direction, meta);
    const message = JSON.stringify(summary);

    // Broadcast to all clients
    const deadClients: WsClient[] = [];
    for (const ws of this.clients) {
      try {
        if (ws.readyState === WS_READY_STATE_OPEN) {
          ws.send(message);
        } else {
          deadClients.push(ws);
        }
      } catch (err) {
        deadClients.push(ws);
      }
    }

    // Clean up dead clients
    for (const ws of deadClients) {
      this.clients.delete(ws);
    }
    this.stats.clientsConnected = this.clients.size;
    this.enabled = this.clients.size > 0;
  }

  /**
   * Build a packet summary for inspection
   * @private
   * @param {Buffer} data - Raw packet data
   * @param {string} direction - "send" or "recv"
   * @param {Object} meta - Metadata
   * @returns {Object} Packet summary
   */
  _buildSummary(
    data: Buffer,
    direction: string,
    meta: { address?: string; port?: number }
  ): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      timestamp: Date.now(),
      direction,
      length: data.length,
      address: meta.address || "",
      port: meta.port || 0
    };

    // Try to parse v2 header
    if (data.length >= HEADER_SIZE && data[0] === 0x53 && data[1] === 0x4b) {
      summary.protocol = data[2] >= 3 ? `v${data[2]}` : "v2";
      summary.version = data[2];
      summary.type = getTypeName(data[3]);
      summary.flags = data[4];
      summary.sequence = data.readUInt32BE(5);
      summary.payloadLength = data.readUInt32BE(9);
    } else {
      summary.protocol = "unknown";
    }

    // First 32 bytes hex preview
    summary.hexPreview = data.subarray(0, Math.min(32, data.length)).toString("hex");

    return summary;
  }

  /**
   * Get inspector statistics
   * @returns {Object}
   */
  getStats(): { enabled: boolean; packetsInspected: number; clientsConnected: number } {
    return {
      enabled: this.enabled,
      ...this.stats
    };
  }

  /**
   * Disconnect all clients and reset
   */
  reset(): void {
    for (const ws of this.clients) {
      try {
        ws.removeAllListeners("close");
        ws.removeAllListeners("error");
        ws.close();
      } catch (err) {
        // Ignore close errors
      }
    }
    this.clients.clear();
    this.enabled = false;
    this.stats = { packetsInspected: 0, clientsConnected: 0 };
  }
}

export { PacketCapture, PacketInspector };
