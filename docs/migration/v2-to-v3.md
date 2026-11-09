# Migration Guide: v2 to v3

## Overview

Protocol v3 replaced v2 in signalk-edge-link 3.0.0. It is not the default: a connection without `protocolVersion` is Basic (v1), so select Advanced (v3) for every new connection. The encrypted data payload is **identical to v2**. v3 adds two HMAC-SHA256 layers keyed by the shared `secretKey`:

1. **Control packets** (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST) carry a 16-byte tag. This closes the v2 forgery surface: forged FULL_STATUS_REQUEST replay amplification, forged NAK retransmit storms, forged HELLO sessions.
2. **DATA/METADATA headers** are authenticated by default (`authenticatedHeaders: true`): a 16-byte HMAC tag binds the header (type, flags, sequence, length) to the encrypted payload, so an on-path attacker cannot alter it. This adds 16 bytes per packet.

The upgrade needs no new key material. Both peers must agree on `protocolVersion: 3` and on `authenticatedHeaders` (default on; if one peer cannot enable it, set it to `false` on both).

Field names and the `"basic"`/`"advanced"` aliases are defined in [configuration-reference.md](../configuration-reference.md); metric names (`deltasSent`, `deltasReceived`, `malformedPackets`) in [metrics.md](../metrics.md).

## What changes between v2 and v3

| Aspect                                | v2                    | v3                                                                                            |
| ------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Data payload (GCM)                    | encrypted + integrity | unchanged                                                                                     |
| Wire format / header                  | 15-byte binary header | 15-byte header + 16-byte HMAC tag\*                                                           |
| DATA/METADATA header authentication   | CRC16 only            | HMAC-SHA256 (default on)                                                                      |
| Control packet authentication         | CRC only (forgeable)  | HMAC-SHA256                                                                                   |
| Retransmission / congestion / bonding | ✓                     | ✓ (unchanged)                                                                                 |
| Safe on untrusted networks            | **No**                | **Authenticated, with replay limits** ([security.md](../security.md#data-anti-replay-window)) |

\* With `authenticatedHeaders` enabled (the default), DATA/METADATA packets carry a trailing 16-byte HMAC tag; both peers must use the same setting. `false` on both ends restores the CRC-only header.

AES-256-GCM encryption, Brotli compression, MessagePack, path-dictionary encoding, the configuration UI and all REST endpoints are unchanged.

## Automatic config coercion

A stored `protocolVersion: 2` is coerced to `3` on first start of 3.0.0. In the common case no manual migration is needed: upgrade the plugin on both peers, restart, and the link comes up on v3.

The v2 wire protocol was removed in 3.0.0; a 3.0.0+ build cannot select it. See [Rollback](#rollback) for a peer that cannot be upgraded.

## How to migrate

### Step 1: Upgrade the plugin on both peers

Update from the Signal K App Store, or for a source install pull and rebuild as in [GUIDE.md](../GUIDE.md#4-installation).

**Both sides must run Advanced (v3) with the same key and authentication settings.** Plugin versions may differ as long as both support the settings you enable (`epochBoundAuth` needs 4.0.0+, fleet sharing 4.4.0+). A peer left on Basic, or with mismatched settings, breaks the link and no data flows. The counter that rises depends on the mismatch: a different `secretKey` or `stretchAsciiKey` shows in the server's `encryptionErrors`; a protocol mismatch, or a v3 server with `authenticatedHeaders` off receiving tagged packets, shows in `malformedPackets`; a server that requires `authenticatedHeaders` receiving untagged packets logs `Authenticated header required` and counts a general error ([troubleshooting.md](../troubleshooting.md)). Change both ends in the same maintenance window.

### Step 2: Confirm `protocolVersion: 3`

In the Admin UI select **Advanced (v3)**, or set the field in each existing connection (fragment, other fields unchanged):

```json
{
  "connections": [
    {
      "protocolVersion": 3
    }
  ]
}
```

`protocolVersion` also accepts `"basic"` / `"advanced"`. `secretKey` must be identical on both ends; it now also keys the control HMAC.

### Step 3: Restart both peers simultaneously

### Step 4: Verify

1. Data flows again: check `deltasSent` / `deltasReceived`.
2. On the receiving server, `acksSent` rises in `GET /connections/:id/metrics` for the server connection (one count across all its clients; `GET /metrics` shows only the first connection, which may be a client). `naksSent` rises only when packets are lost, so 0 is normal.
3. If the link does not recover, check that both sides use the same `protocolVersion` **and** `secretKey`.

### Step 5: Authenticated DATA/METADATA headers (on by default)

`authenticatedHeaders` defaults to `true` from 3.0.0, so two default-configured v3 peers authenticate headers with no action. It adds 16 bytes per packet and **both ends must match**.

If one peer cannot enable it (for example a constrained custom client), disable it on **both** ends to fall back to the CRC-only header:

```json
{
  "protocolVersion": 3,
  "authenticatedHeaders": false
}
```

Threat model: [security.md](../security.md).

## Rollback

A 3.0.0+ build cannot run v2: `protocolVersion: 2` is coerced to `3`. The options are:

- **Interoperate with a peer that cannot be upgraded:** keep both peers on a pre-3.0.0 build, which speaks v2. v3 and v2 peers cannot exchange data.
- **Downgrade to Basic (v1):** set `protocolVersion: 1` on **both** peers. A v1 client also needs `testAddress` and `testPort`, and validation rejects the v3-only options, so turn off `epochBoundAuth`, `useValueDedup`, `useCompactDeltas` and `fleetSharing` first ([configuration-reference.md](../configuration-reference.md)). This removes the reliability and authentication layer (no ACK/NAK, congestion control or bonding); use it only on trusted, private links.

Neither change discards stored data. v1 has no retransmission, so datagrams lost in transit on a v1 link are not recovered.

## Troubleshooting

### Link does not recover after upgrade / `malformedPackets` climbing

One peer runs v3 and the other still runs a pre-3.0.0 build (v2) or has a different `secretKey`. v3 control packets fail HMAC verification against the wrong key or are rejected by the v2 peer. Upgrade both ends to 3.0.0+ and align `secretKey`.

### Config rejected after upgrade

The Basic (v1) ping-monitor fields `testAddress`, `testPort` and `pingIntervalTime` do not cause this: plugin startup and the management API strip them from a v3 client before validation, and v3 measures RTT from ACK timing. Only `npm run migrate:config` rejects them, in a legacy single-object file; remove them there.
