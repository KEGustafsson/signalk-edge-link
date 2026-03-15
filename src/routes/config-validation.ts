function validateRuntimeConfigBody(filename: string, body: any): string | null {
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
