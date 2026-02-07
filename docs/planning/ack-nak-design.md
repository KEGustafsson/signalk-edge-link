# ACK/NAK Packet Format Design

## ACK Packet Structure

### Purpose
Acknowledge received packets to allow sender to clean retransmit queue

### Binary Payload Format
Uses existing v2 packet header with type=ACK (0x02).

**Payload**: 4 bytes - cumulative ACK sequence (uint32 big-endian)
```
┌──────────────────────────┐
│ Acked Sequence (4 bytes) │  All packets <= this are acknowledged
└──────────────────────────┘
```

### Behavior
- Sent periodically (every 100ms default)
- Only sent when new data has been received (idle detection)
- Includes cumulative sequence (all packets up to this seq received)
- Sent immediately if large gap detected (>10 packets)

### Size Analysis
- ACK packet: 15 bytes header + 4 bytes payload = 19 bytes
- Target: <5% of data bandwidth overhead

## NAK Packet Structure

### Purpose
Request retransmission of missing packets

### Binary Payload Format
Uses existing v2 packet header with type=NAK (0x03).

**Payload**: N * 4 bytes - array of missing sequence numbers (uint32 big-endian)
```
┌──────────────────────────┬──────────────────────────┬─────┐
│ Missing Seq 1 (4 bytes)  │ Missing Seq 2 (4 bytes)  │ ... │
└──────────────────────────┴──────────────────────────┴─────┘
```

### Behavior
- Triggered by SequenceTracker gap detection with 100ms timeout
- Cancel NAK if packet arrives before timeout
- Don't send duplicate NAKs for same sequences

### Size Analysis
- 3 missing packets: 15 + 12 = 27 bytes
- 10 missing packets: 15 + 40 = 55 bytes

## Trade-offs

### Cumulative vs Selective ACK
**Decision**: Cumulative only (simple, small). The SequenceTracker already handles
out-of-order detection and NAK scheduling. Selective ACK adds complexity without
proportional benefit for our use case.

### Periodic vs On-Demand ACK
**Decision**: Periodic with idle detection. ACK timer runs at configurable interval
(default 100ms) but skips sending if no new data received since last ACK. This
avoids overhead when idle while ensuring timely ACK during active transmission.

## Configuration Options
```json
{
  "reliability": {
    "ackInterval": 100,
    "nakTimeout": 100,
    "maxRetransmits": 3,
    "retransmitQueueSize": 5000
  }
}
```

## Existing Implementation (Phase 1)

ACK/NAK packet building and parsing already exists:
- `PacketBuilder.buildACKPacket(ackedSequence)` - builds ACK with 4-byte payload
- `PacketBuilder.buildNAKPacket(missingSequences)` - builds NAK with N*4-byte payload
- `PacketParser.parseACKPayload(payload)` - returns acked sequence number
- `PacketParser.parseNAKPayload(payload)` - returns array of missing sequences

## Phase 2 Integration Points

### Client Side
1. **RetransmitQueue**: Store sent packets for potential retransmission
2. **ACK Handler**: Remove acknowledged packets from queue
3. **NAK Handler**: Retransmit requested packets
4. **Control Packet Listener**: Handle incoming ACK/NAK on UDP socket

### Server Side
1. **Periodic ACK Timer**: Send cumulative ACKs at interval
2. **NAK on Loss**: Send NAKs when SequenceTracker detects gaps
3. **Client Address Tracking**: Store sender address for ACK/NAK replies
4. **_sendUDP**: Send control packets back to client
