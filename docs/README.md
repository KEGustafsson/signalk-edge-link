# Documentation Guide

This folder includes both **end-user documentation** and **internal engineering documents**.

If you are configuring or operating the plugin, start with the user docs below.

## End-user docs

- `../README.md` - Quick start, installation, protocol choice, and links to detailed references
- `configuration-reference.md` - Complete configuration keys, defaults, ranges, and examples
- `api-reference.md` - REST endpoints, response examples, and monitoring/control routes
- `troubleshooting.md` - Diagnostic workflows and symptom-based fixes
- `migration/v1-to-v2.md` - Practical migration path from protocol v1 to v2
- `protocol-v2-spec.md` - Protocol behavior and packet-level specification
- `protocol-v2.md` - Operational v2 overview (reliability, ACK/NAK, congestion, bonding)
- `bonding.md` - Bonding concepts, endpoint usage, and tuning notes
- `congestion-control.md` - Congestion-control behavior and tuning workflow
- `metrics.md` - Runtime and Prometheus-oriented metrics reference
- `management-tools.md` - Practical API and CLI operations for instances/bonding
- `security.md` - Security hardening and operational best practices
- `performance-tuning.md` - Tuning guidance for embedded and server deployments

## Performance reports

- `performance/phase-1-baseline.md`
- `performance/phase-2-results.md`
- `performance/phase-7-results.md`

These are benchmarking and optimization records from development phases.

## Sample configs

- `../samples/` - Sample config files for minimal, development, and v2-bonding setups

## Dashboard assets

- `../grafana/dashboards/edge-link.json` - Starter dashboard for RTT, loss, retransmit, ACK/NAK and bonding trends

## Planning and design records

- `planning/pipeline-analysis.md`
- `planning/pipeline-v2-design.md`
- `planning/ack-nak-design.md`
- `planning/sequence-spec.md`
- `planning/metrics-spec.md`
- `planning/phase-1-completion.md`
- `planning/phase-2-completion.md`
- `planning/phase-3-completion.md`

These are architecture/design notes retained for contributors and maintainers.

## Reading order recommendations

### New end users

1. `../README.md`
2. `configuration-reference.md`
3. `troubleshooting.md`

### Operators tuning unstable links

1. `../README.md` (Protocol v2 guidance)
2. `api-reference.md` (metrics and monitoring endpoints)
3. `protocol-v2-spec.md` (deeper behavior details)

### Contributors

1. `../README.md`
2. `protocol-v2-spec.md`
3. `planning/` and `performance/` docs relevant to your area
