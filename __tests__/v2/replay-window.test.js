"use strict";

const { ReplayWindow } = require("../../lib/transport/reliability/replay-window");

describe("ReplayWindow", () => {
  test("accepts the first sequence (establishes the baseline)", () => {
    const w = new ReplayWindow();
    expect(w.isEmpty).toBe(true);
    expect(w.accept(100)).toBe(true);
    expect(w.isEmpty).toBe(false);
  });

  test("accepts strictly increasing sequences", () => {
    const w = new ReplayWindow();
    expect(w.accept(1)).toBe(true);
    expect(w.accept(2)).toBe(true);
    expect(w.accept(3)).toBe(true);
  });

  test("rejects an exact replay of the high-water mark", () => {
    const w = new ReplayWindow();
    w.accept(5);
    expect(w.accept(5)).toBe(false);
  });

  test("accepts an in-window reorder once, then rejects its replay", () => {
    const w = new ReplayWindow();
    w.accept(10);
    w.accept(12); // gap at 11
    expect(w.accept(11)).toBe(true); // legitimate late arrival within the window
    expect(w.accept(11)).toBe(false); // replay of an already-accepted sequence
  });

  test("rejects sequences older than the window", () => {
    const w = new ReplayWindow(8);
    w.accept(100);
    expect(w.accept(92)).toBe(false); // exactly `size` behind → too old
    expect(w.accept(50)).toBe(false); // far too old
    expect(w.accept(95)).toBe(true); // within the window, unseen → accept
  });

  test("reset re-accepts a previously seen sequence (epoch change)", () => {
    const w = new ReplayWindow();
    w.accept(7);
    expect(w.accept(7)).toBe(false);
    w.reset();
    expect(w.isEmpty).toBe(true);
    expect(w.accept(7)).toBe(true);
  });

  test("handles uint32 serial-number wraparound", () => {
    const w = new ReplayWindow();
    expect(w.accept(0xfffffffe)).toBe(true);
    expect(w.accept(0xffffffff)).toBe(true);
    expect(w.accept(0)).toBe(true); // wraps forward past 2^32-1
    expect(w.accept(1)).toBe(true);
    expect(w.accept(0xffffffff)).toBe(false); // already seen within the wraparound window
  });

  test("bounds memory under sustained sequential advance and still catches replays", () => {
    const w = new ReplayWindow(64);
    for (let i = 0; i < 10000; i++) {
      expect(w.accept(i)).toBe(true);
    }
    expect(w.accept(9999)).toBe(false); // replay of the high-water mark
    expect(w.accept(9990)).toBe(false); // replay within the window
    expect(w.accept(1)).toBe(false); // far behind → too old
  });
});
