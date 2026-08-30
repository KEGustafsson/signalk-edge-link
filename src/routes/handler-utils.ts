"use strict";

/**
 * Shared route-handler plumbing.
 *
 * @module routes/handler-utils
 */

import type { RouteHandler, RouteRequest, RouteResponse } from "./types";

/**
 * Wrap a (possibly async) handler so a sync throw or a rejected promise
 * becomes a 500 JSON response instead of an unhandled rejection or a hung
 * request — Express 4 catches neither on its own.
 *
 * The response body is a fixed generic message: a lower-layer error can carry
 * filesystem paths or internal state that must not reach API clients. Pass
 * `app` to keep the detail in the server log.
 */
export function wrap(
  handler: (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>,
  app?: { error?: (msg: string) => void }
): RouteHandler {
  const respond500 = (res: RouteResponse, err: unknown): void => {
    app?.error?.(`Route handler failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  };
  return (req, res) => {
    // Run synchronously — a sync handler must have written its response by the
    // time this returns — and use the promise only to catch async rejections.
    try {
      const result = handler(req, res) as { then?: unknown; catch?: unknown } | undefined;
      if (result && typeof result.catch === "function") {
        (result as Promise<unknown>).catch((err: unknown) => respond500(res, err));
      }
    } catch (err: unknown) {
      respond500(res, err);
    }
  };
}
