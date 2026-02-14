"use strict";

/**
 * Signal K Edge Link v2.0 - Network Simulator
 *
 * Simulates network conditions for reliability testing:
 * - Packet loss (configurable percentage)
 * - Latency (fixed + jitter)
 * - Packet reordering
 * - Link flapping (periodic up/down cycling)
 * - Bandwidth throttling
 * - Asymmetric loss (different rates per direction)
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
   * @param {number} [config.bandwidthLimit=0] - Bandwidth limit in bytes/sec (0=unlimited)
   * @param {boolean} [config.linkDown=false] - Whether link is currently down
   * @param {Object} [config.flapping] - Link flapping configuration
   * @param {number} [config.flapping.upDuration=0] - How long link stays up (ms, 0=disabled)
   * @param {number} [config.flapping.downDuration=0] - How long link stays down (ms)
   */
  constructor(config = {}) {
    this.packetLoss = config.packetLoss || 0;
    this.latency = config.latency || 0;
    this.jitter = config.jitter || 0;
    this.reorderRate = config.reorderRate || 0;
    this.reorderDelay = config.reorderDelay || 50;

    // Bandwidth throttling
    this.bandwidthLimit = config.bandwidthLimit || 0; // bytes/sec, 0 = unlimited
    this._bytesSentInWindow = 0;
    this._windowStart = Date.now();

    // Link state
    this.linkDown = config.linkDown || false;

    // Flapping
    this._flapping = null;
    this._flappingTimer = null;
    if (config.flapping && config.flapping.upDuration > 0) {
      this._flapping = {
        upDuration: config.flapping.upDuration,
        downDuration: config.flapping.downDuration || config.flapping.upDuration
      };
    }

    // Statistics
    this.stats = {
      totalPackets: 0,
      droppedPackets: 0,
      deliveredPackets: 0,
      reorderedPackets: 0,
      throttledPackets: 0,
      linkDownDrops: 0
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

    // Link down check
    if (this.linkDown) {
      this.stats.droppedPackets++;
      this.stats.linkDownDrops++;
      return false;
    }

    // Packet loss
    if (Math.random() < this.packetLoss) {
      this.stats.droppedPackets++;
      return false;
    }

    // Bandwidth throttling
    if (this.bandwidthLimit > 0) {
      const now = Date.now();
      const elapsed = (now - this._windowStart) / 1000;
      if (elapsed >= 1) {
        this._bytesSentInWindow = 0;
        this._windowStart = now;
      }
      if (this._bytesSentInWindow + packet.length > this.bandwidthLimit) {
        this.stats.droppedPackets++;
        this.stats.throttledPackets++;
        return false;
      }
      this._bytesSentInWindow += packet.length;
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
      reorderedPackets: 0,
      throttledPackets: 0,
      linkDownDrops: 0
    };
  }

  /**
   * Set the link state (up or down)
   * @param {boolean} down - True to bring link down
   */
  setLinkDown(down) {
    this.linkDown = down;
  }

  /**
   * Start link flapping (periodic up/down cycling)
   * @param {number} upDuration - How long link stays up (ms)
   * @param {number} downDuration - How long link stays down (ms)
   */
  startFlapping(upDuration, downDuration) {
    this.stopFlapping();
    this._flapping = { upDuration, downDuration };
    this.linkDown = false;

    const cycle = () => {
      if (!this._flapping) return;

      // Link goes down after upDuration
      this._flappingTimer = setTimeout(() => {
        this.linkDown = true;
        // Link comes back up after downDuration
        this._flappingTimer = setTimeout(() => {
          this.linkDown = false;
          cycle();
        }, this._flapping.downDuration);
        this._pendingTimers.push(this._flappingTimer);
      }, this._flapping.upDuration);
      this._pendingTimers.push(this._flappingTimer);
    };

    cycle();
  }

  /**
   * Stop link flapping
   */
  stopFlapping() {
    this._flapping = null;
    if (this._flappingTimer) {
      clearTimeout(this._flappingTimer);
      this._flappingTimer = null;
    }
    this.linkDown = false;
  }

  /**
   * Update network conditions dynamically
   * @param {Object} conditions - New conditions to apply
   */
  updateConditions(conditions) {
    if (conditions.packetLoss !== undefined) this.packetLoss = conditions.packetLoss;
    if (conditions.latency !== undefined) this.latency = conditions.latency;
    if (conditions.jitter !== undefined) this.jitter = conditions.jitter;
    if (conditions.reorderRate !== undefined) this.reorderRate = conditions.reorderRate;
    if (conditions.bandwidthLimit !== undefined) this.bandwidthLimit = conditions.bandwidthLimit;
    if (conditions.linkDown !== undefined) this.linkDown = conditions.linkDown;
  }

  /**
   * Get current network conditions
   * @returns {Object} Current conditions
   */
  getConditions() {
    return {
      packetLoss: this.packetLoss,
      latency: this.latency,
      jitter: this.jitter,
      reorderRate: this.reorderRate,
      bandwidthLimit: this.bandwidthLimit,
      linkDown: this.linkDown,
      flapping: this._flapping ? { ...this._flapping } : null
    };
  }

  /**
   * Cancel all pending deliveries and clean up timers
   */
  destroy() {
    this.stopFlapping();
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
