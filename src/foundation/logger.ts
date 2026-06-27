/**
 * L0 foundation — prefixed logger over a Signal K `app`-like sink.
 *
 * One small wrapper so every module logs with a consistent `[prefix]` tag
 * instead of ad-hoc string concatenation or stray `console` calls.
 * Pure and dependency-free: it
 * takes only a minimal `{ debug, error }` sink, so the foundation layer does
 * not depend on the full `SignalKApp` type.
 */

/** Minimal logging surface — satisfied by the Signal K `app` object. */
export interface LoggerSink {
  debug: (msg: string) => void;
  error: (msg: string) => void;
}

export interface Logger {
  debug(msg: string): void;
  error(msg: string): void;
  /** Derive a logger with an extended prefix, e.g. `conn` → `conn:server`. */
  child(suffix: string): Logger;
}

/**
 * Create a logger that prepends `[prefix] ` to every message.
 *
 * @param sink   destination (typically the Signal K `app`).
 * @param prefix module/connection tag, e.g. `edge-link` or `conn#3`.
 */
export function createLogger(sink: LoggerSink, prefix: string): Logger {
  const tag = `[${prefix}] `;
  return {
    debug(msg: string): void {
      sink.debug(tag + msg);
    },
    error(msg: string): void {
      sink.error(tag + msg);
    },
    child(suffix: string): Logger {
      return createLogger(sink, `${prefix}:${suffix}`);
    }
  };
}
