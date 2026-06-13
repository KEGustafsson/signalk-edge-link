"use strict";

/**
 * Regression test for commit e919d68 ("cascade FULL_STATUS_REQUEST down
 * multi-hop chain on server restart").
 *
 * The cascade is wired in src/index.ts: when a client-mode instance
 * receives FULL_STATUS_REQUEST from its upstream server, it should
 * forward the request to every server-mode instance co-located in the
 * same plugin process, which in turn re-emits FULL_STATUS_REQUEST to
 * each connected downstream client.
 *
 * This file pins three independent guarantees so a single refactor
 * can't silently break the chain:
 *
 *   1. createInstance exposes setFullStatusCascadeHandler /
 *      requestFullStatusFromAllClients on every instance regardless of
 *      mode (the wiring in index.ts is mode-agnostic by design — both
 *      ends are no-ops on the "wrong" mode, but must not throw).
 *   2. requestFullStatusFromAllClients delegates to
 *      state.pipelineServer.requestFullStatusFromAllClients when
 *      present (server-mode pipeline injected).
 *   3. The full 3-hop wiring (Cloud server ← Proxy client/server ←
 *      Boat client) propagates a cascade from one end of the chain to
 *      the other when index.ts-style orchestration is applied.
 */

jest.mock("ping-monitor", () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    stop: jest.fn()
  }))
);

const path = require("path");
const { createConnection: createInstance } = require("../lib/app/connection");

function makeMockApp() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    setPluginStatus: jest.fn(),
    setProviderStatus: jest.fn(),
    getSelfPath: jest.fn(() => "123456789"),
    handleMessage: jest.fn(),
    reportOutputMessages: jest.fn(),
    getDataDirPath: jest.fn(() =>
      path.join(
        process.cwd(),
        "__tests__",
        "temp",
        "cascade-" + Math.random().toString(36).slice(2)
      )
    ),
    subscriptionmanager: { subscribe: jest.fn() }
  };
}

function makeOptions(overrides = {}) {
  return {
    name: "test",
    serverType: "client",
    udpPort: 14600,
    secretKey: "6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536",
    protocolVersion: 1,
    udpAddress: "127.0.0.1",
    testAddress: "127.0.0.1",
    testPort: 80,
    pingIntervalTime: 1,
    helloMessageSender: 60,
    ...overrides
  };
}

describe("FULL_STATUS_REQUEST cascade — API surface (regression for e919d68)", () => {
  test("client-mode instance exposes setFullStatusCascadeHandler + requestFullStatusFromAllClients", () => {
    const inst = createInstance(makeMockApp(), makeOptions(), "client-id", "plugin", jest.fn());
    expect(typeof inst.setFullStatusCascadeHandler).toBe("function");
    expect(typeof inst.requestFullStatusFromAllClients).toBe("function");
    expect(() => inst.setFullStatusCascadeHandler(() => {})).not.toThrow();
    // No pipelineServer attached yet → call is a no-op, must not throw.
    expect(() => inst.requestFullStatusFromAllClients()).not.toThrow();
    inst.stop();
  });

  test("server-mode instance exposes both methods", () => {
    const inst = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "server", udpPort: 14601 }),
      "server-id",
      "plugin",
      jest.fn()
    );
    expect(typeof inst.setFullStatusCascadeHandler).toBe("function");
    expect(typeof inst.requestFullStatusFromAllClients).toBe("function");
    inst.stop();
  });
});

describe("requestFullStatusFromAllClients delegates to pipelineServer", () => {
  test("invokes state.pipelineServer.requestFullStatusFromAllClients when present", () => {
    const inst = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "server", udpPort: 14602 }),
      "server-id",
      "plugin",
      jest.fn()
    );
    const state = inst.getState();
    const requestSpy = jest.fn();
    state.pipelineServer = { requestFullStatusFromAllClients: requestSpy };
    inst.requestFullStatusFromAllClients();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    inst.stop();
  });

  test("is a safe no-op when pipelineServer is null", () => {
    const inst = createInstance(makeMockApp(), makeOptions(), "client-id", "plugin", jest.fn());
    const state = inst.getState();
    expect(state.pipelineServer).toBeNull();
    expect(() => inst.requestFullStatusFromAllClients()).not.toThrow();
    inst.stop();
  });
});

describe("3-hop chain orchestration (index.ts-style wiring)", () => {
  // Mimics what src/index.ts does after startup: every client-mode
  // instance's cascade handler iterates every server-mode instance and
  // invokes requestFullStatusFromAllClients on it. The test captures the
  // handler the wiring installs (rather than overwriting it) so the
  // assertion actually verifies that this orchestration is what runs.
  function captureCascadeHandler(inst) {
    let captured = null;
    const originalSet = inst.setFullStatusCascadeHandler.bind(inst);
    inst.setFullStatusCascadeHandler = (handler) => {
      captured = handler;
      return originalSet(handler);
    };
    return () => captured;
  }
  function wireCascadeForChain(instances) {
    const serverInsts = instances.filter((i) => i.isServerMode());
    const clientInsts = instances.filter((i) => !i.isServerMode());
    if (serverInsts.length === 0 || clientInsts.length === 0) {
      return;
    }
    for (const clientInst of clientInsts) {
      clientInst.setFullStatusCascadeHandler(() => {
        for (const serverInst of serverInsts) {
          serverInst.requestFullStatusFromAllClients();
        }
      });
    }
  }

  test("cascading from a proxy client fires the wired downstream server", () => {
    // Topology (process-local 3-hop proxy node):
    //   - clientUp: connects upstream (to Cloud)
    //   - serverDown: serves downstream (to Boats)
    // When upstream Cloud sends FULL_STATUS_REQUEST → clientUp receives →
    // wired cascade handler → serverDown.requestFullStatusFromAllClients().
    const clientUp = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "client", udpPort: 14700 }),
      "client-up",
      "plugin",
      jest.fn()
    );
    const serverDown = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "server", udpPort: 14701 }),
      "server-down",
      "plugin",
      jest.fn()
    );

    const downSpy = jest.fn();
    serverDown.getState().pipelineServer = { requestFullStatusFromAllClients: downSpy };

    const getHandler = captureCascadeHandler(clientUp);
    wireCascadeForChain([clientUp, serverDown]);

    const wiredHandler = getHandler();
    expect(typeof wiredHandler).toBe("function");
    wiredHandler();

    expect(downSpy).toHaveBeenCalledTimes(1);

    clientUp.stop();
    serverDown.stop();
  });

  test("multiple server instances all receive the cascade", () => {
    // A proxy that fronts two downstream networks simultaneously.
    const client = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "client", udpPort: 14710 }),
      "client",
      "plugin",
      jest.fn()
    );
    const serverA = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "server", udpPort: 14711 }),
      "server-a",
      "plugin",
      jest.fn()
    );
    const serverB = createInstance(
      makeMockApp(),
      makeOptions({ serverType: "server", udpPort: 14712 }),
      "server-b",
      "plugin",
      jest.fn()
    );
    const spyA = jest.fn();
    const spyB = jest.fn();
    serverA.getState().pipelineServer = { requestFullStatusFromAllClients: spyA };
    serverB.getState().pipelineServer = { requestFullStatusFromAllClients: spyB };

    const getHandler = captureCascadeHandler(client);
    wireCascadeForChain([client, serverA, serverB]);

    const wiredHandler = getHandler();
    expect(typeof wiredHandler).toBe("function");
    wiredHandler();

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);

    client.stop();
    serverA.stop();
    serverB.stop();
  });
});
