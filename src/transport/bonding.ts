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
 * @module domain/bonding
 */

import * as dgram from "dgram";
import CircularBuffer from "../foundation/circular-buffer";
import type { SignalKApp } from "../foundation/types";
import {
  BONDING_HEALTH_CHECK_INTERVAL,
  BONDING_RTT_THRESHOLD,
  BONDING_LOSS_THRESHOLD,
  BONDING_FAILBACK_DELAY,
  BONDING_HEARTBEAT_TIMEOUT,
  BONDING_HEALTH_WINDOW_SIZE
} from "../foundation/constants";
import {
  buildHeartbeatProbe,
  classifyHeartbeatResponse,
  expirePendingHeartbeats,
  computeLossRatio,
  calculateQuality,
  updateRttEma,
  shouldFailover,
  shouldFailback,
  buildFailoverNotification,
  bindLinkInterface,
  recreateLinkSocket
} from "./bonding-health";
import type { FailoverDecisionInput } from "./bonding-health";
import { LinkStatus, BondingMode, createLinkState, linkHealthSnapshot } from "./bonding-types";
import type {
  LinkState,
  LinkHealth,
  BondingConfig,
  LinkMetricsPublisher,
  FailoverThresholds,
  LinkHealthSnapshot,
  BondingState
} from "./bonding-types";

export class BondingManager {
  private app: SignalKApp;
  private config: BondingConfig;
  private mode: string;
  private instanceId: string;
  private sourceLabel: string;
  private notificationsEnabled: boolean;
  private secretKey: string | null;
  private stretchAsciiKey: boolean;
  private links: { primary: LinkState; backup: LinkState };
  private activeLink: string;
  failoverThresholds: FailoverThresholds;
  private lastFailoverTime: number;
  // Timestamp primary last became active (startup or last failback). Used to
  // enforce a minimum dwell before a *soft* (degradation-driven) failover so a
  // marginal primary cannot flap primary<->backup every health-check tick.
  private lastFailbackTime: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null;
  private _initialized: boolean;
  private _stopped: boolean;
  public metricsPublisher: LinkMetricsPublisher | null;
  private _onFailover: ((from: string, to: string) => void) | null;
  private _onFailback: ((from: string, to: string) => void) | null;
  private _onControlPacket?: ((linkName: string, msg: Buffer) => void) | null;

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
  constructor(config: BondingConfig, app: SignalKApp) {
    this.app = app;
    this.config = config;
    this.mode = config.mode || BondingMode.MAIN_BACKUP;
    // instanceId namespaces the failover notification path so multiple bonding
    // instances don't overwrite each other's notifications in Signal K.
    this.instanceId = config.instanceId || "";
    this.sourceLabel = this.instanceId
      ? `signalk-edge-link:${this.instanceId}`
      : "signalk-edge-link";
    this.notificationsEnabled = config.notificationsEnabled === true;
    this.secretKey = config.secretKey || null;
    this.stretchAsciiKey = !!config.stretchAsciiKey;

    // Link definitions
    this.links = {
      primary: createLinkState("primary", config.primary),
      backup: createLinkState("backup", config.backup)
    };

    this.activeLink = "primary";

    // Failover thresholds
    const failoverConfig = config.failover || {};
    this.failoverThresholds = {
      rttThreshold: failoverConfig.rttThreshold ?? BONDING_RTT_THRESHOLD,
      lossThreshold: failoverConfig.lossThreshold ?? BONDING_LOSS_THRESHOLD,
      healthCheckInterval: failoverConfig.healthCheckInterval ?? BONDING_HEALTH_CHECK_INTERVAL,
      failbackDelay: failoverConfig.failbackDelay ?? BONDING_FAILBACK_DELAY,
      heartbeatTimeout: failoverConfig.heartbeatTimeout ?? BONDING_HEARTBEAT_TIMEOUT
    };

    this.lastFailoverTime = 0;
    this.lastFailbackTime = 0;
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
  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    for (const [name, link] of Object.entries(this.links)) {
      link.socket = dgram.createSocket("udp4");

      if (link.interface) {
        await bindLinkInterface(link);
      }

      this._attachSocketHandlers(name, link, "socket error");

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
  startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this._checkHealth();
    }, this.failoverThresholds.healthCheckInterval);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Perform health check on all links
   * @private
   */
  private _checkHealth(): void {
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
  private _measureLinkHealth(name: string, link: LinkState): void {
    if (!link.socket) {
      return;
    }

    // Send heartbeat probe.
    // When a secretKey is configured, a truncated HMAC-SHA256 tag is appended
    // after the fixed 12-byte header so the server can reject forged probes.
    const seq = link.heartbeatSeq++;
    const timestamp = Date.now();
    const probe = buildHeartbeatProbe(seq, this.secretKey, this.stretchAsciiKey);

    link.pendingHeartbeats.set(seq, timestamp);
    link.heartbeatsSent++;
    this._sendProbe(name, link, probe);

    // Clean up old pending heartbeats (older than timeout)
    const timeout = this.failoverThresholds.heartbeatTimeout;
    expirePendingHeartbeats(link.pendingHeartbeats, link.lossSamples, timestamp, timeout);

    // Calculate health metrics
    this._updateLinkMetrics(name, link);

    // Check if link is down (no responses for heartbeatTimeout)
    this._maybeMarkLinkDown(name, link, timestamp, timeout);

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
   * Send a heartbeat probe on a link's socket, logging (but swallowing) any
   * async send error or synchronous send exception.
   * @private
   */
  private _sendProbe(name: string, link: LinkState, probe: Buffer): void {
    try {
      link.socket!.send(probe, link.port, link.address, (err?: Error | null) => {
        if (err) {
          this.app.debug(`[Bonding] ${name} heartbeat send error: ${err.message}`);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.app.debug(`[Bonding] ${name} heartbeat send exception: ${msg}`);
    }
  }

  /**
   * Mark a link DOWN when it has sent enough probes but received no response
   * within the heartbeat timeout window.
   * @private
   */
  private _maybeMarkLinkDown(
    name: string,
    link: LinkState,
    timestamp: number,
    timeout: number
  ): void {
    const noResponse = link.heartbeatsSent > 3 && timestamp - link.lastHeartbeatResponse > timeout;
    if (noResponse && link.health.status !== LinkStatus.DOWN) {
      this.app.debug(
        `[Bonding] ${name} link appears down (no heartbeat response for ${timeout}ms)`
      );
      link.health.status = LinkStatus.DOWN;
    }
  }

  /**
   * Handle a heartbeat response from a link
   * @private
   * @param {string} name - Link name
   * @param {Buffer} msg - Response message
   */
  private _handleHeartbeatResponse(name: string, msg: Buffer): void {
    const link = this.links[name as keyof typeof this.links] as LinkState | undefined;
    if (!link) {
      return;
    }

    const classification = classifyHeartbeatResponse(msg, this.secretKey, this.stretchAsciiKey);
    if (classification === "not-heartbeat") {
      // Not a heartbeat response — might be a control packet, pass through.
      if (this._onControlPacket) {
        this._onControlPacket(name, msg);
      }
      return;
    }
    if (classification === "drop") {
      this.app.debug(`[Bonding] ${name} heartbeat response failed validation — dropping`);
      return;
    }

    const seq = msg.readUInt32BE(7);
    const sendTime = link.pendingHeartbeats.get(seq);
    if (sendTime === undefined) {
      return;
    }

    this._recordHeartbeatRtt(name, link, seq, Date.now() - sendTime);
  }

  /**
   * Record a successful heartbeat response: update counters, push samples,
   * refresh the EMA RTT, and recover the link if it was previously DOWN.
   * @private
   */
  private _recordHeartbeatRtt(name: string, link: LinkState, seq: number, rtt: number): void {
    link.pendingHeartbeats.delete(seq);
    link.heartbeatResponses++;
    link.lastHeartbeatResponse = Date.now();
    link.lossSamples.push(true);

    // Track RTT sample
    link.rttSamples.push(rtt);

    // Update RTT using EMA
    link.health.rtt = updateRttEma(link.health.rtt, rtt);

    // If link was down, mark it as recovering
    if (link.health.status === LinkStatus.DOWN) {
      link.health.status = this.activeLink === name ? LinkStatus.ACTIVE : LinkStatus.STANDBY;
      this.app.debug(`[Bonding] ${name} link recovered (RTT: ${rtt}ms)`);
    }
  }

  /**
   * Update health metrics for a link based on heartbeat statistics
   * @private
   * @param {string} name - Link name
   * @param {Object} link - Link object
   */
  private _updateLinkMetrics(name: string, link: LinkState): void {
    // Calculate loss ratio from recent heartbeat outcomes (or aggregate
    // counters as a fallback for tests/diagnostics).
    const loss = computeLossRatio(link.lossSamples, link.heartbeatsSent, link.heartbeatResponses);
    if (loss !== null) {
      link.health.loss = loss;
    }

    // Calculate quality score
    link.health.quality = this._calculateQuality(link.health);
  }

  /**
   * Calculate link quality score (0-100) from a link's RTT and loss.
   * @private
   * @param {Object} health - Health metrics {rtt, loss}
   * @returns {number} Quality score 0-100
   */
  private _calculateQuality(health: LinkHealth): number {
    return calculateQuality(health);
  }

  /**
   * Schedule socket recreation after an error, with a 5-second delay.
   * @private
   * @param {string} name - Link name
   * @param {Object} link - Link state object
   */
  private _scheduleSocketRecovery(name: string, link: LinkState): void {
    if (this._stopped) {
      return;
    }
    // Avoid scheduling multiple recoveries
    if (link._recoveryTimer) {
      return;
    }

    link._recoveryTimer = setTimeout(() => {
      link._recoveryTimer = null;
      if (this._stopped) {
        return;
      }
      this._recreateSocket(name, link);
    }, 5000);
  }

  /**
   * Recreate a link's UDP socket after an error, re-attaching handlers and
   * rebinding to the configured interface when one is set.
   * @private
   */
  private _recreateSocket(name: string, link: LinkState): void {
    recreateLinkSocket(
      link,
      name,
      (msg: string) => this.app.debug(msg),
      (l: LinkState) => this._attachSocketHandlers(name, l, "socket error after recovery"),
      { standby: LinkStatus.STANDBY, down: LinkStatus.DOWN }
    );
  }

  /**
   * Attach the heartbeat-response message handler and an error handler that
   * marks the link DOWN and reschedules recovery. `errorContext` distinguishes
   * the initial wiring from a post-recovery wiring in debug output.
   * @private
   */
  private _attachSocketHandlers(name: string, link: LinkState, errorContext: string): void {
    link.socket!.on("message", (msg: Buffer, _rinfo: dgram.RemoteInfo) => {
      this._handleHeartbeatResponse(name, msg);
    });
    link.socket!.on("error", (err: Error) => {
      this.app.debug(`[Bonding] ${name} ${errorContext}: ${err.message}`);
      link.health.status = LinkStatus.DOWN;
      this._scheduleSocketRecovery(name, link);
    });
  }

  /**
   * Determine if failover from primary to backup is needed
   * @private
   * @returns {boolean}
   */
  private _shouldFailover(): boolean {
    return shouldFailover(this._failoverDecisionInput());
  }

  /**
   * Determine if failback from backup to primary is appropriate
   * @private
   * @returns {boolean}
   */
  private _shouldFailback(): boolean {
    return shouldFailback(this._failoverDecisionInput());
  }

  /**
   * Build the snapshot of state used by the failover/failback decision helpers.
   * @private
   */
  private _failoverDecisionInput(): FailoverDecisionInput {
    return {
      activeLink: this.activeLink,
      primary: this.links.primary.health,
      backup: this.links.backup.health,
      thresholds: this.failoverThresholds,
      lastFailbackTime: this.lastFailbackTime,
      lastFailoverTime: this.lastFailoverTime,
      now: Date.now(),
      downStatus: LinkStatus.DOWN
    };
  }

  /**
   * Execute failover from primary to backup
   */
  failover(): void {
    if (this.activeLink === "backup") {
      return;
    }

    this.app.error("[FAILOVER] Switching from primary to backup link");

    this.activeLink = "backup";
    this.links.primary.health.status =
      this.links.primary.health.status === LinkStatus.DOWN ? LinkStatus.DOWN : LinkStatus.STANDBY;
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
  failback(): void {
    if (this.activeLink === "primary") {
      return;
    }

    this.app.debug("[FAILBACK] Switching from backup to primary link");

    this.activeLink = "primary";
    this.links.primary.health.status = LinkStatus.ACTIVE;
    this.links.backup.health.status = LinkStatus.STANDBY;
    this.lastFailbackTime = Date.now();

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
  private _emitFailoverNotification(from: string, to: string): void {
    if (!this.notificationsEnabled) {
      return;
    }
    try {
      this.app.handleMessage(
        this.sourceLabel,
        buildFailoverNotification(this.instanceId, from, to)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.app.debug(`[Bonding] Failed to emit failover notification: ${msg}`);
    }
  }

  /**
   * Get the active link's UDP socket
   * @returns {Object|null} dgram socket or null
   */
  getActiveSocket(): dgram.Socket | null {
    return this.links[this.activeLink as keyof typeof this.links].socket;
  }

  /**
   * Get the active link's destination address and port
   * @returns {Object} { address, port }
   */
  getActiveAddress(): { address: string; port: number } {
    const link = this.links[this.activeLink as keyof typeof this.links] as LinkState;
    return { address: link.address, port: link.port };
  }

  /**
   * Get the active link's socket and destination address atomically.
   * Prefer this over calling getActiveSocket() + getActiveAddress() separately,
   * because a failover between those two calls would produce a mismatched socket
   * and destination address.
   * @returns { socket, address, port } from the same active link snapshot
   */
  getActiveDestination(): { socket: dgram.Socket | null; address: string; port: number } {
    const link = this.links[this.activeLink as keyof typeof this.links] as LinkState;
    return { socket: link.socket, address: link.address, port: link.port };
  }

  /**
   * Get the name of the currently active link
   * @returns {string} 'primary' or 'backup'
   */
  getActiveLinkName(): string {
    return this.activeLink;
  }

  /**
   * Get health information for all links
   * @returns {Object} Link health data
   */
  getLinkHealth(): Record<string, LinkHealthSnapshot> {
    const result: Record<string, LinkHealthSnapshot> = {};
    for (const [name, link] of Object.entries(this.links)) {
      result[name] = linkHealthSnapshot(link);
    }
    return result;
  }

  /**
   * Get full bonding state for API/diagnostics
   * @returns {Object} Bonding state
   */
  getState(): BondingState {
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
  onControlPacket(handler: (linkName: string, msg: Buffer) => void): void {
    this._onControlPacket = handler;
  }

  /**
   * Set callback for failover events
   * @param {Function} handler - (fromLink, toLink) handler
   */
  onFailover(handler: (from: string, to: string) => void): void {
    this._onFailover = handler;
  }

  /**
   * Set callback for failback events
   * @param {Function} handler - (fromLink, toLink) handler
   */
  onFailback(handler: (from: string, to: string) => void): void {
    this._onFailback = handler;
  }

  /**
   * Set the metrics publisher for per-link metrics
   * @param {Object} publisher - MetricsPublisher instance
   */
  setMetricsPublisher(publisher: LinkMetricsPublisher | null): void {
    this.metricsPublisher = publisher;
  }

  /**
   * Manually force a failover (for testing/API)
   */
  forceFailover(): void {
    if (this.activeLink === "primary") {
      this.failover();
    } else {
      this.failback();
    }
  }

  /**
   * Stop bonding manager and clean up all resources
   */
  stop(): void {
    this._stopped = true;

    this.stopHealthMonitoring();

    for (const link of Object.values(this.links)) {
      if (link._recoveryTimer) {
        clearTimeout(link._recoveryTimer);
        link._recoveryTimer = null;
      }
      if (link.socket) {
        try {
          link.socket.close();
        } catch (err) {
          // Socket may already be closed
        }
        link.socket = null;
      }
      link.pendingHeartbeats.clear();
      link.lossSamples = new CircularBuffer(BONDING_HEALTH_WINDOW_SIZE);
      link.rttSamples = new CircularBuffer(BONDING_HEALTH_WINDOW_SIZE);
    }

    this._initialized = false;
  }
}

/** Create and return a `BondingManager` for the given bonding configuration. */
export function createBondingManager(config: BondingConfig, app: SignalKApp): BondingManager {
  return new BondingManager(config, app);
}

/** Frozen enum objects for link-status and bonding-mode string values. */
export { LinkStatus, BondingMode };
