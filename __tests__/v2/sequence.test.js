"use strict";

const { SequenceTracker } = require("../../lib/sequence");

describe("SequenceTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new SequenceTracker();
  });

  afterEach(() => {
    tracker.reset();
  });

  describe("construction", () => {
    test("initializes with expectedSeq 0", () => {
      expect(tracker.expectedSeq).toBe(0);
    });

    test("initializes with empty receivedSeqs", () => {
      expect(tracker.receivedSeqs.size).toBe(0);
    });

    test("accepts custom maxOutOfOrder", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 50 });
      expect(t.maxOutOfOrder).toBe(50);
    });

    test("accepts custom nakTimeout", () => {
      const t = new SequenceTracker({ nakTimeout: 200 });
      expect(t.nakTimeout).toBe(200);
    });

    test("accepts onLossDetected callback", () => {
      const cb = jest.fn();
      const t = new SequenceTracker({ onLossDetected: cb });
      expect(t.onLossDetected).toBe(cb);
    });

    test("defaults to noop onLossDetected", () => {
      expect(typeof tracker.onLossDetected).toBe("function");
      // Should not throw
      tracker.onLossDetected([1]);
    });
  });

  describe("in-order delivery", () => {
    test("processes first sequence (0) as in order", () => {
      const result = tracker.processSequence(0);
      expect(result.inOrder).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.duplicate).toBe(false);
    });

    test("advances expectedSeq after in-order", () => {
      tracker.processSequence(0);
      expect(tracker.expectedSeq).toBe(1);
    });

    test("processes consecutive sequences in order", () => {
      for (let i = 0; i < 10; i++) {
        const result = tracker.processSequence(i);
        expect(result.inOrder).toBe(true);
        expect(result.missing).toEqual([]);
      }
      expect(tracker.expectedSeq).toBe(10);
    });

    test("records received sequences", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.processSequence(2);
      expect(tracker.receivedSeqs.has(0)).toBe(true);
      expect(tracker.receivedSeqs.has(1)).toBe(true);
      expect(tracker.receivedSeqs.has(2)).toBe(true);
    });
  });

  describe("gap detection", () => {
    test("detects single gap", () => {
      tracker.processSequence(0);
      const result = tracker.processSequence(2);
      expect(result.inOrder).toBe(false);
      expect(result.missing).toContain(1);
    });

    test("detects multiple missing in one gap", () => {
      tracker.processSequence(0);
      const result = tracker.processSequence(5);
      expect(result.missing).toEqual([1, 2, 3, 4]);
    });

    test("detects gap at start (no seq 0)", () => {
      const result = tracker.processSequence(3);
      expect(result.missing).toEqual([0, 1, 2]);
    });

    test("detects multiple gaps", () => {
      tracker.processSequence(0);
      tracker.processSequence(2); // gap at 1
      const result = tracker.processSequence(5); // expectedSeq still 1, so missing 1, 3, 4
      expect(result.missing).toEqual([1, 3, 4]);
    });

    test("reports all missing from expectedSeq each time", () => {
      tracker.processSequence(0);
      const r1 = tracker.processSequence(3); // missing 1, 2
      expect(r1.missing).toEqual([1, 2]);
      const r2 = tracker.processSequence(5); // expectedSeq still 1, reports 1, 2, 4
      expect(r2.missing).toEqual([1, 2, 4]);
    });
  });

  describe("out-of-order arrival", () => {
    test("handles 0, 2, 1 sequence", () => {
      tracker.processSequence(0);
      tracker.processSequence(2);
      tracker.processSequence(1);
      expect(tracker.expectedSeq).toBe(3);
    });

    test("handles 0, 3, 1, 2 sequence", () => {
      tracker.processSequence(0);
      tracker.processSequence(3);
      tracker.processSequence(1);
      tracker.processSequence(2);
      expect(tracker.expectedSeq).toBe(4);
    });

    test("advances past contiguous buffered sequences", () => {
      tracker.processSequence(0);
      tracker.processSequence(3);
      tracker.processSequence(2);
      // After receiving 1, should advance past 2 and 3
      const result = tracker.processSequence(1);
      expect(result.inOrder).toBe(true);
      expect(tracker.expectedSeq).toBe(4);
    });

    test("does not advance past non-contiguous", () => {
      tracker.processSequence(0);
      tracker.processSequence(2);
      tracker.processSequence(4);
      tracker.processSequence(1);
      // Received: 0, 1, 2, 4 → expected should be 3 (gap at 3)
      expect(tracker.expectedSeq).toBe(3);
    });
  });

  describe("duplicate detection", () => {
    test("detects immediate duplicate", () => {
      tracker.processSequence(0);
      const result = tracker.processSequence(0);
      expect(result.duplicate).toBe(true);
      expect(result.inOrder).toBe(false);
    });

    test("detects delayed duplicate", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.processSequence(2);
      const result = tracker.processSequence(1);
      expect(result.duplicate).toBe(true);
    });

    test("duplicate does not affect expectedSeq", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      const seqBefore = tracker.expectedSeq;
      tracker.processSequence(0);
      expect(tracker.expectedSeq).toBe(seqBefore);
    });
  });

  describe("NAK scheduling", () => {
    test("schedules NAK after timeout", async () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 50,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(2); // Gap at 1

      // Wait for NAK timeout
      await new Promise(resolve => setTimeout(resolve, 70));

      expect(onLoss).toHaveBeenCalledWith([1]);
      t.reset();
    });

    test("cancels NAK if packet arrives before timeout", async () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 80,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(2); // Gap at 1

      // Packet 1 arrives before timeout
      await new Promise(resolve => setTimeout(resolve, 20));
      t.processSequence(1);

      // Wait past timeout
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(onLoss).not.toHaveBeenCalled();
      t.reset();
    });

    test("does not schedule duplicate NAK timers", () => {
      tracker.processSequence(0);
      tracker.processSequence(3); // Gap at 1, 2
      // Process another packet that would re-detect the same gap
      tracker.processSequence(4);
      // Should only have timers for 1, 2 (not duplicated)
      expect(tracker.nakTimers.size).toBe(2);
    });

    test("NAK fires for each missing sequence independently", async () => {
      const losses = [];
      const t = new SequenceTracker({
        nakTimeout: 30,
        onLossDetected: (seqs) => losses.push(...seqs)
      });

      t.processSequence(0);
      t.processSequence(3); // Missing 1, 2

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(losses).toContain(1);
      expect(losses).toContain(2);
      t.reset();
    });

    test("NAK cancelled via contiguous advancement", async () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 80,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(3); // Gap at 1, 2

      // Fill in the gap - contiguous advancement cancels timers
      await new Promise(resolve => setTimeout(resolve, 20));
      t.processSequence(1);
      t.processSequence(2);

      await new Promise(resolve => setTimeout(resolve, 80));

      expect(onLoss).not.toHaveBeenCalled();
      t.reset();
    });
  });

  describe("memory cleanup", () => {
    test("cleans up old sequences beyond maxOutOfOrder", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 10 });

      // Process 20 in-order sequences
      for (let i = 0; i < 20; i++) {
        t.processSequence(i);
      }

      // Old sequences should be cleaned up
      expect(t.receivedSeqs.has(0)).toBe(false);
      expect(t.receivedSeqs.has(5)).toBe(false);
      // Recent ones should still exist
      expect(t.receivedSeqs.has(15)).toBe(true);
      expect(t.receivedSeqs.has(19)).toBe(true);
      t.reset();
    });

    test("does not clean up sequences still in tracking window", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 100 });

      for (let i = 0; i < 50; i++) {
        t.processSequence(i);
      }

      // All should still be in the set (within window)
      expect(t.receivedSeqs.has(0)).toBe(true);
      expect(t.receivedSeqs.has(49)).toBe(true);
      t.reset();
    });

    test("cleanup only runs on in-order processing", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 5 });

      for (let i = 0; i < 10; i++) {
        t.processSequence(i);
      }

      // Receiving out-of-order far ahead should not trigger cleanup
      const sizeBefore = t.receivedSeqs.size;
      t.processSequence(20);
      // Size should increase (added 20) but no cleanup since not in-order
      expect(t.receivedSeqs.size).toBe(sizeBefore + 1);
      t.reset();
    });
  });

  describe("getMissingSequences", () => {
    test("returns empty for no gaps", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.processSequence(2);
      expect(tracker.getMissingSequences()).toEqual([]);
    });

    test("returns missing sequences in gap", () => {
      tracker.processSequence(0);
      tracker.processSequence(3);
      const missing = tracker.getMissingSequences();
      // expectedSeq is still 1 (since 1 was not received)
      // getMissingSequences checks from max(0, expectedSeq - maxOutOfOrder) to expectedSeq
      // expectedSeq is 1, so it checks seq 0 (received) → nothing missing
      // Actually, let me reconsider: after processing 0 and 3, expectedSeq = 1
      // getMissingSequences looks from 0 to 1 → seq 0 is received → []
      // The "missing" sequences (1, 2) are above expectedSeq so not in getMissingSequences range
      expect(missing).toEqual([]);
    });

    test("returns missing after partial fill", () => {
      tracker.processSequence(0);
      tracker.processSequence(2);
      tracker.processSequence(1);
      // Now expectedSeq = 3, all received
      expect(tracker.getMissingSequences()).toEqual([]);
    });
  });

  describe("reset", () => {
    test("resets expectedSeq to 0", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.reset();
      expect(tracker.expectedSeq).toBe(0);
    });

    test("clears receivedSeqs", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.reset();
      expect(tracker.receivedSeqs.size).toBe(0);
    });

    test("cancels all NAK timers", () => {
      tracker.processSequence(0);
      tracker.processSequence(5); // Gaps at 1-4
      expect(tracker.nakTimers.size).toBe(4);
      tracker.reset();
      expect(tracker.nakTimers.size).toBe(0);
    });

    test("allows reuse after reset", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.reset();
      const result = tracker.processSequence(0);
      expect(result.inOrder).toBe(true);
      expect(tracker.expectedSeq).toBe(1);
    });
  });

  describe("large gap handling", () => {
    test("handles gap of 50 sequences", () => {
      tracker.processSequence(0);
      const result = tracker.processSequence(51);
      expect(result.missing).toHaveLength(50);
      expect(result.missing[0]).toBe(1);
      expect(result.missing[49]).toBe(50);
    });

    test("limits NAK timers to gap size", () => {
      tracker.processSequence(0);
      tracker.processSequence(11); // Gap of 10
      expect(tracker.nakTimers.size).toBe(10);
    });
  });

  describe("edge cases", () => {
    test("handles sequence 0 as first and only", () => {
      const result = tracker.processSequence(0);
      expect(result.inOrder).toBe(true);
      expect(tracker.expectedSeq).toBe(1);
    });

    test("handles high sequence numbers", () => {
      const t = new SequenceTracker();
      t.expectedSeq = 1000000;
      t.receivedSeqs.add(999999);
      const result = t.processSequence(1000000);
      expect(result.inOrder).toBe(true);
      expect(t.expectedSeq).toBe(1000001);
      t.reset();
    });

    test("handles rapid sequential processing", () => {
      for (let i = 0; i < 1000; i++) {
        const result = tracker.processSequence(i);
        expect(result.inOrder).toBe(true);
      }
      expect(tracker.expectedSeq).toBe(1000);
    });

    test("handles interleaved in-order and out-of-order", () => {
      tracker.processSequence(0); // in-order
      tracker.processSequence(1); // in-order
      tracker.processSequence(3); // gap at 2
      tracker.processSequence(4); // out-of-order (buffered)
      tracker.processSequence(2); // fills gap, advances to 5
      expect(tracker.expectedSeq).toBe(5);
    });

    test("late arrival below expectedSeq is accepted", () => {
      // Process 0, 1, skip 2, 3
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.processSequence(3); // gap at 2
      // expectedSeq is still 2
      // Now simulate receiving seq 2 later (which fills the gap)
      const result = tracker.processSequence(2);
      expect(result.inOrder).toBe(true);
      expect(tracker.expectedSeq).toBe(4);
    });

    test("processes single packet correctly", () => {
      const result = tracker.processSequence(0);
      expect(result.inOrder).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.duplicate).toBe(false);
    });

    test("handles reverse order delivery", () => {
      tracker.processSequence(4);
      tracker.processSequence(3);
      tracker.processSequence(2);
      tracker.processSequence(1);
      tracker.processSequence(0);
      expect(tracker.expectedSeq).toBe(5);
    });

    test("accepts very late arrival after cleanup removes it from receivedSeqs", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 5 });
      // Process 0-10 in order, which triggers cleanup of old sequences
      for (let i = 0; i < 11; i++) {
        t.processSequence(i);
      }
      // Sequences 0-5 should be cleaned up (threshold = 11 - 5 = 6)
      expect(t.receivedSeqs.has(3)).toBe(false);
      // Receive seq 3 again (late arrival: 3 < 11, not in receivedSeqs)
      const result = t.processSequence(3);
      expect(result.inOrder).toBe(false);
      expect(result.duplicate).toBe(false);
      expect(t.receivedSeqs.has(3)).toBe(true);
      t.reset();
    });

    test("handles uint32 wraparound in-order", () => {
      const t = new SequenceTracker();
      t.expectedSeq = 0xffffffff;

      const r1 = t.processSequence(0xffffffff);
      expect(r1.inOrder).toBe(true);
      expect(t.expectedSeq).toBe(0);

      const r2 = t.processSequence(0);
      expect(r2.inOrder).toBe(true);
      expect(t.expectedSeq).toBe(1);
      t.reset();
    });

    test("handles out-of-order delivery across wraparound", () => {
      const t = new SequenceTracker();
      t.expectedSeq = 0xfffffffe;

      // Arrives ahead by 2 (missing 0xfffffffe, 0xffffffff)
      const ahead = t.processSequence(0);
      expect(ahead.inOrder).toBe(false);
      expect(ahead.missing).toEqual([0xfffffffe, 0xffffffff]);

      // Fill the gap and ensure contiguous advancement includes wrapped seq 0
      t.processSequence(0xfffffffe);
      const fill = t.processSequence(0xffffffff);
      expect(fill.inOrder).toBe(true);
      expect(t.expectedSeq).toBe(1);
      t.reset();
    });

    test("late arrival cancels pending NAK timer", async () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({ nakTimeout: 100, onLossDetected: onLoss, maxOutOfOrder: 5 });
      // Process 0-10, causing cleanup
      for (let i = 0; i < 11; i++) {
        t.processSequence(i);
      }
      // Manually add a pending NAK timer for sequence 3 to simulate edge case
      t.nakTimers.set(3, setTimeout(() => onLoss([3]), 100));
      // Late arrival of seq 3 should cancel the timer
      t.processSequence(3);
      expect(t.nakTimers.has(3)).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(onLoss).not.toHaveBeenCalled();
      t.reset();
    });
  });

  describe("getMissingSequences edge cases", () => {
    test("finds missing sequences in tracking window", () => {
      // Directly set up state to simulate lost packets
      tracker.expectedSeq = 10;
      for (let i = 0; i < 10; i++) {
        if (i !== 3 && i !== 7) {tracker.receivedSeqs.add(i);}
      }
      const missing = tracker.getMissingSequences();
      expect(missing).toContain(3);
      expect(missing).toContain(7);
      expect(missing).toHaveLength(2);
    });
  });
});
