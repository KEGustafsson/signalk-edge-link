"use strict";

/**
 * Minimal typed interfaces for Express request/response objects used by route
 * handlers in this module.  Defining them here avoids a runtime dependency on
 * @types/express while still giving the TypeScript compiler enough information
 * to catch mistakes in handler bodies.
 *
 * The shapes are structural subsets of express.Request / express.Response and
 * are assignment-compatible when the real Express objects are passed at runtime.
 */

/** Subset of express.Request properties used by route handlers. */
export interface RouteRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** Remote IP address of the caller (populated by Express). */
  ip?: string;
}

/** Subset of express.Response methods used by route handlers. */
export interface RouteResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: unknown): this;
  set(key: string, value: string): this;
  /** Sets the Content-Type response header. Alias for res.set('Content-Type', ...). */
  contentType(type: string): this;
  end(): void;
}
