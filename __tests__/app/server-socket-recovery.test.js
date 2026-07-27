"use strict";

/**
 * Server-mode UDP socket recovery.
 *
 * The server listener recovers from a transient interface fault (ENETDOWN /
 * EADDRNOTAVAIL on a switching cellular or Wi-Fi uplink) by re-creating and
 * re-binding the socket with exponential backoff. `bind()` is asynchronous and
 * signals failure with an "error" event rather than a throw, so "did the
 * recovery work?" can only be answered by the "listening" event.
 */

const { EventEmitter } = require("events");
const { startServer } = require("../../lib/app/connection/start-server");
const {
  SOCKET_RECOVERY_BASE_MS,
  SOCKET_RECOVERY_MAX_MS
} = require("../../lib/app/connection/context");

function makeSocket() {
  const socket = new EventEmitter();
  socket.address = () => ({ address: "0.0.0.0", port: 4446 });
  return socket;
}

function makeCtx() {
  const shuttingDown = { value: false };
  const sockets = [];
  const state = {
    socketUdp: null,
    pipelineServer: null,
    readyToSend: false,
    socketRecoveryInProgress: false,
    socketRecoveryTimer: null
  };

  const ctx = {
    state,
    // protocolVersion 1 keeps attachServerPipeline off the reliable path; the
    // recovery logic under test is shared by both.
    options: { udpPort: 4446, protocolVersion: 1, secretKey: "k" },
    app: { debug: jest.fn(), error: jest.fn() },
    instanceId: "srv",
    appProxy: {},
    metricsApi: {},
    getV1Pipeline: jest.fn(),
    socketRecoveryBackoffMs: SOCKET_RECOVERY_BASE_MS,
    socketManager: {
      create: jest.fn(() => {
        const s = makeSocket();
        sockets.push(s);
        return s;
      }),
      bind: jest.fn(),
      close: jest.fn()
    },
    lifecycle: { isShuttingDown: () => shuttingDown.value },
    setStatus: jest.fn()
  };

  return { ctx, state, sockets, shuttingDown };
}

/** Drive startServer to a listening socket. */
async function startListening(ctx, sockets) {
  const started = startServer(ctx);
  sockets[0].emit("listening");
  await started;
  return sockets[0];
}

describe("server socket recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("a transient socket error schedules a re-bind", async () => {
    const { ctx, state, sockets } = makeCtx();
    const first = await startListening(ctx, sockets);
    expect(state.readyToSend).toBe(true);

    first.emit("error", Object.assign(new Error("network down"), { code: "ENETDOWN" }));

    expect(state.readyToSend).toBe(false);
    expect(state.socketRecoveryInProgress).toBe(true);
    expect(state.socketRecoveryTimer).not.toBeNull();
    expect(ctx.socketManager.close).toHaveBeenCalled();
  });

  test("recovery is only declared once the replacement socket is listening", async () => {
    const { ctx, state, sockets } = makeCtx();
    const first = await startListening(ctx, sockets);
    ctx.setStatus.mockClear();

    first.emit("error", Object.assign(new Error("network down"), { code: "ENETDOWN" }));
    jest.advanceTimersByTime(SOCKET_RECOVERY_BASE_MS);

    // The replacement socket exists and bind() has been called, but bind is
    // asynchronous — nothing is proven yet.
    const replacement = sockets[1];
    expect(replacement).toBeDefined();
    expect(ctx.socketManager.bind).toHaveBeenCalledWith(4446);
    expect(state.readyToSend).toBe(false);
    expect(state.socketRecoveryInProgress).toBe(true);
    expect(ctx.setStatus).not.toHaveBeenCalledWith("UDP socket recovered", true);
    // Backoff must not be reset until the bind is known to have succeeded.
    expect(ctx.socketRecoveryBackoffMs).toBe(SOCKET_RECOVERY_BASE_MS * 2);

    replacement.emit("listening");

    expect(state.readyToSend).toBe(true);
    expect(state.socketRecoveryInProgress).toBe(false);
    expect(ctx.socketRecoveryBackoffMs).toBe(SOCKET_RECOVERY_BASE_MS);
    expect(ctx.setStatus).toHaveBeenCalledWith("UDP socket recovered", true);
  });

  test("a failed re-bind backs off instead of retrying at a fixed interval", async () => {
    const { ctx, state, sockets } = makeCtx();
    const first = await startListening(ctx, sockets);

    first.emit("error", Object.assign(new Error("network down"), { code: "ENETDOWN" }));

    const delays = [];
    for (let i = 0; i < 6; i++) {
      delays.push(ctx.socketRecoveryBackoffMs);
      jest.advanceTimersByTime(ctx.socketRecoveryBackoffMs);
      const attempted = sockets[sockets.length - 1];
      // bind() reports its failure as an event, never as a throw.
      attempted.emit("error", Object.assign(new Error("no address"), { code: "EADDRNOTAVAIL" }));
      expect(state.socketRecoveryInProgress).toBe(true);
    }

    expect(delays[0]).toBe(SOCKET_RECOVERY_BASE_MS);
    expect(delays[1]).toBe(SOCKET_RECOVERY_BASE_MS * 2);
    expect(delays[2]).toBe(SOCKET_RECOVERY_BASE_MS * 4);
    expect(Math.max(...delays)).toBeLessThanOrEqual(SOCKET_RECOVERY_MAX_MS);
  });

  test("a fatal bind failure stops retrying", async () => {
    const { ctx, state, sockets } = makeCtx();
    const first = await startListening(ctx, sockets);

    first.emit("error", Object.assign(new Error("network down"), { code: "ENETDOWN" }));
    jest.advanceTimersByTime(SOCKET_RECOVERY_BASE_MS);

    // The port was taken while the link was down — retrying forever would only
    // spam the log; the operator has to change the port.
    sockets[1].emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" }));

    expect(state.socketRecoveryInProgress).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a fatal error on the initial listener never schedules recovery", async () => {
    const { ctx, state, sockets } = makeCtx();
    const first = await startListening(ctx, sockets);

    first.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" }));

    expect(state.socketRecoveryInProgress).toBe(false);
    expect(state.socketRecoveryTimer).toBeNull();
  });

  test("shutting down while a retry is pending creates no socket", async () => {
    const { ctx, sockets, shuttingDown } = makeCtx();
    const first = await startListening(ctx, sockets);

    first.emit("error", Object.assign(new Error("network down"), { code: "ENETDOWN" }));
    shuttingDown.value = true;
    ctx.socketManager.create.mockClear();
    jest.runOnlyPendingTimers();

    expect(ctx.socketManager.create).not.toHaveBeenCalled();
    expect(ctx.state.socketRecoveryInProgress).toBe(false);
  });
});
