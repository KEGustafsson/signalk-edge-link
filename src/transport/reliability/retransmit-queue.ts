"use strict";

/**
 * Signal K Edge Link v2.0 - Retransmission Queue
 *
 * Stores recently sent packets for potential retransmission.
 * Implements bounded map with automatic expiration.
 *
 * @module transport/reliability/retransmit-queue
 */

interface QueueEntry {
  packet: Buffer;
  timestamp: number;
  originalTimestamp: number;
  attempts: number;
}

interface RetransmitQueueConfig {
  maxSize?: number;
  maxRetransmits?: number;
}

interface RetransmitPacket {
  sequence: number;
  packet: Buffer;
  attempt: number;
}

interface QueueStats {
  size: number;
  totalAttempts: number;
  maxAttempts: number;
  avgAttempts: number;
}

export class RetransmitQueue {
  maxSize: number;
  maxRetransmits: number;
  queue: Map<number, QueueEntry>;
  /** Packets dropped after exhausting `maxRetransmits` — unrecoverable loss. */
  abandonedCount: number;
  /** Most recent abandoned sequence, for operator diagnostics. */
  lastAbandonedSeq: number | null;

  constructor(config: RetransmitQueueConfig = {}) {
    this.maxSize = config.maxSize ?? 5000;
    this.maxRetransmits = config.maxRetransmits ?? 3;
    this.queue = new Map(); // sequence -> {packet, timestamp, attempts}
    this.abandonedCount = 0;
    this.lastAbandonedSeq = null;
  }

  /**
   * Add packet to queue
   *
   * @param sequence - Packet sequence number
   * @param packet - Complete packet data
   */
  add(sequence: number, packet: Buffer): void {
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
  }

  /**
   * Get packet entry by sequence
   *
   * @param sequence
   * @returns Queue entry or undefined
   */
  get(sequence: number): QueueEntry | undefined {
    return this.queue.get(sequence);
  }

  /**
   * Acknowledge packets up to sequence (inclusive).
   * Removes all acknowledged packets from the queue.
   *
   * @param cumulativeSeq - All packets <= this are acknowledged
   * @returns Number of packets removed
   */
  acknowledge(cumulativeSeq: number): number {
    cumulativeSeq = cumulativeSeq >>> 0;
    if (this.queue.size === 0) {
      return 0;
    }

    // Anchor on the numerically-oldest outstanding sequence, not the first
    // insertion. Entries are enqueued in send-completion order, which concurrent
    // sendDelta calls and UDP send retries can reorder relative to sequence
    // allocation — so Map insertion order is NOT sequence order.
    const oldestOutstanding = this.oldestOutstandingSeq();
    if (oldestOutstanding === null) {
      return 0;
    }
    const distanceStartToEnd = (cumulativeSeq - oldestOutstanding) >>> 0;

    // If ACK is "behind" the oldest outstanding packet in serial space,
    // treat it as stale and avoid deleting the queue.
    if (distanceStartToEnd >= 0x80000000) {
      return 0;
    }

    // Collect keys to delete first, then delete — avoids modifying the Map
    // during iteration, which can cause entries to be silently skipped in V8.
    const toDelete: number[] = [];
    for (const seq of this.queue.keys()) {
      const distanceStartToSeq = (seq - oldestOutstanding) >>> 0;
      if (distanceStartToSeq <= distanceStartToEnd) {
        toDelete.push(seq);
      }
    }
    for (const seq of toDelete) {
      this.queue.delete(seq);
    }
    return toDelete.length;
  }

  /**
   * Numerically-oldest outstanding sequence in uint32 serial space, or null when
   * the queue is empty. Uses pairwise serial comparison so wraparound is handled.
   */
  private oldestOutstandingSeq(): number | null {
    let oldest: number | null = null;
    for (const seq of this.queue.keys()) {
      const candidate = seq >>> 0;
      if (oldest === null) {
        oldest = candidate;
        continue;
      }
      // candidate is behind `oldest` when the forward distance from candidate
      // to oldest is in the near half of the sequence space.
      if ((oldest - candidate) >>> 0 < 0x80000000) {
        oldest = candidate;
      }
    }
    return oldest;
  }

  /**
   * Acknowledge packets in the circular range (previousAckSeq, cumulativeSeq].
   * Handles uint32 sequence wraparound correctly.
   *
   * @param previousAckSeq - Previously processed cumulative ACK
   * @param cumulativeSeq - New cumulative ACK
   * @returns Number of packets removed
   */
  acknowledgeRange(previousAckSeq: number | null | undefined, cumulativeSeq: number): number {
    cumulativeSeq = cumulativeSeq >>> 0;

    // Backward-compatible behavior for first ACK in a session.
    if (previousAckSeq === null || previousAckSeq === undefined) {
      return this.acknowledge(cumulativeSeq);
    }

    const prevSeq = previousAckSeq >>> 0;
    if (prevSeq === cumulativeSeq) {
      return 0;
    }

    const distanceStartToEnd = (cumulativeSeq - prevSeq) >>> 0;
    // If cumulative ACK is behind the previous ACK in serial space,
    // it's stale/out-of-order and should not remove queued packets.
    if (distanceStartToEnd >= 0x80000000) {
      return 0;
    }
    // Collect keys to delete first, then delete — avoids modifying the Map
    // during iteration, which can cause entries to be silently skipped in V8.
    // Scan the whole queue: entries are enqueued in send-completion order, which
    // is not necessarily ascending sequence order, so an early `break` on the
    // first out-of-range key could stop before reaching acknowledged entries.
    const toDelete: number[] = [];
    for (const seq of this.queue.keys()) {
      const distanceStartToSeq = (seq - prevSeq) >>> 0;
      if (distanceStartToSeq > 0 && distanceStartToSeq <= distanceStartToEnd) {
        toDelete.push(seq);
      }
    }
    for (const seq of toDelete) {
      this.queue.delete(seq);
    }

    return toDelete.length;
  }

  /**
   * Get packets for retransmission.
   * Increments attempt counter and removes packets that exceed maxRetransmits.
   *
   * @param sequences - Sequences to retransmit
   * @returns Array of retransmit packet descriptors
   */
  retransmit(sequences: number[]): RetransmitPacket[] {
    const packets: RetransmitPacket[] = [];

    for (const seq of sequences) {
      const entry = this.queue.get(seq);
      if (!entry) {
        continue;
      }

      // Check max attempts. Dropping here is unrecoverable data loss: the
      // receiver will keep NAKing a sequence we can no longer produce, so it
      // must be counted rather than discarded silently.
      if (entry.attempts >= this.maxRetransmits) {
        this.queue.delete(seq);
        this.abandonedCount++;
        this.lastAbandonedSeq = seq >>> 0;
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
   * @param limit - Max number of sequences to return
   * @param minRetransmitAge - Only include sequences whose last retransmit
   *   timestamp is at least this many ms ago (0 = no filter). Use this when
   *   a recovery burst and a NAK handler could both select the same sequences
   *   in rapid succession — passing the burst interval here prevents the burst
   *   from re-sending packets that were already retransmitted recently via NAK.
   * @returns Sequence numbers
   */
  getOldestSequences(limit = 100, minRetransmitAge = 0): number[] {
    const cutoff = minRetransmitAge > 0 ? Date.now() - minRetransmitAge : 0;
    const eligible: Array<{ seq: number; at: number }> = [];
    for (const [seq, entry] of this.queue.entries()) {
      if (minRetransmitAge > 0 && entry.attempts > 0 && entry.timestamp > cutoff) {
        // This sequence was retransmitted too recently — skip it.
        continue;
      }
      eligible.push({ seq, at: entry.originalTimestamp });
    }
    // Order by true age: Map insertion order tracks send completion, not
    // sequence allocation, so it can diverge under concurrent sends.
    eligible.sort((a, b) => a.at - b.at);
    return eligible.slice(0, limit).map((e) => e.seq);
  }

  /**
   * Get current queue size
   *
   * @returns Number of packets in queue
   */
  getSize(): number {
    return this.queue.size;
  }

  /**
   * Get queue statistics
   *
   * @returns Statistics
   */
  getStats(): QueueStats {
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
  clear(): void {
    this.queue.clear();
  }

  /**
   * Remove packets older than age (ms)
   *
   * @param maxAge - Maximum age in milliseconds
   * @returns Number of packets removed
   */
  expireOld(maxAge: number): number {
    const now = Date.now();
    const toDelete: number[] = [];

    for (const [seq, entry] of this.queue.entries()) {
      if (now - entry.originalTimestamp > maxAge) {
        toDelete.push(seq);
      }
    }
    for (const seq of toDelete) {
      this.queue.delete(seq);
    }

    return toDelete.length;
  }

  /**
   * Evict the oldest entry from the queue
   * @private
   */
  private _evictOldest(): void {
    if (this.queue.size === 0) {
      return;
    }

    // Evict by true age rather than Map insertion order: entries are enqueued
    // in send order, which concurrent sends and UDP retries can reorder.
    let oldestKey: number | null = null;
    let oldestAt = Infinity;
    for (const [seq, entry] of this.queue.entries()) {
      if (entry.originalTimestamp < oldestAt) {
        oldestAt = entry.originalTimestamp;
        oldestKey = seq;
      }
    }
    if (oldestKey !== null) {
      this.queue.delete(oldestKey);
    }
  }
}
