"use strict";

/**
 * Alert manager.
 *
 * Manages alert thresholds and emits Signal K notifications when network
 * metrics exceed configured limits.
 *
 * @module domain/monitoring/alert-manager
 */

import { MONITORING_ALERT_COOLDOWN } from "../../foundation/constants";

interface AlertApp {
  handleMessage(source: string, delta: unknown): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

interface Threshold {
  warning?: number;
  critical?: number;
}

interface Alert {
  metric: string;
  level: string;
  value: number;
  threshold: number;
  timestamp: number;
}

/** Resolve the per-metric thresholds from a (possibly nested) config object. */
function resolveThresholds(config: Record<string, unknown>): Record<string, Threshold> {
  const thresholdsConfig =
    config &&
    typeof config === "object" &&
    config.thresholds &&
    typeof config.thresholds === "object"
      ? config.thresholds
      : config;
  const tc = thresholdsConfig as Record<string, Threshold | undefined>;
  return {
    rtt: tc?.rtt || { warning: 300, critical: 800 },
    packetLoss: tc?.packetLoss || { warning: 0.03, critical: 0.1 },
    retransmitRate: tc?.retransmitRate || { warning: 0.05, critical: 0.15 },
    jitter: tc?.jitter || { warning: 100, critical: 300 },
    queueDepth: tc?.queueDepth || { warning: 100, critical: 500 }
  };
}

/** Build the per-metric cooldown overrides map, e.g. { rtt: 30000, packetLoss: 120000 }. */
function resolvePerMetricCooldown(config: Record<string, unknown>): Map<string, number> {
  const perMetricCooldown = new Map<string, number>();
  if (config.cooldowns && typeof config.cooldowns === "object") {
    for (const [metric, cd] of Object.entries(config.cooldowns)) {
      if (typeof cd === "number" && cd > 0) {
        perMetricCooldown.set(metric, cd);
      }
    }
  }
  return perMetricCooldown;
}

export class AlertManager {
  app: AlertApp;
  instanceId: string;
  sourceLabel: string;
  thresholds: Record<string, Threshold>;
  cooldown: number;
  _perMetricCooldown: Map<string, number>;
  notificationsEnabled: boolean;
  activeAlerts: Map<string, Alert>;
  _lastAlertTime: Map<string, number>;

  /**
   * @param {Object} app - Signal K app instance
   * @param {Object} [config]
   * @param {Object} [config.thresholds] - Alert thresholds
   */
  constructor(app: AlertApp, config: Record<string, unknown> = {}) {
    this.app = app;
    // instanceId is used to namespace notification paths so multiple instances
    // don't overwrite each other's alerts in Signal K.
    this.instanceId = String((config && config.instanceId) || "");
    this.sourceLabel = this.instanceId
      ? `signalk-edge-link:${this.instanceId}`
      : "signalk-edge-link";
    this.thresholds = resolveThresholds(config);
    this.cooldown =
      typeof config.cooldown === "number" ? config.cooldown : MONITORING_ALERT_COOLDOWN;
    this._perMetricCooldown = resolvePerMetricCooldown(config);
    this.notificationsEnabled = config.enabled === true;

    // Track active alerts and last alert time for cooldown
    this.activeAlerts = new Map(); // metricName -> { level, timestamp, value }
    this._lastAlertTime = new Map(); // metricName -> timestamp
  }

  /**
   * Check a metric value against thresholds and emit alerts
   * @param {string} metricName - Name of the metric (e.g., 'rtt', 'packetLoss')
   * @param {number} value - Current metric value
   * @returns {Object|null} Alert object if threshold exceeded, null otherwise
   */
  check(metricName: string, value: number): Alert | null {
    const threshold = this.thresholds[metricName];
    if (!threshold) {
      return null;
    }

    let level: string | null = null;
    if (threshold.critical !== undefined && value >= threshold.critical) {
      level = "critical";
    } else if (threshold.warning !== undefined && value >= threshold.warning) {
      level = "warning";
    }

    const currentAlert = this.activeAlerts.get(metricName);

    if (level) {
      // Check cooldown (per-metric override or global default)
      const lastTime = this._lastAlertTime.get(metricName) || 0;
      const effectiveCooldown = this._perMetricCooldown.get(metricName) ?? this.cooldown;
      const cooldownExpired = Date.now() - lastTime >= effectiveCooldown;

      // Only alert if level changed or cooldown expired
      if (!currentAlert || currentAlert.level !== level || cooldownExpired) {
        const alert = {
          metric: metricName,
          level,
          value,
          threshold: threshold[level as "warning" | "critical"] ?? 0,
          timestamp: Date.now()
        };

        this.activeAlerts.set(metricName, alert);
        this._lastAlertTime.set(metricName, Date.now());
        this._emitAlert(alert);
        return alert;
      }
    } else if (currentAlert) {
      // Clear alert
      this.activeAlerts.delete(metricName);
      this._emitClear(metricName);
    }

    return null;
  }

  /**
   * Check all metrics at once
   * @param {Object} metrics - { rtt, packetLoss, retransmitRate, jitter, queueDepth }
   * @returns {Array<Object>} Array of triggered alerts
   */
  checkAll(metrics: Record<string, number | undefined>): Alert[] {
    const alerts: Alert[] = [];
    for (const [name, value] of Object.entries(metrics)) {
      if (value !== undefined && this.thresholds[name]) {
        const alert = this.check(name, value);
        if (alert) {
          alerts.push(alert);
        }
      }
    }
    return alerts;
  }

  /**
   * Update threshold configuration
   * @param {string} metricName - Metric name
   * @param {Object} thresholds - { warning, critical }
   */
  setThreshold(metricName: string, thresholds: Threshold): void {
    if (!this.thresholds[metricName]) {
      this.thresholds[metricName] = {};
    }
    if (thresholds.warning !== undefined) {
      this.thresholds[metricName].warning = thresholds.warning;
    }
    if (thresholds.critical !== undefined) {
      this.thresholds[metricName].critical = thresholds.critical;
    }
  }

  /**
   * Get current alert state
   * @returns {Object} Active alerts and thresholds
   */
  getState(): {
    thresholds: Record<string, Threshold>;
    activeAlerts: Record<string, Alert>;
  } {
    const alerts: Record<string, Alert> = {};
    for (const [name, alert] of this.activeAlerts) {
      alerts[name] = { ...alert };
    }
    return {
      thresholds: { ...this.thresholds },
      activeAlerts: alerts
    };
  }

  /**
   * Send a Signal K notification for a given path and state
   * @private
   */
  _emitNotification(path: string, state: string, message: string, method: string[]): void {
    if (!this.notificationsEnabled) {
      return;
    }
    try {
      // Emit a `$source` string rather than a structured `source` object:
      // signalk-server derives `${label}.XX` from a label-only source object,
      // which would split this notification across a spurious
      // `signalk-edge-link.XX` bucket. See src/source-dispatch.ts.
      this.app.handleMessage(this.sourceLabel, {
        context: "vessels.self",
        updates: [
          {
            $source: "signalk-edge-link",
            timestamp: new Date().toISOString(),
            values: [{ path, value: { state, message, method } }]
          }
        ]
      });
    } catch (err: unknown) {
      this.app.debug?.(
        `[Alert] Failed to emit notification: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Emit an alert notification via Signal K
   * @private
   */
  _emitAlert(alert: Alert): void {
    const stateMap: Record<string, string> = { warning: "warn", critical: "alert" };
    const ns = this.instanceId ? `${this.instanceId}.` : "";
    this._emitNotification(
      `notifications.signalk-edge-link.${ns}${alert.metric}`,
      stateMap[alert.level] || "alert",
      `${alert.metric}: ${alert.value} exceeds ${alert.level} threshold (${alert.threshold})`,
      ["visual"]
    );
  }

  /**
   * Emit a clear notification when alert condition resolves
   * @private
   */
  _emitClear(metricName: string): void {
    const ns = this.instanceId ? `${this.instanceId}.` : "";
    this._emitNotification(
      `notifications.signalk-edge-link.${ns}${metricName}`,
      "normal",
      `${metricName}: returned to normal`,
      []
    );
  }

  /**
   * Reset all active alerts
   */
  reset(): void {
    this.activeAlerts.clear();
    this._lastAlertTime.clear();
  }
}
