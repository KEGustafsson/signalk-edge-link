"use strict";

/**
 * Regression coverage for the UDP send error / retry path in
 * src/pipeline-utils.ts. The shared udpSendAsync helper is used by both
 * v1 and v2 client pipelines; until now every test mocked
 * socket.send to always succeed, so the recordError / metrics increment
 * paths were dead-code as far as the suite was concerned.
 *
 * These tests exercise the three failure modes:
 *   1. Hard error (ENETUNREACH) on first attempt → onError fires
 *      immediately with retryCount === 0 and the call rejects.
 *   2. Transient error (EAGAIN) → onRetry fires until UDP_RETRY_MAX, the
 *      retry counter advances, and onError fires once the cap is hit.
 *   3. Send timeout (callback never invoked) → the race against
 *      UDP_SEND_TIMEOUT_MS rejects with a timeout error.
 */

const dgram = require("dgram");
const { udpSendAsync } = require("../lib/pipeline-utils");

function makeFakeSocket({ errorCode = null, neverCallback = false } = {}) {
  return {
    send: jest.fn((_message, _port, _host, cb) => {
      if (neverCallback) {
        // Simulate a totally stuck send — the timeout race must rescue us.
        return;
      }
      if (errorCode) {
        const err = new Error(errorCode);
        err.code = errorCode;
        // Async callback to mimic real dgram behaviour.
        setImmediate(() => cb(err));
        return;
      }
      setImmediate(() => cb(null));
    })
  };
}

describe("udpSendAsync — error paths", () => {
  test("hard error fires onError once and rejects", async () => {
    const socket = makeFakeSocket({ errorCode: "ENETUNREACH" });
    const onError = jest.fn();
    const onRetry = jest.fn();
    await expect(
      udpSendAsync(socket, Buffer.from("x"), "127.0.0.1", 4567, { onError, onRetry })
    ).rejects.toMatchObject({ code: "ENETUNREACH" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(0); // retryCount on first failure
    expect(onRetry).not.toHaveBeenCalled();
    // Single send attempt — non-retryable codes don't trigger backoff.
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  test("transient ENOBUFS retries up to UDP_RETRY_MAX then fails", async () => {
    const socket = makeFakeSocket({ errorCode: "ENOBUFS" });
    const onError = jest.fn();
    const onRetry = jest.fn();
    await expect(
      udpSendAsync(socket, Buffer.from("x"), "127.0.0.1", 4567, { onError, onRetry })
    ).rejects.toMatchObject({ code: "ENOBUFS" });
    // UDP_RETRY_MAX is 3 → 3 retries (after the initial attempt) before
    // giving up. socket.send is called 4 times total.
    expect(socket.send).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    // The final onError reports the retry count we landed on.
    expect(onError.mock.calls[0][1]).toBe(3);
  });

  test("send timeout rejects when callback never fires", async () => {
    jest.useFakeTimers();
    const socket = makeFakeSocket({ neverCallback: true });
    const promise = udpSendAsync(socket, Buffer.from("x"), "127.0.0.1", 4567);
    // Race a no-op against the configured 5s timeout.
    jest.advanceTimersByTime(5001);
    await expect(promise).rejects.toThrow(/timed out/);
    jest.useRealTimers();
  });

  test("succeeds without invoking error callbacks on clean send", async () => {
    const socket = makeFakeSocket();
    const onError = jest.fn();
    const onRetry = jest.fn();
    await expect(
      udpSendAsync(socket, Buffer.from("x"), "127.0.0.1", 4567, { onError, onRetry })
    ).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("rejects synchronously when socket is null", () => {
    expect(() => udpSendAsync(null, Buffer.from("x"), "127.0.0.1", 4567)).toThrow(
      /UDP socket not initialized/
    );
  });
});

// Sanity check that the real dgram surface still works alongside our
// fake — protects against a future change to the helper that breaks the
// happy-path live socket call.
describe("udpSendAsync — live dgram smoke test", () => {
  let socket;
  let receiver;
  let port;

  beforeAll((done) => {
    receiver = dgram.createSocket("udp4");
    receiver.bind(0, "127.0.0.1", () => {
      port = receiver.address().port;
      done();
    });
  });

  afterAll((done) => {
    receiver.close(() => done());
  });

  beforeEach(() => {
    socket = dgram.createSocket("udp4");
  });

  afterEach(() => {
    socket.close();
  });

  test("real socket reaches local receiver", (done) => {
    receiver.once("message", (msg) => {
      expect(msg.toString()).toBe("hello");
      done();
    });
    udpSendAsync(socket, Buffer.from("hello"), "127.0.0.1", port).catch(done);
  });
});
