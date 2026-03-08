# Metrics reference (v2 + bonding)

This document summarizes runtime metrics used for monitoring Edge Link behavior.

## Core transport metrics

- `deltasSent` / `deltasReceived`
- `packetsSent` / `packetsReceived`
- `bytesSent` / `bytesReceived`
- `compressionErrors`, `encryptionErrors`, `udpSendErrors`
- `errorCounts` (categorized totals) and `recentErrors` (recent categorized events)
- `malformedPackets` (dropped malformed/corrupted packet count)

## Reliability metrics

- `acksSent`
- `naksSent`
- `duplicatePackets`
- `dataPacketsReceived`
- `retransmissions`

## Link quality metrics

- `rtt`
- `jitter`
- `packetLoss`
- `queueDepth`
- `retransmitRate`

## Bonding-related metrics

- active link selection state
- failover/failback event counts (when exposed by integration)
- per-path quality snapshots

## Prometheus endpoint

Notable exported counters include:

- `signalk_edge_link_errors_by_category_total{category=...}`
- `signalk_edge_link_malformed_packets_total`


Prometheus text-format metrics are exposed at:

- `GET /prometheus`

Use this endpoint for dashboard and alerting ingestion.

## JSON monitoring endpoints

For JSON consumers, use:

- `GET /metrics`
- `GET /network-metrics`
- `GET /connections/:id/metrics`
- `GET /connections/:id/network-metrics`

## Related docs

- `docs/api-reference.md`
- `docs/protocol-v2.md`
- `docs/bonding.md`
- `grafana/dashboards/edge-link.json`
