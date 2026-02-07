# Migration Guide: v1 to v2 Protocol

## Overview

The v2 protocol adds a binary packet header layer on top of the existing v1 encryption/compression pipeline. This enables sequence tracking, packet loss detection, and lays the groundwork for reliable delivery in future phases.

**Key principle:** v2 is opt-in and backward compatible. Existing v1 deployments continue to work without changes.

## What Changes

| Aspect | v1 | v2 |
|--------|----|----|
| Packet format | `[IV][Encrypted][AuthTag]` | `[Header(15B)][IV][Encrypted][AuthTag]` |
| Packet overhead | 28 bytes | 43 bytes (+15 byte header) |
| Sequence tracking | None | Per-packet sequence numbers |
| Loss detection | None | Gap detection with NAK scheduling |
| Packet types | Data only | DATA, ACK, NAK, HEARTBEAT, HELLO |
| Version detection | N/A | Magic bytes "SK" + version byte |

## What Stays the Same

- AES-256-GCM encryption (same algorithm, same key format)
- Brotli compression (same quality, same pipeline)
- MessagePack serialization (same library)
- Path dictionary encoding (same dictionary)
- Smart batching logic (same MTU awareness)
- Configuration UI (same web dashboard)
- All API endpoints (same REST interface)

## How to Migrate

### Step 1: Update the Plugin

```bash
cd ~/.signalk/node_modules/signalk-edge-link
git pull
npm install
npm run build
```

### Step 2: Configure Protocol Version

In the plugin configuration, set `protocolVersion` to `2`:

```json
{
  "serverType": true,
  "udpPort": 5555,
  "secretKey": "your-32-character-key-here......",
  "protocolVersion": 2
}
```

**Both client and server must use the same protocol version.**

### Step 3: Verify

1. Check the web dashboard for packet flow
2. Verify sequence numbers are incrementing
3. Monitor for any loss detection messages in debug logs

## Rollback

To revert to v1, simply set `protocolVersion` back to `1` (or remove the setting, as v1 is the default).

## Mixed Version Environments

The v2 server can distinguish v1 packets from v2 packets by checking the magic bytes. However, **mixed version operation is not supported in Phase 1**. Both client and server should use the same protocol version.

Future phases may add automatic version negotiation.

## Performance Impact

The v2 header adds 15 bytes per packet. For typical packets of 200-1400 bytes, this is 1-7% overhead. The benefits of sequence tracking and future reliability features outweigh this small overhead.

## Troubleshooting

### "Invalid magic bytes" Error

The server is receiving v1 packets but expecting v2. Ensure both sides use the same `protocolVersion`.

### "CRC mismatch" Error

The packet header was corrupted in transit. This may indicate network issues. The packet is safely discarded.

### "Unsupported protocol version" Error

The packet has v2 magic bytes but a different version number. Ensure both sides run the same plugin version.
