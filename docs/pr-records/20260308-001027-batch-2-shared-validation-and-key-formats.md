# Batch 2 - Shared validation and key formats

- Status: draft
- Base: main
- Head: multi_test_v2
- Commit: 5ea4cc8215610514cf48689fdf1965a8f8ebfb1d
- Created: 2026-03-08T00:10:27.2080877+02:00

## Summary

Scope: extracted shared connection validation/sanitization, reused it in /plugin-config, /instances, and migrate-config, expanded supported secretKey formats across runtime/schema/docs, and added regression coverage for merged instance updates plus hex/base64 secrets.

