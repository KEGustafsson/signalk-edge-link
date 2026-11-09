# Signal K Edge Link — Metrics Reference

> All metrics exposed via REST API, Signal K paths, and Prometheus.

Each table gives the JSON field (from `GET /metrics` unless stated) and the matching `GET /prometheus` series. Response shapes and routes: [api-reference.md](api-reference.md).

---

## Core Transport Metrics

`GET /metrics` → `stats` and `bandwidth`:

| JSON field                                   | Prometheus                                                                                     | Description                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `stats.deltasSent`                           | `signalk_edge_link_deltas_sent_total`                                                          | Signal K delta batches sent (client)                                                               |
| `stats.deltasReceived`                       | `signalk_edge_link_deltas_received_total`                                                      | Deltas received and injected into Signal K (server); one batch can add several                     |
| `status.deltasBuffered`                      | `signalk_edge_link_deltas_buffered`                                                            | Deltas currently buffered for send                                                                 |
| `status.readyToSend`                         | `signalk_edge_link_ready_to_send`                                                              | Client ready-to-send flag (1/0)                                                                    |
| `uptime.seconds`                             | `signalk_edge_link_uptime_seconds`                                                             | Plugin uptime                                                                                      |
| `stats.processDeltaCalls`                    | —                                                                                              | Deltas handed to the outbound path (pre-filter, pre-batch)                                         |
| `stats.deltasBufferHighWaterMark`            | —                                                                                              | Peak outbound buffer depth; the backpressure signal before drops start                             |
| `stats.droppedDeltaBatches`                  | `signalk_edge_link_dropped_delta_batches_total`                                                | Delta batches dropped before send                                                                  |
| `stats.droppedDeltaCount`                    | `signalk_edge_link_dropped_deltas_total`                                                       | Deltas dropped before send                                                                         |
| `stats.suppressedOutboundDuplicates`         | `signalk_edge_link_suppressed_outbound_duplicates_total`                                       | Exact duplicate outbound deltas suppressed (no per-path breakdown is exported anywhere)            |
| `stats.rateLimitedPackets`                   | `signalk_edge_link_rate_limited_packets_total`                                                 | Packets dropped by rate limiting                                                                   |
| `stats.malformedPackets`                     | `signalk_edge_link_malformed_packets_total`                                                    | Packets dropped due to invalid format or CRC mismatch                                              |
| `stats.udpSendErrors`                        | `signalk_edge_link_udp_send_errors_total`                                                      | UDP socket send failures                                                                           |
| `stats.udpRetries`                           | `signalk_edge_link_udp_retries_total`                                                          | UDP send retry attempts; a packet retried twice counts twice                                       |
| `stats.compressionErrors`                    | `signalk_edge_link_compression_errors_total`                                                   | Brotli compress/decompress failures                                                                |
| `stats.encryptionErrors`                     | `signalk_edge_link_encryption_errors_total`                                                    | AES-GCM encrypt/decrypt failures (key mismatch shows up here)                                      |
| `stats.subscriptionErrors`                   | `signalk_edge_link_subscription_errors_total`                                                  | Signal K subscription setup failures                                                               |
| `stats.errorCounts.<category>`               | `signalk_edge_link_errors_by_category_total{category}`                                         | Errors by category, see [Error Categories](#error-categories)                                      |
| `bandwidth.bytesOut` / `bytesIn`             | `signalk_edge_link_bytes_out_total` / `signalk_edge_link_bytes_in_total`                       | Compressed + encrypted bytes sent / received                                                       |
| `bandwidth.bytesOutRaw` / `bytesInRaw`       | `signalk_edge_link_bytes_out_raw_total` / `signalk_edge_link_bytes_in_raw_total`               | Payload bytes before compression / after decompression                                             |
| `bandwidth.packetsOut` / `packetsIn`         | `signalk_edge_link_packets_out_total` / `signalk_edge_link_packets_in_total`                   | UDP packets sent / received; on a v3 client, retransmissions and control packets are not counted   |
| `bandwidth.rateOut` / `rateIn`               | `signalk_edge_link_bandwidth_rate_out_bytes` / `signalk_edge_link_bandwidth_rate_in_bytes`     | Bytes/s over the interval since the previous rate update                                           |
| `bandwidth.compressionRatio`                 | `signalk_edge_link_compression_ratio_percent`                                                  | `(1 − compressed / raw) × 100` using out-bytes on a client, in-bytes on a server; higher is better |
| `bandwidth.avgPacketSize`                    | —                                                                                              | Mean UDP payload size after compression (in-direction on a server)                                 |
| `bandwidth.metaBytesOut` / `metaBytesIn`     | `signalk_edge_link_metadata_bytes_out_total` / `signalk_edge_link_metadata_bytes_in_total`     | Metadata bytes sent / received                                                                     |
| `bandwidth.metaPacketsOut` / `metaPacketsIn` | `signalk_edge_link_metadata_packets_out_total` / `signalk_edge_link_metadata_packets_in_total` | Metadata packets sent / received                                                                   |
| `bandwidth.metaSnapshotsSent`                | `signalk_edge_link_metadata_snapshots_sent_total`                                              | Metadata snapshots sent                                                                            |
| `bandwidth.metaDiffsSent`                    | `signalk_edge_link_metadata_diffs_sent_total`                                                  | Metadata diffs sent                                                                                |
| `bandwidth.metaRateLimitedPackets`           | `signalk_edge_link_metadata_rate_limited_packets_total`                                        | Metadata packets rate-limited                                                                      |

`bandwidth` also carries display strings (`bytesOutFormatted`, `bytesInFormatted`, `bytesOutRawFormatted`, `bytesInRawFormatted`, `rateOutFormatted`, `rateInFormatted`, `avgPacketSizeFormatted`, `metaBytesOutFormatted`, `metaBytesInFormatted`) and `history`, the last 30 `{ timestamp, rateOut, rateIn, compressionRatio }` samples.

**Interpretation:**

- `encryptionErrors > 0` almost always means the `secretKey` does not match between peers
- `compressionRatio` below 70% suggests short delta batches — increase `deltaTimer` for better batching
- `malformedPackets > 0` with no key change usually means a protocol version mismatch

---

## Reliability Metrics (Advanced v3 only)

| JSON field                       | Prometheus                                      | Description                                                                        |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `networkQuality.acksSent`        | `signalk_edge_link_acks_sent_total`             | ACK packets sent by the server                                                     |
| `networkQuality.naksSent`        | `signalk_edge_link_naks_sent_total`             | NAK packets sent to request retransmission                                         |
| `networkQuality.retransmissions` | `signalk_edge_link_retransmissions_total`       | Data packets retransmitted after a NAK or timeout                                  |
| `stats.duplicatePackets`         | —                                               | Packets received with a seq number already seen (safely dropped)                   |
| `stats.dataPacketsReceived`      | `signalk_edge_link_data_packets_received_total` | Data packets accepted (excludes duplicates)                                        |
| `stats.packetsAbandoned`         | —                                               | Packets the sender dropped from its retransmit queue (unrecoverable)               |
| `stats.abandonedSequences`       | —                                               | Receive-side gaps given up on after exhausting NAK rounds (unrecoverable)          |
| `stats.rejectedControlPackets`   | —                                               | ACK/NAK/request packets dropped because the source did not match a configured peer |
| `stats.replayedPackets`          | —                                               | Datagrams the anti-replay guard refused                                            |
| `stats.epochAuthMismatches`      | —                                               | Packets refused for lacking the epoch flag; usually an `epochBoundAuth` mismatch   |
| `stats.epochAuthPending`         | —                                               | Packets refused because no HELLO has established the sender's epoch yet            |
| `stats.fullStatusCascadeFired`   | —                                               | Times a client instance relayed FULL_STATUS_REQUEST to the servers beside it       |
| `stats.snapshotReplayDeltas`     | —                                               | Deltas emitted while replaying a values snapshot on request                        |

**Interpretation:**

- On a client, `retransmissions / bandwidth.packetsOut` is the `retransmitRate` in [Link Quality Metrics](#link-quality-metrics), which lists its healthy and alert ranges. `dataPacketsReceived` is a server-side count, so it is not a denominator for a client's `retransmissions`.
- `replayedPackets > 0` means the anti-replay guard rejected a datagram the live session has no record of: a replay attempt or a peer bug, but also DATA from a new source port that overtook its HELLO, or a legitimate packet older than the window. A rise is a reason to look, not proof of an attack. This counter is the only external evidence of a replay. A retransmit that crosses an ACK is rejected by the same window but counts in `duplicatePackets`, because its sequence is still in the session's seen-set.
- `epochAuthMismatches > 0`: this receiver requires `epochBoundAuth` and received packets without the epoch flag. The usual cause is a sender that does not use it, so every DATA packet is refused; set the same value on both peers. The flag is checked before the HMAC tag, so forged or wrong-key packets without it count too.
- `epochAuthPending > 0`: the sender binds, but no HELLO has established its epoch yet. A brief burst at startup clears once the HELLO completes. A climbing count means the HELLO is not arriving; check that the peer's DATA and HELLO leave from the same address and port.
- `fullStatusCascadeFired` at zero on a proxy's client instance means the node terminates snapshot requests instead of relaying them upstream.
- Rising `naksSent` with low `acksSent` indicates one-way UDP; check bidirectional reachability.
- `duplicatePackets > 0` is normal on unreliable links; duplicates are discarded.
- `packetsAbandoned` / `abandonedSequences` above zero mean data was permanently lost: the window advanced past a gap the sender could no longer fill.
- `rejectedControlPackets` rising on a client means control packets from a source other than `udpAddress` are dropped before parsing. On its own it does not prove ACKs are lost; if `queueDepth` also climbs and RTT stops updating, the server's replies are among them, so check that `udpAddress` names the host the server replies from.

---

## Link Quality Metrics

`GET /network-metrics`, and `GET /metrics` → `networkQuality`. Warning/critical are the default [alert](#alerts) thresholds; `linkQuality` bands are guidance only (it is not an alert metric).

| JSON field       | Prometheus                              | Unit  | Typical range | Warning  | Critical | Description                                                                   |
| ---------------- | --------------------------------------- | ----- | ------------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `rtt`            | `signalk_edge_link_rtt_milliseconds`    | ms    | 10–200 ms     | ≥ 300 ms | ≥ 800 ms | RTT from ACKs of DATA that was not retransmitted                              |
| `jitter`         | `signalk_edge_link_jitter_milliseconds` | ms    | 0–50 ms       | ≥ 100 ms | ≥ 300 ms | RTT variance (standard deviation)                                             |
| `packetLoss`     | `signalk_edge_link_packet_loss_rate`    | ratio | 0–0.02        | ≥ 0.03   | ≥ 0.10   | Loss-event estimate over a recent window ([below](#loss-and-retransmit-rate)) |
| `retransmitRate` | `signalk_edge_link_retransmit_rate`     | ratio | 0–0.02        | ≥ 0.05   | ≥ 0.15   | Retransmissions per sent packet ([below](#loss-and-retransmit-rate))          |
| `queueDepth`     | `signalk_edge_link_queue_depth`         | count | 0–20          | ≥ 100    | ≥ 500    | Sent packets not yet acknowledged, kept for possible retransmission           |
| `linkQuality`    | `signalk_edge_link_link_quality_score`  | 0–100 | 85–100        | < 70     | < 50     | Composite of RTT, jitter, loss and retransmit rate                            |

Alerts fire when a value reaches the threshold (`>=`).

### Loss and retransmit rate

- `packetLoss` is a loss-event estimate, not a fraction of packets lost. The client keeps a window of the last 50 samples: one per sent packet, and one per NAK or retransmit burst however many packets the burst resends.
- `retransmitRate` is computed two ways. On a client, `GET /metrics`, `/network-metrics` and Prometheus report the lifetime ratio, `retransmissions / packetsOut`. A server with fresh client telemetry reports the client's latest-interval ratio instead, so the server and client values are not the same quantity. Alerts and the Signal K `networking.edgeLink.retransmitRate` path use the ratio over the latest publishing interval. An alert can fire while the API value is still below the threshold.

Other fields: `activeLink`, `dataSource` (`local`, or `remote-client` when a server uses client telemetry received within the last 15 s), and on a server `lastRemoteUpdate`. `/network-metrics` adds `timestamp`.

A server with no client telemetry from the last 15 s (`dataSource: local`) omits `queueDepth` from JSON, but Prometheus still reports `signalk_edge_link_queue_depth 0` (and `signalk_edge_link_retransmissions_total 0`). On a server, 0 in those series does not show that the client's queue is empty; check `dataSource` in `/network-metrics`.

| linkQuality | Status    | Implication                                         |
| ----------- | --------- | --------------------------------------------------- |
| 90–100      | Excellent | Low RTT, minimal loss                               |
| 70–89       | Good      | Acceptable for most use cases                       |
| 50–69       | Degraded  | Congestion control and bonding failover recommended |
| < 50        | Poor      | High loss or latency; data delivery unreliable      |

**No score without a measurement.** `rtt`, `jitter` and `linkQuality` are **omitted**, not reported as `0`, until the link has been measured: on a client, its first timed ACK; on a server, client telemetry carrying an RTT (a server measures no latency itself). The Prometheus series are omitted the same way. Jitter needs two RTT samples, so after the first timed ACK it reads `0`, its seeded value, not a measurement.

`packetLoss`, `retransmissions`, `queueDepth`, `retransmitRate` and `activeLink` may also be **absent**: on a server with no client telemetry from the last 15 s. An absent field means "not reported"; the web UI shows it as `N/A`. A `0` is not always a measurement: a server's record starts at `0` and keeps that seed for any field its peer has not reported (an older build, or a value the ingest validator rejected), and a client that has not sent any packets yet reports `packetLoss` and `retransmitRate` as seeded zeros.

`linkQuality` is withheld unless all four inputs (`rtt`, `jitter`, `packetLoss`, `retransmitRate`) are present, since a substituted zero for any of them can only inflate the score.

---

## Smart Batching Metrics

`GET /metrics` → `smartBatching` (client only; `null` and no Prometheus series in server mode):

| JSON field          | Prometheus                                          | Description                                                                   |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `earlySends`        | `signalk_edge_link_smart_batch_early_sends_total`   | Batches sent before `deltaTimer` because the packet reached the size limit    |
| `timerSends`        | `signalk_edge_link_smart_batch_timer_sends_total`   | Batches sent on the normal timer cadence                                      |
| `oversizedPackets`  | `signalk_edge_link_smart_batch_oversized_total`     | Packets that exceeded `MAX_SAFE_UDP_PAYLOAD` (should always be 0)             |
| `avgBytesPerDelta`  | `signalk_edge_link_smart_batch_avg_bytes_per_delta` | Smoothed packet bytes per delta, packet overhead included                     |
| `maxDeltasPerBatch` | —                                                   | Current batch limit, recalculated from the average delta size after each send |

**Interpretation:**

- `earlySends / (earlySends + timerSends)` > 20% means the batch fills before the timer fires: data arrives faster than one batch per `deltaTimer` holds. Reduce the incoming rate (filter or throttle paths); a longer `deltaTimer` makes it worse
- `oversizedPackets > 0` is a bug unless you have modified `MAX_SAFE_UDP_PAYLOAD`

---

## Error Categories

`errorCounts` (in `GET /metrics` → `stats` and in each `GET /status` instance) counts errors by category. Unknown categories are counted as `general`. Prometheus: `signalk_edge_link_errors_by_category_total{category="..."}`.

| Category       | Also increments      | Description                                                                        |
| -------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `udpSend`      | `udpSendErrors`      | Socket-level send failures                                                         |
| `compression`  | `compressionErrors`  | Brotli codec errors                                                                |
| `encryption`   | `encryptionErrors`   | AES-GCM authentication or key errors                                               |
| `subscription` | `subscriptionErrors` | Signal K subscription failures                                                     |
| `sendFailure`  | —                    | Delta buffer overflow, batch flush errors, packets abandoned after max retransmits |
| `pingTimeout`  | —                    | Seeded at 0                                                                        |
| `crypto`       | —                    | Seeded at 0                                                                        |
| `general`      | —                    | Everything else, including unknown categories                                      |

`recentErrors` holds the latest `{ category, message, timestamp }` entries (last 10 in `/metrics`, last 5 in `/status`) for inspection without server logs.

---

## Bonding Metrics

Fields of the bonding state, relative to `instances[].state` in `GET /bonding` and to the response root of `GET /connections/:id/bonding`:

| JSON field                     | Prometheus                                              | Description                                                                           |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `activeLink`                   | `signalk_edge_link_bonding_active_link`                 | Active link (Prometheus: 1=primary, 2=backup)                                         |
| `links.<l>.status`             | `signalk_edge_link_bonding_link_status{link}`           | Link status (Prometheus: 1=active, 0=standby, -1=other)                               |
| `links.<l>.rtt`                | `signalk_edge_link_bonding_link_rtt_milliseconds{link}` | Heartbeat-measured RTT                                                                |
| `links.<l>.loss`               | `signalk_edge_link_bonding_link_loss_rate{link}`        | Packet loss rate                                                                      |
| `links.<l>.quality`            | `signalk_edge_link_bonding_link_quality{link}`          | Composite quality score (0–100)                                                       |
| `links.<l>.heartbeatsSent`     | —                                                       | Probe count since startup                                                             |
| `links.<l>.heartbeatResponses` | —                                                       | Responses received (difference = unanswered probes, including probes still in flight) |

Each link also reports `address` and `port`.

---

## Fleet Sharing Metrics

`GET /metrics` reports the first connection only; `GET /connections/:id/metrics` reports a given connection. Both include a `fleet` object once fleet sharing has started on that connection ([configuration](configuration-reference.md#fleet-sharing-advancedv3-only), [protocol](protocol-v3-spec.md)); before that, and on connections with fleet sharing off, `fleet` is `null`. When sharing stops (connection stopped, or socket recovery in progress), the counters stay so Prometheus counters do not reset. A server's `state` then reads `disabled`; a client keeps its last `state` until its fleet stream changes. Server and client fields share the object; each side increments only its own. Prometheus exports every numeric field as `signalk_edge_link_fleet_*` (`members`, `contextsKnown` and `minRateFactor` as gauges, the rest as `_total` counters), and `state` as the `fleet_active` gauge (1 when `active`), with only the `mode` and `instance` labels — no vessel, context or path labels. Fleet series appear only while `fleet` is non-null.

| Field                | Side   | Prometheus                                           | Description                                                                                                                                                                                                                                                                                     |
| -------------------- | ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members`            | server | `signalk_edge_link_fleet_members`                    | Sessions currently accepted into the fleet                                                                                                                                                                                                                                                      |
| `packetsSent`        | server | `signalk_edge_link_fleet_packets_sent_total`         | FLEET_DATA packets sent                                                                                                                                                                                                                                                                         |
| `bytesSent`          | server | `signalk_edge_link_fleet_bytes_sent_total`           | FLEET_DATA bytes sent                                                                                                                                                                                                                                                                           |
| `valuesSent`         | server | `signalk_edge_link_fleet_values_sent_total`          | Values sent                                                                                                                                                                                                                                                                                     |
| `retransmits`        | server | `signalk_edge_link_fleet_retransmits_total`          | FLEET_DATA retransmitted on NAK or on timeout; limits in [protocol-v3-spec.md §15.5](protocol-v3-spec.md#15-fleet-sharing-capability-fleet-v1)                                                                                                                                                  |
| `rateLimitedFlushes` | server | `signalk_edge_link_fleet_rate_limited_flushes_total` | Flushes that left values queued because a client's byte budget was spent                                                                                                                                                                                                                        |
| `originDrops`        | server | `signalk_edge_link_fleet_origin_drops_total`         | Uplink deltas and METADATA entries dropped because their vessel belongs to another member (e.g. relayed AIS copies)                                                                                                                                                                             |
| `identityConflicts`  | server | `signalk_edge_link_fleet_identity_conflicts_total`   | Vessel claims moved to a newer session (same vessel reconnected from a new port, or a duplicate)                                                                                                                                                                                                |
| `identityRejected`   | server | `signalk_edge_link_fleet_identity_rejected_total`    | Fleet HELLOs refused: the encrypted identity could not be read, or it declares the server's own vessel                                                                                                                                                                                          |
| `helloDeferred`      | server | `signalk_edge_link_fleet_hello_deferred_total`       | Fleet HELLOs left unanswered because the server's own vessel ID (`mmsi` or `uuid`) is not resolved yet and `includeServerVessel` is off; rising means no client can join until the ID is set                                                                                                    |
| `replayedHellos`     | server | `signalk_edge_link_fleet_replayed_hellos_total`      | Fleet HELLOs ignored as replays: from a session other than the vessel's live owner with a `timestamp` not newer than the owner's newest accepted HELLO, or on a fleet session with a `timestamp` not newer than the HELLO it was last accepted with                                             |
| `keepalivesSent`     | server | `signalk_edge_link_fleet_keepalives_sent_total`      | HELLO_ACK keepalives sent to idle clients                                                                                                                                                                                                                                                       |
| `snapshotsSent`      | server | `signalk_edge_link_fleet_snapshots_sent_total`       | Join snapshots queued                                                                                                                                                                                                                                                                           |
| `staleStreamPackets` | server | `signalk_edge_link_fleet_stale_stream_packets_total` | FLEET_ACK/FLEET_NAK for a stream the session no longer uses                                                                                                                                                                                                                                     |
| `packetsAbandoned`   | server | `signalk_edge_link_fleet_packets_abandoned_total`    | FLEET_DATA given up after the retransmit limit, evicted from the full retransmit queue, or too large for one UDP datagram ([§15.10](protocol-v3-spec.md))                                                                                                                                       |
| `rateBackoffs`       | server | `signalk_edge_link_fleet_rate_backoffs_total`        | Loss-driven rate cuts, at most one per burst of loss; a repeated NAK of a packet already retransmitted does not count ([§15.9](protocol-v3-spec.md))                                                                                                                                            |
| `minRateFactor`      | server | `signalk_edge_link_fleet_min_rate_factor`            | Lowest current rate factor among members; 1 = configured rate. Below 1 means a member's downlink is losing packets                                                                                                                                                                              |
| `state`              | both   | `signalk_edge_link_fleet_active`                     | Client: `disabled`, `offered`, `active`, `declined` (server has fleet sharing off), `not-offered` (no answer after 3 HELLOs: an old server, or a server not reachable at the time; the client keeps sending a HELLO every 60 s). Server: `active` while sharing runs, `disabled` after it stops |
| `packetsReceived`    | client | `signalk_edge_link_fleet_packets_received_total`     | FLEET_DATA accepted                                                                                                                                                                                                                                                                             |
| `valuesReceived`     | client | `signalk_edge_link_fleet_values_received_total`      | Values written into the local tree                                                                                                                                                                                                                                                              |
| `metaReceived`       | client | `signalk_edge_link_fleet_meta_received_total`        | Metadata entries (units, zones, display names) received                                                                                                                                                                                                                                         |
| `contextsKnown`      | client | `signalk_edge_link_fleet_contexts_known`             | Fleet contexts the client remembers for its loop guard: received within the last 24 h, kept across restarts, at most 10000 ([§15.7](protocol-v3-spec.md))                                                                                                                                       |
| `loopDrops`          | client | `signalk_edge_link_fleet_loop_drops_total`           | Uplink deltas dropped because their vessel arrived over the fleet channel, including the values snapshot replayed after a restart                                                                                                                                                               |
| `duplicatePackets`   | client | `signalk_edge_link_fleet_duplicate_packets_total`    | FLEET_DATA already received, replayed, or older than the replay window; not counted toward the inbound packet cap                                                                                                                                                                               |
| `staleValues`        | client | `signalk_edge_link_fleet_stale_values_total`         | Values older than one already applied for the same vessel, source and path                                                                                                                                                                                                                      |
| `rejectedPackets`    | client | `signalk_edge_link_fleet_rejected_packets_total`     | FLEET_DATA or HELLO_ACK rejected: wrong stream, stale nonce, over the inbound packet cap ([§15.10](protocol-v3-spec.md)), or undecodable                                                                                                                                                        |
| `acksSent`           | client | `signalk_edge_link_fleet_acks_sent_total`            | FLEET_ACKs sent                                                                                                                                                                                                                                                                                 |
| `naksSent`           | client | `signalk_edge_link_fleet_naks_sent_total`            | FLEET_NAKs sent                                                                                                                                                                                                                                                                                 |

FLEET_DATA reaches a vessel only while its NAT mapping is open, and the client's outbound packets, including its heartbeats (`heartbeatInterval`), keep it open. `packetsReceived` counts FLEET_DATA only, so it also stays flat when no member has in-scope values to send. The server's `packetsSent` is a total over all members, so it does not show that this client was sent anything. If other members are uplinking in-scope data and this client's `packetsReceived` stays flat while its own uplink works, suspect an expired mapping; see [troubleshooting](troubleshooting.md#fleet-sharing).

---

## Management API Auth Telemetry

`GET /status` and `GET /metrics` include a `managementAuth` block **only when a management token is configured** (`managementApiToken` or `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN`); in open-access mode it is omitted, and `/prometheus` likewise omits `signalk_edge_link_management_auth_requests_total`.

| Field      | Description                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `total`    | Management auth decisions since route registration                                                                                                                    |
| `allowed`  | Decisions that allowed the request                                                                                                                                    |
| `denied`   | Decisions that rejected the request                                                                                                                                   |
| `byReason` | Counts by reason: `open_access`, `valid_token`, `missing_token`, `invalid_token`, `token_required_unconfigured`, `config_read_error`                                  |
| `byAction` | Per route action (`status.read`, `metrics.read`, ...; see [api-reference.md](api-reference.md#endpoint-index)): `total`, `allowed`, `denied`, `reasons`, `byDecision` |

Prometheus: `signalk_edge_link_management_auth_requests_total{decision, reason, action}` (counter). These series carry no `mode` or `instance` label. Token values, transport secrets, client addresses, user agents and raw request paths are never recorded.

---

## Alerts

Alerts run on v2/v3 client instances. A metric alerts when its value is `>=` the `warning` or `critical` threshold. Thresholds are set in `alertThresholds` ([configuration-reference.md](configuration-reference.md#alert-thresholds-client-advancedv3-only)) or with `POST /monitoring/alerts`.

| Metric           | Default warning | Default critical |
| ---------------- | --------------- | ---------------- |
| `rtt`            | 300 ms          | 800 ms           |
| `packetLoss`     | 0.03            | 0.10             |
| `retransmitRate` | 0.05            | 0.15             |
| `jitter`         | 100 ms          | 300 ms           |
| `queueDepth`     | 100             | 500              |

- Notifications (only with `enableNotifications: true`) go to `notifications.signalk-edge-link.<instanceId>.<metric>` (`notifications.signalk-edge-link.<metric>` without an instance ID), with state `warn` for warning and `alert` for critical, and `normal` when the condition clears.
- Notifications per metric are limited to one per 60 s cooldown; a change to a different level, up or down, is sent immediately. A clear is sent only for a metric that was notified.
- `activeAlerts` in `GET /monitoring/alerts` and the gauge follow the live condition regardless of cooldown.
- Prometheus: `signalk_edge_link_alert_<metric>` gauge, 0=ok, 1=warning, 2=critical. One series per metric in `alertThresholds` (plus any active alert), published even when not alerting, so `== 0` rules work. `<metric>` has characters outside `[a-zA-Z0-9_]` replaced by `_`.

---

## Signal K Paths Published

| Signal K path                                   | Type         | Unit    | Description                      |
| ----------------------------------------------- | ------------ | ------- | -------------------------------- |
| `networking.modem.rtt`                          | number       | seconds | v1 external ping RTT             |
| `networking.edgeLink.rtt`                       | number       | ms      | v3 RTT from DATA ACKs            |
| `networking.edgeLink.jitter`                    | number       | ms      | RTT variance                     |
| `networking.edgeLink.packetLoss`                | number       | ratio   | Packet loss (0–1)                |
| `networking.edgeLink.linkQuality`               | number       | 0–100   | Composite link quality           |
| `networking.edgeLink.queueDepth`                | number       | packets | Retransmit queue depth           |
| `networking.edgeLink.retransmissions`           | number       | count   | Retransmitted packets            |
| `networking.edgeLink.retransmitRate`            | number       | ratio   | Retransmissions / packets sent   |
| `networking.edgeLink.sequenceNumber`            | number       | —       | Last published sequence number   |
| `networking.edgeLink.bandwidth.upload`          | number       | B/s     | Outbound throughput              |
| `networking.edgeLink.bandwidth.download`        | number       | B/s     | Inbound throughput               |
| `networking.edgeLink.packetsPerSecond.sent`     | number       | pkt/s   | Outbound packet rate             |
| `networking.edgeLink.packetsPerSecond.received` | number       | pkt/s   | Inbound packet rate              |
| `networking.edgeLink.compressionRatio`          | number       | %       | Compression ratio                |
| `networking.edgeLink.activeLink`                | string       | —       | Active bonded link name          |
| `networking.edgeLink.links.<link>.status`       | string       | —       | Per-link status                  |
| `networking.edgeLink.links.<link>.rtt`          | number       | ms      | Per-link RTT                     |
| `networking.edgeLink.links.<link>.loss`         | number       | ratio   | Per-link loss ratio              |
| `networking.edgeLink.links.<link>.quality`      | number       | 0–100   | Per-link quality score           |
| `notifications.signalk-edge-link.<name>.*`      | notification | —       | Alert events ([Alerts](#alerts)) |

When an instance ID is configured, the paths are namespaced as `networking.edgeLink.<instanceId>.*` and `networking.modem.<instanceId>.rtt`.

---

## Prometheus Metrics

`GET /prometheus` returns text format (`text/plain; version=0.0.4`) for all instances. Series names are listed in the tables above. Names ending in `_total` are counters; all others are gauges.

| Series group                                                | Where listed                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| Deltas, errors, bytes, packets, bandwidth, metadata, uptime | [Core Transport Metrics](#core-transport-metrics)               |
| ACK/NAK, retransmissions, data packets                      | [Reliability Metrics](#reliability-metrics-advanced-v3-only)    |
| RTT, jitter, loss, retransmit rate, queue, link quality     | [Link Quality Metrics](#link-quality-metrics)                   |
| Smart batching                                              | [Smart Batching Metrics](#smart-batching-metrics)               |
| Bonding (`link` label)                                      | [Bonding Metrics](#bonding-metrics)                             |
| Fleet                                                       | [Fleet Sharing Metrics](#fleet-sharing-metrics)                 |
| `alert_<metric>`                                            | [Alerts](#alerts)                                               |
| Management auth                                             | [Management API Auth Telemetry](#management-api-auth-telemetry) |

Every series except the management-auth one carries a `mode` label (`"client"` or `"server"`), plus an `instance` label when an instance ID is configured. Smart-batching series are client only; RTT, jitter and link-quality series are omitted until the link has a timed RTT; loss and retransmit-rate series are omitted only while their own value is absent; bonding series appear only with bonding enabled.

### Prometheus scrape configuration

`/prometheus` goes through the same management-auth check as every other route. With no token configured and `requireManagementApiToken` off, a scrape needs no credentials. Once a token is set, an unauthenticated scrape gets 401 and Prometheus marks the target down, which blanks dashboards.

```yaml
scrape_configs:
  - job_name: "signalk-edge-link"
    scrape_interval: 15s
    metrics_path: "/plugins/signalk-edge-link/prometheus"
    authorization:
      type: Bearer
      # Prefer credentials_file so the token is not stored in prometheus.yml.
      credentials_file: /etc/prometheus/signalk-edge-link.token
    static_configs:
      - targets: ["signalk-server:3000"]
```

Drop the `authorization` block only on an install with no token; [security.md](security.md) explains why that state is not recommended. No Grafana dashboard JSON is bundled; build one from these series.

---

## Source Replication Metrics

The server keeps a source-registry replica built from client-provided update metadata, readable at `GET /sources`.

Schema version 1 fields:

- **Required identity:** `identity.label`, `identity.type`
- **Optional identity:** `identity.src`, `identity.instance`, `identity.pgn`, `identity.deviceId`
- **Timestamps:** `firstSeenAt`, `lastSeenAt`, `lastUpdatedAt`
- **Provenance:** `provenance.lastUpdatedBy`, `provenance.sourceClientInstanceId`, `provenance.updateTimestamp`

Merge counters, `GET /metrics` → `sourceReplication.metrics`:

| Counter           | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `upserts`         | New sources registered or existing entries updated                   |
| `noops`           | Incoming data identical to stored state (deduplicated via mergeHash) |
| `missingIdentity` | Records dropped due to missing required identity fields              |
| `conflicts`       | Conflicting field values resolved by latest timestamp                |

```bash
curl -H "X-Edge-Link-Token: $TOKEN" \
  http://localhost:3000/plugins/signalk-edge-link/sources | jq .
```
