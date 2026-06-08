/**
 * L0 foundation — `Result<T, E>` and typed errors.
 *
 * A small, dependency-free discriminated union for module-boundary error
 * handling, plus a typed-error hierarchy. The goal is to replace silent
 * failures — notably the
 * `stretchAsciiKey` mismatch that today causes total decrypt failure with no
 * actionable diagnostic — with explicit, surfaced results.
 *
 * NOTE: wiring `DecryptError` into the crypto/decrypt path (capability
 * signalling so a key mismatch yields this typed error instead of a silent
 * drop) is Phase 6 hardening and must not change the bytes of a correctly
 * matched exchange. This module only defines the vocabulary.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Return the value or throw the error (escape hatch at trusted call sites). */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) {
    return r.value;
  }
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
}

/** Return the value or a fallback when the result is an error. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Base class for typed Edge Link errors — carries a stable machine code. */
export class EdgeLinkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Decryption / authentication failure. `keyMismatchHint` is set when the
 * failure is consistent with a `stretchAsciiKey` (or key-format) disagreement
 * between peers, so logs/metrics/UI can surface an actionable message instead
 * of a silent drop (Phase 6).
 */
export class DecryptError extends EdgeLinkError {
  readonly keyMismatchHint: boolean;

  constructor(message: string, options: { keyMismatchHint?: boolean } = {}) {
    super("DECRYPT_FAILED", message);
    this.keyMismatchHint = options.keyMismatchHint ?? false;
  }
}

/** Packet parse/validation failure (malformed header, CRC, version, etc.). */
export class PacketParseError extends EdgeLinkError {
  constructor(message: string) {
    super("PACKET_PARSE_FAILED", message);
  }
}

/** Configuration validation failure. */
export class ConfigValidationError extends EdgeLinkError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
  }
}
