"use strict";

/**
 * Connection lifecycle FSM (L4 application layer).
 *
 * Replaces the boolean soup (stopped, readyToSend, socketRecoveryInProgress,
 * subscribing) from the old God Object with one explicit state machine. A
 * single canSend() predicate derives from state; illegal transitions are logged
 * in production and throw in dev.
 *
 * States: Created → Starting → Ready ⇄ Recovering → Stopping → Stopped
 *
 * @module app/lifecycle
 */

/** Discriminated union of all valid connection lifecycle states. */
export type LifecycleState =
  | "Created"
  | "Starting"
  | "Ready"
  | "Recovering"
  | "Stopping"
  | "Stopped";

const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  Created: ["Starting", "Stopped"],
  Starting: ["Ready", "Stopped"],
  Ready: ["Recovering", "Stopping", "Stopped"],
  Recovering: ["Ready", "Stopping", "Stopped"],
  Stopping: ["Stopped"],
  Stopped: ["Starting"]
};

/**
 * Finite state machine that tracks the lifecycle of a single connection.
 *
 * States: Created → Starting → Ready ⇄ Recovering → Stopping → Stopped
 */
export class Lifecycle {
  private _state: LifecycleState = "Created";
  private _invalidCount = 0;

  /** Current lifecycle state. */
  get state(): LifecycleState {
    return this._state;
  }

  /** True only in Ready — the single gate for outbound delta sends. */
  canSend(): boolean {
    return this._state === "Ready";
  }

  /** Returns true when the current state matches `s`. */
  is(s: LifecycleState): boolean {
    return this._state === s;
  }

  /** True for any terminal or winding-down state. */
  isShuttingDown(): boolean {
    return this._state === "Stopping" || this._state === "Stopped";
  }

  /** Attempt a transition; returns true on success. Logs or throws on invalid. */
  transition(next: LifecycleState, log?: (msg: string) => void): boolean {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      const msg = `[lifecycle] Invalid transition ${this._state} → ${next} (invalid#${++this._invalidCount})`;
      if (typeof log === "function") {
        log(msg);
      }
      if (process.env.NODE_ENV !== "production") {
        throw new Error(msg);
      }
      return false;
    }
    this._state = next;
    return true;
  }

  /** Force any state → Stopped (safe regardless of current state; no-op if already stopped). */
  forceStop(): void {
    this._state = "Stopped";
  }

  /** Number of invalid transition attempts since construction. */
  get invalidTransitionCount(): number {
    return this._invalidCount;
  }
}
