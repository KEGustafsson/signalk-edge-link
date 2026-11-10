# Documentation Index

Documentation for Signal K Edge Link (current: 4.4.0).

Start with [GUIDE.md](GUIDE.md), the setup and operations guide. It links to the reference docs below, which own the settings, API, metrics and wire format.

## Operator docs

| Doc                                                      | Covers                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [GUIDE.md](GUIDE.md)                                     | Setup and operations: install, first link, topologies, keys, upgrades (start here) |
| [configuration-reference.md](configuration-reference.md) | Every setting with defaults and valid ranges                                       |
| [configuration-schema.json](configuration-schema.json)   | JSON Schema of the configuration payload                                           |
| [web-ui.md](web-ui.md)                                   | Configuration panel and runtime dashboard (server, client, relay nodes)            |
| [api-reference.md](api-reference.md)                     | REST endpoints, request and response shapes, rate limit                            |
| [management-tools.md](management-tools.md)               | Management API token, web UI token injection, CLI                                  |
| [metrics.md](metrics.md)                                 | JSON metrics, Signal K paths, Prometheus output, alerts                            |
| [protocol-v3.md](protocol-v3.md)                         | How Basic (v1) and Advanced (v3) modes work                                        |
| [bonding.md](bonding.md)                                 | Dual-link failover                                                                 |
| [congestion-control.md](congestion-control.md)           | Send-rate control and tuning                                                       |
| [performance-tuning.md](performance-tuning.md)           | Settings profiles by hardware and link type                                        |
| [security.md](security.md)                               | Encryption, keys, deployment hardening                                             |
| [troubleshooting.md](troubleshooting.md)                 | Symptoms and fixes, including relay chains                                         |
| [migration/v2-to-v3.md](migration/v2-to-v3.md)           | Upgrading from protocol v2; automatic coercion of `protocolVersion: 2`             |
| [`../samples/`](../samples/)                             | Sample configs: minimal, development, bonding, v3 control, fleet sharing           |

No Grafana dashboard ships with the plugin; build one from the `/prometheus` metrics described in [metrics.md](metrics.md).

## Contributor docs

| Doc                                                                                | Covers                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [protocol-v3-spec.md](protocol-v3-spec.md)                                         | Normative wire format: header, packet types, flags, CRC16, HMAC, fleet sharing                        |
| [architecture-overview.md](architecture-overview.md)                               | Source modules and client/server data flow                                                            |
| [release-checklist.md](release-checklist.md)                                       | Commands to run before publishing                                                                     |
| [future-security-and-protocol-roadmap.md](future-security-and-protocol-roadmap.md) | Future security and protocol design options: online key rotation, key agreement, protocol v4, scaling |
| [`planning/`](planning/)                                                           | Historical v2 design notes: pipeline, ACK/NAK, sequence tracker, metrics                              |
| [`performance/`](performance/)                                                     | Historical benchmark results (phases 1, 2, 7) and a parameter-impact report                           |

The `planning/` and `performance/` records describe the code at the time they were written; file names and protocol versions in them may no longer exist.
