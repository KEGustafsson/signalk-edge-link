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

`GET /status` and `GET /metrics` include a `managementAuth` block **only when a `managementApiToken` is configured** (in open-access mode it is omitted, and `/prometheus` likewise omits the management-auth metrics):

| Field      | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `total`    | Total management auth decisions since route registration                |
| `allowed`  | Decisions that allowed the request                                      |
| `denied`   | Decisions that rejected the request                                     |
| `byReason` | Counts by bounded reason: `open_access`, `valid_token`, `invalid_token` |
| `byAction` | Counts by bounded route action: `status.read`, `metrics.read`, etc.     |

---

## Signal K Paths Published

| Signal K path                                   | Type         | Unit    | Description                    |
| ----------------------------------------------- | ------------ | ------- | ------------------------------ |
| `networking.modem.rtt`                          | number       | seconds | v1 external ping RTT           |
| `networking.edgeLink.rtt`                       | number       | ms      | v3 heartbeat RTT               |
| `networking.edgeLink.jitter`                    | number       | ms      | RTT variance                   |
| `networking.edgeLink.packetLoss`                | number       | ratio   | Packet loss (0–1)              |
| `networking.edgeLink.linkQuality`               | number       | 0–100   | Composite link quality         |
| `networking.edgeLink.queueDepth`                | number       | packets | Retransmit queue depth         |
| `networking.edgeLink.retransmissions`           | number       | count   | Retransmitted packets          |
| `networking.edgeLink.sequenceNumber`            | number       | —       | Last published sequence number |
| `networking.edgeLink.bandwidth.upload`          | number       | B/s     | Outbound throughput            |
| `networking.edgeLink.bandwidth.download`        | number       | B/s     | Inbound throughput             |
| `networking.edgeLink.packetsPerSecond.sent`     | number       | pkt/s   | Outbound packet rate           |
| `networking.edgeLink.packetsPerSecond.received` | number       | pkt/s   | Inbound packet rate            |
| `networking.edgeLink.compressionRatio`          | number       | ratio   | Compression ratio              |
| `networking.edgeLink.activeLink`                | string       | —       | Active bonded link name        |
| `networking.edgeLink.links.<link>.status`       | string       | —       | Per-link status                |
| `networking.edgeLink.links.<link>.rtt`          | number       | ms      | Per-link RTT                   |
| `networking.edgeLink.links.<link>.loss`         | number       | ratio   | Per-link loss ratio            |
| `networking.edgeLink.links.<link>.quality`      | number       | 0–100   | Per-link quality score         |
| `notifications.signalk-edge-link.<name>.*`      | notification | —       | Alert events                   |

When an instance ID is configured, the `networking.edgeLink.*` paths are namespaced as `networking.edgeLink.<instanceId>.*`.

---

## Prometheus Metrics

Full list exported by `GET /prometheus`:

| Metric                                                   | Type    | Description                                                                                                            |
| -------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `signalk_edge_link_uptime_seconds`                       | gauge   | Plugin uptime                                                                                                          |
| `signalk_edge_link_ready_to_send`                        | gauge   | Client ready-to-send flag (1/0)                                                                                        |
| `signalk_edge_link_deltas_sent_total`                    | counter | Total deltas sent                                                                                                      |
| `signalk_edge_link_deltas_received_total`                | counter | Total deltas received                                                                                                  |
| `signalk_edge_link_deltas_buffered`                      | gauge   | Deltas currently buffered for send                                                                                     |
| `signalk_edge_link_data_packets_received_total`          | counter | Data packets accepted (excludes duplicates)                                                                            |
| `signalk_edge_link_dropped_delta_batches_total`          | counter | Delta batches dropped before send                                                                                      |
| `signalk_edge_link_dropped_deltas_total`                 | counter | Deltas dropped before send                                                                                             |
| `signalk_edge_link_suppressed_outbound_duplicates_total` | counter | Exact duplicate outbound deltas suppressed                                                                             |
| `signalk_edge_link_rate_limited_packets_total`           | counter | Packets dropped by rate limiting                                                                                       |
| `signalk_edge_link_malformed_packets_total`              | counter | Malformed packets dropped                                                                                              |
| `signalk_edge_link_udp_send_errors_total`                | counter | UDP send errors                                                                                                        |
| `signalk_edge_link_udp_retries_total`                    | counter | UDP send retries                                                                                                       |
| `signalk_edge_link_compression_errors_total`             | counter | Compression errors                                                                                                     |
| `signalk_edge_link_encryption_errors_total`              | counter | Encryption / authentication errors                                                                                     |
| `signalk_edge_link_subscription_errors_total`            | counter | Signal K subscription errors                                                                                           |
| `signalk_edge_link_errors_by_category_total`             | counter | Errors grouped by category (label: `category`)                                                                         |
| `signalk_edge_link_bytes_out_total`                      | counter | Compressed bytes sent                                                                                                  |
| `signalk_edge_link_bytes_in_total`                       | counter | Compressed bytes received                                                                                              |
| `signalk_edge_link_bytes_out_raw_total`                  | counter | Raw bytes sent (before compression)                                                                                    |
| `signalk_edge_link_bytes_in_raw_total`                   | counter | Raw bytes received (after decompression)                                                                               |
| `signalk_edge_link_packets_out_total`                    | counter | Packets sent                                                                                                           |
| `signalk_edge_link_packets_in_total`                     | counter | Packets received                                                                                                       |
| `signalk_edge_link_bandwidth_rate_out_bytes`             | gauge   | Outbound bytes/s                                                                                                       |
| `signalk_edge_link_bandwidth_rate_in_bytes`              | gauge   | Inbound bytes/s                                                                                                        |
| `signalk_edge_link_compression_ratio_percent`            | gauge   | Compression ratio                                                                                                      |
| `signalk_edge_link_acks_sent_total`                      | counter | ACK packets sent                                                                                                       |
| `signalk_edge_link_naks_sent_total`                      | counter | NAK packets sent                                                                                                       |
| `signalk_edge_link_retransmissions_total`                | counter | Retransmissions                                                                                                        |
| `signalk_edge_link_queue_depth`                          | gauge   | Retransmit queue depth                                                                                                 |
| `signalk_edge_link_rtt_milliseconds`                     | gauge   | Round-trip time                                                                                                        |
| `signalk_edge_link_jitter_milliseconds`                  | gauge   | Jitter                                                                                                                 |
| `signalk_edge_link_packet_loss_rate`                     | gauge   | Packet loss ratio                                                                                                      |
| `signalk_edge_link_link_quality_score`                   | gauge   | Link quality (0–100)                                                                                                   |
| `signalk_edge_link_metadata_bytes_out_total`             | counter | Metadata bytes sent                                                                                                    |
| `signalk_edge_link_metadata_bytes_in_total`              | counter | Metadata bytes received                                                                                                |
| `signalk_edge_link_metadata_packets_out_total`           | counter | Metadata packets sent                                                                                                  |
| `signalk_edge_link_metadata_packets_in_total`            | counter | Metadata packets received                                                                                              |
| `signalk_edge_link_metadata_snapshots_sent_total`        | counter | Metadata snapshots sent                                                                                                |
| `signalk_edge_link_metadata_diffs_sent_total`            | counter | Metadata diffs sent                                                                                                    |
| `signalk_edge_link_metadata_rate_limited_packets_total`  | counter | Metadata packets rate-limited                                                                                          |
| `signalk_edge_link_smart_batch_early_sends_total`        | counter | Batches sent before the timer (size cap)                                                                               |
| `signalk_edge_link_smart_batch_timer_sends_total`        | counter | Batches sent on the timer cadence                                                                                      |
| `signalk_edge_link_smart_batch_oversized_total`          | counter | Oversized packets (should be 0)                                                                                        |
| `signalk_edge_link_smart_batch_avg_bytes_per_delta`      | gauge   | Average compressed bytes per delta                                                                                     |
| `signalk_edge_link_bonding_active_link`                  | gauge   | Active link indicator (1=primary, 2=backup)                                                                            |
| `signalk_edge_link_bonding_link_status`                  | gauge   | Per-link status (label: `link`)                                                                                        |
| `signalk_edge_link_bonding_link_rtt_milliseconds`        | gauge   | Per-link RTT (label: `link`)                                                                                           |
| `signalk_edge_link_bonding_link_loss_rate`               | gauge   | Per-link loss (label: `link`)                                                                                          |
| `signalk_edge_link_bonding_link_quality`                 | gauge   | Per-link quality (label: `link`)                                                                                       |
| `signalk_edge_link_management_auth_requests_total`       | counter | Management auth decisions (labels: `decision`, `reason`, `action`); emitted only when a management token is configured |

Per-alert series (one per active alert, names derived from the alert name) are
also emitted but are intentionally excluded from this static list.

Every time-series carries a `mode` label (`"client"` or `"server"`). When an
instance ID is configured, each series additionally carries an `instance` label.

### Prometheus scrape configuration

```yaml
scrape_configs:
  - job_name: "signalk-edge-link"
    scrape_interval: 15s
    metrics_path: "/plugins/signalk-edge-link/prometheus"
    static_configs:
      - targets: ["signalk-server:3000"]
```

Build a Grafana dashboard from the Prometheus metrics exposed at `/prometheus` (no dashboard JSON is bundled with the plugin).

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
