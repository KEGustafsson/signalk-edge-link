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
    test("initializes with expectedSeq null until first packet", () => {
      expect(tracker.expectedSeq).toBe(null);
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
      expect(result.inOrder).toBe(true);
      expect(result.missing).toEqual([]);
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
    // Fake timers throughout: these assertions used real sleeps with ~20ms
    // margins against 30-80ms timeouts, so an event-loop stall flipped them.
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test("schedules NAK after timeout", () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 50,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(2); // Gap at 1

      // Fake timers: a real 70ms sleep against a 50ms timeout leaves only a
      // ~20ms margin, so an event-loop stall flips the result.
      jest.advanceTimersByTime(70);
      jest.advanceTimersByTime(1); // next-tick coalescing flush

      expect(onLoss).toHaveBeenCalledWith([1]);
      t.reset();
    });

    test("cancels NAK if packet arrives before timeout", () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 80,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(2); // Gap at 1

      // Packet 1 arrives before timeout
      jest.advanceTimersByTime(20);
      t.processSequence(1);

      // Advance well past the timeout: nothing should fire.
      jest.advanceTimersByTime(200);

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

    test("NAK fires for each missing sequence independently", () => {
      const losses = [];
      const t = new SequenceTracker({
        nakTimeout: 30,
        onLossDetected: (seqs) => losses.push(...seqs)
      });

      t.processSequence(0);
      t.processSequence(3); // Missing 1, 2

      jest.advanceTimersByTime(50);

      expect(losses).toContain(1);
      expect(losses).toContain(2);
      t.reset();
    });

    test("coalesces a multi-sequence gap into a single batched NAK callback", () => {
      jest.useFakeTimers();
      const calls = [];
      const t = new SequenceTracker({
        nakTimeout: 30,
        onLossDetected: (seqs) => calls.push(seqs.slice())
      });
      try {
        t.processSequence(0);
        t.processSequence(6); // Missing 1,2,3,4,5

        // Advance past the nakTimeout and run the follow-up setTimeout(…, 0) flush.
        jest.advanceTimersByTime(30);
        jest.runOnlyPendingTimers();

        // One batched call rather than five separate ones.
        expect(calls.length).toBe(1);
        expect(calls[0].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        t.reset();
        jest.useRealTimers();
      }
    });

    test("NAK cancelled via contiguous advancement", () => {
      const onLoss = jest.fn();
      const t = new SequenceTracker({
        nakTimeout: 80,
        onLossDetected: onLoss
      });

      t.processSequence(0);
      t.processSequence(3); // Gap at 1, 2

      // Fill in the gap - contiguous advancement cancels timers
      jest.advanceTimersByTime(20);
      t.processSequence(1);
      t.processSequence(2);

      jest.advanceTimersByTime(200);

      expect(onLoss).not.toHaveBeenCalled();
      t.reset();
    });

    test("reset clears NAK timers scheduled by a near-limit gap", () => {
      jest.useFakeTimers();
      try {
        const onLoss = jest.fn();
        const t = new SequenceTracker({
          maxGapTracking: 6,
          nakTimeout: 50,
          onLossDetected: onLoss
        });

        t.processSequence(0);
        const result = t.processSequence(6);

        expect(result.missing).toEqual([1, 2, 3, 4, 5]);
        expect(t.nakTimers.size).toBe(5);

        t.reset();
        jest.advanceTimersByTime(60);

        expect(t.nakTimers.size).toBe(0);
        expect(onLoss).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
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
      // After processSequence(0): expectedSeq=1, receivedSeqs={0}
      // After processSequence(3): gap detected for 1,2; expectedSeq stays 1, receivedSeqs={0,3}
      // Forward window: furthestAhead = distanceForward(1, 3) = 2
      // Checks seqs 1 (missing) and 2 (missing) → [1, 2]
      expect(missing).toContain(1);
      expect(missing).toContain(2);
      expect(missing).toHaveLength(2);
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
    test("resets expectedSeq to null", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      tracker.reset();
      expect(tracker.expectedSeq).toBe(null);
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

    test("late arrival cancels pending NAK timer", () => {
      jest.useFakeTimers();
      const onLoss = jest.fn();
      const t = new SequenceTracker({ nakTimeout: 100, onLossDetected: onLoss, maxOutOfOrder: 5 });
      // Process 0-10, causing cleanup
      for (let i = 0; i < 11; i++) {
        t.processSequence(i);
      }
      // Manually add a pending NAK timer for sequence 3 to simulate edge case
      t.nakTimers.set(
        3,
        setTimeout(() => onLoss([3]), 100)
      );
      // Late arrival of seq 3 should cancel the timer
      t.processSequence(3);
      expect(t.nakTimers.has(3)).toBe(false);
      jest.advanceTimersByTime(200);
      expect(onLoss).not.toHaveBeenCalled();
      t.reset();
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test("resyncs on excessive ahead gap to avoid timer explosion", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 10, maxGapTracking: 20 });
      t.processSequence(0);

      const result = t.processSequence(1000);
      expect(result.inOrder).toBe(true);
      expect(result.resynced).toBe(true);
      expect(t.expectedSeq).toBe(1001);
      expect(t.nakTimers.size).toBe(0);
      t.reset();
    });

    test("resyncs on excessive behind distance after sender restart", () => {
      const t = new SequenceTracker({ maxOutOfOrder: 10, behindResyncThreshold: 50 });
      t.processSequence(1000);

      const result = t.processSequence(10);
      expect(result.inOrder).toBe(true);
      expect(result.resynced).toBe(true);
      expect(t.expectedSeq).toBe(11);
      t.reset();
    });

    test("duplicate arrival after a gap does not advance expected sequence", () => {
      tracker.processSequence(0);
      tracker.processSequence(3);

      const duplicate = tracker.processSequence(3);

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.inOrder).toBe(false);
      expect(tracker.expectedSeq).toBe(1);
      expect(tracker.nakTimers.size).toBe(2);
    });
  });

  describe("getMissingSequences edge cases", () => {
    test("finds forward-gap sequences in tracking window", () => {
      // Simulate a gap where seqs 3 and 7 are missing but later seqs were buffered.
      // expectedSeq=3 means we received 0,1,2 in-order and are waiting for 3.
      // Buffered ahead: 4,5,6,8,9 received but 3 and 7 are missing.
      tracker.expectedSeq = 3;
      for (let i = 4; i <= 9; i++) {
        if (i !== 7) {
          tracker.receivedSeqs.add(i);
        }
      }
      const missing = tracker.getMissingSequences();
      // Forward window: furthestAhead = distanceForward(3, 9) = 6
      // Checks seqs 3,4,5,6,7,8 → 3 (missing) and 7 (missing)
      expect(missing).toContain(3);
      expect(missing).toContain(7);
      expect(missing).toHaveLength(2);
    });

    test("returns empty when no sequences are buffered ahead", () => {
      tracker.processSequence(0);
      tracker.processSequence(1);
      // expectedSeq=2, no buffered-ahead sequences → no forward gaps
      expect(tracker.getMissingSequences()).toEqual([]);
    });
  });

  describe("permanently lost sequences", () => {
    test("advances past a gap the sender never fills, instead of stalling", () => {
      jest.useFakeTimers();
      try {
        const abandoned = [];
        const nakRounds = [];
        const t = new SequenceTracker({
          nakTimeout: 50,
          maxNakRounds: 3,
          onLossDetected: (seqs) => nakRounds.push(seqs),
          onGapAbandoned: (seq) => abandoned.push(seq)
        });

        t.processSequence(100);
        // 101 is lost forever; the sender has exhausted its retransmit budget.
        t.processSequence(102);
        expect(t.expectedSeq).toBe(101);

        // Each NAK round re-arms; after maxNakRounds the gap is given up on.
        jest.advanceTimersByTime(50 * 5);

        // maxNakRounds means exactly that many NAKs reach the sender. The
        // abandon check counts the round it is about to emit, so an off-by-one
        // here silently spends the last round on the give-up instead of on a
        // retransmit request.
        expect(nakRounds).toEqual([[101], [101], [101]]);
        expect(abandoned).toEqual([101]);
        expect(t.abandonedCount).toBe(1);
        // Window must move past the hole so the cumulative ACK is not frozen.
        expect(t.expectedSeq).toBe(103);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    test("does not abandon a gap that the sender fills in time", () => {
      jest.useFakeTimers();
      try {
        const abandoned = [];
        const t = new SequenceTracker({
          nakTimeout: 50,
          maxNakRounds: 3,
          onGapAbandoned: (seq) => abandoned.push(seq)
        });

        t.processSequence(100);
        t.processSequence(102);
        jest.advanceTimersByTime(50);

        // Retransmission arrives before the rounds are exhausted.
        t.processSequence(101);
        jest.advanceTimersByTime(50 * 5);

        expect(abandoned).toEqual([]);
        expect(t.expectedSeq).toBe(103);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    // The retry counter is keyed per sequence and had no reader other than the
    // abandon path, so every successfully-retransmitted packet left an entry
    // behind: unbounded growth for the life of the session on a lossy link.
    test("does not retain NAK retry state for sequences that arrive", () => {
      jest.useFakeTimers();
      try {
        const t = new SequenceTracker({ nakTimeout: 50, maxNakRounds: 5 });
        const attempts = t._nakAttempts ?? t["_nakAttempts"];

        let seq = 200;
        for (let i = 0; i < 50; i++) {
          t.processSequence(seq); // in order
          t.processSequence(seq + 2); // opens a gap at seq+1
          jest.advanceTimersByTime(50); // one NAK round for seq+1
          t.processSequence(seq + 1); // retransmit lands
          seq += 3;
        }
        jest.advanceTimersByTime(50 * 10);

        expect(t.expectedSeq).toBe(seq);
        expect(attempts.size).toBe(0);
        expect(t.nakTimers.size).toBe(0);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    // Abandonment is not free: the sender's retransmit budget (maxRetransmits,
    // default 10) outlives the receiver's NAK budget (maxNakRounds, default 5),
    // so a packet can still arrive after the window moved past it. It must be
    // reported as already-accounted-for rather than as new data — re-injecting
    // it would push a stale delta into Signal K long after the fact.
    //
    // This is deliberate, but it makes give-up timing observable as data loss,
    // which is what made the e2e ARQ delivery test machine-speed dependent.
    // maxNakRounds was hard-coded to the tracker's own default, so a user who
    // raised maxRetransmits got a receiver that still gave up after 5 rounds —
    // abandoning the gap while the sender still had budget to answer it. The
    // configured value has to reach the tracker for the two budgets to be
    // tunable against each other at all.
    test("the configured maxNakRounds reaches the server's sequence tracker", async () => {
      const createMetrics = require("../../lib/metrics");
      const { createPipeline } = require("../../lib/pipeline-factory");
      const { PacketBuilder } = require("../../lib/packet");

      const SECRET = "12345678901234567890123456789012";
      const naks = [];
      const state = {
        options: {
          secretKey: SECRET,
          udpPort: 12345,
          protocolVersion: 3,
          authenticatedHeaders: false,
          // Deliberately different from the built-in default of 5.
          reliability: { nakTimeout: 20, maxNakRounds: 2 }
        },
        socketUdp: {
          send: (buf, _port, _addr, cb) => {
            naks.push(buf);
            if (cb) {
              cb(null);
            }
          }
        },
        instanceId: null
      };
      const metricsApi = createMetrics();
      const pipeline = createPipeline(
        2,
        "server",
        { debug: () => {}, error: () => {}, handleMessage: () => {} },
        state,
        metricsApi
      );

      // Open a gap: deliver sequence 0, then 2, leaving 1 missing.
      const builder = new PacketBuilder({ protocolVersion: 3, secretKey: SECRET });
      const rinfo = { address: "10.4.0.1", port: 4400 };
      await pipeline.receivePacket(builder.buildHelloPacket({ clientId: "c" }), SECRET, rinfo);

      expect(typeof pipeline.getSequenceTracker).toBe("function");
      const tracker = pipeline.getSequenceTracker();
      expect(tracker).toBeDefined();
      expect(tracker.maxNakRounds).toBe(2);
    });

    test("a retransmit that lands after abandonment is not dispatched again", () => {
      jest.useFakeTimers();
      try {
        const t = new SequenceTracker({ nakTimeout: 50, maxNakRounds: 3 });

        t.processSequence(100);
        t.processSequence(102); // 101 is now a gap
        jest.advanceTimersByTime(50 * 5); // exhaust the NAK rounds
        expect(t.abandonedCount).toBe(1);
        expect(t.expectedSeq).toBe(103);

        // The sender still had budget left and the packet finally gets through.
        const result = t.processSequence(101);

        // Caller must be able to tell "already handled" from "new data".
        expect(result.duplicate || result.lateArrival).toBe(true);
        expect(result.inOrder).toBe(false);
        // And the late arrival must not drag the window backwards.
        expect(t.expectedSeq).toBe(103);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  });
});
