"use strict";

/**
 * Signal K Edge Link v2.0 - Retransmission Queue
 *
 * Stores recently sent packets for potential retransmission.
 * Implements bounded map with automatic expiration.
 *
 * @module lib/retransmit-queue
 */

class RetransmitQueue {
  /**
   * @param {Object} [config]
   * @param {number} [config.maxSize=5000] - Max packets to store
   * @param {number} [config.maxRetransmits=3] - Max retransmit attempts per packet
   */
  constructor(config = {}) {
    this.maxSize = config.maxSize || 5000;
    this.maxRetransmits = config.maxRetransmits || 3;
    this.queue = new Map(); // sequence -> {packet, timestamp, attempts}
    this._oldestSeq = Infinity;
  }

  /**
   * Add packet to queue
   *
   * @param {number} sequence - Packet sequence number
   * @param {Buffer} packet - Complete packet data
   */
  add(sequence, packet) {
    // Remove oldest if at capacity
    if (this.queue.size >= this.maxSize) {
      this._evictOldest();
    }

    const now = Date.now();
    this.queue.set(sequence, {
      packet: packet,
      timestamp: now,
      originalTimestamp: now,
      attempts: 0
    });

    if (this._oldestSeq === Infinity) {
      this._oldestSeq = sequence;
    }
  }

  /**
   * Get packet entry by sequence
   *
   * @param {number} sequence
   * @returns {Object|undefined} Queue entry or undefined
   */
  get(sequence) {
    return this.queue.get(sequence);
  }

  /**
   * Acknowledge packets up to sequence (inclusive).
   * Removes all acknowledged packets from the queue.
   *
   * @param {number} cumulativeSeq - All packets <= this are acknowledged
   * @returns {number} Number of packets removed
   */
  acknowledge(cumulativeSeq) {
    cumulativeSeq = cumulativeSeq >>> 0;
    if (this.queue.size === 0) {
      return 0;
    }

    const first = this.queue.keys().next();
    if (first.done) {
      return 0;
    }

    const oldestOutstanding = first.value >>> 0;
    const distanceStartToEnd = (cumulativeSeq - oldestOutstanding) >>> 0;

    // If ACK is "behind" the oldest outstanding packet in serial space,
    // treat it as stale and avoid deleting the queue.
    if (distanceStartToEnd >= 0x80000000) {
      return 0;
    }

    let removed = 0;
    for (const seq of this.queue.keys()) {
      const distanceStartToSeq = (seq - oldestOutstanding) >>> 0;
      if (distanceStartToSeq <= distanceStartToEnd) {
        this.queue.delete(seq);
        removed++;
      }
    }
    this._updateOldestSeq();
    return removed;
  }

  /**
   * Acknowledge packets in the circular range (previousAckSeq, cumulativeSeq].
   * Handles uint32 sequence wraparound correctly.
   *
   * @param {number|null|undefined} previousAckSeq - Previously processed cumulative ACK
   * @param {number} cumulativeSeq - New cumulative ACK
   * @returns {number} Number of packets removed
   */
  acknowledgeRange(previousAckSeq, cumulativeSeq) {
    cumulativeSeq = cumulativeSeq >>> 0;

    // Backward-compatible behavior for first ACK in a session.
    if (previousAckSeq === null || previousAckSeq === undefined) {
      return this.acknowledge(cumulativeSeq);
    }

    previousAckSeq = previousAckSeq >>> 0;
    if (previousAckSeq === cumulativeSeq) {
      return 0;
    }

    const distanceStartToEnd = (cumulativeSeq - previousAckSeq) >>> 0;
    // If cumulative ACK is behind the previous ACK in serial space,
    // it's stale/out-of-order and should not remove queued packets.
    if (distanceStartToEnd >= 0x80000000) {
      return 0;
    }
    let removed = 0;

    for (const seq of this.queue.keys()) {
      const distanceStartToSeq = (seq - previousAckSeq) >>> 0;
      if (distanceStartToSeq > 0 && distanceStartToSeq <= distanceStartToEnd) {
        this.queue.delete(seq);
        removed++;
      }
    }

    if (removed > 0) {
      this._updateOldestSeq();
    }

    return removed;
  }

  /**
   * Get packets for retransmission.
   * Increments attempt counter and removes packets that exceed maxRetransmits.
   *
   * @param {number[]} sequences - Sequences to retransmit
   * @returns {Array<{sequence: number, packet: Buffer, attempt: number}>}
   */
  retransmit(sequences) {
    const packets = [];

    for (const seq of sequences) {
      const entry = this.queue.get(seq);
      if (!entry) {continue;}

      // Check max attempts
      if (entry.attempts >= this.maxRetransmits) {
        this.queue.delete(seq);
        continue;
      }

      // Increment attempts
      entry.attempts++;
      entry.timestamp = Date.now();

      packets.push({
        sequence: seq,
        packet: entry.packet,
        attempt: entry.attempts
      });
    }

    return packets;
  }

  /**
   * Get up to N oldest queued sequence numbers.
   * Map preserves insertion order, which reflects send order.
   *
   * @param {number} [limit=100] - Max number of sequences to return
   * @returns {number[]} Sequence numbers
   */
  getOldestSequences(limit = 100) {
    const result = [];
    for (const seq of this.queue.keys()) {
      result.push(seq);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  /**
   * Get current queue size
   *
   * @returns {number} Number of packets in queue
   */
  getSize() {
    return this.queue.size;
  }

  /**
   * Get queue statistics
   *
   * @returns {Object} Statistics
   */
  getStats() {
    let totalAttempts = 0;
    let maxAttempts = 0;

    for (const entry of this.queue.values()) {
      totalAttempts += entry.attempts;
      maxAttempts = Math.max(maxAttempts, entry.attempts);
    }

    return {
      size: this.queue.size,
      totalAttempts,
      maxAttempts,
      avgAttempts: this.queue.size > 0 ? totalAttempts / this.queue.size : 0
    };
  }

  /**
   * Clear all packets from queue
   */
  clear() {
    this.queue.clear();
    this._oldestSeq = Infinity;
  }

  /**
   * Remove packets older than age (ms)
   *
   * @param {number} maxAge - Maximum age in milliseconds
   * @returns {number} Number of packets removed
   */
  expireOld(maxAge) {
    const now = Date.now();
    let removed = 0;

    for (const [seq, entry] of this.queue.entries()) {
      if (now - entry.timestamp > maxAge) {
        this.queue.delete(seq);
        removed++;
      }
    }

    if (removed > 0) {
      this._updateOldestSeq();
    }

    return removed;
  }

  /**
   * Evict the oldest entry from the queue
   * @private
   */
  _evictOldest() {
    if (this.queue.size === 0) {return;}

    // Map preserves insertion order: first key is oldest queued packet.
    const oldest = this.queue.keys().next().value;
    this.queue.delete(oldest);
    this._updateOldestSeq();
  }

  /**
   * Update cached oldest sequence
   * @private
   */
  _updateOldestSeq() {
    if (this.queue.size === 0) {
      this._oldestSeq = Infinity;
      return;
    }
    this._oldestSeq = this.queue.keys().next().value;
  }
}

module.exports = { RetransmitQueue };
