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
    this.expectedSeq = 0;
    this.receivedSeqs = new Set();
    this.maxOutOfOrder = config.maxOutOfOrder || 100;
    this.nakTimeout = config.nakTimeout || 100;
    this.nakTimers = new Map();
    this.onLossDetected = config.onLossDetected || (() => {});
  }

  /**
   * Process a received sequence number
   * @param {number} sequence - The received sequence number
   * @returns {Object} Result with inOrder, missing, and duplicate flags
   */
  processSequence(sequence) {
    const result = {
      inOrder: false,
      missing: [],
      duplicate: false
    };

    // Check for duplicate
    if (this.receivedSeqs.has(sequence)) {
      result.duplicate = true;
      return result;
    }

    // Also duplicate if below expected and already processed
    if (sequence < this.expectedSeq && !this.receivedSeqs.has(sequence)) {
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
      this.expectedSeq++;

      // Advance past contiguous buffered sequences
      while (this.receivedSeqs.has(this.expectedSeq)) {
        // Cancel NAK timer for this sequence since it arrived
        if (this.nakTimers.has(this.expectedSeq)) {
          clearTimeout(this.nakTimers.get(this.expectedSeq));
          this.nakTimers.delete(this.expectedSeq);
        }
        this.expectedSeq++;
      }

      this._cleanupOldSequences();
    } else if (sequence > this.expectedSeq) {
      // Gap detected - record missing sequences
      for (let i = this.expectedSeq; i < sequence; i++) {
        if (!this.receivedSeqs.has(i)) {
          result.missing.push(i);
          this._scheduleNAK(i);
        }
      }
    }

    return result;
  }

  /**
   * Get list of known missing sequences in the tracking window
   * @returns {number[]} Array of missing sequence numbers
   */
  getMissingSequences() {
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
    this.expectedSeq = 0;
    this.receivedSeqs.clear();
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
    const threshold = this.expectedSeq - this.maxOutOfOrder;
    if (threshold <= 0) {return;}
    for (const seq of this.receivedSeqs) {
      if (seq < threshold) {
        this.receivedSeqs.delete(seq);
      }
    }
  }
}

module.exports = { SequenceTracker };
