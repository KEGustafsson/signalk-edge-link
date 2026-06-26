"use strict";

/**
 * Tests for app/lifecycle – Connection lifecycle FSM
 *
 * Covers all valid state transitions, canSend(), forceStop(), and invalid
 * transition handling (thrown only under the test runner; logged and ignored
 * in every real deployment, including development).
 */

const { Lifecycle } = require("../../lib/app/lifecycle");

describe("Lifecycle FSM", () => {
  test("starts in Created state", () => {
    const lc = new Lifecycle();
    expect(lc.state).toBe("Created");
  });

  test("canSend() is false in initial Created state", () => {
    const lc = new Lifecycle();
    expect(lc.canSend()).toBe(false);
  });

  test("is() returns true for the current state", () => {
    const lc = new Lifecycle();
    expect(lc.is("Created")).toBe(true);
    expect(lc.is("Ready")).toBe(false);
  });

  test("isShuttingDown() is false initially", () => {
    const lc = new Lifecycle();
    expect(lc.isShuttingDown()).toBe(false);
  });

  // ── Valid happy-path: Created → Starting → Ready → Stopping → Stopped ──────

  test("Created → Starting is valid", () => {
    const lc = new Lifecycle();
    const ok = lc.transition("Starting");
    expect(ok).toBe(true);
    expect(lc.state).toBe("Starting");
  });

  test("Starting → Ready is valid", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    const ok = lc.transition("Ready");
    expect(ok).toBe(true);
    expect(lc.state).toBe("Ready");
  });

  test("canSend() is true only in Ready", () => {
    const lc = new Lifecycle();
    expect(lc.canSend()).toBe(false);
    lc.transition("Starting");
    expect(lc.canSend()).toBe(false);
    lc.transition("Ready");
    expect(lc.canSend()).toBe(true);
    lc.transition("Stopping");
    expect(lc.canSend()).toBe(false);
    lc.transition("Stopped");
    expect(lc.canSend()).toBe(false);
  });

  test("Ready → Stopping → Stopped is valid", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    lc.transition("Ready");
    expect(lc.transition("Stopping")).toBe(true);
    expect(lc.state).toBe("Stopping");
    expect(lc.transition("Stopped")).toBe(true);
    expect(lc.state).toBe("Stopped");
  });

  // ── Recovery cycle: Ready → Recovering → Ready ────────────────────────────

  test("Ready → Recovering → Ready is valid (socket recovery)", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    lc.transition("Ready");
    expect(lc.transition("Recovering")).toBe(true);
    expect(lc.state).toBe("Recovering");
    expect(lc.canSend()).toBe(false);
    expect(lc.transition("Ready")).toBe(true);
    expect(lc.canSend()).toBe(true);
  });

  test("Recovering → Stopping → Stopped is valid (stop during recovery)", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    lc.transition("Ready");
    lc.transition("Recovering");
    expect(lc.transition("Stopping")).toBe(true);
    expect(lc.transition("Stopped")).toBe(true);
    expect(lc.state).toBe("Stopped");
  });

  test("isShuttingDown() is true in Stopping and Stopped", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    lc.transition("Ready");
    lc.transition("Stopping");
    expect(lc.isShuttingDown()).toBe(true);
    lc.transition("Stopped");
    expect(lc.isShuttingDown()).toBe(true);
  });

  // ── Early-exit: start error path → Stopped ────────────────────────────────

  test("Starting → Stopped is valid (start error)", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    expect(lc.transition("Stopped")).toBe(true);
    expect(lc.state).toBe("Stopped");
  });

  // ── Restart: Stopped → Starting ───────────────────────────────────────────

  test("Stopped → Starting is valid (restart)", () => {
    const lc = new Lifecycle();
    lc.transition("Starting");
    lc.transition("Stopped");
    expect(lc.transition("Starting")).toBe(true);
    expect(lc.state).toBe("Starting");
  });

  // ── forceStop ────────────────────────────────────────────────────────────

  test("forceStop() from any state reaches Stopped", () => {
    for (const state of ["Created", "Starting", "Ready", "Recovering", "Stopping"]) {
      const lc = new Lifecycle();
      if (
        state === "Starting" ||
        state === "Ready" ||
        state === "Recovering" ||
        state === "Stopping"
      ) {
        lc.transition("Starting");
      }
      if (state === "Ready" || state === "Recovering" || state === "Stopping") {
        lc.transition("Ready");
      }
      if (state === "Recovering") {
        lc.transition("Recovering");
      }
      if (state === "Stopping") {
        lc.transition("Stopping");
      }
      lc.forceStop();
      expect(lc.state).toBe("Stopped");
    }
  });

  test("forceStop() is idempotent when already Stopped", () => {
    const lc = new Lifecycle();
    lc.forceStop();
    lc.forceStop();
    expect(lc.state).toBe("Stopped");
  });

  // ── Invalid transitions ───────────────────────────────────────────────────

  test("invalid transition returns false and invokes log callback in prod mode", () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const lc = new Lifecycle();
      const log = jest.fn();
      const ok = lc.transition("Ready", log); // Created → Ready is invalid
      expect(ok).toBe(false);
      expect(lc.state).toBe("Created"); // unchanged
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid transition"));
      expect(lc.invalidTransitionCount).toBe(1);
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test("invalid transition throws under the test runner (NODE_ENV=test)", () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const lc = new Lifecycle();
      expect(() => lc.transition("Ready")).toThrow("Invalid transition");
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test("invalid transition does NOT throw in development / unset NODE_ENV (field safety)", () => {
    const origEnv = process.env.NODE_ENV;
    for (const env of ["development", undefined]) {
      if (env === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = env;
      }
      try {
        const lc = new Lifecycle();
        const log = jest.fn();
        let ok;
        expect(() => {
          ok = lc.transition("Ready", log); // Created → Ready is invalid
        }).not.toThrow();
        expect(ok).toBe(false);
        expect(lc.state).toBe("Created");
        expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid transition"));
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    }
  });

  test("Ready → Created is invalid", () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const lc = new Lifecycle();
      lc.transition("Starting");
      lc.transition("Ready");
      const log = jest.fn();
      const ok = lc.transition("Created", log);
      expect(ok).toBe(false);
      expect(lc.state).toBe("Ready"); // unchanged
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test("Stopped → Ready is invalid (must go through Starting)", () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const lc = new Lifecycle();
      lc.transition("Starting");
      lc.transition("Stopped");
      const log = jest.fn();
      const ok = lc.transition("Ready", log);
      expect(ok).toBe(false);
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  // ── invalidTransitionCount ────────────────────────────────────────────────

  test("invalidTransitionCount increments on each invalid transition in prod", () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const lc = new Lifecycle();
      expect(lc.invalidTransitionCount).toBe(0);
      lc.transition("Ready", jest.fn()); // invalid: Created → Ready (counts 1)
      lc.transition("Stopped", jest.fn()); // valid: Created → Stopped (early-exit; count stays 1)
      lc.transition("Stopping", jest.fn()); // invalid: Stopped → Stopping (counts 2)
      expect(lc.invalidTransitionCount).toBe(2);
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});
