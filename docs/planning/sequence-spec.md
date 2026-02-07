# Sequence Tracker Specification

## Purpose

Track received sequence numbers to detect packet loss (gaps), handle
out-of-order delivery, and trigger NAK (negative acknowledgement) requests
for missing packets.

## Class: SequenceTracker

### Constructor Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxOutOfOrder` | number | 100 | Max sequence slots to track |
| `nakTimeout` | number | 100 | Delay (ms) before NAK callback fires |
| `onLossDetected` | function | noop | Callback when loss is confirmed |

### Internal State

- `expectedSeq` (number): Next expected sequence number (starts at 0)
- `receivedSeqs` (Set): Recently received sequence numbers
- `nakTimers` (Map): Pending NAK timers keyed by sequence number

### Methods

1. **`processSequence(sequence)`** → `{ inOrder, missing, duplicate }`
   - If `seq === expectedSeq` → in order; increment expectedSeq; advance past any contiguous buffered sequences
   - If `seq > expectedSeq` → gap detected; record missing sequences; schedule NAK timers
   - If `seq < expectedSeq` and already received → duplicate
   - If `seq < expectedSeq` and not received → late arrival (accepted)

2. **`getMissingSequences()`** → `number[]`
   - Returns list of known missing sequences in the tracking window

3. **`reset()`** → void
   - Clears all state and cancels NAK timers

### Edge Cases

- **Sequence wraparound** at 2^32 (not implemented in Phase 1; sequences will not reach this in practice)
- **Duplicate detection**: packets already in `receivedSeqs` are flagged
- **NAK timer cancellation**: if a missing packet arrives before the timer fires, the timer is cancelled
- **Memory cleanup**: old sequences below `expectedSeq - maxOutOfOrder` are pruned

## Test Cases Required (35+)

1. In-order delivery (seq 0, 1, 2, ...)
2. Out-of-order arrival (0, 2, 1)
3. Gap detection (0, 1, 3 → missing 2)
4. Duplicate detection
5. NAK scheduling and cancellation
6. Memory cleanup of old sequences
7. Large gap handling
8. Multiple simultaneous gaps
9. Loss callback invocation
10. Reset functionality
11. Late arrival acceptance
12. Contiguous sequence advancement
