# Conformance harness

The frozen wire/codec conformance suite for the productization rewrite
(see `docs/planning/rewrite/03-frozen-conformance-spec.md` and
`docs/planning/rewrite/06-test-strategy.md`).

It is the **executable definition of "correct"** that the rewrite targets:
the new layered codec must reproduce every committed vector byte-for-byte,
and every phase must keep this suite green.

## Files

| Path                          | Role                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `build-vectors.js`            | Pure, deterministic vector builder. Injected with codec modules.        |
| `generate-vectors.js`         | CLI generator (uses compiled `lib/**`). Writes the committed vectors.   |
| `conformance.test.js`         | Asserts the **source** reproduces the vectors + round-trips + decrypts. |
| `vectors/golden.json`         | Deterministic wire/codec vectors. Regenerated; diffs must be reviewed.  |
| `vectors/crypto-decrypt.json` | Frozen AES-256-GCM ciphertext (random IV baked in). Immutable.          |

## How it stays honest

`build-vectors.js` runs identical logic over identical fixed inputs from two
entry points:

- `generate-vectors.js` injects the **compiled** modules to emit
  `vectors/golden.json`.
- `conformance.test.js` injects the **source** modules (through the
  `lib/** → src/**` Jest `moduleNameMapper`) and asserts equality with the
  committed file.

A green test therefore proves: **source === frozen golden === compiled lib**.

CI additionally regenerates `golden.json` from a fresh build and fails on any
diff (`.github/workflows/ci.yml`).

## Regenerating

```sh
npm run conformance:generate   # build:ts + node generate-vectors.js
```

- `golden.json` is always rewritten; a diff means a wire/codec change — review
  it as a protocol decision, not a refactor.
- `crypto-decrypt.json` is written only once and preserved thereafter (its
  random IVs cannot be reproduced). Delete the file to force regeneration —
  only with a reviewed protocol decision.

## Coverage today

CRC16-CCITT · v3 control packets (ACK/ACK+window/NAK/HEARTBEAT/META_REQUEST/
FULL_STATUS_REQUEST) + HMAC auth tags + tamper rejection · AES-256-GCM decrypt
for hex/base64/ASCII(raw)/ASCII(stretched) keys + stretch-mismatch rejection ·
compact-delta · value-dedup · path-dictionary · metadata envelope.

Extended per-flag DATA/METADATA and source-snapshot envelope vectors are added
in Phase 1 as those codecs are re-implemented (doc 06 §6.1).
