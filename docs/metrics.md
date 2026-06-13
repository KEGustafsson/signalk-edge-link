# Signal K Edge Link — Metrics Reference

> All metrics exposed via REST API, Signal K paths, and Prometheus.

---

## Core Transport Metrics

From `GET /metrics` under `stats` and `bandwidth`:

| Metric                 | Unit    | Description                                                           |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `deltasSent`           | count   | Total Signal K delta batches sent (client mode)                       |
| `deltasReceived`       | count   | Total delta batches received and injected into Signal K (server mode) |
| `bandwidth.packetsOut` | count   | Total UDP packets sent                                                |
| `bandwidth.packetsIn`  | count   | Total UDP packets received                                            |
| `bytesOut`             | bytes   | Compressed + encrypted bytes sent                                     |
| `bytesIn`              | bytes   | Compressed + encrypted bytes received                                 |
| `bytesOutRaw`          | bytes   | Uncompressed payload bytes (before Brotli)                            |
| `compressionRatio`     | percent | `(1 − bytesOut / bytesOutRaw) × 100` — higher is better               |
| `rateOut`              | B/s     | Current outbound byte rate (smoothed)                                 |
| `rateIn`               | B/s     | Current inbound byte rate (smoothed)                                  |
| `avgPacketSize`        | bytes   | Mean UDP payload size after compression                               |
| `compressionErrors`    | count   | Brotli compress/decompress failures                                   |
| `encryptionErrors`     | count   | AES-GCM encrypt/decrypt failures (key mismatch shows up here)         |
| `udpSendErrors`        | count   | UDP socket send failures                                              |
| `udpRetries`           | count   | Packets that required at least one UDP retry                          |
| `subscriptionErrors`   | count   | Signal K subscription setup failures                                  |
| `malformedPackets`     | count   | Packets dropped due to invalid format or CRC mismatch                 |

**Interpretation:**

- `encryptionErrors > 0` almost always means the `secretKey` does not match between peers
- `compressionRatio` below 70% suggests short delta batches — increase `deltaTimer` for better batching
- `malformedPackets > 0` with no key change usually means a protocol version mismatch

---

## Reliability Metrics (Advanced v3 only)

From `GET /metrics` under `networkQuality`:

| Metric                | Unit  | Description                                                      |
| --------------------- | ----- | ---------------------------------------------------------------- |
| `acksSent`            | count | ACK packets sent by the server                                   |
| `naksSent`            | count | NAK packets sent to request retransmission                       |
| `retransmissions`     | count | Data packets retransmitted after a NAK or timeout                |
| `duplicatePackets`    | count | Packets received with a seq number already seen (safely dropped) |
| `dataPacketsReceived` | count | Total data packets accepted (excludes duplicates)                |

**Interpretation:**

- `retransmissions / dataPacketsReceived` < 1% is healthy
- Rising `naksSent` with low `acksSent` indicates one-way UDP — check bidirectional reachability
- `duplicatePackets > 0` is normal on unreliable links; duplicates are safely discarded

---

## Link Quality Metrics

Returned by `GET /network-metrics` and embedded in `GET /metrics` under `networkQuality`:

| Metric           | Unit  | Typical range | Warning  | Critical | Description                                      |
| ---------------- | ----- | ------------- | -------- | -------- | ------------------------------------------------ |
| `rtt`            | ms    | 10–200 ms     | > 300 ms | > 800 ms | Round-trip time from heartbeat probes            |
| `jitter`         | ms    | 0–50 ms       | > 100 ms | > 300 ms | RTT variance (standard deviation)                |
| `packetLoss`     | ratio | 0–0.02        | > 0.03   | > 0.10   | Fraction of packets lost in recent window        |
| `retransmitRate` | ratio | 0–0.02        | > 0.05   | > 0.15   | Fraction of sent packets that were retransmitted |
| `queueDepth`     | count | 0–20          | > 100    | > 500    | Pending retransmissions in send queue            |
| `linkQuality`    | 0–100 | 85–100        | < 70     | < 50     | Composite score (RTT + loss + jitter + queue)    |

**linkQuality score bands:**

| Score  | Status    | Implication                                         |
| ------ | --------- | --------------------------------------------------- |
| 90–100 | Excellent | Low RTT, minimal loss                               |
| 70–89  | Good      | Acceptable for most use cases                       |
| 50–69  | Degraded  | Congestion control and bonding failover recommended |
| < 50   | Poor      | High loss or latency; data delivery unreliable      |

---

## Smart Batching Metrics

From `GET /metrics` under `smartBatching` (client mode only):

| Metric              | Unit  | Description                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `earlySends`        | count | Batches sent before `deltaTimer` because the packet reached the size limit |
| `timerSends`        | count | Batches sent on the normal timer cadence                                   |
| `oversizedPackets`  | count | Packets that exceeded `MAX_SAFE_UDP_PAYLOAD` (should always be 0)          |
| `avgBytesPerDelta`  | bytes | Average compressed size per delta object                                   |
| `maxDeltasPerBatch` | count | Largest batch seen in the current session                                  |

**Interpretation:**

- `earlySends / (earlySends + timerSends)` > 20% means you are generating data faster than the current `deltaTimer` can drain — increase `deltaTimer` or filter more paths
- `oversizedPackets > 0` is a bug unless you have modified `MAX_SAFE_UDP_PAYLOAD`

---

## Error Categories

The `errorCounts` object in `GET /status` groups errors for rapid triage:

| Category             | Description                          |
| -------------------- | ------------------------------------ |
| `udpSendErrors`      | Socket-level send failures           |
| `compressionErrors`  | Brotli codec errors                  |
| `encryptionErrors`   | AES-GCM authentication or key errors |
| `subscriptionErrors` | Signal K subscription failures       |

`recentErrors` provides the last few timestamped error entries for quick inspection without consulting server logs.

---

## Bonding Metrics

When bonding is enabled, per-link metrics are included in `GET /bonding`:

| Metric               | Description                                   |
| -------------------- | --------------------------------------------- |
| `rtt` (per link)     | Heartbeat-measured RTT for each link          |
| `loss` (per link)    | Packet loss rate for each link                |
| `quality` (per link) | Composite quality score (0–100) for each link |
| `heartbeatsSent`     | Probe count since startup                     |
| `heartbeatResponses` | Responses received (diff = missed probes)     |

---

## Management API Auth Telemetry

`GET /status` and `GET /metrics` include a `managementAuth` block:

| Field      | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `total`    | Total management auth decisions since route registration                |
| `allowed`  | Decisions that allowed the request                                      |
| `denied`   | Decisions that rejected the request                                     |
| `byReason` | Counts by bounded reason: `open_access`, `valid_token`, `invalid_token` |
| `byAction` | Counts by bounded route action: `status.read`, `metrics.read`, etc.     |

---

## Signal K Paths Published

| Signal K path                              | Type         | Unit    | Description                 |
| ------------------------------------------ | ------------ | ------- | --------------------------- |
| `networking.modem.rtt`                     | number       | seconds | v1 external ping RTT        |
| `networking.edgeLink.rtt`                  | number       | ms      | v3 heartbeat RTT            |
| `networking.edgeLink.jitter`               | number       | ms      | RTT variance                |
| `networking.edgeLink.packetLoss`           | number       | ratio   | Packet loss (0–1)           |
| `networking.edgeLink.retransmitRate`       | number       | ratio   | Retransmit rate (0–1)       |
| `networking.edgeLink.linkQuality`          | number       | 0–100   | Composite link quality      |
| `networking.edgeLink.queueDepth`           | number       | packets | Retransmit queue depth      |
| `networking.edgeLink.throughput.out`       | number       | B/s     | Outbound throughput         |
| `networking.edgeLink.throughput.in`        | number       | B/s     | Inbound throughput          |
| `networking.edgeLink.bonding.activeLink`   | string       | —       | `"primary"` or `"backup"`   |
| `networking.edgeLink.bonding.primary.*`    | object       | —       | Primary link health metrics |
| `networking.edgeLink.bonding.backup.*`     | object       | —       | Backup link health metrics  |
| `notifications.signalk-edge-link.<name>.*` | notification | —       | Alert events                |

---

## Prometheus Metrics

Full list exported by `GET /prometheus`:

| Metric                                             | Type    | Description                                                        |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `signalk_edge_link_uptime_seconds`                 | gauge   | Plugin uptime                                                      |
| `signalk_edge_link_deltas_sent_total`              | counter | Total deltas sent                                                  |
| `signalk_edge_link_deltas_received_total`          | counter | Total deltas received                                              |
| `signalk_edge_link_udp_send_errors_total`          | counter | UDP send errors                                                    |
| `signalk_edge_link_bytes_out_total`                | counter | Compressed bytes sent                                              |
| `signalk_edge_link_bytes_in_total`                 | counter | Compressed bytes received                                          |
| `signalk_edge_link_bytes_out_raw_total`            | counter | Raw bytes sent (before compression)                                |
| `signalk_edge_link_packets_out_total`              | counter | Packets sent                                                       |
| `signalk_edge_link_packets_in_total`               | counter | Packets received                                                   |
| `signalk_edge_link_bandwidth_rate_out_bytes`       | gauge   | Outbound bytes/s                                                   |
| `signalk_edge_link_bandwidth_rate_in_bytes`        | gauge   | Inbound bytes/s                                                    |
| `signalk_edge_link_compression_ratio_percent`      | gauge   | Compression ratio                                                  |
| `signalk_edge_link_rtt_milliseconds`               | gauge   | Round-trip time                                                    |
| `signalk_edge_link_jitter_milliseconds`            | gauge   | Jitter                                                             |
| `signalk_edge_link_retransmissions_total`          | counter | Retransmissions                                                    |
| `signalk_edge_link_queue_depth`                    | gauge   | Retransmit queue depth                                             |
| `signalk_edge_link_packet_loss_rate`               | gauge   | Packet loss ratio                                                  |
| `signalk_edge_link_link_quality_score`             | gauge   | Link quality (0–100)                                               |
| `signalk_edge_link_bonding_active_link`            | gauge   | Active link indicator (1=primary, 2=backup)                        |
| `signalk_edge_link_bonding_link_rtt_milliseconds`  | gauge   | Per-link RTT (label: `link`)                                       |
| `signalk_edge_link_bonding_link_loss_rate`         | gauge   | Per-link loss (label: `link`)                                      |
| `signalk_edge_link_bonding_link_quality`           | gauge   | Per-link quality (label: `link`)                                   |
| `signalk_edge_link_management_auth_requests_total` | counter | Management auth decisions (labels: `decision`, `reason`, `action`) |

Per-instance transport metrics include a `mode` label (`"client"` or `"server"`).

### Prometheus scrape configuration

```yaml
scrape_configs:
  - job_name: "signalk-edge-link"
    scrape_interval: 15s
    metrics_path: "/plugins/signalk-edge-link/prometheus"
    static_configs:
      - targets: ["signalk-server:3000"]
```

A starter Grafana dashboard is included at `grafana/dashboards/edge-link.json`.

---

## Source Replication Metrics

The server maintains a source-registry replica built from client-provided update metadata.

### Schema version 1

**Required identity fields:** `identity.label`, `identity.type`

**Optional identity fields:** `identity.src`, `identity.instance`, `identity.pgn`, `identity.deviceId`

**Timestamps:** `firstSeenAt`, `lastSeenAt`, `lastUpdatedAt`

**Provenance:** `provenance.lastUpdatedBy`, `provenance.sourceClientInstanceId`, `provenance.updateTimestamp`

### Merge counters (from `GET /metrics`)

| Counter           | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `upserts`         | New sources registered or existing entries updated                   |
| `noops`           | Incoming data identical to stored state (deduplicated via mergeHash) |
| `missingIdentity` | Records dropped due to missing required identity fields              |
| `conflicts`       | Conflicting field values resolved by latest timestamp                |

### Full registry access

```bash
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/sources | jq .
```
