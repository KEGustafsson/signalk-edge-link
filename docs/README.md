# Documentation Guide

This folder contains documentation for Signal K Edge Link (current: 2.8.0).

## Primary Reference

**[GUIDE.md](GUIDE.md)** — The single comprehensive reference covering all concepts, configuration, API, protocols, monitoring, security, performance, and troubleshooting.

Start here for any question about configuring, operating, or extending the plugin.

## Wire Protocol Specification

**[protocol-v2-spec.md](protocol-v2-spec.md)** — RFC-style specification of the binary wire format, packet types, flags, CRC16, sequence semantics, and METADATA envelope schema. Read this for bit-level implementation details not covered in GUIDE.md.

## Process Docs

- **[release-checklist.md](release-checklist.md)** — Steps to follow before publishing a release
- **[future-security-and-protocol-roadmap.md](future-security-and-protocol-roadmap.md)** — Planned key-rotation, key-agreement, and protocol-migration features

## Migration

- **[migration/v1-to-v2.md](migration/v1-to-v2.md)** — Practical migration path from protocol v1 to v2

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

- `../grafana/dashboards/edge-link.json` — Starter dashboard for RTT, loss, retransmit, ACK/NAK, and bonding trends

## Reading Order

### New end users

1. `../README.md` (installation and quick start)
2. `GUIDE.md` (full reference)

### Operators tuning unstable links

1. `GUIDE.md` §9 Congestion Control, §10 Bonding, §17 Performance Tuning

### Security hardening

1. `GUIDE.md` §12 Encryption & Keys, §15 Management API

### Contributors

1. `GUIDE.md` §18 Developer Reference
2. `protocol-v2-spec.md`
3. `release-checklist.md`
4. `planning/` and `performance/` docs relevant to your area
