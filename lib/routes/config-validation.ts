// @ts-nocheck
"use strict";

function validateRuntimeConfigBody(filename, body) {
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
  } else if (filename === "sentence_filter.json") {
    if (body.excludedSentences !== undefined && !Array.isArray(body.excludedSentences)) {
      return "excludedSentences must be an array";
    }
  }

  return null;
}

module.exports = {
  validateRuntimeConfigBody
};
