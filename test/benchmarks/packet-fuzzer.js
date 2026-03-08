"use strict";

/**
 * Packet Parser Fuzzer
 *
 * Feeds random and semi-structured buffers into the packet parser
 * to verify it handles malformed input without crashing.
 *
 * Usage:
 *   node test/benchmarks/packet-fuzzer.js [iterations]
 *
 * Default: 100,000 iterations
 */

const crypto = require("crypto");
const { PacketParser } = require("../../lib/packet");

const ITERATIONS = parseInt(process.argv[2], 10) || 100000;
const SECRET_KEY = "a]Wm9xF!jT3kQ#7vL2bR8dN5pY0hU6sZ"; // 32-char test key

const parser = new PacketParser({ secretKey: SECRET_KEY });

let crashes = 0;
let handled = 0;

console.log(`Fuzzing packet parser with ${ITERATIONS} random inputs...`);
const start = Date.now();

for (let i = 0; i < ITERATIONS; i++) {
  try {
    // Generate random buffer of varying lengths (0 to 2000 bytes)
    const len = Math.floor(Math.random() * 2000);
    const buf = crypto.randomBytes(len);

    // Occasionally inject valid magic bytes to exercise deeper code paths
    if (i % 4 === 0 && len >= 2) {
      buf[0] = 0x53; // 'S'
      buf[1] = 0x4b; // 'K'
    }

    // Occasionally inject valid version byte
    if (i % 8 === 0 && len >= 3) {
      buf[2] = 0x02;
    }

    // Try isV2Packet check
    parser.isV2Packet(buf);

    // Try parsing header (only if it looks like a v2 packet)
    if (parser.isV2Packet(buf)) {
      try {
        parser.parseHeader(buf, { secretKey: SECRET_KEY });
      } catch (_e) {
        // Expected for malformed packets
      }
    }

    handled++;
  } catch (err) {
    crashes++;
    console.error(`CRASH at iteration ${i}: ${err.message}`);
    console.error(`  Stack: ${err.stack}`);
  }
}

const elapsed = Date.now() - start;

console.log("\nResults:");
console.log(`  Iterations: ${ITERATIONS}`);
console.log(`  Handled:    ${handled}`);
console.log(`  Crashes:    ${crashes}`);
console.log(`  Time:       ${elapsed}ms`);
console.log(`  Rate:       ${Math.round(ITERATIONS / (elapsed / 1000))} ops/sec`);

if (crashes > 0) {
  console.error(`\nFAILED: ${crashes} crash(es) detected`);
  process.exit(1);
} else {
  console.log("\nPASSED: No crashes detected");
}
