# Documentation Guide

This folder contains documentation for Signal K Edge Link (current: 3.0.0).

## Primary Reference

**[GUIDE.md](GUIDE.md)** — The single comprehensive reference covering all concepts, configuration, API, protocols, monitoring, security, performance, and troubleshooting.

Start here for any question about configuring, operating, or extending the plugin.

## Focused Topic References

These docs cover individual topics in depth and can be read independently:

- **[architecture-overview.md](architecture-overview.md)** — System architecture, topology patterns, and data-flow pipelines
- **[configuration-reference.md](configuration-reference.md)** — Complete settings reference with defaults and valid ranges
- **[api-reference.md](api-reference.md)** — REST API endpoint reference
- **[protocol-v2.md](protocol-v2.md)** — Basic (v1) and v2 protocol wire format and ACK/NAK handshake
- **[protocol-v3-spec.md](protocol-v3-spec.md)** — Advanced (v3) HMAC control-plane authentication
- **[bonding.md](bonding.md)** — Dual-link failover configuration and monitoring
- **[congestion-control.md](congestion-control.md)** — AIMD adaptive send-rate algorithm and tuning
- **[metrics.md](metrics.md)** — All metrics: REST, Signal K paths, and Prometheus
- **[management-tools.md](management-tools.md)** — Management API auth and CLI operations
- **[security.md](security.md)** — Encryption, key management, and deployment hardening
- **[performance-tuning.md](performance-tuning.md)** — Deployment profiles by hardware and link type
- **[troubleshooting.md](troubleshooting.md)** — Issue-oriented diagnostics and common fixes

## Wire Protocol Specification

**[protocol-v2-spec.md](protocol-v2-spec.md)** — RFC-style specification of the binary wire format, packet types, flags, CRC16, sequence semantics, and METADATA envelope schema. Read this for bit-level implementation details not covered in GUIDE.md.

## Process Docs

- **[release-checklist.md](release-checklist.md)** — Steps to follow before publishing a release
- **[future-security-and-protocol-roadmap.md](future-security-and-protocol-roadmap.md)** — Planned key-rotation, key-agreement, and protocol-migration features

## Migration

- **[migration/v1-to-v2.md](migration/v1-to-v2.md)** — Practical migration path from protocol v1 to v2
- **[migration/v2-to-v3.md](migration/v2-to-v3.md)** — Upgrading a v2 link to the authenticated v3 control plane (default in 3.0.0)

## Performance Reports

- `performance/phase-1-baseline.md`
- `performance/phase-2-results.md`
- `performance/phase-7-results.md`

Benchmarking and optimization records from development phases.

## Planning and Design Records

- `planning/pipeline-analysis.md`
- `planning/pipeline-v2-design.md`
- `planning/ack-nak-design.md`
- `planning/sequence-spec.md`
- `planning/metrics-spec.md`
- `planning/phase-1-completion.md`
- `planning/phase-2-completion.md`
- `planning/phase-3-completion.md`

Architecture and design notes retained for contributors and maintainers.

## Sample Configs

- `../samples/` — Sample config files for minimal, development, and v2-bonding setups

## Dashboard Assets

- Grafana: build a dashboard from the `/prometheus` metrics (RTT, loss, retransmit, ACK/NAK, bonding). No dashboard JSON ships with the plugin.

## Reading Order

### New end users

1. `../README.md` (installation and quick start)
2. `GUIDE.md` (full reference)

### Operators tuning unstable links

1. [congestion-control.md](congestion-control.md)
2. [bonding.md](bonding.md)
3. [performance-tuning.md](performance-tuning.md)

### Security hardening

1. [security.md](security.md)
2. [management-tools.md](management-tools.md)

### Contributors

1. `GUIDE.md` §20 Developer Reference
2. `protocol-v2-spec.md`
3. `release-checklist.md`
4. `planning/` and `performance/` docs relevant to your area
