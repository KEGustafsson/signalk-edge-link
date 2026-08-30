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
 */
export function wrap(
  handler: (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>
): RouteHandler {
  const respond500 = (res: RouteResponse, err: unknown): void => {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
