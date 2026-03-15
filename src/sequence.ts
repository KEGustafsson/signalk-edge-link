"use strict";

/**
 * Signal K Edge Link v2.0 - Sequence Tracker
 *
 * Tracks received sequence numbers to detect packet loss
 * and handle out-of-order delivery.
 *
 * @module lib/sequence
 */

interface SequenceTrackerConfig {
  maxOutOfOrder?: number;
  nakTimeout?: number;
  maxGapTracking?: number;
  behindResyncThreshold?: number;
  onLossDetected?: (sequences: number[]) => void;
}

interface ProcessSequenceResult {
  inOrder: boolean;
  missing: number[];
  duplicate: boolean;
  resynced: boolean;
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
      resynced: false
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

    // Also duplicate if below expected and already processed
    if (this._isBehind(sequence, this.expectedSeq) && !this.receivedSeqs.has(sequence)) {
      const behindDistance = this._distanceForward(sequence, this.expectedSeq);
      if (behindDistance > this.behindResyncThreshold) {
        this._resync(sequence);
        result.inOrder = true;
        result.resynced = true;
        return result;
      }

      // Late arrival that was already passed over - accept it
      this.receivedSeqs.add(sequence);

      // Cancel NAK timer if one was scheduled
      if (this.nakTimers.has(sequence)) {
        clearTimeout(this.nakTimers.get(sequence)!);
        this.nakTimers.delete(sequence);
      }

      return result;
    }

    this.receivedSeqs.add(sequence);

    // Proactively clean up if the set grows too large
    if (this.receivedSeqs.size > this.maxGapTracking * 2) {
      this._cleanupOldSequences();
    }

    // In order
    if (sequence === this.expectedSeq) {
      result.inOrder = true;
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;

      // Advance past contiguous buffered sequences
      while (this.receivedSeqs.has(this.expectedSeq)) {
        // Cancel NAK timer for this sequence since it arrived
        if (this.nakTimers.has(this.expectedSeq)) {
          clearTimeout(this.nakTimers.get(this.expectedSeq)!);
          this.nakTimers.delete(this.expectedSeq);
        }
        this.expectedSeq = (this.expectedSeq + 1) >>> 0;
      }

      this._cleanupOldSequences();
    } else if (this._isAhead(sequence, this.expectedSeq)) {
      // Gap detected - record missing sequences
      const gapSize = this._distanceForward(this.expectedSeq, sequence);
      if (gapSize > this.maxGapTracking) {
        this._resync(sequence);
        result.inOrder = true;
        result.resynced = true;
        return result;
      }

      let candidate = this.expectedSeq;
      for (let i = 0; i < gapSize; i++) {
        if (!this.receivedSeqs.has(candidate)) {
          result.missing.push(candidate);
          this._scheduleNAK(candidate);
        }
        candidate = (candidate + 1) >>> 0;
      }

      this._cleanupOldSequences();
    }

    return result;
  }

  /**
   * Get list of known missing sequences in the tracking window
   * @returns Array of missing sequence numbers
   */
  getMissingSequences(): number[] {
    if (this.expectedSeq === null) {
      return [];
    }
    const missing: number[] = [];
    const trackingSpan =
      this._firstSeq !== null
        ? this._distanceForward(this._firstSeq, this.expectedSeq)
        : this.expectedSeq;
    const windowSize = Math.min(this.maxOutOfOrder, trackingSpan);
    for (let i = 1; i <= windowSize; i++) {
      const seq = (this.expectedSeq - i) >>> 0;
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
  }

  /**
   * Schedule a NAK callback for a missing sequence
   * @private
   */
  private _scheduleNAK(sequence: number): void {
    if (this.nakTimers.has(sequence)) {
      return;
    }
    if (this.nakTimers.size >= this.maxGapTracking) {
      return;
    }

    const timer = setTimeout(() => {
      if (!this.receivedSeqs.has(sequence)) {
        this.onLossDetected([sequence]);
      }
      this.nakTimers.delete(sequence);
    }, this.nakTimeout);

    this.nakTimers.set(sequence, timer);
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
