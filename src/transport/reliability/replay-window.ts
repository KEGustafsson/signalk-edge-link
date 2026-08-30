"use strict";

/**
 * Signal K Edge Link - Anti-Replay Window (H3)
 *
 * A strict IPsec/DTLS-style sliding replay window over uint32 sequence numbers.
 * Unlike {@link SequenceTracker} — which is reordering-tolerant and drives the
 * ACK/NAK reliability engine — this is a security gate: it remembers which
 * sequences have already been accepted so a captured DATA datagram cannot be
 * replayed once the live session state is gone (idle expiry / eviction).
 *
 * Semantics (serial-number arithmetic, RFC-style half-range comparison):
 *  - First sequence establishes the baseline (`highest`).
 *  - A sequence strictly ahead of `highest` advances the window (accept).
 *  - A sequence within `[highest - size + 1, highest]` is accepted once; a
 *    repeat of an already-accepted sequence is rejected (replay).
 *  - A sequence older than the window (`>= size` behind `highest`) is rejected.
 *
 * The window is **not** reset on session idle/eviction; resets happen only on a
 * higher connection epoch (a legitimate peer restart, signalled out-of-band by
 * the HELLO handshake), so a restarted peer's new random baseline is accepted
 * while replays of the previous epoch are not.
 *
 * @module transport/reliability/replay-window
 */

import { REPLAY_WINDOW_SIZE } from "../../foundation/constants";
import { serialAhead, serialDistance } from "../../foundation/serial";

export class ReplayWindow {
  /** Highest accepted sequence, or null until the first packet establishes it. */
  private highest: number | null;
  /** Recently-accepted sequences within the window (for in-window dedup). */
  private readonly seen: Set<number>;
  readonly size: number;

  constructor(size: number = REPLAY_WINDOW_SIZE) {
    this.highest = null;
    this.seen = new Set<number>();
    this.size = size > 0 ? size : REPLAY_WINDOW_SIZE;
  }

  /** True while no sequence has been accepted yet. */
  get isEmpty(): boolean {
    return this.highest === null;
  }

  /**
   * Clear all state. Called when a higher connection epoch is observed
   * (legitimate peer restart) so the new sequence baseline is accepted.
   */
  reset(): void {
    this.highest = null;
    this.seen.clear();
  }

  /**
   * Check-and-record a received sequence.
   * @returns true if the sequence is fresh (accept); false if it is a replay of
   *   an already-seen sequence, or older than the window (reject).
   */
  accept(sequence: number): boolean {
    const seq = sequence >>> 0;

    if (this.highest === null) {
      this.highest = seq;
      this.seen.clear();
      this.seen.add(seq);
      return true;
    }

    // Strictly ahead of the current high-water mark: advance the window.
    if (serialAhead(seq, this.highest)) {
      this.highest = seq;
      this.seen.add(seq);
      this._pruneIfNeeded();
      return true;
    }

    const behind = serialDistance(seq, this.highest);
    if (behind >= this.size) {
      // Older than the window — freshness cannot be proven, so reject as replay.
      return false;
    }
    if (this.seen.has(seq)) {
      return false; // already accepted within the window — replay
    }
    this.seen.add(seq);
    return true;
  }

  /**
   * Drop sequences that have fallen out of the window.
   *
   * Pruning is amortized by only running once the set has grown a whole window
   * *past* its nominal size. Triggering at `size` instead does not amortize at
   * all: under sequential arrival the set settles at exactly `size`, so every
   * subsequent packet pushes it to `size + 1`, scans all of them, and deletes
   * exactly one — an O(window) pass per packet on the receive hot path, which
   * at the per-peer rate limit is ~200k set iterations a second. With a full
   * window of slack each scan retires ~`size` entries, so the per-packet cost
   * is O(1) amortized for at most 2x the memory.
   * @private
   */
  private _pruneIfNeeded(): void {
    if (this.highest === null || this.seen.size <= this.size * 2) {
      return;
    }
    // Collect-then-delete: mutating a Set mid-iteration can skip entries in V8.
    const stale: number[] = [];
    for (const s of this.seen) {
      if (serialDistance(s, this.highest) >= this.size) {
        stale.push(s);
      }
    }
    for (const s of stale) {
      this.seen.delete(s);
    }
  }
}
