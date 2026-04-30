# Metrics reference

This document describes the runtime metrics exposed by Signal K Edge Link, their units, typical ranges, and interpretation guidance.

For JSON response structures, see `docs/api-reference.md`. For Prometheus scraping, see the `GET /prometheus` section of that same document.

## Core transport metrics

These counters and gauges appear in `GET /metrics` under `stats` and `bandwidth`.

| Metric               | Unit    | Description                                                      |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `deltasSent`         | count   | Total Signal K delta batches sent (client mode)                  |
| `deltasReceived`     | count   | Total delta batches received and injected into Signal K (server) |
| `packetsSent`        | count   | Total UDP packets sent                                           |
| `packetsReceived`    | count   | Total UDP packets received                                       |
| `bytesOut`           | bytes   | Compressed + encrypted bytes sent                                |
| `bytesIn`            | bytes   | Compressed + encrypted bytes received                            |
| `bytesOutRaw`        | bytes   | Uncompressed payload bytes (before Brotli)                       |
| `compressionRatio`   | percent | `(1 - bytesOut / bytesOutRaw) × 100` — higher is better          |
| `rateOut`            | B/s     | Current outbound byte rate (smoothed)                            |
| `rateIn`             | B/s     | Current inbound byte rate (smoothed)                             |
| `avgPacketSize`      | bytes   | Mean UDP payload size after compression                          |
| `compressionErrors`  | count   | Brotli compress/decompress failures                              |
| `encryptionErrors`   | count   | AES-GCM encrypt/decrypt failures (mismatched key shows up here)  |
| `udpSendErrors`      | count   | UDP socket send failures                                         |
| `udpRetries`         | count   | Packets that required at least one UDP retry                     |
| `subscriptionErrors` | count   | Signal K subscription setup failures                             |
| `malformedPackets`   | count   | Packets dropped due to invalid format or CRC mismatch            |

### Interpretation

- `encryptionErrors > 0` almost always means the `secretKey` does not match between client and server.
- `compressionRatio` below 70% suggests short delta batches; increase `deltaTimer` for better batching.
- `avgPacketSize` well above 1200 bytes with `oversizedPackets > 0` means smart batching is being bypassed — check `MAX_SAFE_UDP_PAYLOAD` constants.

## Reliability metrics

These counters appear in `GET /metrics` under `networkQuality` (v2/v3 only).

| Metric                | Unit  | Description                                                            |
| --------------------- | ----- | ---------------------------------------------------------------------- |
| `acksSent`            | count | ACK packets sent by the server to acknowledge received data            |
| `naksSent`            | count | NAK packets sent to request retransmission of missing sequence numbers |
| `retransmissions`     | count | Data packets retransmitted after a NAK or timeout                      |
| `duplicatePackets`    | count | Packets received with a sequence number already seen (dropped)         |
| `dataPacketsReceived` | count | Total data packets accepted (excludes duplicates)                      |

### Interpretation

- A low `retransmissions / dataPacketsReceived` ratio (< 1%) is healthy.
- Rising `naksSent` with low `acksSent` indicates the client is sending but the server rarely ACKs — check bidirectional UDP reachability.
- `duplicatePackets > 0` is normal on unreliable links where both original and retransmit arrive; the duplicate is safely discarded.

## Link quality metrics

Returned by `GET /network-metrics` and embedded in `GET /metrics` under `networkQuality`.

| Metric           | Unit  | Typical range  | Warning  | Critical | Description                                         |
| ---------------- | ----- | -------------- | -------- | -------- | --------------------------------------------------- |
| `rtt`            | ms    | 10–200 ms      | > 300 ms | > 800 ms | Round-trip time measured from heartbeat probes      |
| `jitter`         | ms    | 0–50 ms        | > 100 ms | > 300 ms | RTT variance (standard deviation of recent samples) |
| `packetLoss`     | ratio | 0–0.02         | > 0.03   | > 0.10   | Fraction of packets lost in recent window           |
| `retransmitRate` | ratio | 0–0.02         | > 0.05   | > 0.15   | Fraction of sent packets that were retransmitted    |
| `queueDepth`     | count | 0–20           | > 100    | > 500    | Pending retransmissions in the send queue           |
| `linkQuality`    | 0–100 | 85–100 healthy | < 70     | < 50     | Composite score (see below)                         |

### linkQuality score

`linkQuality` is a composite 0–100 score that combines RTT, loss, jitter, and queue depth. A score of 100 means a perfect link; scores below 70 indicate degraded conditions that may affect data delivery.

- **90–100**: Excellent — low RTT, minimal loss
- **70–89**: Good — acceptable for most use cases
- **50–69**: Degraded — congestion control and bonding failover recommended
- **< 50**: Poor — high loss or latency; data delivery unreliable

## Smart batching metrics

Returned under `smartBatching` in `GET /metrics` (client mode only).

| Metric              | Unit  | Description                                                                   |
| ------------------- | ----- | ----------------------------------------------------------------------------- |
| `earlySends`        | count | Batches sent before `deltaTimer` because the packet reached the size limit    |
| `timerSends`        | count | Batches sent on the normal timer cadence                                      |
| `oversizedPackets`  | count | Packets that exceeded `MAX_SAFE_UDP_PAYLOAD` (should be 0; non-zero is a bug) |
| `avgBytesPerDelta`  | bytes | Average compressed size per delta object                                      |
| `maxDeltasPerBatch` | count | Largest batch seen in the current session                                     |

### Interpretation

- `earlySends / (earlySends + timerSends)` > 20% means you are generating data faster than the current `deltaTimer` can drain; consider increasing `deltaTimer` or filtering paths.
- `oversizedPackets > 0` should be reported as a bug unless you have modified `MAX_SAFE_UDP_PAYLOAD`.

## Error categories

The `errorCounts` object groups errors by category for rapid triage:

| Category             | Description                          |
| -------------------- | ------------------------------------ |
| `udpSendErrors`      | Socket-level send failures           |
| `compressionErrors`  | Brotli codec errors                  |
| `encryptionErrors`   | AES-GCM authentication or key errors |
| `subscriptionErrors` | Signal K subscription failures       |

`recentErrors` provides the last few categorized error entries with timestamps for quick inspection without consulting server logs.

## Management API auth telemetry

`GET /status` and `GET /metrics` include a top-level `managementAuth` block with aggregate management auth decisions for the current plugin process.

| Field      | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `total`    | Total management auth decisions recorded since route registration |
| `allowed`  | Decisions that allowed the request to continue                    |
| `denied`   | Decisions that rejected the request                               |
| `byReason` | Counts by bounded reason such as `open_access` or `valid_token`   |
| `byAction` | Counts by bounded route action such as `status.read`              |

The same data is exported to Prometheus as `signalk_edge_link_management_auth_requests_total{decision,reason,action}`. The counter is global for the management API and is emitted once per scrape, not once per connection instance.

Management auth telemetry intentionally excludes token values, transport secrets, client addresses, user agents, and raw request paths.

## Monitoring and alerting

Alert thresholds are set via `POST /monitoring/alerts` and checked against the metrics above. Default thresholds:

| Metric          | Warning | Critical |
| --------------- | ------- | -------- |
| RTT             | 300 ms  | 800 ms   |
| Packet loss     | 3%      | 10%      |
| Retransmit rate | 5%      | 15%      |
| Jitter          | 100 ms  | 300 ms   |
| Queue depth     | 100     | 500      |

Alerts emit Signal K notifications at `notifications.signalk-edge-link.<instanceId>.<metric>`.

## Bonding metrics

When bonding is enabled, per-link metrics are included in `GET /bonding`:

| Metric               | Description                                   |
| -------------------- | --------------------------------------------- |
| `rtt` (per link)     | Current heartbeat-measured RTT for each link  |
| `loss` (per link)    | Packet loss rate for each link                |
| `quality` (per link) | Composite quality score (0–100) for each link |
| `heartbeatsSent`     | Probe count since startup                     |
| `heartbeatResponses` | Responses received (diff = missed probes)     |

## JSON monitoring endpoints

| Endpoint                               | Data                                           |
| -------------------------------------- | ---------------------------------------------- |
| `GET /metrics`                         | Full stats, bandwidth, smart batching, quality |
| `GET /network-metrics`                 | RTT, jitter, loss, queue depth, quality score  |
| `GET /connections/:id/metrics`         | Per-connection version of `/metrics`           |
| `GET /connections/:id/network-metrics` | Per-connection version of `/network-metrics`   |
| `GET /monitoring/packet-loss`          | 5-minute packet loss heatmap (60 buckets)      |
| `GET /monitoring/retransmissions`      | Retransmit rate time series                    |
| `GET /monitoring/path-latency`         | Per-path latency percentiles (p50, p95, p99)   |
| `GET /monitoring/alerts`               | Active alerts and current thresholds           |
| `GET /prometheus`                      | Prometheus text format (30+ metrics)           |

## Prometheus scraping

Notable multi-instance labels:

- Per-instance transport metrics include a `mode` label (`"client"` or `"server"`).
- Bonding metrics include a `link` label (`"primary"` or `"backup"`).
- Error category metrics include a `category` label.
- Management auth counters include bounded `decision`, `reason`, and `action` labels.

For the full exported metric list, see `docs/api-reference.md` → **Prometheus Endpoint**.

## Related docs

- `docs/api-reference.md` — full endpoint response schemas
- `docs/bonding.md` — bonding metric interpretation
- `docs/congestion-control.md` — congestion state metrics
- `grafana/dashboards/edge-link.json` — starter Grafana dashboard
