"use strict";

/**
 * Signal K Edge Link v2.0 - Sequence Tracker
 *
 * Tracks received sequence numbers to detect packet loss
 * and handle out-of-order delivery.
 *
 * @module transport/reliability/sequence
 */

interface SequenceTrackerConfig {
  maxOutOfOrder?: number;
  nakTimeout?: number;
  maxGapTracking?: number;
  behindResyncThreshold?: number;
  onLossDetected?: (sequences: number[]) => void;
  /** NAK rounds per missing sequence before it is declared permanently lost. */
  maxNakRounds?: number;
  /** Called when a sequence is given up on and the window advances past it. */
  onGapAbandoned?: (sequence: number) => void;
}

interface ProcessSequenceResult {
  inOrder: boolean;
  missing: number[];
  duplicate: boolean;
  resynced: boolean;
  /**
   * True when the sequence arrived behind the window after aging out of
   * `receivedSeqs`. Not a duplicate as far as the tracker knows, but its
   * payload must not be dispatched again.
   */
  lateArrival: boolean;
}

export class SequenceTracker {
  expectedSeq: number | null;
  private _firstSeq: number | null;
  receivedSeqs: Set<number>;
  maxOutOfOrder: number;
  nakTimeout: number;
  maxGapTracking: number;
  behindResyncThreshold: number;
  nakTimers: Map<number, ReturnType<typeof setTimeout>>;
  onLossDetected: (sequences: number[]) => void;
  /**
   * Maximum NAK rounds per missing sequence before it is declared permanently
   * lost and the window advances past it. Without this bound, a sequence the
   * sender can no longer produce (its retransmit budget is spent) pins
   * `expectedSeq` for up to `maxGapTracking` packets: the cumulative ACK
   * freezes, the peer re-NAKs it every `nakTimeout` forever, and no RTT sample
   * can ever be taken again because the acked sequence has left the queue.
   */
  maxNakRounds: number;
  /** Sequences permanently given up on, for operator diagnostics. */
  abandonedCount: number;
  onGapAbandoned: (sequence: number) => void;
  private _nakAttempts: Map<number, number>;
  // Sequences whose NAK timer has fired and are still missing, awaiting the
  // next coalesced flush. Insertion order is ascending (timers are scheduled
  // in gap order), so the emitted batch stays ordered.
  private _pendingNAKs: Set<number>;
  private _nakFlushTimer: ReturnType<typeof setTimeout> | null;

  constructor(config: SequenceTrackerConfig = {}) {
    this.expectedSeq = null;
    this._firstSeq = null;
    this.receivedSeqs = new Set();
    this.maxOutOfOrder = config.maxOutOfOrder ?? 100;
    this.nakTimeout = config.nakTimeout ?? 100;
    this.maxGapTracking = config.maxGapTracking ?? Math.max(this.maxOutOfOrder * 4, 1024);
    this.behindResyncThreshold = config.behindResyncThreshold ?? this.maxGapTracking * 2;
    this.nakTimers = new Map();
    this.onLossDetected = config.onLossDetected || (() => {});
    this.maxNakRounds = config.maxNakRounds ?? 5;
    this.abandonedCount = 0;
    this.onGapAbandoned = config.onGapAbandoned || (() => {});
    this._nakAttempts = new Map();
    this._pendingNAKs = new Set();
    this._nakFlushTimer = null;
  }

  /**
   * Drop every piece of per-sequence NAK state: the pending timer, the retry
   * counter, and any queued flush entry.
   *
   * Retry counters MUST be dropped here and not only on abandonment. A sequence
   * that is successfully retransmitted cancels its timer and leaves the window,
   * but its `_nakAttempts` entry has no other reader — on a lossy link that is
   * one permanently retained Map entry per recovered packet, unbounded for the
   * lifetime of the session.
   * @private
   */
  private _cancelNAK(sequence: number): void {
    const timer = this.nakTimers.get(sequence);
    if (timer) {
      clearTimeout(timer);
      this.nakTimers.delete(sequence);
    }
    this._nakAttempts.delete(sequence);
    this._pendingNAKs.delete(sequence);
  }

  /**
   * Give up on a sequence that has exhausted its NAK rounds: record it as
   * "seen" so the contiguous-advance walk can move past it, drop its timer
   * state, and advance `expectedSeq` when it sits at the head of the window.
   * @private
   */
  private _abandonSequence(sequence: number): void {
    this._cancelNAK(sequence);
    this.receivedSeqs.add(sequence);
    this.abandonedCount++;

    if (this.expectedSeq !== null && sequence === this.expectedSeq) {
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;
      while (this.receivedSeqs.has(this.expectedSeq)) {
        this._cancelNAK(this.expectedSeq);
        this.expectedSeq = (this.expectedSeq + 1) >>> 0;
      }
      this._cleanupOldSequences();
    }

    this.onGapAbandoned(sequence);
  }

  /**
   * Returns true if seq is ahead of reference in uint32 serial number space.
   * Uses half-range comparison (RFC-style serial arithmetic).
   * @private
   */
  private _isAhead(seq: number, reference: number): boolean {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  /**
   * Returns true if seq is behind reference in uint32 serial number space.
   * @private
   */
  private _isBehind(seq: number, reference: number): boolean {
    const distance = (reference - seq) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  /**
   * Forward uint32 distance from `from` to `to` (modulo 2^32).
   * @private
   */
  private _distanceForward(from: number, to: number): number {
    return (to - from) >>> 0;
  }

  /**
   * Process a received sequence number
   * @param sequence - The received sequence number
   * @returns Result with inOrder, missing, and duplicate flags
   */
  processSequence(sequence: number): ProcessSequenceResult {
    sequence = sequence >>> 0;

    const result: ProcessSequenceResult = {
      inOrder: false,
      missing: [],
      duplicate: false,
      resynced: false,
      lateArrival: false
    };

    // Initialize baseline from the first packet we actually receive.
    if (this.expectedSeq === null) {
      this.receivedSeqs.add(sequence);
      this.expectedSeq = (sequence + 1) >>> 0;
      this._firstSeq = sequence;
      result.inOrder = true;
      return result;
    }

    // Check for duplicate
    if (this.receivedSeqs.has(sequence)) {
      result.duplicate = true;
      return result;
    }

    // Packet is behind the expected window — treat as late arrival or resync trigger
    if (this._isBehind(sequence, this.expectedSeq)) {
      this._processBehind(sequence, result);
      return result;
    }

    this.receivedSeqs.add(sequence);
    // The arrival satisfies any NAK outstanding for this very sequence — the
    // common case for a successful retransmit. Its timer would otherwise stay
    // armed until it fired and found the sequence already received, leaving the
    // retry counter behind for good.
    this._cancelNAK(sequence);

    // Proactively clean up if the set grows too large
    if (this.receivedSeqs.size > this.maxGapTracking * 2) {
      this._cleanupOldSequences();
    }

    if (sequence === this.expectedSeq) {
      this._processInOrder(result);
    } else if (this._isAhead(sequence, this.expectedSeq)) {
      this._processAhead(sequence, result);
    }

    return result;
  }

  /**
   * Handle a packet whose sequence is behind the expected window: either trigger
   * a resync (very old) or accept it as a late arrival and cancel any NAK timer.
   * @private
   */
  private _processBehind(sequence: number, result: ProcessSequenceResult): void {
    const behindDistance = this._distanceForward(sequence, this.expectedSeq!);
    if (behindDistance > this.behindResyncThreshold) {
      this._resync(sequence);
      result.inOrder = true;
      result.resynced = true;
      return;
    }

    // Late arrival that was already passed over — accept it for bookkeeping.
    //
    // `duplicate` stays false (the tracker genuinely has no record of it: the
    // sequence aged out of `receivedSeqs`), but callers must NOT treat this as
    // new data. The window already advanced past this sequence, so its payload
    // was either delivered earlier or declared lost; dispatching it again would
    // re-inject a stale delta into Signal K. `lateArrival` makes that
    // distinction explicit rather than leaving it to the caller to infer.
    result.lateArrival = true;
    this.receivedSeqs.add(sequence);

    // Cancel NAK timer if one was scheduled
    this._cancelNAK(sequence);
  }

  /**
   * Handle a packet that matches the expected sequence: advance past it and any
   * contiguous buffered sequences, cancelling their NAK timers.
   * @private
   */
  private _processInOrder(result: ProcessSequenceResult): void {
    result.inOrder = true;
    this.expectedSeq = (this.expectedSeq! + 1) >>> 0;

    // Advance past contiguous buffered sequences
    while (this.receivedSeqs.has(this.expectedSeq)) {
      // Cancel NAK timer for this sequence since it arrived
      this._cancelNAK(this.expectedSeq);
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;
    }

    this._cleanupOldSequences();
  }

  /**
   * Handle a packet ahead of the expected sequence: resync on a huge gap, or
   * record the missing sequences in the gap and schedule NAKs for them.
   * @private
   */
  private _processAhead(sequence: number, result: ProcessSequenceResult): void {
    // Gap detected - record missing sequences
    const gapSize = this._distanceForward(this.expectedSeq!, sequence);
    if (gapSize > this.maxGapTracking) {
      this._resync(sequence);
      result.inOrder = true;
      result.resynced = true;
      return;
    }

    let candidate = this.expectedSeq!;
    for (let i = 0; i < gapSize; i++) {
      if (!this.receivedSeqs.has(candidate)) {
        result.missing.push(candidate);
        this._scheduleNAK(candidate);
      }
      candidate = (candidate + 1) >>> 0;
    }

    this._cleanupOldSequences();
  }

  /**
   * Get list of sequences that are missing in the forward tracking window:
   * sequences between `expectedSeq` and the furthest buffered-ahead sequence
   * that have not yet been received.
   *
   * @returns Array of missing sequence numbers
   */
  getMissingSequences(): number[] {
    if (this.expectedSeq === null) {
      return [];
    }
    // Find how far ahead the furthest buffered sequence is.
    let furthestAhead = 0;
    for (const seq of this.receivedSeqs) {
      const distance = this._distanceForward(this.expectedSeq, seq);
      if (distance > 0 && distance < 0x80000000) {
        furthestAhead = Math.max(furthestAhead, distance);
      }
    }
    if (furthestAhead === 0) {
      return [];
    }
    const missing: number[] = [];
    const windowSize = Math.min(this.maxOutOfOrder, furthestAhead);
    for (let i = 0; i < windowSize; i++) {
      const seq = (this.expectedSeq + i) >>> 0;
      if (!this.receivedSeqs.has(seq)) {
        missing.push(seq);
      }
    }
    return missing;
  }

  /**
   * Reset all state and cancel pending timers
   */
  reset(): void {
    this.expectedSeq = null;
    this._firstSeq = null;
    this.receivedSeqs.clear();
    this._clearNAKTimers();
  }

  /**
   * Re-baseline tracking to a newly observed sequence after major discontinuity.
   * @private
   */
  private _resync(sequence: number): void {
    this._clearNAKTimers();
    this.receivedSeqs.clear();
    this.receivedSeqs.add(sequence);
    this.expectedSeq = (sequence + 1) >>> 0;
    this._firstSeq = sequence;
  }

  /**
   * Cancel and clear all outstanding NAK timers.
   * @private
   */
  private _clearNAKTimers(): void {
    for (const timer of this.nakTimers.values()) {
      clearTimeout(timer);
    }
    this.nakTimers.clear();
    if (this._nakFlushTimer !== null) {
      clearTimeout(this._nakFlushTimer);
      this._nakFlushTimer = null;
    }
    this._pendingNAKs.clear();
    this._nakAttempts.clear();
  }

  /**
   * Schedule a NAK callback for a missing sequence
   * @private
   */
  private _scheduleNAK(sequence: number): void {
    if (this.nakTimers.has(sequence)) {
      return;
    }

    // If the tracker is full, evict the numerically-lowest tracked sequence
    // (i.e. the oldest gap relative to the current window) rather than silently
    // dropping the new NAK request.  Silently dropping would cause unbounded
    // growth of un-tracked gaps on a persistently lossy link.
    if (this.nakTimers.size >= this.maxGapTracking) {
      let oldestSeq: number | null = null;
      for (const s of this.nakTimers.keys()) {
        if (oldestSeq === null || this._isBehind(s, oldestSeq)) {
          oldestSeq = s;
        }
      }
      if (oldestSeq !== null) {
        this._cancelNAK(oldestSeq);
      }
    }

    const timer = setTimeout(() => {
      this.nakTimers.delete(sequence);
      // Coalesce: instead of emitting one NAK datagram per missing sequence
      // (a NAK storm on a lossy link — a single burst loss could otherwise
      // produce hundreds of datagrams), queue the sequence and flush all
      // sequences whose timers expired in the same tick as one batched NAK.
      if (!this.receivedSeqs.has(sequence)) {
        // `attempts` counts the round this firing is about to emit, so the
        // bound is `>` and not `>=`: at `>=` the maxNakRounds'th NAK was
        // abandoned instead of sent, giving the sender only maxNakRounds - 1
        // chances.
        const attempts = (this._nakAttempts.get(sequence) ?? 0) + 1;
        if (attempts > this.maxNakRounds) {
          // The sender has had maxNakRounds chances; assume the packet is gone
          // for good rather than pinning the window on it indefinitely.
          this._abandonSequence(sequence);
          return;
        }
        this._nakAttempts.set(sequence, attempts);
        this._pendingNAKs.add(sequence);
        this._scheduleNAKFlush();
        // Re-arm so the retry cadence does not depend on another ahead-packet
        // arriving to reschedule it.
        this._scheduleNAK(sequence);
      }
    }, this.nakTimeout);

    this.nakTimers.set(sequence, timer);
  }

  /**
   * Schedule a single coalescing flush of all pending NAK sequences. The flush
   * runs on the next tick so all per-sequence timers that fire together (they
   * share the same nakTimeout and are scheduled in one gap-walk) are emitted as
   * one NAK list rather than one datagram each.
   * @private
   */
  private _scheduleNAKFlush(): void {
    if (this._nakFlushTimer !== null) {
      return;
    }
    this._nakFlushTimer = setTimeout(() => {
      this._nakFlushTimer = null;
      this._flushNAKs();
    }, 0);
  }

  /**
   * Emit all still-missing pending NAK sequences as a single batched callback.
   * @private
   */
  private _flushNAKs(): void {
    if (this._pendingNAKs.size === 0) {
      return;
    }
    const batch: number[] = [];
    for (const seq of this._pendingNAKs) {
      // A sequence may have arrived between its timer firing and this flush.
      if (!this.receivedSeqs.has(seq)) {
        batch.push(seq);
      }
    }
    this._pendingNAKs.clear();
    if (batch.length > 0) {
      this.onLossDetected(batch);
    }
  }

  /**
   * Remove old sequences from the tracking set to prevent memory growth.
   * @private
   */
  private _cleanupOldSequences(): void {
    const cutoff = (this.expectedSeq! - this.maxOutOfOrder) >>> 0;
    // Collect sequences to delete first, then delete — avoids modifying the Set
    // during iteration, which can cause entries to be silently skipped in V8.
    const toDelete: number[] = [];
    for (const seq of this.receivedSeqs) {
      if (this._isBehind(seq, cutoff)) {
        toDelete.push(seq);
      }
    }
    for (const seq of toDelete) {
      this.receivedSeqs.delete(seq);
    }
  }
}
