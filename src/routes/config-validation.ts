import { isLikelyUnsafePathFilter } from "../metadata";

/** Upper bound on meta.includePathsMatching length. Same constant as the
 *  metadata runtime — mirrored here so the validator rejects patterns at
 *  save time rather than letting the runtime silently fall back to
 *  allow-all. */
const META_FILTER_MAX_LENGTH = 256;

function validateRuntimeConfigBody(filename: string, body: Record<string, unknown>): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }

  if (filename === "delta_timer.json") {
    if (
      body.deltaTimer !== undefined &&
      (typeof body.deltaTimer !== "number" || body.deltaTimer < 100 || body.deltaTimer > 10000)
    ) {
      return "deltaTimer must be a number between 100 and 10000";
    }
  } else if (filename === "subscription.json") {
    if (body.subscribe !== undefined && !Array.isArray(body.subscribe)) {
      return "subscribe must be an array";
    }
    if (Array.isArray(body.subscribe)) {
      for (let i = 0; i < body.subscribe.length; i++) {
        const item = body.subscribe[i];
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return `subscribe[${i}] must be an object`;
        }
      }
    }
    if (body.meta !== undefined) {
      if (body.meta === null || typeof body.meta !== "object" || Array.isArray(body.meta)) {
        return "meta must be an object";
      }
      const m = body.meta as Record<string, unknown>;
      if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
        return "meta.enabled must be a boolean";
      }
      if (
        m.intervalSec !== undefined &&
        (typeof m.intervalSec !== "number" ||
          !Number.isFinite(m.intervalSec) ||
          m.intervalSec < 30 ||
          m.intervalSec > 86400)
      ) {
        return "meta.intervalSec must be a number between 30 and 86400";
      }
      if (m.includePathsMatching !== undefined && m.includePathsMatching !== null) {
        if (typeof m.includePathsMatching !== "string") {
          return "meta.includePathsMatching must be a string or null";
        }
        // Same three checks the runtime applies, hoisted to save-time so
        // persisted subscription.json cannot contain patterns the runtime
        // would silently ignore. Keeps the API and the runtime in agreement.
        if (m.includePathsMatching.length > META_FILTER_MAX_LENGTH) {
          return `meta.includePathsMatching must be at most ${META_FILTER_MAX_LENGTH} characters`;
        }
        if (isLikelyUnsafePathFilter(m.includePathsMatching)) {
          return "meta.includePathsMatching contains a nested unbounded quantifier (ReDoS shape); refused";
        }
        try {
          new RegExp(m.includePathsMatching);
        } catch (err: unknown) {
          return `meta.includePathsMatching failed to compile: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (
        m.maxPathsPerPacket !== undefined &&
        (typeof m.maxPathsPerPacket !== "number" ||
          !Number.isFinite(m.maxPathsPerPacket) ||
          m.maxPathsPerPacket < 10 ||
          m.maxPathsPerPacket > 5000)
      ) {
        return "meta.maxPathsPerPacket must be a number between 10 and 5000";
      }
    }
  } else if (filename === "sentence_filter.json") {
    if (body.excludedSentences !== undefined && !Array.isArray(body.excludedSentences)) {
      return "excludedSentences must be an array";
    }
    if (Array.isArray(body.excludedSentences)) {
      for (let i = 0; i < body.excludedSentences.length; i++) {
        if (typeof body.excludedSentences[i] !== "string") {
          return `excludedSentences[${i}] must be a string`;
        }
      }
    }
  }

  return null;
}

export { validateRuntimeConfigBody };
