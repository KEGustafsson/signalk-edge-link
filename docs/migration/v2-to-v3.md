# Migration Guide: v2 to v3

## Overview

Protocol v3 is the default wire format as of signalk-edge-link 3.0.0. The
encrypted data payload is **identical to v2**; v3 adds two HMAC-SHA256
authentication layers keyed by the shared `secretKey`:

1. **Control packets** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST,
   FULL_STATUS_REQUEST) carry a 16-byte authentication tag, closing the v2
   control-plane forgery surface (forged FULL_STATUS_REQUEST replay
   amplification, forged NAK retransmit storms, forged HELLO sessions).
2. **DATA/METADATA headers** are authenticated by default
   (`authenticatedHeaders: true`): each packet carries a 16-byte HMAC tag binding
   its header (type/flags/sequence/length) to the encrypted payload, preventing
   on-path header tampering. This adds 16 bytes/packet.

**Key principle:** the upgrade is configuration-only — no new key material. Both
peers just need to agree on `protocolVersion: 3` and on the `authenticatedHeaders`
setting (default on; if one peer cannot enable it, set it to `false` on both).

> **Authoritative references.** Field names (`protocolVersion`, `secretKey`,
> `authenticatedHeaders`) and the `"basic"`/`"advanced"` string aliases are
> defined in [configuration-reference.md](../configuration-reference.md); metric
> names (`deltasSent`, `deltasReceived`, `malformedPackets`) are defined in
> [metrics.md](../metrics.md). Those documents are the single source of truth —
> if a name or alias changes in the implementation, update it there and keep the
> references in this guide in sync.

## What changes between v2 and v3

| Aspect                                | v2                    | v3                                  |
| ------------------------------------- | --------------------- | ----------------------------------- |
| Data payload (GCM)                    | encrypted + integrity | unchanged                           |
| Wire format / header                  | 15-byte binary header | 15-byte header + 16-byte HMAC tag\* |
| DATA/METADATA header authentication   | CRC16 only            | HMAC-SHA256 (default on)            |
| Control packet authentication         | CRC only (forgeable)  | HMAC-SHA256                         |
| Retransmission / congestion / bonding | ✓                     | ✓ (unchanged)                       |
| Safe on untrusted networks            | **No**                | **Yes**                             |

\* When `authenticatedHeaders` is enabled (the default), DATA/METADATA packets
carry a trailing 16-byte HMAC tag; both peers must use the same setting. Setting
it to `false` on both ends restores the legacy CRC-only header.

Everything else — AES-256-GCM encryption, Brotli compression, MessagePack,
path-dictionary encoding, the configuration UI, and all REST endpoints — stays
the same.

## Automatic config coercion

Existing connection configs with `protocolVersion: 2` are **silently coerced to
`3` on first start** of 3.0.0. No manual migration is required for the common
case: upgrade the plugin on both peers, restart, and the link comes up on v3.

The v2 wire protocol was **removed** in 3.0.0 — there is no way to re-select it
in a 3.0.0+ build. A stored `protocolVersion: 2` always resolves to `3`. See
Rollback below for how to interoperate with a peer that cannot be upgraded.

## How to migrate

### Step 1: Upgrade the plugin on both peers

```bash
cd ~/.signalk/node_modules/signalk-edge-link
git pull origin main
npm install
npm run build
```

> **Both sides must run the same version.** Upgrading one peer without the other
> causes immediate link failure: `malformedPackets` increments and no data
> flows. Plan a simultaneous restart.

### Step 2: Confirm `protocolVersion: 3`

In the Admin UI select **Advanced (v3)**, or in JSON set:

```json
{
  "connections": [
    {
      "protocolVersion": 3,
      "secretKey": "your-shared-secret-here"
    }
  ]
}
```

`protocolVersion` accepts the string aliases `"basic"` / `"advanced"` as well.
The `secretKey` must be identical on both ends — it now also keys the control
HMAC.

### Step 3: Restart both peers simultaneously

### Step 4: Verify

1. Confirm data flow resumes — check `deltasSent` / `deltasReceived`.
2. Confirm ACK/NAK traffic is present in `GET /metrics`.
3. If the link does not recover, verify both sides use the same
   `protocolVersion` **and** `secretKey`.

### Step 5: Authenticated DATA/METADATA headers (on by default)

Since 3.0.0, v3 enables `authenticatedHeaders` by default (`true`). Each
DATA/METADATA packet carries a 16-byte HMAC tag binding the header
(type/flags/sequence/length) to the encrypted payload, preventing on-path header
tampering. It adds 16 bytes/packet and **both ends must match** — two
default-configured v3 peers authenticate headers automatically, so no action is
needed in the common case.

Only if one peer cannot enable it (e.g. a constrained custom client), disable it
explicitly on **both** ends to fall back to the legacy CRC-only header:

```json
{
  "protocolVersion": 3,
  "authenticatedHeaders": false
}
```

See `docs/security.md` for the threat model.

## Rollback

The v2 wire protocol was removed in 3.0.0, so you cannot roll a 3.0.0+ build
back to v2 — `protocolVersion: 2` is coerced to `3`. Your options are:

- **Interoperate with an un-upgradable peer:** keep that peer on its older
  (< 3.0.0) build, which still speaks v2, and keep the other peer on its old
  build too. v3 and v2 peers cannot exchange data.
- **Downgrade to Basic (v1):** set `protocolVersion: 1` on **both** peers. This
  drops the reliability/authentication layer entirely (no ACK/NAK, congestion
  control, or bonding) and should only be used on trusted/private links.

No data loss occurs on the data path during either change.

## Troubleshooting

### Link does not recover after upgrade / `malformedPackets` climbing

One peer is on v3 and the other is still on v2 (running a pre-3.0.0 build) or
has a different `secretKey`. v3 control packets fail HMAC verification against
the wrong key or are rejected by a v2 peer. Upgrade both ends to 3.0.0+ and
align `secretKey`.

### Config rejected after upgrade

The Basic (v1) ping-monitor fields `testAddress`, `testPort`, and
`pingIntervalTime` are not valid on a v3 connection — v3 derives RTT from
HEARTBEAT exchanges. Remove them if present.
