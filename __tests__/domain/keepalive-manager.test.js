"use strict";

/**
 * Unit tests for the L3 keepalive-manager service in isolation.
 *
 * The hello interval is driven with fake timers; the pipeline, app, and v1
 * fallback are injected fakes. No real instance or socket.
 */

const { createKeepaliveManager } = require("../../lib/domain/keepalive-manager");

function makeState(overrides = {}) {
  return {
    helloMessageSender: null,
    lastPacketTime: 0,
    readyToSend: true,
    pipeline: null,
    ...overrides
  };
}

function makeManager(overrides = {}) {
  const state = overrides.state || makeState();
  const app = {
    debug: jest.fn(),
    error: jest.fn(),
    getSelfPath: jest.fn(() => "123456789")
  };
  const packCrypt = jest.fn().mockResolvedValue(undefined);
  const deps = {
    state,
    options: {
      helloMessageSender: 10, // 10s interval
      udpAddress: "1.2.3.4",
      udpPort: 9000,
      secretKey: "k"
    },
    app,
    instanceId: "test",
    getV1Pipeline: () => ({ packCrypt }),
    ...overrides
  };
  const manager = createKeepaliveManager(deps);
  return { manager, state, app, packCrypt };
}

describe("domain/keepalive-manager", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("start() arms an interval tracked on state.helloMessageSender", () => {
    const { manager, state } = makeManager();
    manager.start();
    expect(state.helloMessageSender).not.toBeNull();
  });

  test("start() clears a prior interval so it cannot leak duplicates", () => {
    const { manager, state } = makeManager();
    manager.start();
    const first = state.helloMessageSender;
    manager.start();
    expect(state.helloMessageSender).not.toBe(first);
  });

  test("sends a v2 HELLO when the pipeline supports it and the link is idle", async () => {
    const sendHello = jest.fn().mockResolvedValue(undefined);
    const sendDelta = jest.fn().mockResolvedValue(undefined);
    const state = makeState({ pipeline: { sendHello, sendDelta }, lastPacketTime: 0 });
    const { manager } = makeManager({ state });

    manager.start();
    await jest.advanceTimersByTimeAsync(10000);

    expect(sendHello).toHaveBeenCalledWith("1.2.3.4", 9000);
    expect(sendDelta).not.toHaveBeenCalled();
  });

  test("falls back to the v1 empty-delta keepalive when no sendHello exists", async () => {
    const state = makeState({ pipeline: null, lastPacketTime: 0 });
    const { manager, packCrypt } = makeManager({ state });

    manager.start();
    await jest.advanceTimersByTimeAsync(10000);

    expect(packCrypt).toHaveBeenCalledTimes(1);
    const [deltas, secret, addr, port] = packCrypt.mock.calls[0];
    expect(deltas[0].context).toBe("vessels.urn:mrn:imo:mmsi:123456789");
    expect(secret).toBe("k");
    expect(addr).toBe("1.2.3.4");
    expect(port).toBe(9000);
  });

  test("skips the keepalive when not ready to send", async () => {
    const sendHello = jest.fn().mockResolvedValue(undefined);
    const state = makeState({ pipeline: { sendHello }, readyToSend: false });
    const { manager } = makeManager({ state });

    manager.start();
    await jest.advanceTimersByTimeAsync(10000);

    expect(sendHello).not.toHaveBeenCalled();
  });

  test("skips the keepalive while recent traffic is within the interval", async () => {
    const sendHello = jest.fn().mockResolvedValue(undefined);
    const state = makeState({ pipeline: { sendHello } });
    const { manager } = makeManager({ state });

    manager.start();
    // Halfway to the interval, record fresh traffic so that when the timer
    // fires at 10s the gap (5s) is still within the hello interval.
    await jest.advanceTimersByTimeAsync(5000);
    state.lastPacketTime = Date.now();
    await jest.advanceTimersByTimeAsync(5000);

    expect(sendHello).not.toHaveBeenCalled();
  });

  test("stop() clears the interval and nulls the handle", () => {
    const { manager, state } = makeManager();
    manager.start();
    manager.stop();
    expect(state.helloMessageSender).toBeNull();
  });
});
