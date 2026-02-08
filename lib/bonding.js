"use strict";

/**
 * Signal K Edge Link v2.0 - Connection Bonding
 *
 * Manages dual-link bonding with automatic failover/failback.
 * Supports main-backup mode with independent health monitoring per link.
 *
 * Features:
 * - Primary/backup link management with separate UDP sockets
 * - Health monitoring with configurable check intervals
 * - Automatic failover on: RTT threshold, packet loss threshold, or link down
 * - Failback delay to prevent oscillation
 * - Per-link metrics publishing to Signal K
 * - Signal K notifications on failover events
 *
 * @module lib/bonding
 */

const dgram = require("dgram");
const {
  BONDING_HEALTH_CHECK_INTERVAL,
  BONDING_RTT_THRESHOLD,
  BONDING_LOSS_THRESHOLD,
  BONDING_FAILBACK_DELAY,
  BONDING_HEARTBEAT_TIMEOUT,
  BONDING_FAILBACK_RTT_HYSTERESIS,
  BONDING_FAILBACK_LOSS_HYSTERESIS,
  BONDING_HEALTH_WINDOW_SIZE,
  BONDING_RTT_EMA_ALPHA
} = require("./constants");

/**
 * Link status values
 * @enum {string}
 */
const LinkStatus = Object.freeze({
  UNKNOWN: "unknown",
  ACTIVE: "active",
  STANDBY: "standby",
  DOWN: "down"
});

/**
 * Bonding mode values
 * @enum {string}
 */
const BondingMode = Object.freeze({
  MAIN_BACKUP: "main-backup"
});

class BondingManager {
  /**
   * @param {Object} config - Bonding configuration
   * @param {string} [config.mode='main-backup'] - Bonding mode
   * @param {Object} config.primary - Primary link config
   * @param {string} config.primary.address - Primary server address
   * @param {number} config.primary.port - Primary server port
   * @param {string} [config.primary.interface] - Bind interface for primary
   * @param {Object} config.backup - Backup link config
   * @param {string} config.backup.address - Backup server address
   * @param {number} config.backup.port - Backup server port
   * @param {string} [config.backup.interface] - Bind interface for backup
   * @param {Object} [config.failover] - Failover thresholds
   * @param {Object} app - Signal K app instance (for logging and messaging)
   */
  constructor(config, app) {
    this.app = app;
    this.config = config;
    this.mode = config.mode || BondingMode.MAIN_BACKUP;

    // Link definitions
    this.links = {
      primary: {
        name: "primary",
        address: config.primary.address,
        port: config.primary.port,
        interface: config.primary.interface || null,
        socket: null,
        health: {
          rtt: 0,
          loss: 0,
          quality: 100,
          status: LinkStatus.UNKNOWN
        },
        // Health measurement state
        heartbeatSeq: 0,
        pendingHeartbeats: new Map(), // seq -> timestamp
        heartbeatResponses: 0,
        heartbeatsSent: 0,
        rttSamples: [],
        lastHeartbeatResponse: 0
      },
      backup: {
        name: "backup",
        address: config.backup.address,
        port: config.backup.port,
        interface: config.backup.interface || null,
        socket: null,
        health: {
          rtt: 0,
          loss: 0,
          quality: 100,
          status: LinkStatus.UNKNOWN
        },
        heartbeatSeq: 0,
        pendingHeartbeats: new Map(),
        heartbeatResponses: 0,
        heartbeatsSent: 0,
        rttSamples: [],
        lastHeartbeatResponse: 0
      }
    };

    this.activeLink = "primary";

    // Failover thresholds
    const failoverConfig = config.failover || {};
    this.failoverThresholds = {
      rttThreshold: failoverConfig.rttThreshold || BONDING_RTT_THRESHOLD,
      lossThreshold: failoverConfig.lossThreshold || BONDING_LOSS_THRESHOLD,
      healthCheckInterval: failoverConfig.healthCheckInterval || BONDING_HEALTH_CHECK_INTERVAL,
      failbackDelay: failoverConfig.failbackDelay || BONDING_FAILBACK_DELAY,
      heartbeatTimeout: failoverConfig.heartbeatTimeout || BONDING_HEARTBEAT_TIMEOUT
    };

    this.lastFailoverTime = 0;
    this.healthCheckTimer = null;
    this._initialized = false;
    this._stopped = false;

    // Metrics publisher reference (set externally)
    this.metricsPublisher = null;

    // Event callbacks
    this._onFailover = null;
    this._onFailback = null;
  }

  /**
   * Initialize bonding manager - create UDP sockets and start health monitoring
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    for (const [name, link] of Object.entries(this.links)) {
      link.socket = dgram.createSocket("udp4");

      if (link.interface) {
        await new Promise((resolve, reject) => {
          link.socket.bind({ address: link.interface, port: 0 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Set up message handler for heartbeat responses
      link.socket.on("message", (msg, rinfo) => {
        this._handleHeartbeatResponse(name, msg);
      });

      link.socket.on("error", (err) => {
        this.app.debug(`[Bonding] ${name} socket error: ${err.message}`);
        link.health.status = LinkStatus.DOWN;
      });

      link.health.status = LinkStatus.STANDBY;
    }

    // Primary starts as active
    this.links.primary.health.status = LinkStatus.ACTIVE;

    this._initialized = true;

    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Start periodic health check monitoring
   */
  startHealthMonitoring() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      this._checkHealth();
    }, this.failoverThresholds.healthCheckInterval);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Perform health check on all links
   * @private
   */
  _checkHealth() {
    for (const [name, link] of Object.entries(this.links)) {
      this._measureLinkHealth(name, link);
    }

    // Evaluate failover/failback
    if (this._shouldFailover()) {
      this.failover();
    } else if (this._shouldFailback()) {
      this.failback();
    }
  }

  /**
   * Measure health of a specific link by sending a heartbeat probe
   * and evaluating recent response data
   * @private
   * @param {string} name - Link name ('primary' or 'backup')
   * @param {Object} link - Link object
   */
  _measureLinkHealth(name, link) {
    if (!link.socket || link.health.status === LinkStatus.DOWN) return;

    // Send heartbeat probe
    const seq = link.heartbeatSeq++;
    const timestamp = Date.now();
    const probe = Buffer.alloc(12);
    probe.write("HBPROBE", 0, 7, "ascii");
    probe.writeUInt32BE(seq, 7);
    probe.writeUInt8(0, 11); // padding

    link.pendingHeartbeats.set(seq, timestamp);
    link.heartbeatsSent++;

    try {
      link.socket.send(probe, link.port, link.address, (err) => {
        if (err) {
          this.app.debug(`[Bonding] ${name} heartbeat send error: ${err.message}`);
        }
      });
    } catch (err) {
      this.app.debug(`[Bonding] ${name} heartbeat send exception: ${err.message}`);
    }

    // Clean up old pending heartbeats (older than timeout)
    const timeout = this.failoverThresholds.heartbeatTimeout;
    for (const [pendingSeq, pendingTs] of link.pendingHeartbeats) {
      if (timestamp - pendingTs > timeout) {
        link.pendingHeartbeats.delete(pendingSeq);
      }
    }

    // Calculate health metrics
    this._updateLinkMetrics(name, link);

    // Check if link is down (no responses for heartbeatTimeout)
    if (link.heartbeatsSent > 3 && timestamp - link.lastHeartbeatResponse > timeout) {
      if (link.health.status !== LinkStatus.DOWN) {
        this.app.debug(`[Bonding] ${name} link appears down (no heartbeat response for ${timeout}ms)`);
        link.health.status = LinkStatus.DOWN;
      }
    }

    // Publish per-link metrics
    if (this.metricsPublisher) {
      this.metricsPublisher.publishLinkMetrics(name, {
        rtt: link.health.rtt,
        jitter: 0,
        packetLoss: link.health.loss,
        retransmitRate: 0,
        status: link.health.status
      });
    }
  }

  /**
   * Handle a heartbeat response from a link
   * @private
   * @param {string} name - Link name
   * @param {Buffer} msg - Response message
   */
  _handleHeartbeatResponse(name, msg) {
    const link = this.links[name];
    if (!link) return;

    // Validate response format
    if (msg.length < 12 || msg.toString("ascii", 0, 7) !== "HBPROBE") {
      // Not a heartbeat response - might be a control packet, pass through
      if (this._onControlPacket) {
        this._onControlPacket(name, msg);
      }
      return;
    }

    const seq = msg.readUInt32BE(7);
    const sendTime = link.pendingHeartbeats.get(seq);

    if (sendTime !== undefined) {
      const rtt = Date.now() - sendTime;
      link.pendingHeartbeats.delete(seq);
      link.heartbeatResponses++;
      link.lastHeartbeatResponse = Date.now();

      // Track RTT sample
      link.rttSamples.push(rtt);
      if (link.rttSamples.length > BONDING_HEALTH_WINDOW_SIZE) {
        link.rttSamples.shift();
      }

      // Update RTT using EMA
      if (link.health.rtt === 0) {
        link.health.rtt = rtt;
      } else {
        link.health.rtt = BONDING_RTT_EMA_ALPHA * rtt +
          (1 - BONDING_RTT_EMA_ALPHA) * link.health.rtt;
      }

      // If link was down, mark it as recovering
      if (link.health.status === LinkStatus.DOWN) {
        link.health.status = this.activeLink === name ? LinkStatus.ACTIVE : LinkStatus.STANDBY;
        this.app.debug(`[Bonding] ${name} link recovered (RTT: ${rtt}ms)`);
      }
    }
  }

  /**
   * Update health metrics for a link based on heartbeat statistics
   * @private
   * @param {string} name - Link name
   * @param {Object} link - Link object
   */
  _updateLinkMetrics(name, link) {
    // Calculate loss ratio
    if (link.heartbeatsSent > 0) {
      const expected = link.heartbeatsSent;
      const received = link.heartbeatResponses;
      link.health.loss = Math.max(0, Math.min(1, 1 - (received / expected)));
    }

    // Calculate quality score
    link.health.quality = this._calculateQuality(link.health);
  }

  /**
   * Calculate link quality score (0-100)
   * @private
   * @param {Object} health - Health metrics {rtt, loss}
   * @returns {number} Quality score 0-100
   */
  _calculateQuality(health) {
    // RTT component: 0-1 (1 = perfect, 0 = worst)
    const rttScore = Math.max(0, Math.min(1, 1 - (health.rtt / 1000)));

    // Loss component: 0-1 (1 = no loss, 0 = total loss)
    const lossScore = Math.max(0, 1 - health.loss);

    // Weighted: loss matters more (60%) than RTT (40%)
    const quality = (lossScore * 60 + rttScore * 40);

    return Math.round(quality);
  }

  /**
   * Determine if failover from primary to backup is needed
   * @private
   * @returns {boolean}
   */
  _shouldFailover() {
    if (this.activeLink !== "primary") return false;

    const primary = this.links.primary.health;
    const backup = this.links.backup.health;

    // Don't failover if backup is also down
    if (backup.status === LinkStatus.DOWN) return false;

    return (
      primary.status === LinkStatus.DOWN ||
      primary.rtt > this.failoverThresholds.rttThreshold ||
      primary.loss > this.failoverThresholds.lossThreshold
    );
  }

  /**
   * Determine if failback from backup to primary is appropriate
   * @private
   * @returns {boolean}
   */
  _shouldFailback() {
    if (this.activeLink !== "backup") return false;

    const primary = this.links.primary.health;
    const timeSinceFailover = Date.now() - this.lastFailoverTime;

    // Wait for failback delay
    if (timeSinceFailover < this.failoverThresholds.failbackDelay) return false;

    // Don't failback if primary is down
    if (primary.status === LinkStatus.DOWN) return false;

    // Hysteresis: require significantly better metrics before failback
    const rttOk = primary.rtt < this.failoverThresholds.rttThreshold * BONDING_FAILBACK_RTT_HYSTERESIS;
    const lossOk = primary.loss < this.failoverThresholds.lossThreshold * BONDING_FAILBACK_LOSS_HYSTERESIS;

    return rttOk && lossOk;
  }

  /**
   * Execute failover from primary to backup
   */
  failover() {
    if (this.activeLink === "backup") return;

    this.app.error("[FAILOVER] Switching from primary to backup link");

    this.activeLink = "backup";
    this.links.primary.health.status = this.links.primary.health.status === LinkStatus.DOWN
      ? LinkStatus.DOWN
      : LinkStatus.STANDBY;
    this.links.backup.health.status = LinkStatus.ACTIVE;
    this.lastFailoverTime = Date.now();

    // Emit Signal K notification
    this._emitFailoverNotification("primary", "backup");

    if (this._onFailover) {
      this._onFailover("primary", "backup");
    }
  }

  /**
   * Execute failback from backup to primary
   */
  failback() {
    if (this.activeLink === "primary") return;

    this.app.debug("[FAILBACK] Switching from backup to primary link");

    this.activeLink = "primary";
    this.links.primary.health.status = LinkStatus.ACTIVE;
    this.links.backup.health.status = LinkStatus.STANDBY;

    // Emit Signal K notification
    this._emitFailoverNotification("backup", "primary");

    if (this._onFailback) {
      this._onFailback("backup", "primary");
    }
  }

  /**
   * Emit a Signal K notification about a link change
   * @private
   * @param {string} from - Source link name
   * @param {string} to - Destination link name
   */
  _emitFailoverNotification(from, to) {
    try {
      this.app.handleMessage("vessels.self", {
        updates: [{
          source: {
            label: "signalk-edge-link",
            type: "plugin"
          },
          timestamp: new Date().toISOString(),
          values: [{
            path: "notifications.signalk-edge-link.linkFailover",
            value: {
              state: "alert",
              message: `Link switched: ${from} to ${to}`,
              method: ["visual", "sound"]
            }
          }]
        }]
      });
    } catch (err) {
      this.app.debug(`[Bonding] Failed to emit failover notification: ${err.message}`);
    }
  }

  /**
   * Get the active link's UDP socket
   * @returns {Object|null} dgram socket or null
   */
  getActiveSocket() {
    return this.links[this.activeLink].socket;
  }

  /**
   * Get the active link's destination address and port
   * @returns {Object} { address, port }
   */
  getActiveAddress() {
    const link = this.links[this.activeLink];
    return { address: link.address, port: link.port };
  }

  /**
   * Get the name of the currently active link
   * @returns {string} 'primary' or 'backup'
   */
  getActiveLinkName() {
    return this.activeLink;
  }

  /**
   * Get health information for all links
   * @returns {Object} Link health data
   */
  getLinkHealth() {
    const result = {};
    for (const [name, link] of Object.entries(this.links)) {
      result[name] = {
        address: link.address,
        port: link.port,
        status: link.health.status,
        rtt: Math.round(link.health.rtt),
        loss: link.health.loss,
        quality: link.health.quality,
        heartbeatsSent: link.heartbeatsSent,
        heartbeatResponses: link.heartbeatResponses
      };
    }
    return result;
  }

  /**
   * Get full bonding state for API/diagnostics
   * @returns {Object} Bonding state
   */
  getState() {
    return {
      enabled: true,
      mode: this.mode,
      activeLink: this.activeLink,
      lastFailoverTime: this.lastFailoverTime,
      failoverThresholds: { ...this.failoverThresholds },
      links: this.getLinkHealth()
    };
  }

  /**
   * Set a callback for control packets received on link sockets
   * (e.g., ACK/NAK packets that should be forwarded to the pipeline)
   * @param {Function} handler - (linkName, msg) handler
   */
  onControlPacket(handler) {
    this._onControlPacket = handler;
  }

  /**
   * Set callback for failover events
   * @param {Function} handler - (fromLink, toLink) handler
   */
  onFailover(handler) {
    this._onFailover = handler;
  }

  /**
   * Set callback for failback events
   * @param {Function} handler - (fromLink, toLink) handler
   */
  onFailback(handler) {
    this._onFailback = handler;
  }

  /**
   * Set the metrics publisher for per-link metrics
   * @param {Object} publisher - MetricsPublisher instance
   */
  setMetricsPublisher(publisher) {
    this.metricsPublisher = publisher;
  }

  /**
   * Manually force a failover (for testing/API)
   */
  forceFailover() {
    if (this.activeLink === "primary") {
      this.failover();
    } else {
      this.failback();
    }
  }

  /**
   * Stop bonding manager and clean up all resources
   */
  stop() {
    this._stopped = true;

    this.stopHealthMonitoring();

    for (const link of Object.values(this.links)) {
      if (link.socket) {
        try {
          link.socket.close();
        } catch (err) {
          // Socket may already be closed
        }
        link.socket = null;
      }
      link.pendingHeartbeats.clear();
      link.rttSamples = [];
    }

    this._initialized = false;
  }
}

module.exports = { BondingManager, LinkStatus, BondingMode };
