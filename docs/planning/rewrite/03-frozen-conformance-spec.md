# 03 — Frozen Conformance Specification

Everything in this document is an external/wire contract or a proven
internal invariant. The rewrite MUST reproduce it exactly. Each item is
backed by a golden-vector fixture in `__conformance__/` (doc 06). Any
change here is a protocol decision requiring separate review — not a
refactor.

## 1. Packet wire format (`packet.ts`)

### Header — 15 bytes, big-endian

| Offset | Size | Field          | Notes                            |
| ------ | ---- | -------------- | -------------------------------- |
| 0      | 2    | Magic          | `0x53 0x4B` ("SK")               |
| 2      | 1    | Version        | `0x03` (v3); `0x02` rejected     |
| 3      | 1    | Type           | see PacketType                   |
| 4      | 1    | Flags          | bitmask, see PacketFlags         |
| 5      | 4    | Sequence       | uint32 BE, wraps at `0xFFFFFFFF` |
| 9      | 4    | Payload length | uint32 BE                        |
| 13     | 2    | CRC16-CCITT    | over header bytes 0..12          |

Constants: `HEADER_SIZE = 15`, `MAGIC = [0x53,0x4B]`,
`PROTOCOL_VERSION_V3 = 0x03`, `MAX_SEQUENCE = 0xFFFFFFFF`.

> **Protocol scope (decision, doc 08 Q3): keep v1 and v3, REMOVE v2.**
> v3 is "v2 + authenticated control packets" — it keeps the entire reliable
> binary stack (sequence, ACK/NAK, retransmit, congestion, bonding,
> metadata, this packet format). Removing v2 removes ONLY the unauthenticated
> CRC-based control-plane variant. Consequences for this spec:
>
> - `SUPPORTED_PROTOCOL_VERSIONS = {0x03}` for the binary protocol (v1 is the
>   separate legacy JSON pipeline, not a binary version byte).
> - Header byte `0x02` is **rejected** by the parser (treated as
>   unsupported/malformed).
> - The control-packet CRC trailer path is deleted; control packets are
>   ALWAYS HMAC-authenticated (see Payload trailers below).
> - The header CRC16 (offset 13) is UNAFFECTED — it stays for all packets.
> - Golden vectors are generated for v1 and v3 only; v2 vectors are not
>   produced. This is a breaking change for any peer still speaking v2 (see
>   doc 04 §migration).
> - Config-level back-compat is separate from the wire: a stored
>   `protocolVersion: 2` is ACCEPTED and coerced to v3 at load (doc 04 §2.1).
>   The `0x02` rejection here is about packets on the wire, not config.

### PacketType

`DATA=0x01, ACK=0x02, NAK=0x03, HEARTBEAT=0x04, HELLO=0x05,
METADATA=0x06, META_REQUEST=0x07, FULL_STATUS_REQUEST=0x08`.

### PacketFlags (bit positions)

`COMPRESSED=0x01, ENCRYPTED=0x02, MESSAGEPACK=0x04, PATH_DICTIONARY=0x08`.

### CRC16-CCITT

Polynomial `0x1021`, init `0xFFFF`, computed over header bytes 0..12. A
precomputed 256-entry table is used (`crc16(data)`); reuse verbatim.

### Payload trailers (v3 only — v2 CRC trailer removed)

- **DATA / METADATA**: payload is AEAD ciphertext that already embeds
  `[IV(12)][ciphertext][authTag(16)]` from `encryptBinary`. No separate
  trailer.
- **Control packets** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST,
  FULL_STATUS_REQUEST): append HMAC-SHA256 tag truncated to
  `CONTROL_AUTH_TAG_LENGTH = 16` bytes, covering header[0..12] + payload
  (`createControlPacketAuthTag`). Verification is mandatory; a control
  packet that fails HMAC is dropped and counted.
- The old v2 behavior (2-byte CRC trailer on non-empty control payloads,
  no trailer on empty HEARTBEAT/META_REQUEST) is **removed**. The
  `usesAuthenticatedControl()` helper becomes vestigial (always true for the
  binary protocol) and can be deleted along with the CRC-trailer branch.

### Control payload encodings

- ACK payload: 4 bytes `sequence` (uint32 BE), or 8 bytes
  `sequence + receiveWindow` (uint32 BE each). Parsers:
  `parseACKPayload` (seq only), `parseACKPayloadFull` (seq + optional
  window).
- NAK payload: N × 4 bytes, each a missing `sequence` (uint32 BE).
  `parseNAKPayload` returns the array.
- HELLO payload: JSON of `{protocolVersion, clientId, instanceId,
capabilities[]}`, bounded by `HELLO_PAYLOAD_MAX_BYTES = 4096`.
- METADATA / source-snapshot envelopes: see §6.

### Sequence numbering

- DATA uses one counter; METADATA uses a _separate_ `_metaSequence`
  counter. Both wrap at `MAX_SEQUENCE`.
- Serial-number comparisons use uint32 arithmetic with half-range
  (`0x80000000`) as the distance threshold (RFC-1982 style). The same
  convention is used in `sequence.ts` and `retransmit-queue.ts`.

## 2. Cryptography (`crypto.ts`, `shared/crypto-constants.ts`)

- **AEAD:** AES-256-GCM. `encryptBinary` returns
  `[IV(12)][ciphertext][authTag(16)]`. `decryptBinary` reverses and throws
  on auth failure. `IV_LENGTH = 12`, `AUTH_TAG_LENGTH = 16`. IV is fresh
  `crypto.randomBytes(12)` per call (no reuse).
- **Key normalization (`normalizeKey`)** accepts:
  - 64-char hex → 32 bytes,
  - 44-char base64 → 32 bytes,
  - 32-char ASCII → 32 bytes (raw), or PBKDF2-stretched if
    `stretchAsciiKey: true`.
- **Key stretching:** PBKDF2-SHA256, salt `"signalk-edge-link-v1"`,
  iterations `PBKDF2_ITERATIONS = 600_000`, output 32 bytes
  (`deriveKeyFromPassphrase`). Both peers must agree on `stretchAsciiKey`.
- **Derived-key cache:** per-process LRU keyed by SHA-256(key material),
  max 32 entries; plaintext keys never retained.
- **Control auth (v3):** `createControlPacketAuthTag` /
  `verifyControlPacketAuthTag` = HMAC-SHA256 truncated to 16 bytes,
  timing-safe compare. `CONTROL_AUTH_TAG_LENGTH = 16`.
- **Key validation (`validateSecretKey`):** entropy/diversity checks,
  Shannon entropy ≥ 3.0 bits/char.

> Hardening (additive, see doc 07 phase 6): a capability/version signal so a
> `stretchAsciiKey` mismatch yields a typed, logged `DecryptError` instead
> of silent total failure. This must NOT change the bytes of a correctly
> matched exchange (golden vectors stay valid).

## 3. Reliability algorithm (`sequence.ts`, `retransmit-queue.ts`)

### SequenceTracker

State: `expectedSeq`, `receivedSeqs` set, `nakTimers`. Config:
`maxOutOfOrder` (100), `nakTimeout` (100ms), `maxGapTracking`,
`behindResyncThreshold`. `processSequence(seq)` returns
`{inOrder, missing[], duplicate, resynced}`:

- duplicate if seq already received;
- buffers out-of-order, advances `expectedSeq` only on contiguous arrival;
- schedules NAK timers for gaps (fire after `nakTimeout`);
- resyncs on gap > `maxGapTracking` or falling behind beyond
  `behindResyncThreshold`.

### RetransmitQueue

Bounded `Map<seq, {packet, timestamp, originalTimestamp, attempts}>`.
Defaults `maxSize=5000`, `maxRetransmits=3`. `add` evicts oldest at
capacity. `acknowledge(cumulativeSeq)` and `acknowledgeRange(prev, cum)`
remove acked packets (serial-aware, wraparound-safe). `retransmit(seqs)`
increments attempts, drops at `maxRetransmits`. `getOldestSequences(limit,
minRetransmitAge)` for recovery bursts. `expireOld(maxAge)` prunes by age.
Aging is RTT-tuned by the pipeline:
`maxAge = clamp(smoothedRtt * retransmitRttMultiplier, retransmitMinAge,
retransmitMaxAge)`.

### Recovery & ACK behavior

- Cumulative ACK: server advertises `ackSeq = expectedSeq - 1`; client
  removes all `seq ≤ ackSeq`.
- NAK-triggered immediate retransmit of named sequences.
- Periodic recovery burst drains oldest unacked packets, guarded by an
  in-flight flag with try/finally reset; respects `minRetransmitAge` to
  avoid double-send with NAK handling.

## 4. Congestion control (`congestion.ts`) — AIMD

EMA of RTT and loss (`alpha = CONGESTION_SMOOTHING_FACTOR = 0.2`). Adjust
every `CONGESTION_ADJUST_INTERVAL`. Logic:

- severe (loss > 5% or rtt > target×1.5): `timer *= CONGESTION_DECREASE_
FACTOR (1.5)` (slow down sends);
- very healthy (loss < 1% and rtt < target×0.8): converge toward
  `nominalDeltaTimer` (×`CONGESTION_INCREASE_FACTOR 0.95`);
- otherwise weak restoring force toward nominal.
  Clamp to `[CONGESTION_MIN_DELTA_TIMER 100, CONGESTION_MAX_DELTA_TIMER
5000]`. Manual override mode supported.

## 5. Bonding (`bonding.ts`)

Main/backup links. Per-link RTT EMA (`BONDING_RTT_EMA_ALPHA 0.2`) and loss
over a `BONDING_HEALTH_WINDOW_SIZE (10)` CircularBuffer. Failover when
active link breaches `BONDING_RTT_THRESHOLD (500ms)` or
`BONDING_LOSS_THRESHOLD (0.1)`. Failback after `BONDING_FAILBACK_DELAY
(30s)` with hysteresis (`*_RTT_HYSTERESIS 0.8`, `*_LOSS_HYSTERESIS 0.5`).
Heartbeat probes HMAC-authenticated (truncated SHA-256). SignalK
notification emitted on failover/failback.

## 6. Codec invariants (must round-trip exactly)

- **Compact delta** (`compact-delta.ts`): top-level `[context,
[updateTuple...]]`; each updateTuple is a fixed 5-slot array
  `[source, $source, timestamp, [[pathId,value]...], [[pathId,meta]...]]`
  (`UPDATE_TUPLE_LEN=5`). Discriminated by `isCompactDeltaArray`.
- **Value dedup** (`value-dedup.ts`): sentinel `{$$:"dup"}` replaces
  unchanged values; cache key `` `${context||"*"} ${path}` ``; LRU at
  `VALUE_DEDUP_CACHE_MAX (10000)`. `undedup` expands sentinels from cache,
  skips unknown paths.
- **Path dictionary** (`pathDictionary.ts`): bidirectional `PATH_TO_ID` /
  `ID_TO_PATH`, 282 entries, category-coded IDs. `encodePath` returns
  numeric id or original string (preserves instance IDs); `decodePath`
  reverses.
- **Metadata** (`metadata.ts`): `MetaEnvelope = {v:1, kind:
"snapshot"|"diff", seq, idx, total, entries}`. `MetaCache.diff/commit/
replaceAll/clear` with monotonic generation. Config ranges:
  `intervalSec [30,86400] default 300`, `maxPathsPerPacket [10,5000]
default 500`, `includePathsMatching ≤256 chars`, ReDoS heuristic
  `isLikelyUnsafePathFilter`.
- **Source snapshot** (`source-snapshot.ts`): `SourceSnapshotEnvelope =
{v:1, kind:"sources", seq, idx, total, sources}`. Merge bounds: depth ≤8,
  string ≤1024, array ≤256, object keys ≤256; blocked keys
  `__proto__/constructor/prototype`; printable-ASCII keys only.
- **Source registry** (`source-replication.ts`): schema version 1; LRU+TTL
  (`SOURCE_REGISTRY_MAX_RECORDS 5000`, `SOURCE_REGISTRY_TTL_MS 7d`);
  identity hash and timestamp-based conflict resolution.
- **Delta sanitizer** (`delta-sanitizer.ts`): own-data prefix
  `networking.edgeLink.`; keep-RTT regex
  `^networking\.(?:modem|edgeLink)(?:\.[^.]+)?\.rtt$`; quantize, throttle
  (deadband/minInterval), allow/deny glob filter, drop malformed paths.

## 7. Server-side safety limits (DoS protection)

| Constant                                    | Value        | Purpose                    |
| ------------------------------------------- | ------------ | -------------------------- |
| `MAX_DELTAS_PER_PACKET`                     | 500          | truncate oversized batches |
| `MAX_DECOMPRESSED_SIZE`                     | 10 MB        | decompression bomb cap     |
| `MAX_PARSE_PAYLOAD_SIZE`                    | 512 KB       | parse-stall cap            |
| `MAX_CLIENT_SESSIONS`                       | 100          | global session table       |
| (per-IP session cap)                        | 5            | spoof resistance           |
| `UDP_RATE_LIMIT_WINDOW` / `..._MAX_PACKETS` | 1000ms / 200 | per-session rate limit     |
| session idle TTL                            | 5 min        | eviction                   |

## 8. Full constants registry (`constants.ts`)

The rewrite carries `constants.ts` forward as L0 essentially verbatim
(values are tuned). Grouped values:

- **Delta/timing:** `DEFAULT_DELTA_TIMER 1000`, `PING_TIMEOUT_BUFFER
10000`, `MILLISECONDS_PER_MINUTE 60000`, `MAX_DELTAS_BUFFER_SIZE 1000`,
  `DELTA_BUFFER_DROP_RATIO 0.5`, `MAX_DELTAS_PER_PACKET 500`.
- **File watch:** `FILE_WATCH_DEBOUNCE_DELAY 300`, `CONTENT_HASH_ALGORITHM
"md5"`, `WATCHER_RECOVERY_DELAY 5000`.
- **UDP/network:** `MAX_SAFE_UDP_PAYLOAD 1400`, `BROTLI_QUALITY_HIGH 6`,
  `BROTLI_QUALITY_MIN 0`, `BROTLI_QUALITY_MAX 11`, `UDP_RETRY_MAX 3`,
  `UDP_RETRY_DELAY 100`, `UDP_SEND_TIMEOUT_MS 5000`.
- **Smart batching:** `SMART_BATCH_SAFETY_MARGIN 0.85`,
  `SMART_BATCH_SMOOTHING 0.2`, `SMART_BATCH_INITIAL_ESTIMATE 200`,
  `SMART_BATCH_MIN_DELTAS 1`, `SMART_BATCH_MAX_DELTAS 50`.
- **API rate limit:** `RATE_LIMIT_WINDOW 60000`, `RATE_LIMIT_MAX_REQUESTS
120`.
- **Congestion:** `CONGESTION_MIN_DELTA_TIMER 100`,
  `CONGESTION_MAX_DELTA_TIMER 5000`, `CONGESTION_TARGET_RTT 200`,
  `CONGESTION_ADJUST_INTERVAL 5000`, `CONGESTION_MAX_ADJUSTMENT 0.2`,
  `CONGESTION_SMOOTHING_FACTOR 0.2`, `CONGESTION_LOSS_THRESHOLD_LOW 0.01`,
  `CONGESTION_LOSS_THRESHOLD_HIGH 0.05`, `CONGESTION_RTT_MULTIPLIER_HIGH
1.5`, `CONGESTION_INCREASE_FACTOR 0.95`, `CONGESTION_DECREASE_FACTOR
1.5`.
- **Bonding:** `BONDING_HEALTH_CHECK_INTERVAL 1000`, `BONDING_RTT_THRESHOLD
500`, `BONDING_LOSS_THRESHOLD 0.1`, `BONDING_FAILBACK_DELAY 30000`,
  `BONDING_HEARTBEAT_TIMEOUT 5000`, `BONDING_FAILBACK_RTT_HYSTERESIS 0.8`,
  `BONDING_FAILBACK_LOSS_HYSTERESIS 0.5`, `BONDING_HEALTH_WINDOW_SIZE 10`,
  `BONDING_RTT_EMA_ALPHA 0.2`.
- **Server sessions:** `MAX_CLIENT_SESSIONS 100`, `UDP_RATE_LIMIT_WINDOW
1000`, `UDP_RATE_LIMIT_MAX_PACKETS 200`.
- **Decompression safety:** `MAX_DECOMPRESSED_SIZE 10MB`,
  `MAX_PARSE_PAYLOAD_SIZE 512KB`.
- **Metrics:** `METRICS_PUBLISH_INTERVAL 1000`, `BANDWIDTH_HISTORY_MAX 60`,
  `PATH_STATS_MAX_SIZE 500`.
- **Dedup/throttle caches:** `VALUE_DEDUP_CACHE_MAX 10000`,
  `PATH_THROTTLE_STATE_MAX 10000`.
- **Outbound dedup:** `OUTBOUND_DUPLICATE_SUPPRESS_MS 1500`,
  `SUPPRESSED_DUPLICATE_STATS_MAX_SIZE 50`,
  `OUTBOUND_DEDUPE_CLEANUP_INTERVAL_MS 1000`, `OUTBOUND_DEDUPE_MAX_ENTRIES
5000`.
- **Source registry:** `SOURCE_REGISTRY_MAX_RECORDS 5000`,
  `SOURCE_REGISTRY_TTL_MS 7d`.
- **Source snapshot:** `SOURCE_SNAPSHOT_INTERVAL_MS 60000`,
  `..._MAX_PROVIDERS 256`, `..._MAX_KEY_LENGTH 128`, `..._MAX_STRING_LENGTH
1024`, `..._MAX_DEPTH 8`, `..._MAX_ARRAY_LENGTH 256`,
  `..._MAX_OBJECT_KEYS 256`.
- **Delta send retry:** `DELTA_SEND_MAX_RETRIES 1`,
  `DELTA_SEND_RETRY_BACKOFF_MS 100`.
- **Snapshot replay:** `SNAPSHOT_REPLAY_CHUNK_SIZE 50`.
- **Hello:** `HELLO_PAYLOAD_MAX_BYTES 4096`.
- **Monitoring:** `MONITORING_HEATMAP_BUCKETS 60`,
  `MONITORING_HEATMAP_BUCKET_DURATION 5000`,
  `MONITORING_RETRANSMIT_HISTORY_SIZE 120`, `MONITORING_PATH_LATENCY_WINDOW
50`, `MONITORING_ALERT_COOLDOWN 60000`, `PACKET_CAPTURE_MAX_PACKETS
1000`, `PACKET_INSPECTOR_MAX_CLIENTS 5`.
- **Utility fns:** `calculateMaxDeltasPerBatch(avgBytes)`,
  `clampBytesPerDeltaSample(bytesPerDelta)`.

## 9. Conformance acceptance

Phase 1 of the rewrite is not "done" until the new codec layer reproduces
every golden vector byte-for-byte, AND an interop test passes between the
_old compiled build_ and the _new build_ in both directions for v1, v2, and
v3 (data + control + metadata + source snapshot).
