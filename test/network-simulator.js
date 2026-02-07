"use strict";

/**
 * Signal K Edge Link v2.0 - Network Simulator
 *
 * Simulates network conditions for reliability testing:
 * - Packet loss (configurable percentage)
 * - Latency (fixed + jitter)
 * - Packet reordering
 *
 * @module test/network-simulator
 */

class NetworkSimulator {
  /**
   * @param {Object} [config]
   * @param {number} [config.packetLoss=0] - Packet loss rate (0.0 to 1.0)
   * @param {number} [config.latency=0] - Base latency in ms
   * @param {number} [config.jitter=0] - Random jitter in ms (+/-)
   * @param {number} [config.reorderRate=0] - Probability of reordering (0.0 to 1.0)
   * @param {number} [config.reorderDelay=50] - Extra delay for reordered packets (ms)
   */
  constructor(config = {}) {
    this.packetLoss = config.packetLoss || 0;
    this.latency = config.latency || 0;
    this.jitter = config.jitter || 0;
    this.reorderRate = config.reorderRate || 0;
    this.reorderDelay = config.reorderDelay || 50;

    // Statistics
    this.stats = {
      totalPackets: 0,
      droppedPackets: 0,
      deliveredPackets: 0,
      reorderedPackets: 0
    };

    // Pending deliveries (for cleanup)
    this._pendingTimers = [];
  }

  /**
   * Simulate sending a packet through the network.
   * The packet may be dropped, delayed, or reordered.
   *
   * @param {Buffer} packet - Packet data
   * @param {function} deliverFn - Callback to deliver the packet: (packet) => void
   * @returns {boolean} false if dropped, true if scheduled for delivery
   */
  send(packet, deliverFn) {
    this.stats.totalPackets++;

    // Packet loss
    if (Math.random() < this.packetLoss) {
      this.stats.droppedPackets++;
      return false;
    }

    // Calculate delay
    let delay = this.latency;
    if (this.jitter > 0) {
      delay += (Math.random() * 2 - 1) * this.jitter;
    }
    delay = Math.max(0, delay);

    // Reordering: add extra delay
    if (Math.random() < this.reorderRate) {
      delay += this.reorderDelay;
      this.stats.reorderedPackets++;
    }

    // Schedule delivery
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.stats.deliveredPackets++;
        deliverFn(packet);
      }, delay);
      this._pendingTimers.push(timer);
    } else {
      // Immediate delivery
      this.stats.deliveredPackets++;
      deliverFn(packet);
    }

    return true;
  }

  /**
   * Get current statistics
   * @returns {Object} Network simulation statistics
   */
  getStats() {
    return {
      ...this.stats,
      lossRate: this.stats.totalPackets > 0
        ? this.stats.droppedPackets / this.stats.totalPackets
        : 0,
      deliveryRate: this.stats.totalPackets > 0
        ? this.stats.deliveredPackets / this.stats.totalPackets
        : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalPackets: 0,
      droppedPackets: 0,
      deliveredPackets: 0,
      reorderedPackets: 0
    };
  }

  /**
   * Cancel all pending deliveries and clean up timers
   */
  destroy() {
    for (const timer of this._pendingTimers) {
      clearTimeout(timer);
    }
    this._pendingTimers = [];
  }
}

/**
 * Creates a simulated UDP socket pair that routes through a NetworkSimulator.
 * Useful for end-to-end testing without real network I/O.
 *
 * @param {NetworkSimulator} clientToServer - Simulator for client→server direction
 * @param {NetworkSimulator} serverToClient - Simulator for server→client direction
 * @returns {Object} { clientSocket, serverSocket } - Mock socket objects
 */
function createSimulatedSockets(clientToServer, serverToClient) {
  const listeners = {
    client: [],
    server: []
  };

  const clientSocket = {
    send(message, port, host, callback) {
      const sent = clientToServer.send(Buffer.from(message), (packet) => {
        for (const fn of listeners.server) {
          fn(packet, { address: "127.0.0.1", port: 5555 });
        }
      });
      if (callback) callback(sent ? null : new Error("Packet dropped by simulator"));
    },
    on(event, fn) {
      if (event === "message") {
        listeners.client.push(fn);
      }
    },
    close() {
      listeners.client = [];
    }
  };

  const serverSocket = {
    send(message, port, host, callback) {
      const sent = serverToClient.send(Buffer.from(message), (packet) => {
        for (const fn of listeners.client) {
          fn(packet, { address: "127.0.0.1", port: 6666 });
        }
      });
      if (callback) callback(sent ? null : new Error("Packet dropped by simulator"));
    },
    on(event, fn) {
      if (event === "message") {
        listeners.server.push(fn);
      }
    },
    close() {
      listeners.server = [];
    }
  };

  return { clientSocket, serverSocket };
}

module.exports = { NetworkSimulator, createSimulatedSockets };
