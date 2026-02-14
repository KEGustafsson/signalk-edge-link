# Changelog

All notable changes to Signal K Edge Link are documented in this file.

## [2.0.0] - 2026-02-14

### Summary

Signal K Edge Link v2.0 is a major release adding production-grade reliability, monitoring, and resilience to UDP data transmission between Signal K servers.

### Added

#### Phase 1: v2 Binary Protocol
- Binary packet protocol with 15-byte headers (magic bytes, version, type, flags, sequence, CRC16)
- Five packet types: DATA, ACK, NAK, HEARTBEAT, HELLO
- Flag-based feature negotiation (compression, encryption, msgpack, path dictionary)
- CRC-CCITT integrity checking on packet headers
- Sequence tracking for packet loss detection
- Pipeline factory for v1/v2 protocol selection
- v2 client and server pipeline implementations
- Backward compatibility with v1 (auto-detection via magic bytes)

#### Phase 2: Reliability Layer
- ACK/NAK retransmission mechanism for reliable delivery (>99.9% at 5% loss)
- Retransmit queue with bounded storage (5,000 packets max)
- Cumulative ACK scheme to reduce control traffic
- Selective NAK for targeted retransmission
- Network simulator for testing under adverse conditions
- Reliability integration tests with simulated packet loss

#### Phase 3: Network Quality Metrics
- 13 network quality metrics published to Signal K paths
- RTT, jitter, packet loss, retransmit rate, link quality score
- Metrics publisher for Signal K data model integration
- Network metrics REST endpoint (`GET /network-metrics`)
- Network quality display in web dashboard with link quality gauge

#### Phase 4: Dynamic Congestion Control
- AIMD (Additive Increase, Multiplicative Decrease) algorithm
- Automatic delta timer adjustment based on RTT and packet loss
- EMA smoothing for stable metric tracking
- Manual override via REST API (`POST /delta-timer`)
- Congestion state endpoint (`GET /congestion`)
- 11 configurable congestion control constants

#### Phase 5: Connection Bonding
- Dual-link bonding with primary/backup failover
- Independent per-link health monitoring via heartbeat probes
- Automatic failover on RTT threshold, loss threshold, or link down
- Failback with configurable delay and hysteresis to prevent oscillation
- Per-link metrics publishing to Signal K
- Signal K notifications on failover events
- Manual failover trigger (`POST /bonding/failover`)
- Bonding state endpoint (`GET /bonding`)

#### Phase 6: Enhanced Monitoring
- Packet loss heatmap with time-bucketed tracking and trend analysis
- Per-path latency tracking with percentile statistics (p50, p95, p99)
- Retransmission rate chart with time-series data
- Alert thresholds system with warning/critical levels and Signal K notifications
- Packet capture to `.pcap` format (libpcap compatible)
- Live packet inspector via WebSocket
- Prometheus metrics exporter (30+ metrics with labels)
- Pre-built Grafana dashboard JSON (15+ panels)
- Network simulation mode with bandwidth throttling

#### Phase 7: Testing & Validation
- Enhanced network simulator with throttle patterns (constant, step-down, sawtooth, burst)
- Asymmetric loss simulation (independent per direction)
- Burst and correlated loss (Gilbert-Elliott model)
- Latency spike simulation
- Bandwidth efficiency benchmarks (21.6x compression at 50 deltas/batch)
- CPU profiling benchmarks (full TX 1,087 ops/sec, monitoring <0.1us overhead)
- Memory leak testing (all bounded buffers, 3.4 MB growth over 100k iterations)
- Latency percentile benchmarks (full pipeline p99 = 2.07ms)
- System-level validation tests

#### Phase 8: Documentation & Release
- Complete protocol v2.0 specification (14 sections)
- API reference documentation (30+ endpoints)
- Configuration reference with all settings documented
- Migration guide from v1 to v2 with examples
- Troubleshooting guide
- Configuration migration script (`scripts/migrate-config-v2.js`)
- CHANGELOG

### Changed

- Minimum Node.js version raised to 14.0.0
- Package version bumped from 1.0.0 to 2.0.0
- README updated with v2.0 features and documentation links
- Test badge updated to reflect 743+ tests

### Performance

| Metric | Value |
|--------|-------|
| Delivery rate @ 5% loss | >99.9% |
| Dual-link failover time | <2 seconds |
| Full pipeline latency (p99) | 2.07 ms |
| Compression ratio (50 deltas) | 21.6x |
| CPU overhead (monitoring) | <0.1 us/operation |
| Memory stability | Bounded (3.4 MB over 100k ops) |
| Total tests | 743+ passing |

---

## [1.0.0] - 2024-01-01

### Added

- Initial release
- AES-256-GCM encrypted UDP data transmission
- Brotli compression (quality 10) with 85-97% bandwidth reduction
- MessagePack binary serialization (optional)
- Path dictionary encoding with 170+ Signal K paths
- Smart batching with adaptive packet sizing (prevents UDP fragmentation)
- Sentence filtering for NMEA data
- Network monitoring with TCP ping RTT measurement
- Web dashboard with real-time bandwidth and path analytics
- Hot-reload configuration files (delta_timer, subscription, sentence_filter)
- Rate-limited REST API (20 req/min/IP)
- React-based configuration UI panel
