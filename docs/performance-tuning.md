# Signal K Edge Link — Performance Tuning

> Recommended settings by hardware and link type. Settings are defined in [configuration-reference.md](configuration-reference.md); metrics in [metrics.md](metrics.md).

---

## Compression and Batching

Brotli compresses a batch better the more deltas it holds:

| Batch size | Raw JSON | After Brotli | Ratio | Bytes/delta |
| ---------- | -------- | ------------ | ----- | ----------- |
| 1 delta    | 221 B    | 193 B        | 1.1×  | 193 B       |
| 5 deltas   | 1.1 KB   | 227 B        | 5.0×  | 45 B        |
| 10 deltas  | 2.3 KB   | 253 B        | 9.1×  | 25 B        |
| 20 deltas  | 4.5 KB   | 341 B        | 13.6× | 17 B        |
| 50 deltas  | 11.3 KB  | 537 B        | 21.6× | 11 B        |

Raise `deltaTimer` (`delta_timer.json`, 100–10000 ms) on bandwidth-constrained links to collect more deltas per batch. The batch size is a target, not a hard limit: the client divides 85% of the 1400 B payload limit by the average bytes per delta of previous packets, capped at 50 deltas (see [internal constants](configuration-reference.md#internal-constants)). A buffer that reaches that count is sent before the timer fires (counted in `earlySends`). A packet that still exceeds 1400 B is sent whole, not split, and counted in `oversizedPackets`.

---

## Processing Latency Per Stage

| Stage           | p50      | p95      | p99      |
| --------------- | -------- | -------- | -------- |
| Serialize       | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt         | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build    | 0.001 ms | 0.002 ms | 0.009 ms |

Compression dominates. On constrained hardware with high delta rates, raise `deltaTimer` to run Brotli less often.

---

## Deployment Profiles

### Raspberry Pi 3/4 (vessel, constrained CPU)

```json
{
  "useMsgpack": true,
  "usePathDictionary": true,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 300,
    "minDeltaTimer": 250,
    "maxDeltaTimer": 5000
  }
}
```

- `deltaTimer` 250 ms or more, to limit Brotli frequency.
- Normal RSS is 30–80 MB; investigate above 150 MB.

### x86 / ARM64 client on a LAN-speed link

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 100,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 2000
  }
}
```

- `deltaTimer` 100–250 ms for low-latency feeds on stable LAN-speed links.

### Satellite link (high latency, low bandwidth)

```json
{
  "useMsgpack": true,
  "usePathDictionary": true,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 800,
    "minDeltaTimer": 1000,
    "maxDeltaTimer": 10000
  }
}
```

- `deltaTimer` 2000–5000 ms for the best compression ratio.
- `targetRTT: 800` keeps a high-RTT link out of the congested band (above 1200 ms).
- `minDeltaTimer` accepts at most 1000 ms. The controller's timer starts at 1000 ms, not at `deltaTimer`. The `delta_timer.json` interval applies until the first adjustment (5 s after start, once an ACK has arrived); the send interval then drops to 1050 ms on a healthy link (1020 ms in the middle band) and rises 5% (2%) per 5 s step toward `nominalDeltaTimer`, which defaults to the connection's `deltaTimer`. See [congestion-control.md](congestion-control.md#algorithm).
- Exclude `GSV`, `GSA`, `VTG` and `GLL` in `sentence_filter.json`.

---

## Tuning Summary Table

| Link type      | `deltaTimer` | `useMsgpack` | `usePathDictionary` | `targetRTT` |
| -------------- | ------------ | ------------ | ------------------- | ----------- |
| Local LAN      | 100–250 ms   | optional     | optional            | 50 ms       |
| LTE (good)     | 250–500 ms   | yes          | yes                 | 150–200 ms  |
| LTE (variable) | 500–1000 ms  | yes          | yes                 | 300 ms      |
| Satellite      | 2000–5000 ms | yes          | yes                 | 700–1000 ms |
| Starlink       | 500–1000 ms  | yes          | yes                 | 200–400 ms  |

On Basic (v1), set `useMsgpack` on the server as well; Advanced (v3) detects it per packet. `usePathDictionary` needs no server setting.

---

## Bandwidth Optimization Checklist

1. `useMsgpack: true`: 15–25% smaller than JSON.
2. `usePathDictionary: true`: 10–20% saved on path strings.
3. `sentence_filter.json`: exclude `GSV`, `GSA`, `VTG`, `GLL` (repetitive, rarely needed).
4. Higher `deltaTimer` on slow links: 50 deltas per batch compress about 21×, single deltas about 1×.
5. Congestion control: stops the sender from flooding a slow link ([congestion-control.md](congestion-control.md)).

---

## Memory Bounds Reference

| Buffer               | Maximum                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| Retransmit queue     | 5000 packets by default; `reliability.retransmitQueueSize` accepts 100–50000 |
| Monitoring heatmap   | 60 buckets                                                                   |
| Path latency tracker | 200 paths × 50 samples                                                       |
| Retransmit history   | 120 entries                                                                  |
| Bandwidth history    | 60 entries                                                                   |
| Delta buffer         | 1000 deltas                                                                  |

---

## Runtime Monitoring

| Metric                                             | Action                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `compressionRatio` below 70%                       | Raise `deltaTimer`                                                   |
| `earlySends / (earlySends + timerSends)` above 20% | Data rate exceeds the timer: raise `deltaTimer` or filter more paths |
| `rtt` consistently above `targetRTT`               | Raise `targetRTT` to the link's real RTT                             |

See [metrics.md](metrics.md) for the full metrics reference.
