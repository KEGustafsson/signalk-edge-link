"use strict";

/**
 * Signal K Edge Link v2.0 - Sequence Tracker
 *
 * Tracks received sequence numbers to detect packet loss
 * and handle out-of-order delivery.
 *
 * @module lib/sequence
 */

class SequenceTracker {
  /**
   * @param {Object} [config]
   * @param {number} [config.maxOutOfOrder=100] - Max sequences to track for reordering
   * @param {number} [config.nakTimeout=100] - Delay (ms) before NAK callback fires
   * @param {function} [config.onLossDetected] - Callback when packet loss is confirmed
   */
  constructor(config = {}) {
    this.expectedSeq = null;
    this.receivedSeqs = new Set();
    this.maxOutOfOrder = config.maxOutOfOrder || 100;
    this.nakTimeout = config.nakTimeout || 100;
    this.maxGapTracking = config.maxGapTracking || Math.max(this.maxOutOfOrder * 4, 1024);
    this.behindResyncThreshold = config.behindResyncThreshold || (this.maxGapTracking * 2);
    this.nakTimers = new Map();
    this.onLossDetected = config.onLossDetected || (() => {});
  }

  /**
   * Returns true if seq is ahead of reference in uint32 serial number space.
   * Uses half-range comparison (RFC-style serial arithmetic).
   * @private
   */
  _isAhead(seq, reference) {
    const distance = (seq - reference) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  /**
   * Returns true if seq is behind reference in uint32 serial number space.
   * @private
   */
  _isBehind(seq, reference) {
    const distance = (reference - seq) >>> 0;
    return distance !== 0 && distance < 0x80000000;
  }

  /**
   * Forward uint32 distance from `from` to `to` (modulo 2^32).
   * @private
   */
  _distanceForward(from, to) {
    return (to - from) >>> 0;
  }

  /**
   * Process a received sequence number
   * @param {number} sequence - The received sequence number
   * @returns {Object} Result with inOrder, missing, and duplicate flags
   */
  processSequence(sequence) {
    sequence = sequence >>> 0;

    const result = {
      inOrder: false,
      missing: [],
      duplicate: false,
      resynced: false
    };

    // Initialize baseline from the first packet we actually receive.
    // This prevents deadlock when sender/receiver restart out of sequence.
    if (this.expectedSeq === null) {
      this.receivedSeqs.add(sequence);
      this.expectedSeq = (sequence + 1) >>> 0;
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
        clearTimeout(this.nakTimers.get(sequence));
        this.nakTimers.delete(sequence);
      }

      return result;
    }

    this.receivedSeqs.add(sequence);

    // In order
    if (sequence === this.expectedSeq) {
      result.inOrder = true;
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;

      // Advance past contiguous buffered sequences
      while (this.receivedSeqs.has(this.expectedSeq)) {
        // Cancel NAK timer for this sequence since it arrived
        if (this.nakTimers.has(this.expectedSeq)) {
          clearTimeout(this.nakTimers.get(this.expectedSeq));
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
    }

    return result;
  }

  /**
   * Get list of known missing sequences in the tracking window
   * @returns {number[]} Array of missing sequence numbers
   */
  getMissingSequences() {
    if (this.expectedSeq === null) {
      return [];
    }
    const missing = [];
    const start = Math.max(0, this.expectedSeq - this.maxOutOfOrder);
    for (let i = start; i < this.expectedSeq; i++) {
      if (!this.receivedSeqs.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  /**
   * Reset all state and cancel pending timers
   */
  reset() {
    this.expectedSeq = null;
    this.receivedSeqs.clear();
    this._clearNAKTimers();
  }

  /**
   * Re-baseline tracking to a newly observed sequence after major discontinuity.
   * This prevents timer storms and prolonged desynchronization.
   * @private
   * @param {number} sequence
   */
  _resync(sequence) {
    this._clearNAKTimers();
    this.receivedSeqs.clear();
    this.receivedSeqs.add(sequence);
    this.expectedSeq = (sequence + 1) >>> 0;
  }

  /**
   * Cancel and clear all outstanding NAK timers.
   * @private
   */
  _clearNAKTimers() {
    for (const timer of this.nakTimers.values()) {
      clearTimeout(timer);
    }
    this.nakTimers.clear();
  }

  /**
   * Schedule a NAK callback for a missing sequence
   * @private
   * @param {number} sequence
   */
  _scheduleNAK(sequence) {
    if (this.nakTimers.has(sequence)) {return;}

    const timer = setTimeout(() => {
      if (!this.receivedSeqs.has(sequence)) {
        this.onLossDetected([sequence]);
      }
      this.nakTimers.delete(sequence);
    }, this.nakTimeout);

    this.nakTimers.set(sequence, timer);
  }

  /**
   * Remove old sequences from the tracking set to prevent memory growth
   * @private
   */
  _cleanupOldSequences() {
    for (const seq of this.receivedSeqs) {
      if (
        this._isBehind(seq, this.expectedSeq) &&
        this._distanceForward(seq, this.expectedSeq) > this.maxOutOfOrder
      ) {
        this.receivedSeqs.delete(seq);
      }
    }
  }
}

module.exports = { SequenceTracker };
