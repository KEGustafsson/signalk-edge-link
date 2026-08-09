"use strict";

/**
 * Regression coverage for value-dedup cache divergence.
 *
 * A sentinel means "the value you already have". If the sender's cache and the
 * receiver's cache ever disagree, the receiver injects a stale value and keeps
 * injecting it, because the sender has no reason to send an absolute again.
 * These tests cover the ways they used to diverge.
 */

const {
  createValueDedupState,
  resetValueDedupState,
  dedupDelta,
  undedupDelta,
  isDupSentinel
} = require("../lib/value-dedup");

const { RetransmitQueue } = require("../lib/retransmit-queue");

function delta(path, value) {
  return {
    context: "vessels.self",
    updates: [{ values: [{ path, value }] }]
  };
}

function firstValue(d) {
  return d.updates[0].values[0].value;
}

describe("value dedup: sender/receiver cache agreement", () => {
  test("a sentinel for a path the receiver never saw is dropped, not injected raw", () => {
    const receiver = createValueDedupState();
    const out = undedupDelta(delta("navigation.state", { $$: "dup" }), receiver);
    expect(out.updates[0].values).toEqual([]);
  });

  test("resetValueDedupState makes the next send absolute again", () => {
    const sender = createValueDedupState();

    expect(
      isDupSentinel(firstValue(dedupDelta(delta("navigation.state", "sailing"), sender)))
    ).toBe(false);
    // Unchanged → sentinel.
    expect(
      isDupSentinel(firstValue(dedupDelta(delta("navigation.state", "sailing"), sender)))
    ).toBe(true);

    resetValueDedupState(sender);

    // Baseline dropped → absolute again.
    const afterReset = dedupDelta(delta("navigation.state", "sailing"), sender);
    expect(isDupSentinel(firstValue(afterReset))).toBe(false);
    expect(firstValue(afterReset)).toBe("sailing");
  });

  test("an unacknowledged queue drop resyncs the sender so a lost packet cannot strand a stale value", () => {
    const sender = createValueDedupState();
    const queue = new RetransmitQueue({
      maxSize: 2,
      maxRetransmits: 1,
      onPacketDropped: () => resetValueDedupState(sender)
    });

    // Establish a baseline and confirm it dedups.
    dedupDelta(delta("navigation.state", "sailing"), sender);
    expect(
      isDupSentinel(firstValue(dedupDelta(delta("navigation.state", "sailing"), sender)))
    ).toBe(true);

    // Fill past capacity so the oldest entry is evicted without being ACKed.
    queue.add(1, Buffer.from("a"));
    queue.add(2, Buffer.from("b"));
    queue.add(3, Buffer.from("c"));

    // The eviction resynced the sender: the value is sent absolutely again.
    expect(
      isDupSentinel(firstValue(dedupDelta(delta("navigation.state", "sailing"), sender)))
    ).toBe(false);
  });

  test("abandoning a packet after maxRetransmits also resyncs", () => {
    const dropped = [];
    const queue = new RetransmitQueue({
      maxRetransmits: 1,
      onPacketDropped: (seq, reason) => dropped.push([seq, reason])
    });

    queue.add(7, Buffer.from("payload"));
    queue.retransmit([7]); // attempt 1
    queue.retransmit([7]); // exhausted → abandoned

    expect(dropped).toEqual([[7, "abandoned"]]);
  });

  test("acknowledged removals do not resync", () => {
    const dropped = [];
    const queue = new RetransmitQueue({
      onPacketDropped: (seq, reason) => dropped.push([seq, reason])
    });

    queue.add(1, Buffer.from("a"));
    queue.add(2, Buffer.from("b"));
    queue.acknowledge(2);

    expect(queue.getSize()).toBe(0);
    expect(dropped).toEqual([]);
  });

  test("a listener that throws cannot corrupt queue bookkeeping", () => {
    const queue = new RetransmitQueue({
      maxSize: 1,
      onPacketDropped: () => {
        throw new Error("observer blew up");
      }
    });

    expect(() => {
      queue.add(1, Buffer.from("a"));
      queue.add(2, Buffer.from("b"));
    }).not.toThrow();
    expect(queue.getSize()).toBe(1);
  });
});

describe("value dedup: reordered packets cannot roll the receive cache backwards", () => {
  test("an older absolute is delivered but does not overwrite a newer cached value", () => {
    const receiver = createValueDedupState();

    // seq 10 carries the newer value and arrives first.
    const newer = undedupDelta(delta("navigation.state", "motoring"), receiver, 10);
    expect(firstValue(newer)).toBe("motoring");

    // seq 9 is the older packet, reordered by the network. It is still
    // delivered — the receiver does not silently swallow data — but it must not
    // become the baseline, or the next sentinel expands to it.
    const older = undedupDelta(delta("navigation.state", "sailing"), receiver, 9);
    expect(firstValue(older)).toBe("sailing");

    // The sender's view is "motoring"; a sentinel must expand to that.
    const sentinel = undedupDelta(delta("navigation.state", { $$: "dup" }), receiver, 11);
    expect(firstValue(sentinel)).toBe("motoring");
  });

  test("sequence wraparound does not discard a freshly-wrapped absolute", () => {
    const receiver = createValueDedupState();

    undedupDelta(delta("navigation.state", "old"), receiver, 0xfffffffe);
    // Wraps past 2^32 — numerically smaller, but newer in serial space.
    undedupDelta(delta("navigation.state", "new"), receiver, 2);

    const sentinel = undedupDelta(delta("navigation.state", { $$: "dup" }), receiver, 3);
    expect(firstValue(sentinel)).toBe("new");
  });

  test("without a sequence the cache behaves as before (arrival order wins)", () => {
    const receiver = createValueDedupState();
    undedupDelta(delta("navigation.state", "first"), receiver);
    undedupDelta(delta("navigation.state", "second"), receiver);
    const sentinel = undedupDelta(delta("navigation.state", { $$: "dup" }), receiver);
    expect(firstValue(sentinel)).toBe("second");
  });
});
