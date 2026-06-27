"use strict";

/**
 * Deterministic, reproducible PRNG for fuzz/property tests.
 *
 * Why: fuzz tests that call `Math.random()` / `crypto.randomBytes()` directly
 * are not reproducible — a failure cannot be replayed. This helper seeds a
 * fast PRNG (mulberry32) so a run is fully determined by its seed.
 *
 * Controls (env):
 *   FUZZ_SEED   integer seed (default: a fixed constant for stable CI runs)
 *   FUZZ_ITERS  iteration multiplier override for loops that call iters()
 *
 * On a failing run, the seed is printed (see logSeed()) so it can be replayed
 * with `FUZZ_SEED=<value> npx jest <file>`.
 *
 * @module __tests__/helpers/seeded-random
 */

const DEFAULT_SEED = 0x1234_5678;

function resolveSeed() {
  const raw = process.env.FUZZ_SEED;
  if (raw === undefined || raw === "") {
    return DEFAULT_SEED >>> 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : DEFAULT_SEED >>> 0;
}

/**
 * Create a seeded PRNG instance. Each call returns an independent generator
 * starting from the resolved seed, so test files don't share mutable state.
 */
function createSeededRandom(seedOverride) {
  let state = (seedOverride !== undefined ? seedOverride >>> 0 : resolveSeed()) >>> 0;
  const seed = state;

  // mulberry32 — small, fast, good enough for fuzz input distribution.
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function intBelow(n) {
    return Math.floor(next() * n);
  }

  function bytes(len) {
    const buf = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      buf[i] = intBelow(256);
    }
    return buf;
  }

  function pick(arr) {
    return arr[intBelow(arr.length)];
  }

  return { seed, random: next, intBelow, bytes, pick };
}

/**
 * Resolve an iteration count, scaled by the FUZZ_ITERS override when set.
 * e.g. FUZZ_ITERS=4 runs loops 4x longer for deeper local fuzzing.
 */
function iters(base) {
  const raw = process.env.FUZZ_ITERS;
  if (raw === undefined || raw === "") {
    return base;
  }
  const mult = Number(raw);
  return Number.isFinite(mult) && mult > 0 ? Math.max(1, Math.round(base * mult)) : base;
}

/**
 * Log the seed for a suite so a failing run can be replayed. Call once in a
 * describe/beforeAll. Always prints so the seed is in the captured output.
 */
function logSeed(label, seed) {
  // eslint-disable-next-line no-console
  console.log(`[fuzz] ${label} seed=${seed} (replay with FUZZ_SEED=${seed})`);
}

module.exports = { createSeededRandom, iters, logSeed, DEFAULT_SEED };
