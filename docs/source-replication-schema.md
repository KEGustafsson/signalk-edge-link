# Source Replication Schema (v1)

The server maintains a normalized source-registry replica of client-provided update metadata.

## Versioned contract

- `schemaVersion: 1`
- Required identity fields:
  - `identity.label`
  - `identity.type`
- Optional identity fields:
  - `identity.src`, `identity.instance`, `identity.pgn`, `identity.deviceId`
- Optional metadata fields:
  - `metadata.*` (copied from `update.source` payload)
- Timestamps:
  - `firstSeenAt`, `lastSeenAt`, `lastUpdatedAt`
- Provenance:
  - `provenance.lastUpdatedBy`
  - `provenance.sourceClientInstanceId`
  - `provenance.updateTimestamp`
- Diagnostics/raw retention:
  - `raw.source`
  - `raw.$source`
  - `mergeHash` (deterministic no-op dedupe)

## Canonicalization rules

- Registry key is deterministic and derived from sanitized identity fields:
  - `source-ref:$source` when `$source` is present
  - otherwise `source-identity:<sha256(canonical-identity)>` where canonical identity is derived from `identity.type/label/src/instance/pgn/deviceId`
- Values are sanitized to lowercase-safe key tokens for the key material.
- `source` payload fields are preserved as provided by the client (no special parsing of labels such as `ws.*`).
- Legacy `$source` values are retained as-is and used as the primary deterministic source key.

## Merge policy

- Field-level merge is deterministic.
- Empty/undefined incoming fields never clear non-empty existing fields.
- Conflicting values are resolved by latest update timestamp (`update.timestamp`, fallback to the current time when absent).
- Identical post-merge state is deduped via `mergeHash` and counted as no-op.

## Backward compatibility

- Legacy compatibility shape is preserved in API responses:
  - `legacy.byLabel[label] -> canonicalKey`
  - `legacy.bySourceRef[$source] -> canonicalKey`
- Existing delta forwarding remains unchanged (`update.source` and `$source` still forwarded to Signal K).
- Partial legacy deltas containing only `$source` are accepted and merged incrementally.

## API exposure

- `GET /sources` returns the full registry snapshot.
- `GET /metrics` includes `sourceReplication.metrics` only (full registry remains on `GET /sources`).
- Source replication is populated from normal DATA delta ingest (`update.source` / `$source`) and is independent of optional metadata packet streaming (`updates[].meta` snapshot/diff flow).
