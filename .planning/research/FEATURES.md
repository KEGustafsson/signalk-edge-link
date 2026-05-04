# Research: Features

**Source:** Local codebase map
**Date:** 2026-04-30

## Existing Product Features

- Multi-connection plugin configuration.
- Client and server modes.
- Encrypted UDP data transport.
- Reliable UDP variants with retransmission, ACK/NAK, sequencing, bonding, and congestion control.
- Optional compression and binary encoding.
- Metadata and source replication support.
- Runtime configuration files with atomic save and file watching.
- Management REST APIs for status, config, metrics, monitoring, Prometheus, and packet capture.
- CLI management commands.
- React/RJSF configuration UI.
- Prometheus formatting and Signal K metrics publishing.

## Operator Workflows

- Configure one or more peer links.
- Start or restart plugin instances through Signal K.
- Observe connection health, metrics, errors, and alerts.
- Adjust monitoring thresholds and runtime configuration.
- Package and publish built `lib/` and `public/` artifacts.

## Contributor Workflows

- Update shared schema, backend validation, webapp behavior, docs, and samples together.
- Add focused tests before changing lifecycle or reliable transport behavior.
- Run build and packaging checks before release.

## Planning Implications

The first milestone should not add a large new product surface. It should protect the existing feature set by improving docs, release checks, security observability, lifecycle coverage, transport coverage, and schema parity.
