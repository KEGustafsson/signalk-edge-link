# Batch 1 - Route auth hardening

- Status: draft
- Base: main
- Head: multi_test_v2
- Commit: 0ebf47248b7c8a47db6873ae2245850fdc738a86
- Created: 2026-03-07T23:49:48.9930781+02:00

## Summary

Scope: protected management-token coverage for config, monitoring, capture, delta-timer, and failover routes; redacted secretKey values from GET /plugin-config; preserved persisted secretKey values when the [redacted] sentinel is submitted unchanged; added focused auth and redaction regression tests.

