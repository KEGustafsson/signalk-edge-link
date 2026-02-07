"use strict";

const { RetransmitQueue } = require("../../lib/retransmit-queue");

describe("RetransmitQueue", () => {
  describe("Basic Operations", () => {
    test("adds packets to queue", () => {
      const queue = new RetransmitQueue();
      const packet = Buffer.from("test");

      queue.add(0, packet);

      expect(queue.getSize()).toBe(1);
      expect(queue.get(0).packet).toEqual(packet);
    });

    test("stores packet with metadata", () => {
      const queue = new RetransmitQueue();
      const packet = Buffer.from("test");

      queue.add(42, packet);
      const entry = queue.get(42);

      expect(entry.packet).toEqual(packet);
      expect(entry.timestamp).toBeDefined();
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.attempts).toBe(0);
    });

    test("adds multiple packets", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 10; i++) {
        queue.add(i, Buffer.from(`packet ${i}`));
      }

      expect(queue.getSize()).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(queue.get(i)).toBeDefined();
      }
    });

    test("returns undefined for non-existent sequence", () => {
      const queue = new RetransmitQueue();
      expect(queue.get(999)).toBeUndefined();
    });

    test("overwrites packet with same sequence", () => {
      const queue = new RetransmitQueue();

      queue.add(5, Buffer.from("original"));
      queue.add(5, Buffer.from("updated"));

      expect(queue.getSize()).toBe(1);
      expect(queue.get(5).packet.toString()).toBe("updated");
    });
  });

  describe("Cumulative Acknowledgment", () => {
    test("acknowledges packets cumulatively", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 5; i++) {
        queue.add(i, Buffer.from(`packet ${i}`));
      }

      const removed = queue.acknowledge(2); // ACK 0, 1, 2

      expect(removed).toBe(3);
      expect(queue.getSize()).toBe(2);
      expect(queue.get(0)).toBeUndefined();
      expect(queue.get(1)).toBeUndefined();
      expect(queue.get(2)).toBeUndefined();
      expect(queue.get(3)).toBeDefined();
      expect(queue.get(4)).toBeDefined();
    });

    test("acknowledges all packets", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 5; i++) {
        queue.add(i, Buffer.from(`packet ${i}`));
      }

      const removed = queue.acknowledge(4);

      expect(removed).toBe(5);
      expect(queue.getSize()).toBe(0);
    });

    test("acknowledges no packets when seq below all", () => {
      const queue = new RetransmitQueue();

      queue.add(5, Buffer.from("p5"));
      queue.add(6, Buffer.from("p6"));

      const removed = queue.acknowledge(3);

      expect(removed).toBe(0);
      expect(queue.getSize()).toBe(2);
    });

    test("acknowledges partial range with gaps", () => {
      const queue = new RetransmitQueue();

      queue.add(1, Buffer.from("p1"));
      queue.add(3, Buffer.from("p3"));
      queue.add(5, Buffer.from("p5"));
      queue.add(7, Buffer.from("p7"));

      const removed = queue.acknowledge(4); // Should remove 1, 3

      expect(removed).toBe(2);
      expect(queue.getSize()).toBe(2);
      expect(queue.get(1)).toBeUndefined();
      expect(queue.get(3)).toBeUndefined();
      expect(queue.get(5)).toBeDefined();
      expect(queue.get(7)).toBeDefined();
    });

    test("repeated acknowledge is idempotent", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 5; i++) {
        queue.add(i, Buffer.from(`p${i}`));
      }

      queue.acknowledge(2);
      const removed = queue.acknowledge(2);

      expect(removed).toBe(0);
      expect(queue.getSize()).toBe(2);
    });
  });

  describe("Retransmission", () => {
    test("retransmits requested packets", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));
      queue.add(1, Buffer.from("p1"));
      queue.add(2, Buffer.from("p2"));

      const retransmits = queue.retransmit([1, 2]);

      expect(retransmits).toHaveLength(2);
      expect(retransmits[0].sequence).toBe(1);
      expect(retransmits[0].packet.toString()).toBe("p1");
      expect(retransmits[0].attempt).toBe(1);
      expect(retransmits[1].sequence).toBe(2);
      expect(retransmits[1].attempt).toBe(1);
    });

    test("increments attempt count on each retransmit", () => {
      const queue = new RetransmitQueue();
      queue.add(0, Buffer.from("test"));

      queue.retransmit([0]);
      expect(queue.get(0).attempts).toBe(1);

      queue.retransmit([0]);
      expect(queue.get(0).attempts).toBe(2);

      queue.retransmit([0]);
      expect(queue.get(0).attempts).toBe(3);
    });

    test("enforces max retransmit attempts", () => {
      const queue = new RetransmitQueue({ maxRetransmits: 2 });

      queue.add(0, Buffer.from("test"));

      queue.retransmit([0]); // Attempt 1
      queue.retransmit([0]); // Attempt 2
      const result = queue.retransmit([0]); // Attempt 3 - exceeds max

      expect(result).toHaveLength(0);
      expect(queue.get(0)).toBeUndefined();
    });

    test("skips non-existent sequences", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));

      const retransmits = queue.retransmit([0, 99, 100]);

      expect(retransmits).toHaveLength(1);
      expect(retransmits[0].sequence).toBe(0);
    });

    test("returns empty array for all non-existent sequences", () => {
      const queue = new RetransmitQueue();
      const retransmits = queue.retransmit([1, 2, 3]);
      expect(retransmits).toHaveLength(0);
    });

    test("updates timestamp on retransmit", () => {
      jest.useFakeTimers();
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("test"));
      const originalTs = queue.get(0).timestamp;

      jest.advanceTimersByTime(500);
      queue.retransmit([0]);

      expect(queue.get(0).timestamp).toBeGreaterThan(originalTs);

      jest.useRealTimers();
    });

    test("retransmits single packet from large queue", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 100; i++) {
        queue.add(i, Buffer.from(`packet ${i}`));
      }

      const retransmits = queue.retransmit([50]);

      expect(retransmits).toHaveLength(1);
      expect(retransmits[0].sequence).toBe(50);
      expect(retransmits[0].packet.toString()).toBe("packet 50");
    });
  });

  describe("Queue Size Limits", () => {
    test("enforces max queue size", () => {
      const queue = new RetransmitQueue({ maxSize: 3 });

      for (let i = 0; i < 5; i++) {
        queue.add(i, Buffer.from(`p${i}`));
      }

      expect(queue.getSize()).toBe(3);
      expect(queue.get(0)).toBeUndefined(); // Oldest removed
      expect(queue.get(1)).toBeUndefined(); // Second oldest removed
      expect(queue.get(2)).toBeDefined(); // Kept
      expect(queue.get(3)).toBeDefined(); // Kept
      expect(queue.get(4)).toBeDefined(); // Newest kept
    });

    test("evicts oldest when at capacity", () => {
      const queue = new RetransmitQueue({ maxSize: 2 });

      queue.add(10, Buffer.from("p10"));
      queue.add(20, Buffer.from("p20"));
      queue.add(30, Buffer.from("p30"));

      expect(queue.getSize()).toBe(2);
      expect(queue.get(10)).toBeUndefined();
      expect(queue.get(20)).toBeDefined();
      expect(queue.get(30)).toBeDefined();
    });

    test("handles maxSize of 1", () => {
      const queue = new RetransmitQueue({ maxSize: 1 });

      queue.add(0, Buffer.from("first"));
      queue.add(1, Buffer.from("second"));

      expect(queue.getSize()).toBe(1);
      expect(queue.get(0)).toBeUndefined();
      expect(queue.get(1)).toBeDefined();
    });
  });

  describe("Expiration", () => {
    test("expires old packets", () => {
      jest.useFakeTimers();
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("old"));

      jest.advanceTimersByTime(6000);

      queue.add(1, Buffer.from("new"));

      const removed = queue.expireOld(5000);

      expect(removed).toBe(1);
      expect(queue.get(0)).toBeUndefined();
      expect(queue.get(1)).toBeDefined();

      jest.useRealTimers();
    });

    test("does not expire recent packets", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("recent"));

      const removed = queue.expireOld(5000);

      expect(removed).toBe(0);
      expect(queue.get(0)).toBeDefined();
    });

    test("expires all packets when all old", () => {
      jest.useFakeTimers();
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));
      queue.add(1, Buffer.from("p1"));
      queue.add(2, Buffer.from("p2"));

      jest.advanceTimersByTime(10000);

      const removed = queue.expireOld(5000);

      expect(removed).toBe(3);
      expect(queue.getSize()).toBe(0);

      jest.useRealTimers();
    });

    test("expires nothing from empty queue", () => {
      const queue = new RetransmitQueue();
      const removed = queue.expireOld(5000);
      expect(removed).toBe(0);
    });

    test("retransmit resets timestamp for expiration", () => {
      jest.useFakeTimers();
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));
      queue.add(1, Buffer.from("p1"));

      jest.advanceTimersByTime(4000);

      // Retransmit seq 0, refreshing its timestamp
      queue.retransmit([0]);

      jest.advanceTimersByTime(2000);

      // Now 6s since add for both, but seq 0 was retransmitted 2s ago
      const removed = queue.expireOld(5000);

      expect(removed).toBe(1); // Only seq 1 expired
      expect(queue.get(0)).toBeDefined();
      expect(queue.get(1)).toBeUndefined();

      jest.useRealTimers();
    });
  });

  describe("Clear", () => {
    test("clears all packets", () => {
      const queue = new RetransmitQueue();

      for (let i = 0; i < 10; i++) {
        queue.add(i, Buffer.from(`p${i}`));
      }

      queue.clear();

      expect(queue.getSize()).toBe(0);
      expect(queue.get(0)).toBeUndefined();
    });

    test("clear on empty queue is safe", () => {
      const queue = new RetransmitQueue();
      queue.clear();
      expect(queue.getSize()).toBe(0);
    });
  });

  describe("Statistics", () => {
    test("tracks statistics correctly", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));
      queue.add(1, Buffer.from("p1"));
      queue.add(2, Buffer.from("p2"));

      queue.retransmit([0]); // 1 attempt
      queue.retransmit([0, 1]); // 2 attempts on 0, 1 on 1

      const stats = queue.getStats();

      expect(stats.size).toBe(3);
      expect(stats.totalAttempts).toBe(3);
      expect(stats.maxAttempts).toBe(2);
      expect(stats.avgAttempts).toBeCloseTo(1.0);
    });

    test("reports empty statistics", () => {
      const queue = new RetransmitQueue();
      const stats = queue.getStats();

      expect(stats.size).toBe(0);
      expect(stats.totalAttempts).toBe(0);
      expect(stats.maxAttempts).toBe(0);
      expect(stats.avgAttempts).toBe(0);
    });

    test("statistics reflect acknowledgments", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("p0"));
      queue.add(1, Buffer.from("p1"));
      queue.retransmit([0]); // 1 attempt on seq 0

      queue.acknowledge(0); // Remove seq 0

      const stats = queue.getStats();
      expect(stats.size).toBe(1);
      expect(stats.totalAttempts).toBe(0); // Only seq 1 remains with 0 attempts
    });
  });

  describe("Edge Cases", () => {
    test("handles large sequence numbers", () => {
      const queue = new RetransmitQueue();
      const largeSeq = 0xffffffff;

      queue.add(largeSeq, Buffer.from("max seq"));

      expect(queue.get(largeSeq)).toBeDefined();
      expect(queue.get(largeSeq).packet.toString()).toBe("max seq");
    });

    test("handles sequence 0", () => {
      const queue = new RetransmitQueue();

      queue.add(0, Buffer.from("zero"));

      expect(queue.get(0)).toBeDefined();

      const removed = queue.acknowledge(0);
      expect(removed).toBe(1);
    });

    test("handles non-contiguous sequences", () => {
      const queue = new RetransmitQueue();

      queue.add(100, Buffer.from("p100"));
      queue.add(200, Buffer.from("p200"));
      queue.add(300, Buffer.from("p300"));

      expect(queue.getSize()).toBe(3);

      const retransmits = queue.retransmit([100, 300]);
      expect(retransmits).toHaveLength(2);
    });

    test("default config values", () => {
      const queue = new RetransmitQueue();

      // Add more than default maxSize to verify default
      for (let i = 0; i < 5001; i++) {
        queue.add(i, Buffer.from("x"));
      }

      expect(queue.getSize()).toBe(5000);
    });

    test("custom maxRetransmits config", () => {
      const queue = new RetransmitQueue({ maxRetransmits: 1 });

      queue.add(0, Buffer.from("test"));

      const first = queue.retransmit([0]); // Attempt 1 (== max)
      expect(first).toHaveLength(1);

      const second = queue.retransmit([0]); // Exceeds max
      expect(second).toHaveLength(0);
      expect(queue.get(0)).toBeUndefined();
    });

    test("mixed operations sequence", () => {
      const queue = new RetransmitQueue({ maxSize: 10 });

      // Add 5 packets
      for (let i = 0; i < 5; i++) {
        queue.add(i, Buffer.from(`p${i}`));
      }
      expect(queue.getSize()).toBe(5);

      // Acknowledge first 2
      queue.acknowledge(1);
      expect(queue.getSize()).toBe(3);

      // Retransmit one
      const retransmits = queue.retransmit([3]);
      expect(retransmits).toHaveLength(1);

      // Add more
      queue.add(5, Buffer.from("p5"));
      queue.add(6, Buffer.from("p6"));
      expect(queue.getSize()).toBe(5);

      // Acknowledge up to 4
      queue.acknowledge(4);
      expect(queue.getSize()).toBe(2);
      expect(queue.get(5)).toBeDefined();
      expect(queue.get(6)).toBeDefined();
    });
  });
});
