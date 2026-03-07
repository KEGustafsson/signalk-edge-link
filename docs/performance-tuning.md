# Performance Tuning Guide

This guide summarizes practical tuning levers for edge deployments.

## Baseline references

Use the existing benchmark reports as a starting point:

- `docs/performance/phase-1-baseline.md`
- `docs/performance/phase-2-results.md`
- `docs/performance/phase-7-results.md`

## Key knobs

| Setting | Effect | Typical range |
|---|---|---|
| `deltaTimer` interval | Lower values reduce latency, raise CPU/network overhead | 100-1000 ms |
| Batch size | Larger batches improve throughput, can increase tail latency | 10-100 deltas |
| `protocolVersion` | v2 adds reliability/flow control overhead with better loss handling | `1` or `2` |
| `congestionControl.maxWindow` | Higher window can increase throughput on stable links | 8-64 |
| `bonding.failoverThreshold` | Lower values react faster but can flap on unstable links | 300-1000 ms |

## Profiling workflow

1. Record idle CPU/memory baseline.
2. Run representative traffic and capture:
   - process CPU percent
   - RSS/heap growth
   - RTT/jitter/retransmit metrics
3. Compare changes after tuning one parameter at a time.

## Recommended profiles

### Raspberry Pi 3/4

- Prefer `deltaTimer` 250-500 ms for balanced CPU.
- Enable v2 only when lossy links need ACK/NAK reliability.
- Keep `maxWindow` conservative (8-24).

### x86 shore server

- Lower `deltaTimer` (100-250 ms) for faster updates.
- Higher `maxWindow` (24-64) on stable LAN/WAN links.
- Enable bonding when dual uplinks are available.

## Regression checks

After any change, verify:

- retransmissions do not trend up unexpectedly,
- sequence/duplicate counters stay stable,
- CPU and memory remain within hardware budgets.
