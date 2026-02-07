# Network Metrics Specification

## Signal K Paths (13 new)

### Core Metrics
1. `networking.edgeLink.rtt` (number, ms) - Round-trip time
2. `networking.edgeLink.jitter` (number, ms) - RTT variance
3. `networking.edgeLink.packetLoss` (number, 0.0-1.0) - Loss rate
4. `networking.edgeLink.bandwidth.upload` (number, bytes/sec)
5. `networking.edgeLink.bandwidth.download` (number, bytes/sec)

### Performance Metrics
6. `networking.edgeLink.packetsPerSecond.sent` (number)
7. `networking.edgeLink.packetsPerSecond.received` (number)
8. `networking.edgeLink.retransmissions` (number) - Cumulative count
9. `networking.edgeLink.sequenceNumber` (number) - Current sequence
10. `networking.edgeLink.queueDepth` (number) - Retransmit queue size

### Quality Metrics
11. `networking.edgeLink.linkQuality` (number, 0-100) - Composite score
12. `networking.edgeLink.activeLink` (string) - "primary"|"backup"|"bonded"
13. `networking.edgeLink.compressionRatio` (number) - Existing from v1

### Per-Link Metrics (for bonding)
- `networking.edgeLink.links.primary.{status, rtt, loss, quality}`
- `networking.edgeLink.links.backup.{status, rtt, loss, quality}`

## Link Quality Algorithm

### Formula
```
quality = (
  (1 - packetLoss) * 40 +
  rttScore * 30 +
  jitterScore * 20 +
  retransmitScore * 10
)

where:
  rttScore = clamp(1 - (rtt / 1000), 0, 1)
  jitterScore = clamp(1 - (jitter / 500), 0, 1)
  retransmitScore = clamp(1 - (retransmitRate / 0.1), 0, 1)
```

### Score Interpretation
- 90-100: Excellent (green)
- 70-89: Good (yellow)
- 50-69: Fair (orange)
- 0-49: Poor (red)

## Update Frequency
- Publish every 1 second
- Calculate as moving average (window: 10 seconds)

## Data Sources

### Client Side
- RTT: From ACK timestamp echo
- Jitter: RTT variance (standard deviation)
- Upload bandwidth: Bytes sent per second
- Retransmissions: From retransmit queue stats
- Queue depth: Current retransmit queue size

### Server Side
- Packet loss: From sequence tracker gaps
- Download bandwidth: Bytes received per second
- Packets per second: Received packet count
