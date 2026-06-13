# Signal K Edge Link — Performance Tuning

> Deployment tuning recommendations by hardware profile and link type.

---

## Compression and Batching

Brotli compression ratio improves dramatically with batch size. Larger batches = better compression and lower per-delta bandwidth cost:

| Batch size | Raw JSON | After Brotli | Ratio | Bytes/delta |
| ---------- | -------- | ------------ | ----- | ----------- |
| 1 delta    | 221 B    | 193 B        | 1.1×  | 193 B       |
| 5 deltas   | 1.1 KB   | 227 B        | 5.0×  | 45 B        |
| 10 deltas  | 2.3 KB   | 253 B        | 9.1×  | 25 B        |
| 20 deltas  | 4.5 KB   | 341 B        | 13.6× | 17 B        |
| 50 deltas  | 11.3 KB  | 537 B        | 21.6× | 11 B        |

**Increase `deltaTimer` on bandwidth-constrained links** to collect more deltas per batch.

---

## Processing Latency Per Stage

| Stage           | p50      | p95      | p99      |
| --------------- | -------- | -------- | -------- |
| Serialize       | 0.004 ms | 0.008 ms | 0.017 ms |
| Brotli compress | 0.782 ms | 0.992 ms | 1.291 ms |
| Encrypt         | 0.013 ms | 0.027 ms | 0.102 ms |
| Packet build    | 0.001 ms | 0.002 ms | 0.009 ms |

Compression dominates processing time. On constrained hardware generating high delta rates, increase `deltaTimer` to reduce Brotli invocation frequency.

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

- `deltaTimer` ≥ 250 ms to limit Brotli frequency
- Monitor RSS: normal 30–80 MB; investigate if > 150 MB

### x86 / ARM64 shore server

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

- Low `deltaTimer` (100–250 ms) for low-latency feeds on stable LAN-speed links

### Satellite link (high-latency, low-bandwidth)

```json
{
  "useMsgpack": true,
  "usePathDictionary": true,
  "congestionControl": {
    "enabled": true,
    "targetRTT": 800,
    "minDeltaTimer": 2000,
    "maxDeltaTimer": 10000
  }
}
```

Also add `sentence_filter.json` excluding `GSV`, `GSA`, `VTG`.

- High `deltaTimer` (2000–5000 ms) maximizes compression ratio
- `targetRTT: 800` prevents constant congestion decisions on a high-RTT link

---

## Tuning Summary Table

| Link type      | `deltaTimer` | `useMsgpack` | `usePathDictionary` | `targetRTT` |
| -------------- | ------------ | ------------ | ------------------- | ----------- |
| Local LAN      | 100–250 ms   | optional     | optional            | 50 ms       |
| LTE (good)     | 250–500 ms   | yes          | yes                 | 150–200 ms  |
| LTE (variable) | 500–1000 ms  | yes          | yes                 | 300 ms      |
| Satellite      | 2000–5000 ms | yes          | yes                 | 700–1000 ms |
| Starlink       | 500–1000 ms  | yes          | yes                 | 200–400 ms  |

---

## Memory Bounds Reference

| Buffer               | Maximum                |
| -------------------- | ---------------------- |
| Retransmit queue     | 5000 packets           |
| Monitoring heatmap   | 60 buckets             |
| Path latency tracker | 200 paths × 50 samples |
| Retransmit history   | 120 entries            |
| Bandwidth history    | 60 entries             |
| Delta buffer         | 1000 deltas            |

---

## Bandwidth Optimization Checklist

1. **Enable `useMsgpack: true`** — saves 15–25% vs JSON
2. **Enable `usePathDictionary: true`** — saves 10–20% on path strings
3. **Add `sentence_filter.json`** — exclude `GSV`, `GSA`, `VTG`, `GLL` (repetitive, rarely actionable)
4. **Increase `deltaTimer`** on slow links — 50 deltas/batch gives 21× compression vs 1× for single deltas
5. **Enable congestion control** — prevents sender from flooding a slow link

## Runtime Monitoring

Monitor these metrics to assess tuning effectiveness:

- `compressionRatio` < 70%: increase `deltaTimer`
- `earlySends / (earlySends + timerSends)` > 20%: data rate exceeds current timer — increase `deltaTimer` or filter more paths
- `rtt` consistently > `targetRTT`: increase `targetRTT` to match actual link RTT

See [metrics.md](metrics.md) for the full metrics reference.
