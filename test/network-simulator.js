"use strict";

/**
 * Signal K Edge Link v2.0 - Network Simulator
 *
 * Simulates network conditions for reliability testing:
 * - Packet loss (configurable percentage)
 * - Latency (fixed + jitter)
 * - Packet reordering
 * - Link flapping (periodic up/down cycling)
 * - Bandwidth throttling with patterns (constant, step-down, sawtooth, burst)
 * - Asymmetric loss (different rates per direction)
 * - Burst/correlated loss (Gilbert-Elliott model)
 * - Latency spike simulation
 *
 * @module test/network-simulator
 */

// Bandwidth throttling pattern types
const ThrottlePattern = {
  CONSTANT: "constant",       // Fixed bandwidth limit
  STEP_DOWN: "step-down",     // Stepwise bandwidth reduction over time
  SAWTOOTH: "sawtooth",       // Ramp up then drop repeatedly
  BURST: "burst"              // Alternate between full and limited bandwidth
};

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
   * @param {Object} [config.burstLoss] - Burst/correlated loss configuration (Gilbert-Elliott)
   * @param {number} [config.burstLoss.burstLength=0] - Average burst length (0=disabled)
   * @param {number} [config.burstLoss.burstRate=0] - Probability of entering burst state
   * @param {Object} [config.throttlePattern] - Bandwidth throttling pattern
   * @param {string} [config.throttlePattern.type] - Pattern type: constant, step-down, sawtooth, burst
   * @param {number} [config.throttlePattern.cycleDuration] - Duration of one pattern cycle (ms)
   * @param {number} [config.throttlePattern.minBandwidth] - Minimum bandwidth in pattern
   * @param {number} [config.throttlePattern.maxBandwidth] - Maximum bandwidth in pattern
   * @param {number} [config.throttlePattern.steps] - Number of steps (for step-down)
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

    // Bandwidth throttling patterns
    this._throttlePattern = null;
    this._throttlePatternStart = Date.now();
    if (config.throttlePattern && config.throttlePattern.type) {
      this._throttlePattern = {
        type: config.throttlePattern.type,
        cycleDuration: config.throttlePattern.cycleDuration || 10000,
        minBandwidth: config.throttlePattern.minBandwidth || 0,
        maxBandwidth: config.throttlePattern.maxBandwidth || config.bandwidthLimit || 10000,
        steps: config.throttlePattern.steps || 4
      };
    }

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

    // Burst/correlated loss (Gilbert-Elliott model)
    this._burstLoss = null;
    this._inBurst = false;
    this._burstRemaining = 0;
    if (config.burstLoss && config.burstLoss.burstLength > 0) {
      this._burstLoss = {
        burstLength: config.burstLoss.burstLength,
        burstRate: config.burstLoss.burstRate || 0.05
      };
    }

    // Latency spike tracking
    this._latencySpike = null;

    // Statistics
    this.stats = {
      totalPackets: 0,
      droppedPackets: 0,
      deliveredPackets: 0,
      reorderedPackets: 0,
      throttledPackets: 0,
      linkDownDrops: 0,
      burstLossPackets: 0,
      latencySpikes: 0
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

    // Burst/correlated loss (Gilbert-Elliott model)
    if (this._burstLoss) {
      if (this._inBurst) {
        this._burstRemaining--;
        if (this._burstRemaining <= 0) {
          this._inBurst = false;
        }
        this.stats.droppedPackets++;
        this.stats.burstLossPackets++;
        return false;
      } else if (Math.random() < this._burstLoss.burstRate) {
        // Enter burst state
        this._inBurst = true;
        this._burstRemaining = this._burstLoss.burstLength - 1;
        this.stats.droppedPackets++;
        this.stats.burstLossPackets++;
        return false;
      }
    }

    // Packet loss
    if (Math.random() < this.packetLoss) {
      this.stats.droppedPackets++;
      return false;
    }

    // Bandwidth throttling (with pattern support)
    const effectiveBandwidth = this._getEffectiveBandwidth();
    if (effectiveBandwidth > 0) {
      const now = Date.now();
      const elapsed = (now - this._windowStart) / 1000;
      if (elapsed >= 1) {
        this._bytesSentInWindow = 0;
        this._windowStart = now;
      }
      if (this._bytesSentInWindow + packet.length > effectiveBandwidth) {
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

    // Latency spike
    if (this._latencySpike) {
      const now = Date.now();
      if (now >= this._latencySpike.startTime && now < this._latencySpike.endTime) {
        delay += this._latencySpike.extraLatency;
        this.stats.latencySpikes++;
      }
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
      linkDownDrops: 0,
      burstLossPackets: 0,
      latencySpikes: 0
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
   * Get the effective bandwidth limit, accounting for throttle patterns.
   * @private
   * @returns {number} Effective bandwidth in bytes/sec (0 = unlimited)
   */
  _getEffectiveBandwidth() {
    if (!this._throttlePattern) {
      return this.bandwidthLimit;
    }

    const elapsed = Date.now() - this._throttlePatternStart;
    const { type, cycleDuration, minBandwidth, maxBandwidth, steps } = this._throttlePattern;
    const cyclePosition = (elapsed % cycleDuration) / cycleDuration; // 0.0 to 1.0

    switch (type) {
      case ThrottlePattern.STEP_DOWN: {
        // Step down from max to min over the cycle
        const step = Math.floor(cyclePosition * steps);
        const range = maxBandwidth - minBandwidth;
        return Math.round(maxBandwidth - (step / (steps - 1)) * range);
      }
      case ThrottlePattern.SAWTOOTH: {
        // Linear ramp from min to max, then drop back to min
        return Math.round(minBandwidth + cyclePosition * (maxBandwidth - minBandwidth));
      }
      case ThrottlePattern.BURST: {
        // First half: full bandwidth, second half: limited
        return cyclePosition < 0.5 ? maxBandwidth : minBandwidth;
      }
      case ThrottlePattern.CONSTANT:
      default:
        return this.bandwidthLimit || maxBandwidth;
    }
  }

  /**
   * Set a bandwidth throttling pattern.
   * @param {string} type - Pattern type: 'constant', 'step-down', 'sawtooth', 'burst'
   * @param {Object} [options]
   * @param {number} [options.cycleDuration=10000] - Duration of one pattern cycle (ms)
   * @param {number} [options.minBandwidth=0] - Minimum bandwidth
   * @param {number} [options.maxBandwidth=10000] - Maximum bandwidth
   * @param {number} [options.steps=4] - Number of steps (for step-down)
   */
  setThrottlePattern(type, options = {}) {
    this._throttlePattern = {
      type,
      cycleDuration: options.cycleDuration || 10000,
      minBandwidth: options.minBandwidth || 0,
      maxBandwidth: options.maxBandwidth || 10000,
      steps: options.steps || 4
    };
    this._throttlePatternStart = Date.now();
  }

  /**
   * Clear any bandwidth throttling pattern.
   */
  clearThrottlePattern() {
    this._throttlePattern = null;
  }

  /**
   * Configure burst/correlated loss (Gilbert-Elliott model).
   * @param {number} burstLength - Average number of consecutive packets lost per burst
   * @param {number} burstRate - Probability of entering burst state per packet (0-1)
   */
  setBurstLoss(burstLength, burstRate) {
    if (burstLength <= 0) {
      this._burstLoss = null;
      this._inBurst = false;
      this._burstRemaining = 0;
      return;
    }
    this._burstLoss = { burstLength, burstRate };
    this._inBurst = false;
    this._burstRemaining = 0;
  }

  /**
   * Simulate a latency spike for a specified duration.
   * @param {number} extraLatency - Additional latency in ms
   * @param {number} duration - Duration of the spike in ms
   */
  simulateLatencySpike(extraLatency, duration) {
    const now = Date.now();
    this._latencySpike = {
      extraLatency,
      startTime: now,
      endTime: now + duration
    };
  }

  /**
   * Clear any active latency spike.
   */
  clearLatencySpike() {
    this._latencySpike = null;
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
      flapping: this._flapping ? { ...this._flapping } : null,
      burstLoss: this._burstLoss ? { ...this._burstLoss } : null,
      throttlePattern: this._throttlePattern ? { ...this._throttlePattern } : null,
      latencySpike: this._latencySpike ? { ...this._latencySpike } : null
    };
  }

  /**
   * Cancel all pending deliveries and clean up timers
   */
  destroy() {
    this.stopFlapping();
    this.clearLatencySpike();
    this._burstLoss = null;
    this._inBurst = false;
    this._throttlePattern = null;
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

module.exports = { NetworkSimulator, createSimulatedSockets, ThrottlePattern };
