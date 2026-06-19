"use strict";

/**
 * Signal K Edge Link v2.0 - Connection Bonding Types
 *
 * Shared type declarations for the bonding manager. Kept in a sibling module so
 * the manager implementation stays focused; these are types only and carry no
 * runtime behavior.
 *
 * @module transport/bonding-types
 */

import * as dgram from "dgram";
import CircularBuffer from "../foundation/circular-buffer";
import { BONDING_HEALTH_WINDOW_SIZE } from "../foundation/constants";

/**
 * Link status values
 * @enum {string}
 */
export const LinkStatus = Object.freeze({
  UNKNOWN: "unknown",
  ACTIVE: "active",
  STANDBY: "standby",
  DOWN: "down"
});

/**
 * Bonding mode values
 * @enum {string}
 */
export const BondingMode = Object.freeze({
  MAIN_BACKUP: "main-backup"
});

export interface LinkConfig {
  address: string;
  port: number;
  interface?: string;
}

export interface LinkHealth {
  rtt: number;
  loss: number;
  quality: number;
  status: string;
}

export interface LinkState {
  name: string;
  address: string;
  port: number;
  interface: string | null;
  socket: dgram.Socket | null;
  health: LinkHealth;
  heartbeatSeq: number;
  pendingHeartbeats: Map<number, number>;
  heartbeatResponses: number;
  heartbeatsSent: number;
  lossSamples: CircularBuffer;
  rttSamples: CircularBuffer;
  lastHeartbeatResponse: number;
  _recoveryTimer?: ReturnType<typeof setTimeout> | null;
}

export interface FailoverConfig {
  rttThreshold?: number;
  lossThreshold?: number;
  healthCheckInterval?: number;
  failbackDelay?: number;
  heartbeatTimeout?: number;
}

export interface BondingConfig {
  mode?: string;
  primary: LinkConfig;
  backup: LinkConfig;
  failover?: FailoverConfig;
  instanceId?: string;
  notificationsEnabled?: boolean;
  /** Shared secret used to authenticate heartbeat probes (HMAC-SHA256). */
  secretKey?: string;
  /** When true, 32-char ASCII keys are stretched via PBKDF2 before use.
   *  Both ends must agree. Defaults to false. */
  stretchAsciiKey?: boolean;
}

/** Per-link metrics payload accepted by a metrics publisher. */
export interface LinkMetrics {
  rtt?: number;
  jitter?: number;
  loss?: number;
  packetLoss?: number;
  retransmitRate?: number;
  status?: string;
}

/** Minimal metrics-publisher contract used by the bonding manager. */
export interface LinkMetricsPublisher {
  publishLinkMetrics(linkName: string, metrics: LinkMetrics): void;
}

export interface FailoverThresholds {
  rttThreshold: number;
  lossThreshold: number;
  healthCheckInterval: number;
  failbackDelay: number;
  heartbeatTimeout: number;
  [key: string]: number;
}

/** Snapshot of a single link's health for diagnostics/API. */
export interface LinkHealthSnapshot {
  address: string;
  port: number;
  status: string;
  rtt: number;
  loss: number;
  quality: number;
  heartbeatsSent: number;
  heartbeatResponses: number;
}

/** Full bonding state for API/diagnostics. */
export interface BondingState {
  enabled: boolean;
  mode: string;
  activeLink: string;
  lastFailoverTime: number;
  failoverThresholds: Record<string, number>;
  links: Record<string, unknown>;
}

/** Build a diagnostics snapshot of a single link's health. */
export function linkHealthSnapshot(link: LinkState): LinkHealthSnapshot {
  return {
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

/**
 * Create initial state for a single link.
 * @param name - Link name
 * @param linkConfig - Link configuration {address, port, interface}
 * @returns Link state object
 */
export function createLinkState(name: string, linkConfig: LinkConfig): LinkState {
  return {
    name,
    address: linkConfig.address,
    port: linkConfig.port,
    interface: linkConfig.interface || null,
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
    lossSamples: new CircularBuffer(BONDING_HEALTH_WINDOW_SIZE),
    rttSamples: new CircularBuffer(BONDING_HEALTH_WINDOW_SIZE),
    lastHeartbeatResponse: 0
  };
}
