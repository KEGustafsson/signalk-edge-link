"use strict";

/**
 * Circular buffer for efficient fixed-size history tracking.
 * Overwrites oldest entries when full, providing O(1) push and O(n) read.
 */
class CircularBuffer<T = unknown> {
  private buffer: Array<T | undefined>;
  private size: number;
  private index: number;
  private filled: boolean;

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`CircularBuffer size must be a positive integer, got ${size}`);
    }
    this.buffer = new Array(size);
    this.size = size;
    this.index = 0;
    this.filled = false;
  }

  push(item: T): void {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.size;
    if (this.index === 0) {
      this.filled = true;
    }
  }

  toArray(): T[] {
    if (!this.filled) {
      return this.buffer.slice(0, this.index) as T[];
    }
    return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)] as T[];
  }

  get length(): number {
    return this.filled ? this.size : this.index;
  }
}

export = CircularBuffer;
