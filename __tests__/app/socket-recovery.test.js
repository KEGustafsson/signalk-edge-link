"use strict";

/**
 * Client UDP socket recovery.
 *
 * This is the code that keeps a link alive across a NIC flap, and it was the
 * least-covered load-bearing module in the tree (38% function coverage): the
 * backoff, the retry scheduling, and the two shutdown guards that stop a
 * pending recovery timer from resurrecting a stopped connection all had no
 * direct tests.
 */

const {
  recoverClientSocket,
  handleClientSocketError
} = require("../../lib/app/connection/socket-recovery");
const {
  SOCKET_RECOVERY_BASE_MS,
  SOCKET_RECOVERY_MAX_MS
} = require("../../lib/app/connection/context");

function makeCtx({ createImpl } = {}) {
  const shuttingDown = { value: false };
  const state = {
    socketUdp: null,
    pipeline: null,
    heartbeatHandle: null,
    readyToSend: true,
    socketRecoveryInProgress: false,
    socketRecoveryTimer: null,
    metaConfig: null
  };

  const socket = {
    on: jest.fn(),
    removeAllListeners: jest.fn()
  };

  const ctx = {
    state,
    options: { udpAddress: "127.0.0.1", udpPort: 4446 },
    app: { debug: jest.fn(), error: jest.fn() },
    instanceId: "test",
    recordError: jest.fn(),
    socketRecoveryBackoffMs: SOCKET_RECOVERY_BASE_MS,
    socketManager: {
      create: createImpl || jest.fn(() => socket),
      close: jest.fn()
    },
    lifecycle: {
      isShuttingDown: () => shuttingDown.value,
      transition: jest.fn()
    },
    setStatus: jest.fn(),
    handleClientSocketError: jest.fn(),
    services: {
      sendSourceSnapshot: jest.fn().mockResolvedValue(undefined),
      scheduleMetadataSnapshot: jest.fn(),
      replayValuesSnapshot: jest.fn()
    }
  };

  return { ctx, state, socket, shuttingDown };
}

describe("client socket recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("a socket error tears down the send path and schedules a retry", () => {
    const { ctx, state } = makeCtx();
    const heartbeat = { stop: jest.fn() };
    state.heartbeatHandle = heartbeat;
    state.socketUdp = { on: jest.fn() };
    state.pipeline = {
      stopMetricsPublishing: jest.fn(),
      stopCongestionControl: jest.fn()
    };

    handleClientSocketError(ctx, Object.assign(new Error("ENETDOWN"), { code: "ENETDOWN" }));

    expect(state.readyToSend).toBe(false);
    expect(state.socketRecoveryInProgress).toBe(true);
    // The heartbeat must stop, otherwise it keeps sending on a dead socket.
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(state.heartbeatHandle).toBeNull();
    expect(state.pipeline.stopMetricsPublishing).toHaveBeenCalled();
    expect(ctx.socketManager.close).toHaveBeenCalled();
    expect(state.socketUdp).toBeNull();
    expect(state.socketRecoveryTimer).not.toBeNull();
    // Status must be explicitly unhealthy, not inferred from message text.
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.stringContaining("recovering"), false);
  });

  test("a second error while recovery is in progress is ignored", () => {
    const { ctx, state } = makeCtx();
    state.socketRecoveryInProgress = true;
    handleClientSocketError(ctx, new Error("boom"));
    expect(ctx.app.error).not.toHaveBeenCalled();
  });

  test("a successful recovery re-arms the pipeline and resets backoff", () => {
    const { ctx, state, socket } = makeCtx();
    ctx.socketRecoveryBackoffMs = 8000;
    state.socketRecoveryInProgress = true;
    state.pipeline = {
      handleControlPacket: jest.fn().mockResolvedValue(undefined),
      startMetricsPublishing: jest.fn(),
      startCongestionControl: jest.fn(),
      startHeartbeat: jest.fn(() => ({ stop: jest.fn() })),
      sendHello: jest.fn()
    };

    recoverClientSocket(ctx);

    expect(state.socketUdp).toBe(socket);
    expect(state.socketRecoveryInProgress).toBe(false);
    expect(state.readyToSend).toBe(true);
    expect(ctx.socketRecoveryBackoffMs).toBe(SOCKET_RECOVERY_BASE_MS);
    // A new source port needs a fresh handshake, or the server treats this as
    // an unhandshaked peer: no replay enforcement and dropped telemetry.
    expect(state.pipeline.sendHello).toHaveBeenCalledWith("127.0.0.1", 4446);
    expect(state.pipeline.startHeartbeat).toHaveBeenCalled();
    expect(ctx.services.replayValuesSnapshot).toHaveBeenCalledWith("socket recovery");
  });

  test("backoff doubles on each failure and caps at the maximum", () => {
    const { ctx } = makeCtx({
      createImpl: jest.fn(() => {
        throw new Error("EADDRNOTAVAIL");
      })
    });

    const seen = [];
    for (let i = 0; i < 12; i++) {
      seen.push(ctx.socketRecoveryBackoffMs);
      recoverClientSocket(ctx);
      // Drain the scheduled retry without letting it recurse further.
      ctx.state.socketRecoveryTimer = null;
      jest.clearAllTimers();
    }

    expect(seen[0]).toBe(SOCKET_RECOVERY_BASE_MS);
    expect(seen[1]).toBe(SOCKET_RECOVERY_BASE_MS * 2);
    expect(seen[2]).toBe(SOCKET_RECOVERY_BASE_MS * 4);
    expect(Math.max(...seen)).toBeLessThanOrEqual(SOCKET_RECOVERY_MAX_MS);
    expect(seen[seen.length - 1]).toBe(SOCKET_RECOVERY_MAX_MS);
  });

  test("shutting down before the retry fires creates no socket", () => {
    const { ctx, shuttingDown } = makeCtx({
      createImpl: jest.fn(() => {
        throw new Error("EADDRNOTAVAIL");
      })
    });
    ctx.state.socketRecoveryInProgress = true;

    recoverClientSocket(ctx);
    expect(ctx.state.socketRecoveryTimer).not.toBeNull();

    // stop() lands while the retry is pending.
    shuttingDown.value = true;
    ctx.socketManager.create.mockClear();
    jest.runOnlyPendingTimers();

    // The timer must not resurrect a socket for a stopped connection.
    expect(ctx.socketManager.create).not.toHaveBeenCalled();
    expect(ctx.state.socketRecoveryInProgress).toBe(false);
  });

  test("shutting down during a failed attempt does not schedule a retry", () => {
    const { ctx, shuttingDown } = makeCtx({
      createImpl: jest.fn(() => {
        shuttingDown.value = true;
        throw new Error("EADDRNOTAVAIL");
      })
    });
    ctx.state.socketRecoveryInProgress = true;

    recoverClientSocket(ctx);

    expect(ctx.state.socketRecoveryTimer).toBeNull();
    expect(ctx.state.socketRecoveryInProgress).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("an error raised while shutting down is ignored entirely", () => {
    const { ctx, shuttingDown } = makeCtx();
    shuttingDown.value = true;
    handleClientSocketError(ctx, new Error("boom"));
    expect(ctx.state.socketRecoveryInProgress).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
