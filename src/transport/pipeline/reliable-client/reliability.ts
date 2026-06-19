"use strict";

/**
 * Signal K Edge Link - reliable client ARQ reliability.
 *
 * Extracted from the v2 client factory: retransmit-queue pruning, recovery
 * burst draining, ACK/NAK handling, and packet-loss calculation.
 *
 * @module transport/pipeline/reliable-client/reliability
 */

import type { ParsedPacket } from "../../../codec/packet-codec";
import type * as dgram from "dgram";
import type { ClientContext } from "./context";
import { udpSendAsync } from "./lifecycle";

/** Returns true when seq is strictly ahead of reference in uint32 sequence space. */
export function isSeqAhead(seq: number, reference: number): boolean {
  const distance = (seq - reference) >>> 0;
  return distance !== 0 && distance < 0x80000000;
}

/** Calculate recent packet loss ratio using the sliding loss window. */
export function calculatePacketLoss(ctx: ClientContext): number {
  const { lossWindow } = ctx;
  if (lossWindow.length === 0) {
    return 0;
  }
  const samples = lossWindow.toArray();
  const losses = samples.filter(Boolean).length;
  return losses / samples.length;
}

function effectiveRetransmitAge(ctx: ClientContext): number {
  const { congestionControl, reliability, mut } = ctx;
  let maxAge = reliability.retransmitMaxAge;

  // Use the congestion controller's smoothed RTT (EMA) instead of the raw
  // latest sample to avoid volatile timeout swings from single RTT spikes.
  const smoothedRtt = congestionControl.getAvgRTT();
  if (smoothedRtt > 0) {
    const rttBasedAge = Math.round(smoothedRtt * reliability.retransmitRttMultiplier);
    maxAge = Math.min(maxAge, Math.max(reliability.retransmitMinAge, rttBasedAge));
  }

  const ackIdleMs = Date.now() - mut.lastAckAt;
  if (ackIdleMs >= reliability.ackIdleDrainAge) {
    maxAge = Math.min(maxAge, reliability.ackIdleDrainAge);
  }

  return Math.max(reliability.retransmitMinAge, maxAge);
}

export function pruneRetransmitQueue(ctx: ClientContext, reason: string): void {
  const { app, metricsApi, retransmitQueue, reliability, mut } = ctx;
  const { metrics } = metricsApi;
  const ackIdleMs = Date.now() - mut.lastAckAt;
  if (
    reliability.forceDrainAfterAckIdle &&
    ackIdleMs >= reliability.forceDrainAfterMs &&
    retransmitQueue.getSize() > 0
  ) {
    const dropped = retransmitQueue.getSize();
    retransmitQueue.clear();
    metrics.queueDepth = 0;
    app.debug(
      `Force-drained retransmit queue: dropped=${dropped} (${reason}, ackIdle=${ackIdleMs}ms)`
    );
    return;
  }

  const maxAge = effectiveRetransmitAge(ctx);
  const expired = retransmitQueue.expireOld(maxAge);
  if (expired > 0) {
    metrics.queueDepth = retransmitQueue.getSize();
    app.debug(
      `Pruned ${expired} retransmit entries (${reason}, maxAge=${maxAge}ms, queueDepth=${metrics.queueDepth})`
    );
  }
}

export function stopRecoveryBurst(ctx: ClientContext, reason?: string): void {
  const { app, mut } = ctx;
  if (mut.recoveryDrainTimer) {
    clearInterval(mut.recoveryDrainTimer);
    mut.recoveryDrainTimer = null;
    if (reason) {
      app.debug(`Recovery burst stopped: ${reason}`);
    }
  }
}

async function runRecoveryBurst(ctx: ClientContext): Promise<void> {
  const { app, state, metricsApi, retransmitQueue, reliability, mut } = ctx;
  const { metrics } = metricsApi;
  if (mut.recoveryDrainInFlight || !mut.lastAckRinfo) {
    return;
  }
  mut.recoveryDrainInFlight = true;
  try {
    // Pass recoveryBurstIntervalMs as minRetransmitAge so that sequences
    // already retransmitted by a concurrent NAK handler within the same burst
    // interval are skipped — avoids double-sending the same packet.
    const pendingSeqs = retransmitQueue.getOldestSequences(
      reliability.recoveryBurstSize,
      reliability.recoveryBurstIntervalMs
    );
    if (pendingSeqs.length === 0) {
      stopRecoveryBurst(ctx);
      return;
    }

    if (!state.socketUdp) {
      stopRecoveryBurst(ctx, "UDP socket unavailable");
      return;
    }

    const toRetransmit = retransmitQueue.retransmit(pendingSeqs);
    for (const { packet: retransmitPacket } of toRetransmit) {
      // Check socket liveness before each async send. The socket may have been
      // closed between the previous await and this iteration.
      if (!state.socketUdp) {
        stopRecoveryBurst(ctx, "UDP socket unavailable");
        break;
      }
      await udpSendAsync(ctx, retransmitPacket, mut.lastAckRinfo.address, mut.lastAckRinfo.port);
      metrics.retransmissions = (metrics.retransmissions ?? 0) + 1;
      if (mut.monitoringHooks && mut.monitoringHooks.packetLossTracker) {
        mut.monitoringHooks.packetLossTracker.record(true);
      }
      ctx.lossWindow.push(true);
    }
    metrics.queueDepth = retransmitQueue.getSize();
    app.debug(
      `Recovery burst: retransmitted ${toRetransmit.length}, queueDepth=${metrics.queueDepth}`
    );
  } catch (err: unknown) {
    app.debug(`Recovery burst error: ${err instanceof Error ? err.message : String(err)}`);
    // Stop the interval timer on error so it doesn't keep firing against a
    // broken socket. A fresh burst will be re-scheduled by the next ACK.
    stopRecoveryBurst(ctx);
  } finally {
    mut.recoveryDrainInFlight = false;
  }
}

export function startRecoveryBurstIfNeeded(
  ctx: ClientContext,
  ackGapMs: number,
  rinfo: { address: string; port: number } | null
): void {
  const { reliability, retransmitQueue, mut } = ctx;
  if (!reliability.recoveryBurstEnabled || !rinfo) {
    return;
  }
  if (ackGapMs < reliability.recoveryAckGapMs) {
    return;
  }
  if (retransmitQueue.getSize() === 0) {
    return;
  }

  mut.lastAckRinfo = { address: rinfo.address, port: rinfo.port };
  if (!mut.recoveryDrainTimer) {
    mut.recoveryDrainTimer = setInterval(() => {
      runRecoveryBurst(ctx);
    }, reliability.recoveryBurstIntervalMs);
  }
  runRecoveryBurst(ctx);
}

/** Update RTT + jitter metrics from a fresh (non-retransmitted) ACK sample. */
function recordRttSample(ctx: ClientContext, rttSample: number): void {
  const { metricsApi, rttSamples } = ctx;
  const { metrics } = metricsApi;
  metrics.rtt = rttSample;
  rttSamples.push(rttSample);

  if (rttSamples.length >= 2) {
    const samples = rttSamples.toArray();
    const avg = samples.reduce((a: number, b: number) => a + b, 0) / samples.length;
    const variance =
      samples.reduce((sum: number, s: number) => sum + Math.pow(s - avg, 2), 0) / samples.length;
    metrics.jitter = Math.round(Math.sqrt(variance));
  }
}

/**
 * Handle incoming ACK packet from server. Removes acknowledged packets from
 * the retransmit queue and updates RTT / congestion / recovery state.
 */
export function receiveACK(
  ctx: ClientContext,
  parsed: ParsedPacket,
  rinfo: dgram.RemoteInfo
): void {
  const { app, metricsApi, packetParser, retransmitQueue, congestionControl, mut } = ctx;
  const { metrics, recordError } = metricsApi;
  try {
    const ackedSeq = packetParser.parseACKPayload(parsed.payload);

    const now = Date.now();
    let rttSample: number | null = null;

    // Only sample RTT from packets that were NOT retransmitted (Karn's
    // algorithm). A retransmitted-packet ACK is ambiguous, so skip it.
    const entry = retransmitQueue.get(ackedSeq);
    if (entry && entry.attempts === 0) {
      rttSample = Math.max(0, now - entry.originalTimestamp);
    }

    if (rttSample !== null) {
      recordRttSample(ctx, rttSample);
    }

    const removed = retransmitQueue.acknowledgeRange(mut.lastAckedSeq, ackedSeq);
    if (mut.lastAckedSeq === null || isSeqAhead(ackedSeq, mut.lastAckedSeq)) {
      mut.lastAckedSeq = ackedSeq >>> 0;
    }
    const ackGapMs = now - mut.lastAckAt;
    mut.lastAckAt = now;
    mut.lastAckRinfo = rinfo ? { address: rinfo.address, port: rinfo.port } : mut.lastAckRinfo;

    // Update congestion control. Only feed RTT when we have a fresh sample;
    // passing -1 makes the controller's >= 0 guard skip the RTT EMA update.
    congestionControl.updateMetrics({
      rtt: rttSample ?? -1,
      packetLoss: Math.min(1, Math.max(0, calculatePacketLoss(ctx)))
    });

    app.debug(
      `ACK received: seq=${ackedSeq}, removed=${removed}, queueDepth=${retransmitQueue.getSize()}, rtt=${metrics.rtt}ms`
    );

    metrics.queueDepth = retransmitQueue.getSize();
    pruneRetransmitQueue(ctx, "ack");
    startRecoveryBurstIfNeeded(ctx, ackGapMs, rinfo);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    app.error(`Failed to process ACK: ${errMsg}`);
    recordError("general", `ACK processing error: ${errMsg}`);
  }
}

/**
 * Handle incoming NAK packet from server. Retransmits the requested missing
 * packets.
 */
export async function receiveNAK(
  ctx: ClientContext,
  parsed: ParsedPacket,
  udpAddress: string,
  udpPort: number
): Promise<void> {
  const { app, metricsApi, packetParser, retransmitQueue, mut } = ctx;
  const { metrics, recordError } = metricsApi;
  try {
    const missingSeqs = packetParser.parseNAKPayload(parsed.payload);

    app.debug(`NAK received: missing=${missingSeqs.join(", ")}`);

    const toRetransmit = retransmitQueue.retransmit(missingSeqs);

    for (const { sequence, packet: retransmitPacket, attempt } of toRetransmit) {
      app.debug(`Retransmitting seq=${sequence}, attempt=${attempt}`);
      await udpSendAsync(ctx, retransmitPacket, udpAddress, udpPort);
      metrics.retransmissions = (metrics.retransmissions ?? 0) + 1;
      if (mut.monitoringHooks && mut.monitoringHooks.packetLossTracker) {
        mut.monitoringHooks.packetLossTracker.record(true);
      }
      ctx.lossWindow.push(true);
    }

    app.debug(`Retransmitted ${toRetransmit.length} packets`);
    metrics.queueDepth = retransmitQueue.getSize();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    app.error(`Failed to process NAK: ${errMsg}`);
    recordError("general", `NAK processing error: ${errMsg}`);
  }
}
