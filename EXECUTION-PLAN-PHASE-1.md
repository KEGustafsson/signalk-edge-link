# Signal K Edge Link v2.0 - Claude Code Execution Plan

**Purpose**: Step-by-step instructions for Claude Code to autonomously implement v2.0
**Created**: February 7, 2026
**Target**: Phase 1 completion by March 7, 2026
**Status**: ✅ COMPLETED - February 7, 2026

---

## Overview

This plan breaks down v2.0 development into discrete, executable steps that can be run by Claude Code (or any AI coding assistant). Each step is self-contained with clear inputs, outputs, and verification criteria.

---

## Prerequisites

Before starting, ensure:
- [x] Repository cloned: `~/.signalk/node_modules/signalk-edge-link`
- [x] Node.js >= 14.0.0 installed
- [x] Dependencies installed: `npm install`
- [x] Git configured for commits
- [x] Planning documents copied to `docs/planning/`

---

## Phase 1: Protocol Foundation (4 weeks)

### Week 1: Packet Module Implementation

---

#### STEP 1.1: Create Directory Structure ✅

**Command**:
```bash
cd ~/.signalk/node_modules/signalk-edge-link
mkdir -p lib/__tests__/v2 test/integration docs/planning
```

**Verification**:
```bash
ls -la lib/__tests__/v2
ls -la test/integration
ls -la docs/planning
```

**Expected Output**: Directories exist

**Git Commit**: `chore: create v2 directory structure`

---

#### STEP 1.2: Copy Planning Documents ✅ (created inline)

**Command**:
```bash
# Copy the 6 files from Claude's outputs
cp /path/to/signalk-edge-link-v2-plan.md docs/planning/
cp /path/to/github-issues.md docs/planning/
cp /path/to/README-PLANNING.md docs/planning/
```

**Verification**:
```bash
wc -l docs/planning/*.md
```

**Expected Output**: Files copied successfully

**Git Commit**: `docs: add v2.0 planning documents`

---

#### STEP 1.3: Implement lib/packet.js ✅

**Input File**: `packet.js` (provided in outputs)

**Command**:
```bash
cp /path/to/packet.js lib/packet.js
```

**Manual Review Checklist**:
- [ ] File has proper header comment
- [ ] All exports are correct
- [ ] JSDoc comments present
- [ ] No syntax errors

**Verification**:
```bash
node -c lib/packet.js  # Check syntax
```

**Expected Output**: No errors

**Git Commit**: `feat(packet): implement v2 packet protocol layer`

---

#### STEP 1.4: Implement Packet Tests ✅

**Input File**: `packet.test.js` (provided in outputs)

**Command**:
```bash
cp /path/to/packet.test.js __tests__/v2/packet.test.js
```

**Verification**:
```bash
npm test -- __tests__/v2/packet.test.js
```

**Expected Output**: 
```
PASS  __tests__/v2/packet.test.js
  PacketBuilder
    ✓ ... (40+ tests)
  PacketParser
    ✓ ...
  Integration scenarios
    ✓ ...

Test Suites: 1 passed, 1 total
Tests:       40+ passed, 40+ total
```

**If Tests Fail**: Debug and fix before proceeding

**Git Commit**: `test(packet): add comprehensive test suite with 40+ tests`

---

#### STEP 1.5: Verify Test Coverage ✅

**Command**:
```bash
npm test -- __tests__/v2/packet.test.js --coverage
```

**Expected Output**: Coverage >95% for lib/packet.js

**Verification Checklist**:
- [ ] Line coverage >95%
- [ ] Branch coverage >90%
- [ ] Function coverage 100%
- [ ] All critical paths tested

**Action if <95%**: Add missing test cases

---

#### STEP 1.6: Update Package.json Test Scripts ✅

**File**: `package.json`

**Action**: Add v2 test scripts

**Code Change**:
```json
{
  "scripts": {
    "test": "jest",
    "test:v2": "jest __tests__/v2/",
    "test:integration": "jest test/integration/",
    "test:coverage": "jest --coverage",
    "test:watch": "jest --watch"
  }
}
```

**Verification**:
```bash
npm run test:v2
```

**Expected Output**: All v2 tests pass

**Git Commit**: `chore: add v2 test scripts to package.json`

---

### Week 2: Sequence Tracking Implementation

---

#### STEP 2.1: Create lib/sequence.js Specification ✅

**Task**: Create detailed specification before coding

**File**: `docs/planning/sequence-spec.md`

**Content Template**:
```markdown
# Sequence Tracker Specification

## Purpose
Track received sequence numbers, detect gaps (lost packets), handle out-of-order arrivals.

## Class: SequenceTracker

### Constructor
- `expectedSeq` (number): Next expected sequence (starts at 0)
- `receivedSeqs` (Set): Recently received sequences
- `maxOutOfOrder` (number): Max sequences to track (default: 100)
- `nakTimeout` (number): Delay before NAK (default: 100ms)

### Methods
1. `processSequence(sequence)` → {inOrder, missing, duplicate}
2. `getMissingSequences()` → [seq1, seq2, ...]
3. `reset()` → void
4. `_scheduleNAK(sequence)` → void
5. `_cleanupOldSequences()` → void

### Behavior
- If seq === expectedSeq → in order, increment expectedSeq
- If seq > expectedSeq → gap detected, schedule NAK
- If seq < expectedSeq → old packet (ignore or duplicate)
- Out-of-order: store in receivedSeqs, advance expectedSeq when contiguous

### Edge Cases
- Sequence wraparound at 2^32
- Duplicate detection
- NAK timer cancellation if packet arrives
- Memory cleanup (remove old sequences)

## Test Cases Required (35+)
1. In-order delivery (seq 0, 1, 2, ...)
2. Out-of-order arrival (0, 2, 1)
3. Gap detection (0, 1, 3 → missing 2)
4. Duplicate detection
5. NAK scheduling and cancellation
6. Sequence wraparound
7. Memory cleanup
8. Large gap handling
...
```

**Git Commit**: `docs(sequence): add sequence tracker specification`

---

#### STEP 2.2: Implement lib/sequence.js (TDD Approach) ✅

**Approach**: Write tests first, then implementation

**Step 2.2a: Write Test Skeleton**

**File**: `__tests__/v2/sequence.test.js`

**Initial Tests** (5 basic tests):
```javascript
const { SequenceTracker } = require('../../lib/sequence');

describe('SequenceTracker', () => {
  test('initializes with expectedSeq 0', () => {
    const tracker = new SequenceTracker();
    expect(tracker.expectedSeq).toBe(0);
  });

  test('processes in-order sequence', () => {
    const tracker = new SequenceTracker();
    const result = tracker.processSequence(0);
    expect(result.inOrder).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('detects gap in sequence', () => {
    const tracker = new SequenceTracker();
    tracker.processSequence(0);
    const result = tracker.processSequence(2);
    expect(result.missing).toContain(1);
  });

  test('handles out-of-order arrival', () => {
    const tracker = new SequenceTracker();
    tracker.processSequence(0);
    tracker.processSequence(2);
    tracker.processSequence(1);
    expect(tracker.expectedSeq).toBe(3);
  });

  test('detects duplicates', () => {
    const tracker = new SequenceTracker();
    tracker.processSequence(0);
    const result = tracker.processSequence(0);
    expect(result.duplicate).toBe(true);
  });
});
```

**Run Tests** (they will fail - that's expected in TDD):
```bash
npm test -- __tests__/v2/sequence.test.js
```

**Expected Output**: All tests fail (module doesn't exist yet)

**Git Commit**: `test(sequence): add initial test skeleton (TDD)`

---

**Step 2.2b: Implement Minimal lib/sequence.js**

**File**: `lib/sequence.js`

**Initial Implementation** (to pass first 5 tests):
```javascript
/**
 * Signal K Edge Link v2.0 - Sequence Tracker
 * 
 * Tracks received sequence numbers to detect packet loss
 * and handle out-of-order delivery.
 * 
 * @module lib/sequence
 */

class SequenceTracker {
  constructor(config = {}) {
    this.expectedSeq = 0;
    this.receivedSeqs = new Set();
    this.maxOutOfOrder = config.maxOutOfOrder || 100;
    this.nakTimeout = config.nakTimeout || 100;
    this.nakTimers = new Map();
    this.onLossDetected = config.onLossDetected || (() => {});
  }

  processSequence(sequence) {
    const result = {
      inOrder: false,
      missing: [],
      duplicate: false
    };

    // Check for duplicate
    if (this.receivedSeqs.has(sequence)) {
      result.duplicate = true;
      return result;
    }

    this.receivedSeqs.add(sequence);

    // Check if in order
    if (sequence === this.expectedSeq) {
      result.inOrder = true;
      this.expectedSeq++;

      // Check for contiguous sequences
      while (this.receivedSeqs.has(this.expectedSeq)) {
        this.expectedSeq++;
      }

      this._cleanupOldSequences();
    } else if (sequence > this.expectedSeq) {
      // Gap detected
      for (let i = this.expectedSeq; i < sequence; i++) {
        if (!this.receivedSeqs.has(i)) {
          result.missing.push(i);
          this._scheduleNAK(i);
        }
      }
    }

    return result;
  }

  _scheduleNAK(sequence) {
    if (this.nakTimers.has(sequence)) return;

    const timer = setTimeout(() => {
      if (!this.receivedSeqs.has(sequence)) {
        this.onLossDetected([sequence]);
      }
      this.nakTimers.delete(sequence);
    }, this.nakTimeout);

    this.nakTimers.set(sequence, timer);
  }

  _cleanupOldSequences() {
    const threshold = this.expectedSeq - this.maxOutOfOrder;
    for (const seq of this.receivedSeqs) {
      if (seq < threshold) {
        this.receivedSeqs.delete(seq);
      }
    }
  }

  getMissingSequences() {
    const missing = [];
    for (let i = this.expectedSeq - this.maxOutOfOrder; i < this.expectedSeq; i++) {
      if (i >= 0 && !this.receivedSeqs.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  reset() {
    this.expectedSeq = 0;
    this.receivedSeqs.clear();
    for (const timer of this.nakTimers.values()) {
      clearTimeout(timer);
    }
    this.nakTimers.clear();
  }
}

module.exports = { SequenceTracker };
```

**Verification**:
```bash
npm test -- __tests__/v2/sequence.test.js
```

**Expected Output**: First 5 tests pass

**Git Commit**: `feat(sequence): implement basic sequence tracker`

---

**Step 2.2c: Add Remaining 30 Tests**

**File**: `__tests__/v2/sequence.test.js`

**Add these test suites**:
1. NAK scheduling and cancellation (5 tests)
2. Sequence wraparound (3 tests)
3. Memory cleanup (4 tests)
4. Large gap handling (3 tests)
5. Multiple gaps (3 tests)
6. Loss callback (3 tests)
7. Reset functionality (2 tests)
8. Edge cases (7 tests)

**Example Test**:
```javascript
describe('NAK Scheduling', () => {
  test('schedules NAK after timeout', async () => {
    const onLoss = jest.fn();
    const tracker = new SequenceTracker({ 
      nakTimeout: 50, 
      onLossDetected: onLoss 
    });

    tracker.processSequence(0);
    tracker.processSequence(2); // Gap at 1

    // Wait for NAK timeout
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(onLoss).toHaveBeenCalledWith([1]);
  });

  test('cancels NAK if packet arrives', async () => {
    const onLoss = jest.fn();
    const tracker = new SequenceTracker({ 
      nakTimeout: 50, 
      onLossDetected: onLoss 
    });

    tracker.processSequence(0);
    tracker.processSequence(2); // Gap at 1
    
    // Packet 1 arrives before timeout
    await new Promise(resolve => setTimeout(resolve, 30));
    tracker.processSequence(1);

    // Wait past timeout
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(onLoss).not.toHaveBeenCalled();
  });
});
```

**Iterative Process**:
1. Add 5-10 tests
2. Run tests → some fail
3. Fix implementation
4. Repeat until all 35+ tests pass

**Final Verification**:
```bash
npm test -- __tests__/v2/sequence.test.js --coverage
```

**Expected Output**: 
- 35+ tests pass
- Coverage >95%

**Git Commit**: `test(sequence): add comprehensive test suite with 35 tests`

---

#### STEP 2.3: Integration Test - Packet + Sequence ✅

**File**: `test/integration/packet-sequence.test.js`

**Purpose**: Verify packet parser and sequence tracker work together

**Test Code**:
```javascript
const { PacketBuilder, PacketParser } = require('../../lib/packet');
const { SequenceTracker } = require('../../lib/sequence');

describe('Packet + Sequence Integration', () => {
  test('tracks sequences from parsed packets', () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const tracker = new SequenceTracker();

    // Send packets 0, 1, 2
    for (let i = 0; i < 3; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      const parsed = parser.parseHeader(packet);
      const result = tracker.processSequence(parsed.sequence);
      expect(result.inOrder).toBe(true);
    }

    expect(tracker.expectedSeq).toBe(3);
  });

  test('detects loss from packet sequence gap', () => {
    const builder = new PacketBuilder();
    const parser = new PacketParser();
    const tracker = new SequenceTracker();

    // Send 0, 1, 3 (missing 2)
    const packets = [0, 1, 3].map(i => {
      builder.setSequence(i);
      return builder.buildDataPacket(Buffer.from(`data ${i}`));
    });

    packets.forEach(packet => {
      const parsed = parser.parseHeader(packet);
      const result = tracker.processSequence(parsed.sequence);
      
      if (parsed.sequence === 3) {
        expect(result.missing).toContain(2);
      }
    });
  });
});
```

**Verification**:
```bash
npm test -- test/integration/packet-sequence.test.js
```

**Expected Output**: All integration tests pass

**Git Commit**: `test(integration): add packet-sequence integration tests`

---

### Week 3: Pipeline Integration

---

#### STEP 3.1: Analyze Current Pipeline ✅

**File to Review**: `lib/pipeline.js`

**Task**: Understand current v1 pipeline flow

**Command**:
```bash
# Read and document current pipeline
cat lib/pipeline.js | head -100
```

**Create Analysis Document**:

**File**: `docs/planning/pipeline-analysis.md`

**Content**:
```markdown
# Current Pipeline Analysis

## v1.0 Pipeline Flow (Client Side)

1. Signal K Delta received
2. Filter → Remove excluded paths
3. Path Dictionary Encode (optional)
4. MessagePack Encode (optional)
5. Brotli Compress
6. AES-256-GCM Encrypt
7. UDP Send

## v1.0 Pipeline Flow (Server Side)

1. UDP Receive
2. AES-256-GCM Decrypt
3. Brotli Decompress
4. MessagePack Decode (optional)
5. Path Dictionary Decode (optional)
6. Signal K handleMessage

## Integration Points for v2

### Where to Insert Packet Layer

**Client Side**: After encrypt, before UDP send
```
... → Encrypt → **Packet Build** → UDP Send
```

**Server Side**: After UDP receive, before decrypt
```
UDP Receive → **Packet Parse** → Decrypt → ...
```

### Required Changes

1. `lib/pipeline.js`: Add packet building/parsing
2. Create `lib/pipeline-v2.js` or add version switch
3. Configuration: `protocolVersion: 1 | 2`
4. Maintain backward compatibility

### Challenges

- Tightly coupled functions
- Need to pass sequence tracker state
- ACK/NAK handling requires separate UDP socket management
```

**Git Commit**: `docs(pipeline): analyze current v1 pipeline for v2 integration`

---

#### STEP 3.2: Design v2 Pipeline Architecture ✅

**File**: `docs/planning/pipeline-v2-design.md`

**Content**:
```markdown
# v2 Pipeline Architecture

## Approach: Parallel Pipelines

Keep v1 and v2 pipelines separate for cleaner code:

```
index.js
  ├── config.protocolVersion === 1
  │   └── lib/pipeline-v1.js (existing)
  └── config.protocolVersion === 2
      └── lib/pipeline-v2.js (new)
```

## v2 Pipeline Components

### Client Pipeline (lib/pipeline-v2-client.js)
```javascript
class PipelineV2Client {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.packetBuilder = new PacketBuilder();
    this.sequenceTracker = new SequenceTracker();
  }

  async sendDelta(delta) {
    // 1. Filter delta
    const filtered = this.filterDelta(delta);
    
    // 2. Encode paths (optional)
    const encoded = this.config.pathDictionary ? 
      pathDictionary.encode(filtered) : filtered;
    
    // 3. MessagePack (optional)
    const packed = this.config.messagepack ?
      msgpack.encode(encoded) : JSON.stringify(encoded);
    
    // 4. Compress
    const compressed = await brotli.compress(packed);
    
    // 5. Encrypt
    const encrypted = crypto.encryptBinary(compressed, this.config.key);
    
    // 6. Build packet
    const packet = this.packetBuilder.buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true,
      messagepack: this.config.messagepack,
      pathDictionary: this.config.pathDictionary
    });
    
    // 7. Send UDP
    await this.sendUDP(packet);
    
    // 8. Store in retransmit queue (Phase 2)
    // this.retransmitQueue.add(seq, packet);
  }

  async receiveACK(packet) {
    // Phase 2: Handle ACKs
  }

  async receiveNAK(packet) {
    // Phase 2: Handle NAKs
  }
}
```

### Server Pipeline (lib/pipeline-v2-server.js)
```javascript
class PipelineV2Server {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.packetParser = new PacketParser();
    this.sequenceTracker = new SequenceTracker({
      onLossDetected: (missing) => this.sendNAK(missing)
    });
  }

  async receiveDelta(packet) {
    // 1. Parse packet header
    const parsed = this.packetParser.parseHeader(packet);
    
    // 2. Track sequence
    const seqResult = this.sequenceTracker.processSequence(parsed.sequence);
    
    if (seqResult.duplicate) {
      return; // Discard duplicate
    }
    
    // 3. Decrypt
    const decrypted = crypto.decryptBinary(parsed.payload, this.config.key);
    
    // 4. Decompress
    const decompressed = await brotli.decompress(decrypted);
    
    // 5. MessagePack decode (optional)
    const unpacked = parsed.isMessagePack ?
      msgpack.decode(decompressed) : JSON.parse(decompressed);
    
    // 6. Path dictionary decode (optional)
    const decoded = parsed.isPathDictionary ?
      pathDictionary.decode(unpacked) : unpacked;
    
    // 7. Send to Signal K
    this.app.handleMessage(this.config.context, decoded);
    
    // 8. Send ACK (Phase 2)
    // Periodic ACK with cumulative seq
  }

  async sendNAK(missingSeqs) {
    // Phase 2: Send NAK packet
  }

  async sendACK() {
    // Phase 2: Send periodic ACK
  }
}
```

## File Structure
```
lib/
├── pipeline.js              (v1 - existing, keep as-is)
├── pipeline-v2-client.js    (new)
├── pipeline-v2-server.js    (new)
└── pipeline-factory.js      (new - version selector)
```

## Integration with index.js

```javascript
// index.js
const { createPipeline } = require('./lib/pipeline-factory');

plugin.start = function(options) {
  const version = options.protocolVersion || 1;
  
  state.pipeline = createPipeline(version, options, state, app);
  
  if (options.mode === 'client') {
    state.pipeline.start();
  } else {
    state.pipeline.listen();
  }
};
```

## Benefits of This Approach

1. Clean separation (no version checks scattered everywhere)
2. Easy to test each version independently
3. Can remove v1 in v3.0 easily
4. Clear migration path
5. No risk of breaking v1 functionality
```

**Git Commit**: `docs(pipeline): design v2 pipeline architecture`

---

#### STEP 3.3: Implement lib/pipeline-factory.js ✅

**File**: `lib/pipeline-factory.js`

**Code**:
```javascript
/**
 * Pipeline Factory - Creates appropriate pipeline based on protocol version
 * 
 * @module lib/pipeline-factory
 */

const PipelineV1 = require('./pipeline'); // Existing v1 pipeline
const PipelineV2Client = require('./pipeline-v2-client');
const PipelineV2Server = require('./pipeline-v2-server');

/**
 * Create pipeline instance based on version
 * 
 * @param {number} version - Protocol version (1 or 2)
 * @param {Object} config - Plugin configuration
 * @param {Object} state - Shared state object
 * @param {Object} app - Signal K app instance
 * @returns {Object} Pipeline instance
 */
function createPipeline(version, config, state, app) {
  if (version === 2) {
    if (config.mode === 'client') {
      return new PipelineV2Client(config, state, app);
    } else {
      return new PipelineV2Server(config, state, app);
    }
  } else {
    // Default to v1
    return PipelineV1;
  }
}

module.exports = { createPipeline };
```

**Verification**:
```bash
node -c lib/pipeline-factory.js
```

**Git Commit**: `feat(pipeline): add pipeline factory for version selection`

---

#### STEP 3.4: Implement lib/pipeline-v2-client.js (Skeleton) ✅

**File**: `lib/pipeline-v2-client.js`

**Code** (initial implementation without ACK/NAK):
```javascript
/**
 * Signal K Edge Link v2.0 - Client Pipeline
 * 
 * Handles delta transmission with v2 protocol:
 * - Packet building with sequence numbers
 * - Encryption and compression
 * - UDP transmission
 * 
 * @module lib/pipeline-v2-client
 */

const dgram = require('dgram');
const { PacketBuilder } = require('./packet');
const { compressAndEncrypt } = require('./pipeline'); // Reuse from v1
const pathDictionary = require('./pathDictionary');
const msgpack = require('msgpack-lite');

class PipelineV2Client {
  constructor(config, state, app) {
    this.config = config;
    this.state = state;
    this.app = app;
    
    // UDP socket
    this.socket = dgram.createSocket('udp4');
    
    // Packet builder
    this.packetBuilder = new PacketBuilder();
    
    // Metrics
    this.metrics = {
      packetsSent: 0,
      bytesSent: 0,
      errors: 0
    };
  }

  /**
   * Start the pipeline
   */
  start() {
    app.debug('Starting v2 client pipeline');
    
    // Subscribe to Signal K deltas
    // (existing subscription logic from v1)
  }

  /**
   * Send a delta packet
   * 
   * @param {Object} delta - Signal K delta
   */
  async sendDelta(delta) {
    try {
      // 1. Prepare payload (filter, encode, pack, compress, encrypt)
      const payload = await this._preparePayload(delta);
      
      // 2. Build packet with header
      const packet = this.packetBuilder.buildDataPacket(payload, {
        compressed: true,
        encrypted: true,
        messagepack: this.config.messagepack,
        pathDictionary: this.config.pathDictionary
      });
      
      // 3. Send UDP
      await this._sendUDP(packet);
      
      // 4. Update metrics
      this.metrics.packetsSent++;
      this.metrics.bytesSent += packet.length;
      
      app.debug(`Sent packet seq=${this.packetBuilder.getCurrentSequence() - 1}, size=${packet.length}`);
      
    } catch (err) {
      this.metrics.errors++;
      app.error(`Failed to send delta: ${err.message}`);
    }
  }

  /**
   * Prepare payload (reuse v1 logic)
   * 
   * @private
   */
  async _preparePayload(delta) {
    // Use existing v1 compression/encryption functions
    // This is a placeholder - actual implementation reuses lib/pipeline.js functions
    const payload = await compressAndEncrypt(delta, this.config);
    return payload;
  }

  /**
   * Send UDP packet
   * 
   * @private
   */
  _sendUDP(packet) {
    return new Promise((resolve, reject) => {
      this.socket.send(
        packet,
        this.config.udpPort,
        this.config.destinationAddress,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Stop the pipeline
   */
  stop() {
    app.debug('Stopping v2 client pipeline');
    if (this.socket) {
      this.socket.close();
    }
  }

  /**
   * Get pipeline metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = PipelineV2Client;
```

**Verification**:
```bash
node -c lib/pipeline-v2-client.js
```

**Git Commit**: `feat(pipeline): implement v2 client pipeline skeleton`

---

#### STEP 3.5: Implement lib/pipeline-v2-server.js (Skeleton) ✅

**File**: `lib/pipeline-v2-server.js`

**Code**:
```javascript
/**
 * Signal K Edge Link v2.0 - Server Pipeline
 * 
 * Handles delta reception with v2 protocol:
 * - Packet parsing and validation
 * - Sequence tracking
 * - Decryption and decompression
 * - Signal K message handling
 * 
 * @module lib/pipeline-v2-server
 */

const dgram = require('dgram');
const { PacketParser, PacketType } = require('./packet');
const { SequenceTracker } = require('./sequence');
const { decompressAndDecrypt } = require('./pipeline'); // Reuse from v1

class PipelineV2Server {
  constructor(config, state, app) {
    this.config = config;
    this.state = state;
    this.app = app;
    
    // UDP socket
    this.socket = dgram.createSocket('udp4');
    
    // Packet parser
    this.packetParser = new PacketParser();
    
    // Sequence tracker
    this.sequenceTracker = new SequenceTracker({
      onLossDetected: (missing) => {
        app.debug(`Packet loss detected: ${missing.join(', ')}`);
        // Phase 2: Send NAK
      }
    });
    
    // Metrics
    this.metrics = {
      packetsReceived: 0,
      bytesReceived: 0,
      packetsDropped: 0,
      duplicates: 0,
      errors: 0
    };
  }

  /**
   * Start listening for packets
   */
  listen() {
    this.socket.bind(this.config.udpPort, () => {
      app.debug(`v2 server listening on port ${this.config.udpPort}`);
    });

    this.socket.on('message', (msg, rinfo) => {
      this.receivePacket(msg, rinfo);
    });

    this.socket.on('error', (err) => {
      app.error(`UDP socket error: ${err.message}`);
      this.metrics.errors++;
    });
  }

  /**
   * Receive and process a packet
   * 
   * @param {Buffer} packet - Received packet
   * @param {Object} rinfo - Remote address info
   */
  async receivePacket(packet, rinfo) {
    try {
      // 1. Parse packet header
      const parsed = this.packetParser.parseHeader(packet);
      
      // 2. Track sequence
      const seqResult = this.sequenceTracker.processSequence(parsed.sequence);
      
      if (seqResult.duplicate) {
        app.debug(`Duplicate packet: seq=${parsed.sequence}`);
        this.metrics.duplicates++;
        return;
      }
      
      // 3. Handle based on packet type
      if (parsed.type === PacketType.DATA) {
        await this._handleDataPacket(parsed);
      } else if (parsed.type === PacketType.HEARTBEAT) {
        app.debug('Received heartbeat');
      }
      // Phase 2: Handle ACK, NAK packets
      
      // 4. Update metrics
      this.metrics.packetsReceived++;
      this.metrics.bytesReceived += packet.length;
      
    } catch (err) {
      app.error(`Failed to process packet: ${err.message}`);
      this.metrics.errors++;
      this.metrics.packetsDropped++;
    }
  }

  /**
   * Handle DATA packet
   * 
   * @private
   */
  async _handleDataPacket(parsed) {
    // 1. Decrypt and decompress payload
    const delta = await this._extractDelta(parsed.payload, {
      isMessagePack: parsed.isMessagePack,
      isPathDictionary: parsed.isPathDictionary
    });
    
    // 2. Send to Signal K
    this.app.handleMessage(this.config.context || 'vessels.self', delta);
    
    app.debug(`Processed delta: seq=${parsed.sequence}, paths=${delta.updates[0].values.length}`);
  }

  /**
   * Extract delta from encrypted payload (reuse v1 logic)
   * 
   * @private
   */
  async _extractDelta(payload, options) {
    // Placeholder - actual implementation reuses lib/pipeline.js functions
    const delta = await decompressAndDecrypt(payload, this.config, options);
    return delta;
  }

  /**
   * Stop the server
   */
  stop() {
    app.debug('Stopping v2 server pipeline');
    if (this.socket) {
      this.socket.close();
    }
  }

  /**
   * Get pipeline metrics
   */
  getMetrics() {
    return { 
      ...this.metrics,
      expectedSeq: this.sequenceTracker.expectedSeq
    };
  }
}

module.exports = PipelineV2Server;
```

**Verification**:
```bash
node -c lib/pipeline-v2-server.js
```

**Git Commit**: `feat(pipeline): implement v2 server pipeline skeleton`

---

#### STEP 3.6: Integration Testing - End-to-End ✅

**File**: `test/integration/pipeline-v2-e2e.test.js`

**Purpose**: Test complete v2 pipeline flow

**Test Code**:
```javascript
const PipelineV2Client = require('../../lib/pipeline-v2-client');
const PipelineV2Server = require('../../lib/pipeline-v2-server');

describe('V2 Pipeline End-to-End', () => {
  let client, server;
  let receivedDeltas = [];

  const mockApp = {
    debug: jest.fn(),
    error: jest.fn(),
    handleMessage: jest.fn((context, delta) => {
      receivedDeltas.push(delta);
    })
  };

  const config = {
    mode: 'client',
    udpPort: 5555,
    destinationAddress: '127.0.0.1',
    encryptionKey: 'test-key-32-characters-long!!',
    messagepack: false,
    pathDictionary: false,
    protocolVersion: 2
  };

  beforeEach(() => {
    receivedDeltas = [];
    
    server = new PipelineV2Server(
      { ...config, mode: 'server' },
      {},
      mockApp
    );
    server.listen();

    client = new PipelineV2Client(
      config,
      {},
      mockApp
    );
  });

  afterEach(() => {
    client.stop();
    server.stop();
  });

  test('transmits delta from client to server', async () => {
    const testDelta = {
      updates: [{
        source: { label: 'test' },
        timestamp: new Date().toISOString(),
        values: [
          { path: 'navigation.position.latitude', value: 60.1 },
          { path: 'navigation.position.longitude', value: 24.9 }
        ]
      }]
    };

    await client.sendDelta(testDelta);

    // Wait for UDP transmission
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(receivedDeltas.length).toBe(1);
    expect(receivedDeltas[0].updates[0].values).toHaveLength(2);
  });

  test('handles sequence correctly over multiple packets', async () => {
    for (let i = 0; i < 5; i++) {
      await client.sendDelta({
        updates: [{
          source: { label: 'test' },
          timestamp: new Date().toISOString(),
          values: [{ path: 'test.value', value: i }]
        }]
      });
    }

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(receivedDeltas.length).toBe(5);
    expect(server.sequenceTracker.expectedSeq).toBe(5);
  });

  test('detects packet loss', async () => {
    // Send packets 0, 1, 3 (skip 2)
    for (let seq of [0, 1, 3]) {
      client.packetBuilder.setSequence(seq);
      await client.sendDelta({
        updates: [{
          source: { label: 'test' },
          timestamp: new Date().toISOString(),
          values: [{ path: 'test.value', value: seq }]
        }]
      });
    }

    await new Promise(resolve => setTimeout(resolve, 200));

    const missing = server.sequenceTracker.getMissingSequences();
    expect(missing).toContain(2);
  });
});
```

**Verification**:
```bash
npm test -- test/integration/pipeline-v2-e2e.test.js
```

**Expected Output**: All E2E tests pass

**Git Commit**: `test(integration): add v2 pipeline end-to-end tests`

---

### Week 4: Documentation & Phase 1 Completion

---

#### STEP 4.1: Write Protocol Specification Document ✅

**File**: `docs/protocol-v2-spec.md`

**Content**: Full protocol specification (see planning docs for template)

**Sections**:
1. Introduction
2. Packet Format (wire format with diagrams)
3. Packet Types
4. Flags
5. CRC16 Checksum
6. Sequence Numbers
7. Protocol Negotiation
8. Backward Compatibility

**Git Commit**: `docs(protocol): add v2.0 protocol specification`

---

#### STEP 4.2: Update Main README ✅

**File**: `README.md`

**Changes**:
- Add v2.0 section
- Link to protocol spec
- Update configuration examples
- Add migration guide link

**Git Commit**: `docs(readme): update for v2.0 protocol`

---

#### STEP 4.3: Create Migration Guide ✅

**File**: `docs/migration/v1-to-v2.md`

(Content from planning docs)

**Git Commit**: `docs(migration): add v1 to v2 migration guide`

---

#### STEP 4.4: Phase 1 Performance Baseline ✅

**File**: `test/benchmarks/phase-1-baseline.js`

**Code**:
```javascript
const Benchmark = require('benchmark');
const { PacketBuilder, PacketParser } = require('../../lib/packet');

const suite = new Benchmark.Suite();

const builder = new PacketBuilder();
const parser = new PacketParser();
const payload = Buffer.alloc(1000); // 1KB payload

suite
  .add('PacketBuilder#buildDataPacket', () => {
    builder.buildDataPacket(payload, { compressed: true, encrypted: true });
  })
  .add('PacketParser#parseHeader', () => {
    const packet = builder.buildDataPacket(payload);
    parser.parseHeader(packet);
  })
  .on('cycle', (event) => {
    console.log(String(event.target));
  })
  .on('complete', function() {
    console.log('Fastest is ' + this.filter('fastest').map('name'));
  })
  .run({ async: true });
```

**Run**:
```bash
node test/benchmarks/phase-1-baseline.js
```

**Document Results** in `docs/performance/phase-1-baseline.md`

**Git Commit**: `perf: add Phase 1 performance baseline measurements`

---

#### STEP 4.5: Phase 1 Completion Checklist ✅

**File**: `docs/planning/phase-1-completion.md`

**Content**:
```markdown
# Phase 1 Completion Checklist

Target: March 7, 2026

## Implementation
- [x] lib/packet.js implemented
- [x] lib/sequence.js implemented
- [x] lib/pipeline-factory.js implemented
- [x] lib/pipeline-v2-client.js implemented
- [x] lib/pipeline-v2-server.js implemented

## Testing
- [x] 40+ packet unit tests (coverage >95%)
- [x] 35+ sequence unit tests (coverage >95%)
- [x] Integration tests (packet + sequence)
- [x] End-to-end pipeline tests
- [x] Performance baseline measured

## Documentation
- [x] Protocol specification written
- [x] Migration guide created
- [x] README updated
- [x] Code documented with JSDoc

## Configuration
- [x] protocolVersion config option
- [x] v1 backward compatibility maintained
- [x] All v1 tests still pass

## Review
- [ ] Code review completed
- [ ] Documentation review completed
- [ ] Performance acceptable (<10% overhead vs v1)

## Release
- [ ] Tag v2.0.0-alpha.1
- [ ] GitHub release created
- [ ] Announcement in Signal K Slack
```

**Git Commit**: `docs: add Phase 1 completion checklist`

---

#### STEP 4.6: Create Alpha Release (deferred to project owner)

**Commands**:
```bash
# Ensure all tests pass
npm test

# Update version
npm version 2.0.0-alpha.1 --no-git-tag-version

# Commit version bump
git add package.json package-lock.json
git commit -m "chore: bump version to 2.0.0-alpha.1"

# Create git tag
git tag -a v2.0.0-alpha.1 -m "Phase 1 Complete: Protocol Foundation

- Implemented v2 packet protocol with headers
- Added sequence tracking for loss detection
- Created parallel v2 pipeline (client & server)
- Maintained v1 backward compatibility
- 75+ tests with >95% coverage
- Performance baseline established

This is an alpha release for testing only."

# Push to GitHub
git push origin main --tags
```

**Create GitHub Release**:
1. Go to repository → Releases → New Release
2. Choose tag: v2.0.0-alpha.1
3. Title: "v2.0.0-alpha.1 - Phase 1: Protocol Foundation"
4. Description: (copy from tag message)
5. Check "This is a pre-release"
6. Publish release

---

## Summary - Phase 1 Complete!

After completing all steps above, you will have:

✅ **Complete v2 packet protocol** (lib/packet.js)  
✅ **Sequence tracking** (lib/sequence.js)  
✅ **Parallel v2 pipeline** (client & server)  
✅ **75+ tests** with >95% coverage  
✅ **Full documentation** (protocol spec, migration guide)  
✅ **Alpha release** (v2.0.0-alpha.1)  
✅ **Backward compatibility** maintained

**Total Implementation Time**: ~80 hours over 4 weeks

---

## Next Steps: Phase 2

After Phase 1 completion, proceed to **Phase 2: Reliability Layer**

This involves:
- Implementing lib/retransmit-queue.js
- Adding ACK/NAK packet handling
- Integrating reliability into pipeline
- Testing with network simulator

See separate execution plan for Phase 2.

---

## Troubleshooting

### If Tests Fail

1. Run specific test file:
   ```bash
   npm test -- __tests__/v2/packet.test.js --verbose
   ```

2. Check for syntax errors:
   ```bash
   node -c lib/packet.js
   ```

3. Enable debug logging:
   ```bash
   DEBUG=* npm test
   ```

### If Integration Fails

1. Check UDP port not in use:
   ```bash
   lsof -i :5555
   ```

2. Verify network connectivity:
   ```bash
   nc -zv 127.0.0.1 5555
   ```

3. Check firewall settings

### If Coverage Low

1. Generate coverage report:
   ```bash
   npm test -- --coverage --coverageReporters=html
   ```

2. Open `coverage/index.html` in browser

3. Add tests for uncovered lines

---

**End of Phase 1 Execution Plan**

*For Phase 2-8 execution plans, request separate document.*
