"use strict";

/**
 * RFC 1982-style serial arithmetic for uint32 sequence numbers.
 *
 * Sequence numbers wrap at 2^32, so plain comparisons report a freshly
 * wrapped sequence as ancient. All ordering decisions therefore compare the
 * forward distance against the half-space (0x80000000). These helpers are the
 * single implementation used by the ACK/NAK, replay-window, retransmit, and
 * value-dedup paths, which previously each carried their own copy.
 *
 * @module foundation/serial
 */

const HALF_SPACE = 0x80000000;

/** Forward uint32 distance from `from` to `to` (modulo 2^32). */
export function serialDistance(from: number, to: number): number {
  return ((to >>> 0) - (from >>> 0)) >>> 0;
}

/** True when `seq` is strictly ahead of `reference` in uint32 serial space. */
export function serialAhead(seq: number, reference: number): boolean {
  const distance = serialDistance(reference, seq);
  return distance !== 0 && distance < HALF_SPACE;
}

/** True when `seq` is at or ahead of `reference` in uint32 serial space. */
export function serialAtOrAfter(seq: number, reference: number): boolean {
  return serialDistance(reference, seq) < HALF_SPACE;
}
