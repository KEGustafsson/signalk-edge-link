"use strict";

const CircularBuffer = require("../lib/CircularBuffer");

describe("CircularBuffer", () => {
  describe("Constructor validation", () => {
    test("rejects size = 0", () => {
      expect(() => new CircularBuffer(0)).toThrow("CircularBuffer size must be a positive integer");
    });

    test("rejects negative size", () => {
      expect(() => new CircularBuffer(-1)).toThrow(
        "CircularBuffer size must be a positive integer"
      );
    });

    test("rejects non-integer size", () => {
      expect(() => new CircularBuffer(1.5)).toThrow(
        "CircularBuffer size must be a positive integer"
      );
    });

    test("rejects NaN", () => {
      expect(() => new CircularBuffer(NaN)).toThrow(
        "CircularBuffer size must be a positive integer"
      );
    });

    test("accepts size = 1", () => {
      expect(() => new CircularBuffer(1)).not.toThrow();
    });

    test("accepts size = 100", () => {
      expect(() => new CircularBuffer(100)).not.toThrow();
    });
  });

  describe("Basic operations", () => {
    test("starts empty", () => {
      const buf = new CircularBuffer(5);
      expect(buf.length).toBe(0);
      expect(buf.toArray()).toEqual([]);
    });

    test("push adds items", () => {
      const buf = new CircularBuffer(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.length).toBe(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    test("overwrites oldest when full", () => {
      const buf = new CircularBuffer(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // Overwrites 1
      expect(buf.length).toBe(3);
      expect(buf.toArray()).toEqual([2, 3, 4]);
    });

    test("size = 1 works correctly", () => {
      const buf = new CircularBuffer(1);
      buf.push(42);
      expect(buf.length).toBe(1);
      expect(buf.toArray()).toEqual([42]);
      buf.push(99);
      expect(buf.length).toBe(1);
      expect(buf.toArray()).toEqual([99]);
    });

    test("returns items in insertion order", () => {
      const buf = new CircularBuffer(5);
      for (let i = 0; i < 5; i++) {
        buf.push(i);
      }
      expect(buf.toArray()).toEqual([0, 1, 2, 3, 4]);
    });

    test("wraps correctly across multiple rotations", () => {
      const buf = new CircularBuffer(3);
      for (let i = 0; i < 9; i++) {
        buf.push(i);
      }
      // Last 3 items: 6, 7, 8
      expect(buf.toArray()).toEqual([6, 7, 8]);
    });
  });
});
