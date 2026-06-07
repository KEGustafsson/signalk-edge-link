"use strict";

/**
 * Shared crypto constants that must stay in sync between the backend crypto
 * module and any UI copy that describes key-derivation behaviour. Kept under
 * `src/shared/` so both the server-side build and the webapp bundle can
 * reference the same value.
 */

/**
 * PBKDF2-SHA256 iteration count used by {@link deriveKeyFromPassphrase} and
 * by the opt-in 32-char ASCII key stretching path in {@link normalizeKey}.
 *
 * Tuned to the NIST SP 800-132 recommendation (≥ 600,000) and takes roughly
 * ~300 ms on modern server hardware. The derived key is cached per-process
 * so the cost is paid at most once per unique (key, salt) pair.
 */
export const PBKDF2_ITERATIONS = 600_000;
