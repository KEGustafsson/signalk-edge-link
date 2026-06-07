"use strict";

/**
 * L1 codec — delta-sanitizer shared primitives:
 * the DeltaPayload shape and the small type guards used across the
 * quantize/throttle/filter/sanitize concerns. Imported by the sibling modules
 * to keep the dependency graph acyclic.
 */

import type { Delta } from "../../foundation/types";

export type DeltaPayload = Delta | Delta[] | Record<string, Delta>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDeltaLike(value: unknown): value is Delta {
  return isObject(value) && Array.isArray(value.updates);
}
