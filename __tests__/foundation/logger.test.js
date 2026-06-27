"use strict";

const { createLogger } = require("../../lib/foundation/logger");

function makeSink() {
  const debug = [];
  const error = [];
  return {
    debug: (m) => debug.push(m),
    error: (m) => error.push(m),
    _debug: debug,
    _error: error
  };
}

describe("foundation/logger", () => {
  test("prefixes debug and error messages", () => {
    const sink = makeSink();
    const log = createLogger(sink, "edge-link");
    log.debug("started");
    log.error("boom");
    expect(sink._debug).toEqual(["[edge-link] started"]);
    expect(sink._error).toEqual(["[edge-link] boom"]);
  });

  test("child extends the prefix", () => {
    const sink = makeSink();
    const log = createLogger(sink, "conn#3").child("server");
    log.debug("bound");
    expect(sink._debug).toEqual(["[conn#3:server] bound"]);
  });

  test("nested children chain prefixes", () => {
    const sink = makeSink();
    createLogger(sink, "a").child("b").child("c").debug("x");
    expect(sink._debug).toEqual(["[a:b:c] x"]);
  });
});
