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

    const forward = (seq - this.highest) >>> 0;
    // Strictly ahead of the current high-water mark: advance the window.
    if (forward !== 0 && forward < 0x80000000) {
      this.highest = seq;
      this.seen.add(seq);
      this._pruneIfNeeded();
      return true;
    }

    const behind = (this.highest - seq) >>> 0;
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
   * Drop sequences that have fallen out of the window. Pruning is amortized:
   * it only runs once the set grows past the window size, so the common
   * sequential-advance path stays O(1).
   * @private
   */
  private _pruneIfNeeded(): void {
    if (this.highest === null || this.seen.size <= this.size) {
      return;
    }
    // Collect-then-delete: mutating a Set mid-iteration can skip entries in V8.
    const stale: number[] = [];
    for (const s of this.seen) {
      if ((this.highest - s) >>> 0 >= this.size) {
        stale.push(s);
      }
    }
    for (const s of stale) {
      this.seen.delete(s);
    }
  }
}
