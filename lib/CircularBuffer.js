"use strict";

/**
 * Circular buffer for efficient fixed-size history tracking.
 * Overwrites oldest entries when full, providing O(1) push and O(n) read.
 */
class CircularBuffer {
  constructor(size) {
    this.buffer = new Array(size);
    this.size = size;
    this.index = 0;
    this.filled = false;
  }

  push(item) {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.size;
    if (this.index === 0) {
      this.filled = true;
    }
  }

  toArray() {
    if (!this.filled) {
      return this.buffer.slice(0, this.index);
    }
    return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)];
  }

  get length() {
    return this.filled ? this.size : this.index;
  }
}

module.exports = CircularBuffer;
