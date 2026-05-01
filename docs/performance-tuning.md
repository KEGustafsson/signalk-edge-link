# Performance Tuning Guide

This guide summarizes practical tuning levers for edge deployments.

## Baseline references

Use the existing benchmark reports as a starting point:

- `docs/performance/phase-1-baseline.md`
- `docs/performance/phase-2-results.md`
- `docs/performance/phase-7-results.md`

## Key knobs

| Setting                           | Effect                                                                                                       | Typical range    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| `deltaTimer` interval             | Lower values reduce latency, raise CPU/network overhead                                                      | 100–1000 ms      |
| Batch size                        | Larger batches improve compression ratio, can increase tail latency                                          | 10–100 deltas    |
| `protocolVersion`                 | v2/v3 add reliability/flow control overhead with better loss handling; v3 also authenticates control packets | `1`, `2`, or `3` |
| `congestionControl.minDeltaTimer` | Lower bound for automatic timer adjustment — faster updates, higher baseline throughput                      | 50–500 ms        |
| `congestionControl.maxDeltaTimer` | Upper bound — slower updates, less network pressure under congestion                                         | 1000–10000 ms    |
| `usePathDictionary`               | Replaces long path strings with short integers — 10–20% size savings, must match both ends                   | `true` / `false` |
| `useMsgpack`                      | Binary-encodes delta payloads — 15–25% size savings, must match both ends                                    | `true` / `false` |
| `bonding.failover.rttThreshold`   | Lower values react faster but can flap on unstable links                                                     | 300–1000 ms      |

## Profiling workflow

1. Record idle CPU/memory baseline.
2. Run representative traffic and capture:
   - process CPU percent
   - RSS/heap growth
   - RTT/jitter/retransmit metrics
3. Compare changes after tuning one parameter at a time.

## Recommended profiles

### Raspberry Pi 3/4 (vessel node, constrained CPU)

- Set `deltaTimer` to 500 ms for a balanced CPU load. Drop to 250 ms only if real-time position updates are critical.
- Use `protocolVersion: 3` when connected via cellular or satellite where link quality is poor and you want authenticated control packets.
- Use `protocolVersion: 1` for a stable local LAN link to avoid ACK/NAK overhead.
- Enable `usePathDictionary: true` and `useMsgpack: true` to reduce Brotli's workload by shrinking input size first.
- Keep `congestionControl.minDeltaTimer` at 250 ms or higher; aggressive low-timer settings cause high Brotli CPU on constrained hardware.
- Monitor RSS: normal operating range is 30–80 MB. Growth beyond 150 MB without restarting may indicate a leak — report it.

### x86 / ARM64 shore server (aggregator or relay)

- Set `deltaTimer` to 100–250 ms for low-latency updates from vessel feeds.
- Use `protocolVersion: 3` for all WAN links.
- Enable bonding when dual uplinks (e.g., LTE + Starlink) are available on the vessel side.
- Enable `congestionControl` with `targetRTT: 100` and `minDeltaTimer: 100` for LAN-speed links.
- Set `congestionControl.maxDeltaTimer: 2000` so the controller backs off significantly under brief congestion events.

### Satellite link (high-latency, low-bandwidth)

- Set `deltaTimer` to 2000–5000 ms to maximize compression ratio per packet.
- Enable `useMsgpack: true` and `usePathDictionary: true` to reduce payload size before Brotli.
- Filter unnecessary NMEA sentences in `sentence_filter.json` (especially `GSV`, `GSA`).
- Set `congestionControl.targetRTT: 800` to avoid constant timer increase on a high-latency link.
- Use `protocolVersion: 3` with bonding to an LTE backup when available.

## Regression checks

After any change, verify:

- retransmissions do not trend up unexpectedly,
- sequence/duplicate counters stay stable,
- CPU and memory remain within hardware budgets.

## Future planning

Future distributed controls and external scaling guidance are tracked in docs/future-security-and-protocol-roadmap.md.
