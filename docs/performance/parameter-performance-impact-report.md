# Parameter & Performance Impact Report

This report captures benchmark runs performed locally to evaluate how key tunable parameters affect throughput, latency, overhead, and reliability behavior.

## Commands run

```bash
node test/benchmarks/bandwidth-efficiency.js
node test/benchmarks/latency-percentiles.js
node test/benchmarks/reliability-overhead.js
```

## Environment

- Repository: `signalk-edge-link`
- Runtime: Node.js benchmark scripts from `test/benchmarks`
- Notes: Results are point-in-time measurements on this host and should be used for directional tuning guidance.

## Parameter reference: what each one means and how it impacts performance

### Common parameters (client and server)

| Parameter | Meaning | Performance impact |
|---|---|---|
| `name` | Connection label / namespace. | No direct runtime throughput/latency impact; helps isolate metrics and per-connection runtime files. |
| `serverType` | Role selection (`client` sender or `server` receiver). | Indirect impact by enabling/disabling mode-specific features (e.g., congestion control and bonding are client-side). |
| `udpPort` | UDP socket port used by the connection. | No direct speed impact; wrong value causes zero useful throughput due to no delivery. |
| `secretKey` | Shared encryption key material used for AES-256-GCM. | No meaningful speed tuning effect; mismatch causes decryption failures and packet drops. |
| `useMsgpack` | Binary encoding option. | Can reduce payload size and bandwidth; CPU impact depends on payload complexity. |
| `usePathDictionary` | Dictionary-based path compaction. | Usually lowers bytes-per-delta significantly for repetitive paths; minimal additional overhead. |
| `protocolVersion` | v1 or v2. | v2 adds reliability/metrics features and control traffic; v1 has lower overhead but fewer recovery capabilities. |

### Client network and sampling parameters

| Parameter | Meaning | Performance impact |
|---|---|---|
| `udpAddress` | Destination host/IP for sends. | Incorrect value = no traffic delivered; does not tune speed directly. |
| `helloMessageSender` | Heartbeat interval (seconds). | Lower values improve liveness detection but increase control-plane traffic. |
| `testAddress` / `testPort` | Connectivity test target. | Affects quality of observed network telemetry (RTT/loss awareness), not packet format efficiency. |
| `pingIntervalTime` | Frequency of connectivity tests. | Lower interval gives fresher network state but adds probe traffic/CPU. |

### Reliability parameters (v2)

#### Server-side ACK/NAK timing

| Parameter | Meaning | Performance impact |
|---|---|---|
| `reliability.ackInterval` | ACK emission cadence. | Lower interval improves recovery feedback latency; increases ACK bandwidth overhead. |
| `reliability.ackResendInterval` | Duplicate ACK resend cadence. | Helps recover from ACK loss; too low can add excess overhead. |
| `reliability.nakTimeout` | Delay before requesting missing packets. | Lower values recover faster but may overreact to jitter/reordering. |

#### Client-side retransmit behavior

| Parameter | Meaning | Performance impact |
|---|---|---|
| `retransmitQueueSize` | Max saved packets for possible retransmit. | Larger queue improves outage tolerance but increases memory usage. |
| `maxRetransmits` | Retry limit per packet. | Higher values increase eventual delivery probability under loss, with more bandwidth cost. |
| `retransmitMaxAge` / `retransmitMinAge` | Packet age bounds for queue expiry. | More aggressive expiry reduces memory/latency backlog but may reduce recoverability. |
| `retransmitRttMultiplier` | Dynamic age scaling vs RTT. | Higher values better tolerate high-latency links; lower values drain queues faster. |
| `ackIdleDrainAge`, `forceDrainAfterAckIdle`, `forceDrainAfterMs` | Behavior when ACKs disappear for long periods. | Prevents unbounded backlog; can trade guaranteed recovery for stability. |
| `recoveryBurstEnabled`, `recoveryBurstSize`, `recoveryBurstIntervalMs`, `recoveryAckGapMs` | Fast catch-up controls after outages. | Faster recovery but can create short burst spikes in traffic/CPU. |

### Congestion control (client, v2)

| Parameter | Meaning | Performance impact |
|---|---|---|
| `congestionControl.enabled` | Enables AIMD send-rate adaptation. | Usually improves robustness under variable WAN conditions. |
| `targetRTT` | Desired RTT threshold. | Lower target is conservative (backs off sooner); higher target favors throughput. |
| `nominalDeltaTimer` | Preferred steady send interval. | Baseline latency/bandwidth trade-off. |
| `minDeltaTimer` / `maxDeltaTimer` | Controller adjustment bounds. | Wider range allows stronger adaptation; narrower range stabilizes behavior. |

### Bonding/failover (client, v2)

| Parameter | Meaning | Performance impact |
|---|---|---|
| `bonding.enabled` | Enables dual-link mode. | Improves availability; adds monitoring/control overhead. |
| `bonding.primary.*` / `bonding.backup.*` | Link endpoint and interface details. | Correct setup can preserve throughput during outages by failover. |
| `bonding.failover.rttThreshold` / `lossThreshold` | Trigger sensitivity for switching links. | Lower values switch earlier (possibly noisy), higher values switch later (possibly degraded performance before failover). |
| `bonding.failover.healthCheckInterval` | Link check cadence. | Lower interval reacts faster with more probe load. |
| `bonding.failover.failbackDelay` | Delay before returning to primary. | Higher values reduce flapping, lower values restore preferred path sooner. |
| `bonding.failover.heartbeatTimeout` | Link-down timeout. | Lower values detect failure faster but risk false positives on jittery links. |

### Monitoring thresholds (client)

| Parameter | Meaning | Performance impact |
|---|---|---|
| `alertThresholds.*.warning/critical` | Warning/critical thresholds for RTT/loss/jitter/retransmit/queue depth. | No direct packet processing speed change; affects alert noise/sensitivity and operator reaction time. |

### Runtime configuration files

| Runtime field | Meaning | Performance impact |
|---|---|---|
| `delta_timer.json: deltaTimer` | Batch send interval. | Lower = lower latency/higher bandwidth; higher = better compression/lower packet rate. |
| `subscription.json` | Included Signal K paths. | Strongest bandwidth lever: narrower subscriptions dramatically reduce payload volume. |
| `sentence_filter.json` | Excluded NMEA sentence types. | Reduces repetitive traffic and packet load when tuned appropriately. |

## 1) Delta timer and batching impact (throughput vs overhead)

Source: `bandwidth-efficiency.js`

### Protocol overhead at various `deltaTimer` values

| Delta timer | Packets/sec | Data BW | ACK overhead | Total BW | Overhead % |
|---:|---:|---:|---:|---:|---:|
| 100 ms | 10.0 | 2.1 KB/s | 210 B/s | 2.3 KB/s | 8.92% |
| 250 ms | 4.0 | 860 B/s | 210 B/s | 1.0 KB/s | 19.67% |
| 500 ms | 2.0 | 430 B/s | 210 B/s | 641 B/s | 32.88% |
| 1000 ms | 1.0 | 215 B/s | 210 B/s | 426 B/s | 49.48% |
| 2000 ms | 0.5 | 108 B/s | 210 B/s | 318 B/s | 66.21% |
| 5000 ms | 0.2 | 43 B/s | 210 B/s | 254 B/s | 83.04% |

### Batch size effect (compression + bytes per delta)

| Batch size | Packet size | Compression ratio | Bytes per delta |
|---:|---:|---:|---:|
| 1 | 195 B | 1.13x | 195 B |
| 5 | 231 B | 4.94x | 46 B |
| 10 | 253 B | 9.13x | 25 B |
| 20 | 341 B | 13.65x | 17 B |
| 50 | 537 B | 21.59x | 11 B |

### Impact summary

- Lower `deltaTimer` reduces latency but increases packet rate and total bandwidth.
- Higher `deltaTimer` sharply increases control-plane overhead share (ACK/heartbeat) because data packets become infrequent.
- Larger batches significantly improve effective bytes-per-delta and compression ratio.

## 2) Congestion control behavior impact

Source: `bandwidth-efficiency.js`

### Observed delta timer adaptation (AIMD)

- **Good → congested:** timer stayed at 1000 ms initially, then rose to 1200 ms under severe congestion sample.
- **Congested → recovery:** timer increased up to 2489 ms, then gradually stepped down to 2390 ms as network recovered.
- **Satellite-like RTT (600+ ms):** timer continually increased (1000 → 3584 ms), indicating conservative behavior under sustained high RTT/loss.
- **LTE-like bursty scenario:** timer mostly remained at nominal 1000 ms in sampled conditions.

### Impact summary

- Congestion control protects link stability by increasing interval under persistent RTT/loss pressure.
- On stable links, timer tends to remain near nominal value.
- On satellite-like links, expect reduced send frequency unless target/limits are tuned for high-latency operation.

## 3) Compression quality impact

Source: `latency-percentiles.js`

| Brotli quality | Avg compression latency | p99 latency | Compressed size | Ratio |
|---:|---:|---:|---:|---:|
| 1 | 0.163 ms | 1.835 ms | 199 B | 1.85x |
| 4 | 0.104 ms | 0.740 ms | 178 B | 2.07x |
| 6 | 0.152 ms | 2.244 ms | 172 B | 2.14x |
| 8 | 0.163 ms | 2.816 ms | 172 B | 2.14x |
| 10 | 0.874 ms | 1.476 ms | 159 B | 2.31x |
| 11 | 1.236 ms | 1.973 ms | 160 B | 2.30x |

### Impact summary

- Higher quality (10/11) yields better compression ratio, but with materially higher CPU/latency cost.
- Mid qualities (4–8) can provide a useful latency/compression trade-off for constrained CPUs.

## 4) Payload size impact

Source: `latency-percentiles.js`

| Paths in delta | Raw size | TX avg | TX p99 | RX avg | RX p99 |
|---:|---:|---:|---:|---:|---:|
| 1 | 151 B | 0.867 ms | 1.519 ms | 0.121 ms | 0.944 ms |
| 3 | 260 B | 0.824 ms | 1.661 ms | 0.087 ms | 0.190 ms |
| 5 | 369 B | 0.686 ms | 1.064 ms | 0.132 ms | 0.267 ms |
| 10 | 638 B | 0.791 ms | 1.389 ms | 0.142 ms | 0.277 ms |
| 20 | 1188 B | 0.899 ms | 1.157 ms | 0.135 ms | 0.327 ms |
| 50 | 2844 B | 1.772 ms | 2.670 ms | 0.164 ms | 0.521 ms |

### Impact summary

- TX latency is relatively flat for small/medium payloads but climbs for very large deltas.
- RX latency increases modestly with payload size in these runs.

## 5) Reliability overhead and loss impact

Source: `reliability-overhead.js`

### ACK/NAK overhead as payload grows

- For 100-byte payloads: ACK is 18.3% of packet size.
- For 500-byte payloads: ACK is 4.1%.
- For 5000-byte payloads: ACK is 0.4%.

### Loss recovery outcomes (10 rounds)

| Simulated loss | Initial delivery | Final delivery |
|---:|---:|---:|
| 1% | 9916/10000 | 9949/10000 (99.49%) |
| 5% | 9505/10000 | 9754/10000 (97.54%) |
| 10% | 8997/10000 | 9496/10000 (94.96%) |
| 20% | 7996/10000 | 9004/10000 (90.04%) |

### Retransmit queue performance (host-specific)

- Add 100,000 packets: 84 ms (~1.19M ops/s)
- Get 100,000 packets: 7 ms (~14.29M ops/s)
- Retransmit 100 seqs × 1000 rounds: 7 ms (~14.29M ops/s)

### Impact summary

- Reliability control traffic is small for medium/large payloads, but significant for tiny packets.
- Recovery effectiveness decreases as packet loss increases; aggressive loss conditions may require longer/more retries and tuned queue aging.
- Queue operations are fast enough that network conditions are likely to dominate in normal use.

## 6) Practical tuning recommendations based on these runs

1. **Low latency target (good link):**
   - Use `deltaTimer` around 100–500 ms.
   - Keep payload scope tight (`subscription` filters) to avoid oversized batches.

2. **Bandwidth-constrained link:**
   - Increase batching (larger effective per-send batch) and/or `deltaTimer` moderately.
   - Avoid very high `deltaTimer` values where control traffic dominates.

3. **High-latency or unstable WAN (LTE/satellite):**
   - Enable v2 reliability + congestion control.
   - Tune congestion bounds to avoid over-throttling if high RTT is expected baseline.
   - Use bonding/failover if dual links are available.

4. **CPU-constrained devices:**
   - Consider a lower Brotli quality if compression CPU becomes bottleneck.

## Caveats

- The retransmit queue memory section showed one anomalous negative reading at 50,000 entries; this is likely due to GC/heap sampling timing in this simple benchmark and should not be interpreted as literal negative memory usage.
- These scripts are synthetic micro/meso benchmarks and should be validated against live Signal K workloads before production tuning.
