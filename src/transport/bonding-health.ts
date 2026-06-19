"use strict";

/**
 * Signal K Edge Link v2.0 - Connection Bonding Health Helpers
 *
 * Standalone, side-effect-light helpers extracted from `BondingManager` for the
 * link-health math and heartbeat probe encoding/parsing. Keeping these here lets
 * the manager class stay small while preserving identical runtime semantics.
 *
 * @module transport/bonding-health
 */

import * as crypto from "crypto";
import * as dgram from "dgram";
import { normalizeKey } from "../codec/crypto";
import {
  BONDING_RTT_EMA_ALPHA,
  BONDING_HEALTH_WINDOW_SIZE,
  BONDING_FAILOVER_MIN_DWELL,
  BONDING_FAILBACK_RTT_HYSTERESIS,
  BONDING_FAILBACK_LOSS_HYSTERESIS
} from "../foundation/constants";
import type CircularBuffer from "../foundation/circular-buffer";
import type { LinkHealth, FailoverThresholds, LinkState } from "./bonding-types";

/** Link-status string values needed by socket-recovery bookkeeping. */
export interface RecoveryStatuses {
  standby: string;
  down: string;
}

/**
 * Recreate a link's UDP socket after an error: close the old socket, create a
 * fresh one, re-attach handlers via `attachHandlers`, and rebind to the
 * configured interface when one is set. Mirrors the original inline recovery
 * logic exactly, including debug output and link-status transitions.
 */
export function recreateLinkSocket(
  link: LinkState,
  name: string,
  debug: (msg: string) => void,
  attachHandlers: (link: LinkState) => void,
  statuses: RecoveryStatuses
): void {
  debug(`[Bonding] Attempting socket recovery for ${name}`);
  try {
    if (link.socket) {
      try {
        link.socket.close();
      } catch (_e) {
        /* already closed */
      }
    }
    link.socket = dgram.createSocket("udp4");
    attachHandlers(link);

    if (link.interface) {
      // bind() failures arrive on the 'error' listener attached above
      // (which marks the link DOWN and reschedules recovery), so the
      // callback only needs to handle the success path.
      link.socket.bind({ address: link.interface, port: 0 }, () => {
        link.health.status = statuses.standby;
        debug(`[Bonding] ${name} socket recovered`);
      });
    } else {
      link.health.status = statuses.standby;
      debug(`[Bonding] ${name} socket recovered`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`[Bonding] ${name} socket recovery failed: ${msg}`);
    link.health.status = statuses.down;
  }
}

/**
 * Bind a link's socket to its configured interface (ephemeral port 0).
 *
 * dgram bind() reports failures via the 'error' event, not the callback (which
 * only fires on success). A one-time error listener is attached so a bind
 * failure rejects (and closes/clears the socket) instead of surfacing as an
 * unhandled 'error' that crashes the process; it is removed once bound.
 */
export function bindLinkInterface(link: LinkState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onBindError = (err: Error) => {
      try {
        link.socket!.close();
      } catch (_e) {
        /* already closed */
      }
      link.socket = null;
      reject(err);
    };
    link.socket!.once("error", onBindError);
    link.socket!.bind({ address: link.interface!, port: 0 }, () => {
      link.socket!.removeListener("error", onBindError);
      resolve();
    });
  });
}

// Length in bytes of the truncated HMAC appended to authenticated heartbeat probes.
export const BONDING_HMAC_TAG_LENGTH = 8;

/** Subset of LinkHealth needed by the quality calculation. */
export interface HealthLike {
  rtt: number;
  loss: number;
}

/**
 * Compute a truncated HMAC-SHA256 tag over the 12-byte heartbeat header.
 * Used to authenticate probe sends and verify probe responses.
 */
export function computeHbHmac(header: Buffer, secretKey: string, stretchAsciiKey: boolean): Buffer {
  const keyBuffer = normalizeKey(secretKey, { stretchAsciiKey });
  return crypto
    .createHmac("sha256", keyBuffer)
    .update(header)
    .digest()
    .subarray(0, BONDING_HMAC_TAG_LENGTH);
}

/**
 * Build a heartbeat probe buffer for the given sequence number. When a secretKey
 * is supplied a truncated HMAC-SHA256 tag is appended after the 12-byte header.
 */
export function buildHeartbeatProbe(
  seq: number,
  secretKey: string | null,
  stretchAsciiKey: boolean
): Buffer {
  const header = Buffer.alloc(12);
  header.write("HBPROBE", 0, 7, "ascii");
  header.writeUInt32BE(seq, 7);
  header.writeUInt8(0, 11); // padding

  if (secretKey) {
    const tag = computeHbHmac(header, secretKey, stretchAsciiKey);
    return Buffer.concat([header, tag]);
  }
  return header;
}

/**
 * Remove pending heartbeats older than `timeout` relative to `now`, recording a
 * loss sample for each expired entry. Mutates `pending` and `lossSamples`.
 */
export function expirePendingHeartbeats(
  pending: Map<number, number>,
  lossSamples: CircularBuffer,
  now: number,
  timeout: number
): void {
  for (const [pendingSeq, pendingTs] of pending) {
    if (now - pendingTs > timeout) {
      pending.delete(pendingSeq);
      lossSamples.push(false);
    }
  }
}

/**
 * Compute the loss ratio (0..1) for a link from recent heartbeat outcomes when
 * available, falling back to aggregate sent/received counters otherwise.
 * Returns null when there is no data to update from.
 */
export function computeLossRatio(
  lossSamples: CircularBuffer | undefined,
  heartbeatsSent: number,
  heartbeatResponses: number
): number | null {
  if (lossSamples && lossSamples.length > 0) {
    const samples = lossSamples.toArray();
    const received = samples.filter(Boolean).length;
    return Math.max(0, Math.min(1, 1 - received / samples.length));
  }
  if (heartbeatsSent > 0) {
    return Math.max(0, Math.min(1, 1 - heartbeatResponses / heartbeatsSent));
  }
  return null;
}

/**
 * Calculate link quality score (0-100) from RTT and loss. Loss is weighted more
 * heavily (60%) than RTT (40%).
 */
export function calculateQuality(health: HealthLike): number {
  // RTT component: 0-1 (1 = perfect, 0 = worst)
  const rttScore = Math.max(0, Math.min(1, 1 - health.rtt / 1000));
  // Loss component: 0-1 (1 = no loss, 0 = total loss)
  const lossScore = Math.max(0, 1 - health.loss);
  // Weighted: loss matters more (60%) than RTT (40%)
  const quality = lossScore * 60 + rttScore * 40;
  return Math.round(quality);
}

/**
 * Apply an exponential moving average update to a link's RTT, seeding directly
 * from the first sample when the current value is 0.
 */
export function updateRttEma(currentRtt: number, sampleRtt: number): number {
  if (currentRtt === 0) {
    return sampleRtt;
  }
  return BONDING_RTT_EMA_ALPHA * sampleRtt + (1 - BONDING_RTT_EMA_ALPHA) * currentRtt;
}

/**
 * Verify that `msg` is a well-formed, authentic heartbeat response.
 *
 * Returns:
 *  - "valid"        : recognised heartbeat, HMAC ok (or not required)
 *  - "not-heartbeat": does not look like a heartbeat probe at all
 *  - "drop"         : looks like a heartbeat but failed length/HMAC checks
 */
export function classifyHeartbeatResponse(
  msg: Buffer,
  secretKey: string | null,
  stretchAsciiKey: boolean
): "valid" | "not-heartbeat" | "drop" {
  // Must start with "HBPROBE" and be at least 12 bytes.
  if (msg.length < 12 || msg.toString("ascii", 0, 7) !== "HBPROBE") {
    return "not-heartbeat";
  }

  // When a secretKey is configured, verify the HMAC tag that follows the
  // fixed 12-byte header. Drop unauthenticated (or forged) responses to
  // prevent an on-path attacker from triggering false-positive link recovery.
  if (secretKey) {
    const minLen = 12 + BONDING_HMAC_TAG_LENGTH;
    if (msg.length < minLen) {
      return "drop";
    }
    const expectedTag = computeHbHmac(msg.subarray(0, 12), secretKey, stretchAsciiKey);
    const receivedTag = msg.subarray(msg.length - BONDING_HMAC_TAG_LENGTH);
    if (!crypto.timingSafeEqual(expectedTag, receivedTag)) {
      return "drop";
    }
  }

  return "valid";
}

/** Signal K delta message describing a link-failover notification. */
export interface FailoverNotification {
  context: string;
  updates: Array<{
    $source: string;
    timestamp: string;
    values: Array<{ path: string; value: unknown }>;
  }>;
}

/**
 * Build the Signal K delta for a link-failover notification.
 *
 * Emits a `$source` string rather than a structured `source` object:
 * signalk-server derives `${label}.XX` from a label-only source object, which
 * would split this notification across a spurious `signalk-edge-link.XX`
 * bucket. See src/source-dispatch.ts.
 */
export function buildFailoverNotification(
  instanceId: string,
  from: string,
  to: string
): FailoverNotification {
  const prefix = instanceId ? instanceId + "." : "";
  return {
    context: "vessels.self",
    updates: [
      {
        $source: "signalk-edge-link",
        timestamp: new Date().toISOString(),
        values: [
          {
            path: `notifications.signalk-edge-link.${prefix}linkFailover`,
            value: {
              state: "alert",
              message: `Link switched: ${from} to ${to}`,
              method: ["visual", "sound"]
            }
          }
        ]
      }
    ]
  };
}

/** Inputs to the failover/failback decision evaluated on each health tick. */
export interface FailoverDecisionInput {
  activeLink: string;
  primary: LinkHealth;
  backup: LinkHealth;
  thresholds: FailoverThresholds;
  lastFailbackTime: number;
  lastFailoverTime: number;
  now: number;
  downStatus: string;
}

/**
 * Determine whether failover from primary to backup is needed. Hard primary
 * failure switches immediately; soft RTT/loss degradation only after the
 * minimum dwell since the primary last became active.
 */
export function shouldFailover(input: FailoverDecisionInput): boolean {
  if (input.activeLink !== "primary") {
    return false;
  }
  const { primary, backup, thresholds, downStatus } = input;

  // Don't failover if backup is also down
  if (backup.status === downStatus) {
    return false;
  }

  // Hard failure: failover immediately (availability over stability).
  if (primary.status === downStatus) {
    return true;
  }

  // Soft degradation (RTT/loss over threshold): only failover after the
  // primary has been active for the minimum dwell, mirroring failbackDelay so
  // a primary oscillating around the threshold cannot flap on every tick.
  const timeSincePrimaryActive = input.now - input.lastFailbackTime;
  if (timeSincePrimaryActive < BONDING_FAILOVER_MIN_DWELL) {
    return false;
  }

  return primary.rtt > thresholds.rttThreshold || primary.loss > thresholds.lossThreshold;
}

/**
 * Determine whether failback from backup to primary is appropriate, applying
 * the failback delay and hysteresis on RTT/loss to avoid oscillation.
 */
export function shouldFailback(input: FailoverDecisionInput): boolean {
  if (input.activeLink !== "backup") {
    return false;
  }
  const { primary, thresholds, downStatus } = input;
  const timeSinceFailover = input.now - input.lastFailoverTime;

  // Wait for failback delay
  if (timeSinceFailover < thresholds.failbackDelay) {
    return false;
  }

  // Don't failback if primary is down
  if (primary.status === downStatus) {
    return false;
  }

  // Hysteresis: require significantly better metrics before failback
  const rttOk = primary.rtt < thresholds.rttThreshold * BONDING_FAILBACK_RTT_HYSTERESIS;
  const lossOk = primary.loss < thresholds.lossThreshold * BONDING_FAILBACK_LOSS_HYSTERESIS;

  return rttOk && lossOk;
}

export { BONDING_HEALTH_WINDOW_SIZE };
