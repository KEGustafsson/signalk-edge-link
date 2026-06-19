# Migration Guide: v2 to v3

## Overview

Protocol v3 is the default wire format as of signalk-edge-link 3.0.0. v3 is
**identical to v2 in the data path and wire format** — the only difference is
that control packets (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST,
FULL_STATUS_REQUEST) carry a 16-byte HMAC-SHA256 authentication tag keyed by the
shared `secretKey`. This closes the v2 control-plane forgery surface (forged
FULL_STATUS_REQUEST replay amplification, forged NAK retransmit storms, forged
HELLO sessions).

**Key principle:** the upgrade is configuration-only. There is no new key
material and no data-format change — both peers just need to agree on
`protocolVersion: 3`.

> **Authoritative references.** Field names (`protocolVersion`, `secretKey`,
> `authenticatedHeaders`) and the `"basic"`/`"advanced"` string aliases are
> defined in [configuration-reference.md](../configuration-reference.md); metric
> names (`deltasSent`, `deltasReceived`, `malformedPackets`) are defined in
> [metrics.md](../metrics.md). Those documents are the single source of truth —
> if a name or alias changes in the implementation, update it there and keep the
> references in this guide in sync.

## What changes between v2 and v3

| Aspect                        | v2                   | v3            |
| ----------------------------- | -------------------- | ------------- |
| Data payload (GCM)            | encrypted + integrity | unchanged    |
| Wire format / header          | 15-byte binary header | unchanged    |
| Control packet authentication | CRC only (forgeable) | HMAC-SHA256   |
| Retransmission / congestion / bonding | ✓            | ✓ (unchanged) |
| Safe on untrusted networks    | **No**               | **Yes**       |

Everything else — AES-256-GCM encryption, Brotli compression, MessagePack,
path-dictionary encoding, the configuration UI, and all REST endpoints — stays
the same.

## Automatic config coercion

Existing connection configs with `protocolVersion: 2` are **silently coerced to
`3` on first start** of 3.0.0. No manual migration is required for the common
case: upgrade the plugin on both peers, restart, and the link comes up on v3.

If you need to stay on v2 (see Rollback below), you must set
`protocolVersion: 2` explicitly after upgrading.

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

### Step 5 (optional): Authenticate DATA/METADATA headers

v3 also supports `authenticatedHeaders` (default `false`). When `true`, each
DATA/METADATA packet carries a 16-byte HMAC tag binding the header
(type/flags/sequence/length) to the encrypted payload, preventing on-path header
tampering. It adds 16 bytes/packet and **both ends must match**.

```json
{
  "protocolVersion": 3,
  "authenticatedHeaders": true
}
```

See `docs/security.md` for the threat model.

## Rollback to v2

Because configs are coerced to v3 automatically, downgrading is an explicit
action:

1. Set `protocolVersion: 2` on **both** peers (the coercion will not override an
   explicit `2`).
2. Restart both peers simultaneously.

No data loss occurs — the v2 pipeline is byte-compatible with v3 on the data
path.

## Troubleshooting

### Link does not recover after upgrade / `malformedPackets` climbing

One peer is on v3 and the other is still on v2 (or has a different
`secretKey`). v3 control packets fail HMAC verification against the wrong key or
are rejected by a v2 peer. Align `protocolVersion` and `secretKey` on both ends.

### Config rejected after upgrade

The Basic (v1) ping-monitor fields `testAddress`, `testPort`, and
`pingIntervalTime` are not valid on a v3 connection — v3 derives RTT from
HEARTBEAT exchanges. Remove them if present.

### Startup warning about a publicly reachable v2 port

This is the expected nudge to upgrade: a v2 connection on a publicly reachable
UDP port has a forgeable control plane. Move it to v3.
